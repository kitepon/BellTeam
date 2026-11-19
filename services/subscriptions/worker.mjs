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

const googleProofPattern = /^[\w.-]{1,4096}$/
const googleStates = { SUBSCRIPTION_STATE_ACTIVE: 'active', SUBSCRIPTION_STATE_CANCELED: 'active', SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace', SUBSCRIPTION_STATE_ON_HOLD: 'billing_retry' }

// Google Playの購読（subscriptionsv2）を既存の購読確認と同じ形へ写す。CANCELEDは解約済みで期限まで使える状態。
export function googleEntitlement(purchase, now) {
  const item = purchase.lineItems?.find?.(line => line?.productId === product.productId)
  if (!item) throw new SubscriptionError('INVALID_PRODUCT', 400, 'BellTeamの月額購読のGoogle Play購読ではありません。')
  const expiry = Date.parse(item.expiryTime)
  if (typeof purchase.subscriptionState !== 'string' || !Number.isFinite(expiry)) throw invalidResponse('Google')
  if (purchase.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') throw new SubscriptionError('GOOGLE_PURCHASE_PENDING', 409, 'Google Playの購入がまだ確定していません。確定してから復元してください。')
  let state = googleStates[purchase.subscriptionState] ?? 'expired'
  // 猶予期間の終わりが示されていれば、その期限まで有効にする（Appleの支払い猶予期間と同じ扱い）。
  const graceEnd = Date.parse(purchase.inGracePeriodStateContext?.gracePeriodEndTime)
  const validUntil = state === 'grace' && Number.isFinite(graceEnd) ? Math.max(expiry, graceEnd) : expiry
  const entitled = ['active', 'grace'].includes(state) && validUntil > now
  if (!entitled && ['active', 'grace'].includes(state)) state = 'expired'
  return {
    entitled, state,
    expiresAt: new Date(expiry).toISOString(),
    validUntil: entitled ? new Date(validUntil).toISOString() : null,
    autoRenewing: state === 'active' && item.autoRenewingPlan?.autoRenewEnabled === true,
    isTrial: entitled && item.offerPhase?.freeTrial !== undefined,
  }
}

const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// サービスアカウントのJWTでアクセストークンを得る。期限の手前まで保持し、保存先・台帳は作らない。
async function googleAccessToken(env, request, now, cache, force = false) {
  const notConfigured = () => new SubscriptionError('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのGoogle Play設定が完了していません。')
  let account
  try { account = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT) } catch { throw notConfigured() }
  if (typeof account?.client_email !== 'string' || typeof account.private_key !== 'string') throw notConfigured()
  if (!force && cache.email === account.client_email && cache.expiresAt > now + 60_000) return cache.token
  const iat = Math.floor(now / 1000)
  const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)))
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`
  let assertion
  try {
    const der = Uint8Array.from(atob(account.private_key.replace(/-----[A-Z ]+-----|\s/g, '')), char => char.charCodeAt(0))
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    assertion = `${unsigned}.${base64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))}`
  } catch { throw notConfigured() }
  let response
  try {
    response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    })
  } catch { throw new SubscriptionError('GOOGLE_API_ERROR', 502, 'Googleとの通信に失敗しました。') }
  if (!response.ok) throw new SubscriptionError('GOOGLE_API_ERROR', 502, `Googleの認証に失敗しました（HTTP ${response.status}）。`)
  let result
  try { result = await response.json() } catch { throw invalidResponse('Google') }
  if (typeof result?.access_token !== 'string' || !Number.isFinite(result.expires_in)) throw invalidResponse('Google')
  Object.assign(cache, { email: account.client_email, token: result.access_token, expiresAt: now + result.expires_in * 1000 })
  return cache.token
}

async function verifyGoogle(env, request, input, now, cache) {
  const proof = input.googlePurchaseToken
  if (typeof proof !== 'string' || !googleProofPattern.test(proof)) throw new SubscriptionError('INVALID_REQUEST', 400, 'Google Playの購入トークンが必要です。')
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${product.bundleId}/purchases/subscriptionsv2/tokens/${proof}`
  let response
  // 認証が古い時（401）だけ、トークンを作り直して一度だけ再実行する。
  for (const force of [false, true]) {
    const token = await googleAccessToken(env, request, now, cache, force)
    try { response = await request(url, { headers: { Authorization: `Bearer ${token}` } }) } catch { throw new SubscriptionError('GOOGLE_API_ERROR', 502, 'Google Playとの通信に失敗しました。') }
    if (response.status !== 401) break
  }
  if ([400, 404, 410].includes(response.status)) throw new SubscriptionError('INVALID_GOOGLE_PROOF', 400, 'Google Playの購入情報が見つかりません。')
  if (!response.ok) throw new SubscriptionError('GOOGLE_API_ERROR', 502, `Google Playとの通信・購読照会に失敗しました（HTTP ${response.status}）。`)
  let purchase
  try { purchase = await response.json() } catch { throw invalidResponse('Google') }
  return {
    productId: product.productId, source: 'google',
    environment: purchase.testPurchase ? 'Sandbox' : 'Production', checkedAt: new Date(now).toISOString(),
    ...googleEntitlement(purchase, now),
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

const termsConsentText = '申し込むと、[利用規約](https://kitepon.dev/terms/)と[BellTeam付属規約](https://kitepon.dev/apps/bellteam/terms/)に同意したことになります。料金・解約・返金は[特定商取引法に基づく表記](https://kitepon.dev/specified-commercial-transactions/#bellteam)のとおりです。'

// 作ったCheckoutを開いたまま使い回す（二重に作らない）ため、sessionId付きなら新規作成せず現在の状態を返す。
async function stripeCheckout(env, request, resumeSessionId) {
  if (resumeSessionId !== undefined) {
    if (typeof resumeSessionId !== 'string' || !/^cs_[A-Za-z0-9_]{1,200}$/.test(resumeSessionId)) throw new SubscriptionError('INVALID_REQUEST', 400, 'StripeのCheckout Session IDの形式が一致しません。')
    const session = await stripeCall(env, request, `/v1/checkout/sessions/${resumeSessionId}`)
    if (session.id !== resumeSessionId || !['open', 'complete', 'expired'].includes(session.status)) throw invalidResponse('Stripe')
    return { sessionId: session.id, status: session.status, url: session.status === 'open' ? session.url : null }
  }
  if (!env.STRIPE_RETURN_URL) throw new SubscriptionError('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのStripe設定が完了していません。')
  const session = await stripeCall(env, request, '/v1/checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': env.STRIPE_PRICE_ID, 'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '30',
    // Stripe Taxは本部住所の登録後だけ使える。登録前にtrueにするとCheckoutが作れないため、設定で切り替える。
    ...(env.STRIPE_AUTOMATIC_TAX === 'true' ? { 'automatic_tax[enabled]': 'true' } : {}),
    // 申込み時に規約への同意を求める。StripeのアカウントにTerms URLを登録した後だけ使えるため、設定で切り替える（Taxと同じ）。
    ...(env.STRIPE_REQUIRE_TERMS === 'true' ? { 'consent_collection[terms_of_service]': 'required', 'custom_text[terms_of_service_acceptance][message]': termsConsentText } : {}),
    success_url: `${env.STRIPE_RETURN_URL}?session_id={CHECKOUT_SESSION_ID}`, cancel_url: env.STRIPE_RETURN_URL,
  })
  if (typeof session.url !== 'string' || typeof session.id !== 'string') throw invalidResponse('Stripe')
  return { url: session.url, sessionId: session.id }
}

// 利用者本人が解約・再開・支払い方法の変更をするStripeの顧客ポータルを開く。購読の価格を確かめてから、その購読の顧客だけへ作る。
async function stripePortal(env, request, subscriptionId) {
  if (typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9_]{1,200}$/.test(subscriptionId)) throw new SubscriptionError('INVALID_REQUEST', 400, 'Stripeの購読IDが必要です。')
  if (!env.STRIPE_RETURN_URL) throw new SubscriptionError('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのStripe設定が完了していません。')
  const subscription = await stripeCall(env, request, `/v1/subscriptions/${subscriptionId}`)
  if (subscription.id !== subscriptionId || !subscription.items?.data?.some(item => item.price?.id === env.STRIPE_PRICE_ID)) {
    throw new SubscriptionError('INVALID_PRODUCT', 400, 'BellTeamの月額購読のStripe購読ではありません。')
  }
  const customer = subscription.customer?.id ?? subscription.customer
  if (typeof customer !== 'string' || !customer) throw invalidResponse('Stripe')
  const portal = await stripeCall(env, request, '/v1/billing_portal/sessions', { customer, return_url: env.STRIPE_RETURN_URL })
  if (typeof portal.url !== 'string') throw invalidResponse('Stripe')
  return { url: portal.url }
}

export function createSubscriptionWorker({
  rootCertificates = appleRoots.certificates.map(certificate => Buffer.from(certificate.der, 'base64')),
  createAPIClient,
  stripeFetch = fetch,
  googleFetch = fetch,
  clock = Date.now,
} = {}) {
  let service
  const googleToken = {}

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
      if (!['/v1/subscriptions/verify', '/v1/subscriptions/stripe/checkout', '/v1/subscriptions/stripe/portal'].includes(path)) return new Response('見つかりません', { status: 404 })
      if (request.method !== 'POST') return new Response('POSTを使ってください。', { status: 405, headers: { Allow: 'POST' } })
      let configured
      try {
        let input
        try { input = await request.json() } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          if (!path.endsWith('/checkout')) throw new SubscriptionError('INVALID_REQUEST', 400, '購入情報をJSONで送信してください。')
        }
        if (path.endsWith('/checkout')) return Response.json(await stripeCheckout(env, stripeFetch, input?.sessionId), { headers: { 'Cache-Control': 'no-store' } })
        if (path.endsWith('/portal')) return Response.json(await stripePortal(env, stripeFetch, input?.stripeSubscriptionId), { headers: { 'Cache-Control': 'no-store' } })
        // 保管庫を増やさず、購入元（store）ごとに公式の照会へ振り分ける。
        if (input?.stripeSessionId !== undefined || input?.stripeSubscriptionId !== undefined) {
          return Response.json(await verifyStripe(env, stripeFetch, input, clock()), { headers: { 'Cache-Control': 'no-store' } })
        }
        if (input?.googlePurchaseToken !== undefined) {
          return Response.json(await verifyGoogle(env, googleFetch, input, clock(), googleToken), { headers: { 'Cache-Control': 'no-store' } })
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
