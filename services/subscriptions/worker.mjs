import appleRoots from './apple-roots.json' with { type: 'json' }
import product from './product.json' with { type: 'json' }

export class SubscriptionError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

function invalidResponse(store = 'Apple') {
  return new SubscriptionError(`INVALID_${store.toUpperCase()}_RESPONSE`, 502, `${store}の購読情報の形式が一致しません。`)
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

const stripeIdPattern = /^(cs|sub)_[A-Za-z0-9_]{1,200}$/
const stripeStates = { active: 'active', trialing: 'active', past_due: 'billing_retry' }

// Stripeの購読を既存の購読確認と同じ形（state・entitled・validUntil）へ写す。
export function stripeEntitlement(subscription, now) {
  const periodEnd = (subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end) * 1000
  if (typeof subscription.status !== 'string' || !Number.isFinite(periodEnd) || typeof subscription.livemode !== 'boolean') throw invalidResponse('Stripe')
  let state = stripeStates[subscription.status] ?? 'expired'
  const entitled = state === 'active' && periodEnd > now
  if (!entitled && state === 'active') state = 'expired'
  return {
    entitled, state,
    expiresAt: new Date(periodEnd).toISOString(),
    validUntil: entitled ? new Date(periodEnd).toISOString() : null,
    autoRenewing: state === 'active' && !subscription.cancel_at_period_end,
    isTrial: entitled && subscription.status === 'trialing',
  }
}

async function stripeCall(env, request, path, body) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) throw new SubscriptionError('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのStripe設定が完了していません。')
  let response
  try {
    response = await request(`https://api.stripe.com${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body && new URLSearchParams(body),
    })
  } catch { throw new SubscriptionError('STRIPE_API_ERROR', 502, 'Stripeとの通信に失敗しました。') }
  if (response.status === 404) throw new SubscriptionError('INVALID_STRIPE_PROOF', 400, 'Stripeの購入情報が見つかりません。')
  if (!response.ok) throw new SubscriptionError('STRIPE_API_ERROR', 502, `Stripeとの通信・購読照会に失敗しました（HTTP ${response.status}）。`)
  try { return await response.json() } catch { throw invalidResponse('Stripe') }
}

async function verifyStripe(env, request, input, now) {
  const proof = input.stripeSubscriptionId ?? input.stripeSessionId
  if (typeof proof !== 'string' || !stripeIdPattern.test(proof)) throw new SubscriptionError('INVALID_REQUEST', 400, 'StripeのCheckout Session IDまたは購読IDが必要です。')
  let subscriptionId = proof
  if (proof.startsWith('cs_')) {
    const session = await stripeCall(env, request, `/v1/checkout/sessions/${proof}`)
    subscriptionId = session.subscription?.id ?? session.subscription
    if (typeof subscriptionId !== 'string') throw new SubscriptionError('STRIPE_SESSION_UNPAID', 409, 'このCheckout Sessionでは購読が開始されていません。')
  }
  const subscription = await stripeCall(env, request, `/v1/subscriptions/${subscriptionId}`)
  if (subscription.id !== subscriptionId || !subscription.items?.data?.some(item => item.price?.id === env.STRIPE_PRICE_ID)) {
    throw new SubscriptionError('INVALID_PRODUCT', 400, 'BellTeamの月額購読のStripe購読ではありません。')
  }
  return {
    productId: product.productId, subscriptionId, source: 'stripe',
    environment: subscription.livemode ? 'Production' : 'Sandbox', checkedAt: new Date(now).toISOString(),
    ...stripeEntitlement(subscription, now),
  }
}

async function stripeCheckout(env, request) {
  if (!env.STRIPE_RETURN_URL) throw new SubscriptionError('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのStripe設定が完了していません。')
  const session = await stripeCall(env, request, '/v1/checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': env.STRIPE_PRICE_ID, 'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '30',
    success_url: `${env.STRIPE_RETURN_URL}?session_id={CHECKOUT_SESSION_ID}`, cancel_url: env.STRIPE_RETURN_URL,
  })
  if (typeof session.url !== 'string' || typeof session.id !== 'string') throw invalidResponse('Stripe')
  return { url: session.url, sessionId: session.id }
}

export function createSubscriptionWorker({
  rootCertificates = appleRoots.certificates.map(certificate => Buffer.from(certificate.der, 'base64')),
  createAPIClient,
  stripeFetch = fetch,
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
      if (!['/v1/subscriptions/verify', '/v1/subscriptions/stripe/checkout'].includes(path)) return new Response('見つかりません', { status: 404 })
      if (request.method !== 'POST') return new Response('POSTを使ってください。', { status: 405, headers: { Allow: 'POST' } })
      let configured
      try {
        if (path.endsWith('/checkout')) return Response.json(await stripeCheckout(env, stripeFetch), { headers: { 'Cache-Control': 'no-store' } })
        let input
        try { input = await request.json() } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          throw new SubscriptionError('INVALID_REQUEST', 400, '購入情報をJSONで送信してください。')
        }
        // 保管庫を増やさず、購入元（store）ごとに公式の照会へ振り分ける。Google Playはここへ分岐を足す。
        if (input?.stripeSessionId !== undefined || input?.stripeSubscriptionId !== undefined) {
          return Response.json(await verifyStripe(env, stripeFetch, input, clock()), { headers: { 'Cache-Control': 'no-store' } })
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
          environment: configured.environment, checkedAt: new Date(now).toISOString(), source: 'apple',
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
