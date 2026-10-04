import appleRoots from './apple-roots.json' with { type: 'json' }
import product from './product.json' with { type: 'json' }

export class SubscriptionError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

function invalidResponse() {
  return new SubscriptionError('INVALID_APPLE_RESPONSE', 502, 'Appleの購読情報の形式が一致しません。')
}

export function subscriptionEntitlement(item, transaction, renewal, now) {
  const states = { 1: 'active', 2: 'expired', 3: 'billing_retry', 4: 'grace', 5: 'revoked' }
  let state = states[item.status]
  if (!state || !Number.isFinite(transaction.expiresDate) || ![0, 1].includes(renewal.autoRenewStatus)) throw invalidResponse()
  if (transaction.revocationDate !== undefined) state = 'revoked'
  const validUntil = state === 'grace' ? renewal.gracePeriodExpiresDate : transaction.expiresDate
  if (state === 'grace' && !Number.isFinite(validUntil)) throw invalidResponse()
  const entitled = ['active', 'grace'].includes(state) && validUntil > now
  if (!entitled && ['active', 'grace'].includes(state)) state = 'expired'
  return {
    entitled, state,
    expiresAt: new Date(transaction.expiresDate).toISOString(),
    validUntil: entitled ? new Date(validUntil).toISOString() : null,
    autoRenewing: renewal.autoRenewStatus === 1,
  }
}

export function createSubscriptionWorker({
  rootCertificates = appleRoots.certificates.map(certificate => Buffer.from(certificate.der, 'base64')),
  createAPIClient,
  clock = Date.now,
} = {}) {
  let service

  async function initialize(env) {
    if (!['Production', 'Sandbox'].includes(env.APPLE_ENVIRONMENT) || !env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) {
      throw new SubscriptionError('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのApple設定が完了していません。')
    }
    // 公式ライブラリの初期化が乱数を使うため、リクエストの処理中に読み込む。
    const { SignedDataVerifier, AppStoreServerAPIClient, VerificationException, APIException } = await import('@apple/app-store-server-library')
    // Workersが変換するnode-fetchのCommonJS参照を避け、標準の通信関数を使う。
    class FetchAPIClient extends AppStoreServerAPIClient {
      makeFetchRequest(path, query, method, body, headers) {
        return fetch(`${this.urlBase}${path}?${query}`, { method, body, headers })
      }
    }
    return {
      environment: env.APPLE_ENVIRONMENT,
      verifier: new SignedDataVerifier(rootCertificates, false, env.APPLE_ENVIRONMENT, product.bundleId, product.appAppleId),
      client: createAPIClient ? createAPIClient() : new FetchAPIClient(env.APPLE_PRIVATE_KEY, env.APPLE_KEY_ID, env.APPLE_ISSUER_ID, product.bundleId, env.APPLE_ENVIRONMENT),
      VerificationException, APIException,
    }
  }

  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname
      if (path !== '/v1/subscriptions/verify') return new Response('見つかりません', { status: 404 })
      if (request.method !== 'POST') return new Response('POSTを使ってください。', { status: 405, headers: { Allow: 'POST' } })
      let configured
      try {
        let input
        try { input = await request.json() } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          throw new SubscriptionError('INVALID_REQUEST', 400, '購入情報をJSONで送信してください。')
        }
        if (typeof input?.signedTransaction !== 'string' || !input.signedTransaction) {
          throw new SubscriptionError('INVALID_REQUEST', 400, 'Appleの署名付き購入情報が必要です。')
        }
        service ??= initialize(env)
        configured = await service
        const submitted = await configured.verifier.verifyAndDecodeTransaction(input.signedTransaction)
        if (submitted.productId !== product.productId || submitted.type !== 'Auto-Renewable Subscription' || typeof submitted.originalTransactionId !== 'string' || !submitted.originalTransactionId) {
          throw new SubscriptionError('INVALID_PRODUCT', 400, 'BellTeamの月額購読の購入情報ではありません。')
        }
        let result
        try {
          result = await configured.client.getAllSubscriptionStatuses(submitted.originalTransactionId)
        } catch (error) {
          const detail = error instanceof configured.APIException ? `（HTTP ${error.httpStatusCode}）` : ''
          throw new SubscriptionError('APPLE_API_ERROR', 502, `Appleとの通信・購読照会に失敗しました${detail}。`)
        }
        const appAppleIdMatches = result.appAppleId === product.appAppleId || (configured.environment === 'Sandbox' && result.appAppleId === undefined)
        if (result.bundleId !== product.bundleId || !appAppleIdMatches || result.environment !== configured.environment || !Array.isArray(result.data) || result.data.some(group => !Array.isArray(group.lastTransactions))) throw invalidResponse()
        const items = result.data.flatMap(group => group.lastTransactions).filter(item => item.originalTransactionId === submitted.originalTransactionId)
        if (items.length !== 1 || typeof items[0].signedTransactionInfo !== 'string' || typeof items[0].signedRenewalInfo !== 'string') throw invalidResponse()
        const item = items[0]
        const transaction = await configured.verifier.verifyAndDecodeTransaction(item.signedTransactionInfo)
        const renewal = await configured.verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo)
        if (transaction.productId !== product.productId || transaction.type !== 'Auto-Renewable Subscription' || transaction.originalTransactionId !== submitted.originalTransactionId || renewal.originalTransactionId !== submitted.originalTransactionId || renewal.productId !== product.productId) throw invalidResponse()
        const now = clock()
        return Response.json({
          productId: product.productId, originalTransactionId: submitted.originalTransactionId,
          environment: configured.environment, checkedAt: new Date(now).toISOString(),
          ...subscriptionEntitlement(item, transaction, renewal, now),
        }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) {
        if (configured && error instanceof configured.VerificationException) {
          error = new SubscriptionError('INVALID_APPLE_SIGNATURE', 400, 'Appleの購入情報の署名・証明書・アプリ・環境を確認できませんでした。')
        }
        if (!(error instanceof SubscriptionError)) throw error
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } })
      }
    },
  }
}

export default createSubscriptionWorker()
