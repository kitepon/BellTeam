import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto'
import test from 'node:test'
import fixtures from './fixtures/subscriptions/certificates.json' with { type: 'json' }
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { createSubscriptionWorker } from '../services/subscriptions/worker.mjs'

const now = fixtures.signedDate + 3600000
const originalTransactionId = '100000000000001'
const env = { APPLE_ENVIRONMENT: 'Sandbox', APPLE_ISSUER_ID: 'test', APPLE_KEY_ID: 'test', APPLE_PRIVATE_KEY: fixtures.signingKey }
const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: fixtures.x5c })).toString('base64url')
const transaction = {
  bundleId: product.bundleId, environment: 'Sandbox', productId: product.productId,
  type: 'Auto-Renewable Subscription', originalTransactionId,
  signedDate: fixtures.signedDate, expiresDate: now + 3600000,
}
const renewal = {
  environment: 'Sandbox', productId: product.productId, originalTransactionId,
  signedDate: transaction.signedDate, autoRenewStatus: 1,
}

// 公開試験専用の証明書と鍵で、購読状態の境界条件を再現する。
function signed(payload) {
  const message = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const signature = sign('sha256', Buffer.from(message), { key: fixtures.signingKey, dsaEncoding: 'ieee-p1363' })
  return `${message}.${signature.toString('base64url')}`
}

function response(status = 1, tx = {}, info = {}) {
  return {
    bundleId: product.bundleId, appAppleId: product.appAppleId, environment: 'Sandbox',
    data: [{ lastTransactions: [{
      status, originalTransactionId,
      signedTransactionInfo: signed({ ...transaction, ...tx }),
      signedRenewalInfo: signed({ ...renewal, ...info }),
    }] }],
  }
}

function worker(getAllSubscriptionStatuses) {
  return createSubscriptionWorker({
    rootCertificates: [Buffer.from(fixtures.rootCertificate, 'base64')],
    createAPIClient: () => ({ getAllSubscriptionStatuses }), clock: () => now,
  })
}

async function verify(service, receipt = signed(transaction), config = env) {
  const result = await service.fetch(new Request('https://example.test/v1/subscriptions/verify', {
    method: 'POST', body: JSON.stringify({ signedTransaction: receipt }),
  }), config)
  return { status: result.status, body: await result.json() }
}

test('古い購入情報で照会しても最新の更新期限を使い、自動更新停止だけでは利用権を短縮しない', async () => {
  const service = worker(async id => {
    assert.equal(id, originalTransactionId)
    return response(1, {}, { autoRenewStatus: 0 })
  })
  const result = await verify(service, signed({ ...transaction, expiresDate: now - 86400000 }))
  assert.equal(result.status, 200)
  assert.equal(result.body.entitled, true)
  assert.equal(result.body.validUntil, new Date(transaction.expiresDate).toISOString())
  assert.equal(result.body.autoRenewing, false)
})

test('期限切れ・支払い再試行・猶予期間・返金で利用権を区別する', async () => {
  for (const [status, tx, info, entitled, state] of [
    [1, { expiresDate: now }, {}, false, 'expired'],
    [2, { expiresDate: now - 1 }, {}, false, 'expired'],
    [3, {}, {}, false, 'billing_retry'],
    [4, { expiresDate: now - 1 }, { gracePeriodExpiresDate: now + 60000 }, true, 'grace'],
    [4, {}, { gracePeriodExpiresDate: now }, false, 'expired'],
    [5, {}, {}, false, 'revoked'],
    [1, { revocationDate: now - 1 }, {}, false, 'revoked'],
  ]) {
    const result = await verify(worker(async () => response(status, tx, info)))
    assert.equal(result.status, 200)
    assert.equal(result.body.entitled, entitled)
    assert.equal(result.body.state, state)
    if (!entitled) assert.equal(result.body.validUntil, null)
  }
})

test('署名改変・別アプリ・本番とSandboxの混在はAppleへ照会する前に拒否する', async () => {
  let calls = 0
  const service = worker(async () => { calls++; return response() })
  const legitimate = signed(transaction)
  const parts = legitimate.split('.')
  parts[1] = Buffer.from(JSON.stringify({ ...transaction, expiresDate: now + 99999999 })).toString('base64url')
  for (const receipt of [parts.join('.'), signed({ ...transaction, bundleId: 'com.other' }), signed({ ...transaction, environment: 'Production' })]) {
    const result = await verify(service, receipt)
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'INVALID_APPLE_SIGNATURE')
  }
  assert.equal(calls, 0)
})

test('実サービスのAppleルート証明書は公開試験用の証明書を信頼しない', async () => {
  const service = createSubscriptionWorker({ createAPIClient: () => ({ getAllSubscriptionStatuses() { assert.fail('照会されてはいけません') } }) })
  const result = await verify(service)
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'INVALID_APPLE_SIGNATURE')
})

test('Apple通信障害は期限切れとして返さず、再試行せずにエラーを返す', async () => {
  let calls = 0
  const result = await verify(worker(async () => { calls++; throw new Error('ネットワーク障害') }))
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'APPLE_API_ERROR')
  assert.equal(result.body.entitled, undefined)
  assert.equal(calls, 1)
})

test('公式APIクライアントは標準fetchでAppleへ認証付き照会を行う', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, `https://api.storekit-sandbox.apple.com/inApps/v1/subscriptions/${originalTransactionId}?`)
    assert.equal(options.method, 'GET')
    const [header, payload, signature] = options.headers.Authorization.slice('Bearer '.length).split('.')
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, env.APPLE_KEY_ID)
    const claims = JSON.parse(Buffer.from(payload, 'base64url'))
    assert.equal(claims.iss, env.APPLE_ISSUER_ID)
    assert.equal(claims.bid, product.bundleId)
    assert.equal(verifySignature('sha256', Buffer.from(`${header}.${payload}`), {
      key: createPublicKey(fixtures.signingKey), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url')), true)
    return Response.json(response())
  })
  const service = createSubscriptionWorker({
    rootCertificates: [Buffer.from(fixtures.rootCertificate, 'base64')], clock: () => now,
  })
  const result = await verify(service)
  assert.equal(calls, 1)
  assert.equal(result.status, 200)
  assert.equal(result.body.entitled, true)
})

test('SandboxはappAppleIdの省略を認め、本番では必須にする', async () => {
  const sandbox = response()
  delete sandbox.appAppleId
  const sandboxResult = await verify(worker(async () => sandbox))
  assert.equal(sandboxResult.status, 200)
  assert.equal(sandboxResult.body.entitled, true)

  const production = response()
  production.environment = 'Production'
  const item = production.data[0].lastTransactions[0]
  item.signedTransactionInfo = signed({ ...transaction, environment: 'Production' })
  item.signedRenewalInfo = signed({ ...renewal, environment: 'Production' })
  const receipt = signed({ ...transaction, environment: 'Production' })
  const configuration = { ...env, APPLE_ENVIRONMENT: 'Production' }
  const validResult = await verify(worker(async () => production), receipt, configuration)
  assert.equal(validResult.status, 200)
  delete production.appAppleId
  const missingResult = await verify(worker(async () => production), receipt, configuration)
  assert.equal(missingResult.status, 502)
  assert.equal(missingResult.body.error.code, 'INVALID_APPLE_RESPONSE')
})

test('Apple応答の別取引・必須項目欠落・未知の状態は購読確認エラーとして返す', async () => {
  const wrongApp = response(); wrongApp.appAppleId = 1
  for (const data of [
    response(99), response(4), response(1, { expiresDate: undefined }),
    response(1, { originalTransactionId: 'other' }), response(1, {}, { originalTransactionId: 'other' }),
    response(1, {}, { productId: 'other' }), wrongApp,
  ]) {
    const result = await verify(worker(async () => data))
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'INVALID_APPLE_RESPONSE')
  }
})

test('Apple設定が不足する時は未設定を明示する', async () => {
  const result = await verify(worker(() => assert.fail('照会されてはいけません')), undefined, {})
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'SUBSCRIPTION_NOT_CONFIGURED')
})

// Stripe: 通信相手だけを試験応答に置き換える。実Stripeへは通信しない。
const stripeEnv = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_980', STRIPE_RETURN_URL: 'https://example.test/return' }
const stripeSubscription = (extra = {}) => ({
  id: 'sub_1', status: 'active', livemode: false, cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_980' }, current_period_end: Math.floor((now + 3600000) / 1000) }] }, ...extra,
})

function stripeWorker(handler) {
  const calls = []
  const service = createSubscriptionWorker({
    stripeFetch: async (url, init) => { calls.push({ url, init }); return handler(url, init) }, clock: () => now,
  })
  const post = (path, body, config = stripeEnv) => service.fetch(new Request(`https://example.test${path}`, { method: 'POST', body: JSON.stringify(body) }), config)
    .then(async result => ({ status: result.status, body: await result.json() }))
  return { post, calls }
}

test('Stripeの状態を購読確認の形へ写し、Appleを呼ばずに無料期間と解約予約を区別する', async () => {
  for (const [extra, entitled, state, isTrial, autoRenewing] of [
    [{}, true, 'active', false, true],
    [{ status: 'trialing' }, true, 'active', true, true],
    [{ cancel_at_period_end: true }, true, 'active', false, false],
    [{ status: 'past_due' }, false, 'billing_retry', false, false],
    [{ status: 'canceled' }, false, 'expired', false, false],
    [{ items: { data: [{ price: { id: 'price_980' }, current_period_end: Math.floor(now / 1000) }] } }, false, 'expired', false, false],
  ]) {
    const { post } = stripeWorker(() => Response.json(stripeSubscription(extra)))
    const result = await post('/v1/subscriptions/verify', { stripeSubscriptionId: 'sub_1' })
    assert.equal(result.status, 200)
    assert.deepEqual([result.body.entitled, result.body.state, result.body.isTrial, result.body.autoRenewing], [entitled, state, isTrial, autoRenewing])
    assert.equal(result.body.source, 'stripe')
    assert.equal(result.body.environment, 'Sandbox')
    assert.equal(result.body.productId, product.productId)
    assert.equal(result.body.validUntil === null, !entitled)
  }
})

test('StripeのCheckout Sessionから購読を引き当て、別の価格・別の購読・不正なIDは拒否する', async () => {
  const { post, calls } = stripeWorker(url => url.endsWith('/v1/checkout/sessions/cs_1') ? Response.json({ subscription: 'sub_1' }) : Response.json(stripeSubscription()))
  const ok = await post('/v1/subscriptions/verify', { stripeSessionId: 'cs_1' })
  assert.equal(ok.body.subscriptionId, 'sub_1')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x')
  const other = await stripeWorker(() => Response.json(stripeSubscription({ items: { data: [{ price: { id: 'price_other' }, current_period_end: 1 }] } })))
    .post('/v1/subscriptions/verify', { stripeSubscriptionId: 'sub_1' })
  assert.equal(other.body.error.code, 'INVALID_PRODUCT')
  const swapped = await stripeWorker(() => Response.json(stripeSubscription({ id: 'sub_2' }))).post('/v1/subscriptions/verify', { stripeSubscriptionId: 'sub_1' })
  assert.equal(swapped.body.error.code, 'INVALID_PRODUCT')
  const unpaid = await stripeWorker(() => Response.json({ subscription: null })).post('/v1/subscriptions/verify', { stripeSessionId: 'cs_1' })
  assert.equal(unpaid.body.error.code, 'STRIPE_SESSION_UNPAID')
  const { post: guarded, calls: guardedCalls } = stripeWorker(() => assert.fail('照会されてはいけません'))
  assert.equal((await guarded('/v1/subscriptions/verify', { stripeSessionId: 'cs_1/../x' })).body.error.code, 'INVALID_REQUEST')
  assert.equal(guardedCalls.length, 0)
})

test('Stripeの通信失敗・未設定を期限切れへ置き換えずエラーで返し、Checkoutは設定の値で作る', async () => {
  const down = await stripeWorker(() => new Response('', { status: 500 })).post('/v1/subscriptions/verify', { stripeSubscriptionId: 'sub_1' })
  assert.deepEqual([down.status, down.body.error.code], [502, 'STRIPE_API_ERROR'])
  const missing = await stripeWorker(() => assert.fail('照会されてはいけません')).post('/v1/subscriptions/verify', { stripeSubscriptionId: 'sub_1' }, {})
  assert.deepEqual([missing.status, missing.body.error.code], [503, 'SUBSCRIPTION_NOT_CONFIGURED'])
  const { post, calls } = stripeWorker(() => Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }))
  const session = await post('/v1/subscriptions/stripe/checkout', {})
  assert.deepEqual(session.body, { url: 'https://checkout.stripe.test/c/1', sessionId: 'cs_1' })
  const form = calls[0].init.body
  assert.equal(form.get('subscription_data[trial_period_days]'), '30')
  assert.equal(form.get('line_items[0][price]'), 'price_980')
  assert.equal(form.has('automatic_tax[enabled]'), false)
  const taxed = stripeWorker(() => Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }))
  await taxed.post('/v1/subscriptions/stripe/checkout', {}, { ...stripeEnv, STRIPE_AUTOMATIC_TAX: 'true' })
  assert.equal(taxed.calls[0].init.body.get('automatic_tax[enabled]'), 'true')
  assert.equal(form.get('success_url'), 'https://example.test/return?session_id={CHECKOUT_SESSION_ID}')
  assert.equal(form.has('consent_collection[terms_of_service]'), false)
  const consent = stripeWorker(() => Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }))
  await consent.post('/v1/subscriptions/stripe/checkout', {}, { ...stripeEnv, STRIPE_REQUIRE_TERMS: 'true' })
  const consentForm = consent.calls[0].init.body
  assert.equal(consentForm.get('consent_collection[terms_of_service]'), 'required')
  const message = consentForm.get('custom_text[terms_of_service_acceptance][message]')
  assert.ok(message.length <= 1200 && message.includes('kitepon.dev/apps/bellteam/terms/') && message.includes('specified-commercial-transactions/#bellteam'))
})

test('開いたままのCheckoutは新しく作らず状態を返し、閉じたものはURLを返さない', async () => {
  for (const [status, url] of [['open', 'https://checkout.stripe.test/c/1'], ['complete', null], ['expired', null]]) {
    const { post, calls } = stripeWorker(() => Response.json({ id: 'cs_1', status, url: 'https://checkout.stripe.test/c/1' }))
    const result = await post('/v1/subscriptions/stripe/checkout', { sessionId: 'cs_1' })
    assert.deepEqual(result.body, { sessionId: 'cs_1', status, url })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.method, 'GET')
  }
  const swapped = await stripeWorker(() => Response.json({ id: 'cs_2', status: 'open' })).post('/v1/subscriptions/stripe/checkout', { sessionId: 'cs_1' })
  assert.equal(swapped.body.error.code, 'INVALID_STRIPE_RESPONSE')
  const { post, calls } = stripeWorker(() => assert.fail('照会されてはいけません'))
  assert.equal((await post('/v1/subscriptions/stripe/checkout', { sessionId: 'cs_1/../x' })).body.error.code, 'INVALID_REQUEST')
  assert.equal(calls.length, 0)
})

test('Stripeの顧客ポータルは、BellTeamの価格の購読の顧客にだけ作る', async () => {
  const handler = url => url.includes('/billing_portal/sessions') ? Response.json({ url: 'https://billing.stripe.test/p/1' }) : Response.json(stripeSubscription({ customer: 'cus_1' }))
  const { post, calls } = stripeWorker(handler)
  const ok = await post('/v1/subscriptions/stripe/portal', { stripeSubscriptionId: 'sub_1' })
  assert.deepEqual(ok.body, { url: 'https://billing.stripe.test/p/1' })
  const form = calls[1].init.body
  assert.deepEqual([form.get('customer'), form.get('return_url')], ['cus_1', 'https://example.test/return'])
  const other = await stripeWorker(() => Response.json(stripeSubscription({ customer: 'cus_1', items: { data: [{ price: { id: 'price_other' } }] } })))
    .post('/v1/subscriptions/stripe/portal', { stripeSubscriptionId: 'sub_1' })
  assert.equal(other.body.error.code, 'INVALID_PRODUCT')
  const bad = await stripeWorker(() => assert.fail('照会されてはいけません')).post('/v1/subscriptions/stripe/portal', { stripeSubscriptionId: 'cs_1' })
  assert.equal(bad.body.error.code, 'INVALID_REQUEST')
  const denied = await stripeWorker(url => url.includes('/billing_portal/') ? new Response('', { status: 403 }) : Response.json(stripeSubscription({ customer: 'cus_1' })))
    .post('/v1/subscriptions/stripe/portal', { stripeSubscriptionId: 'sub_1' })
  assert.deepEqual([denied.status, denied.body.error.code], [502, 'STRIPE_API_ERROR'])
})

// Google Play: 通信相手だけを試験応答に置き換える。サービスアカウントの鍵は試験用に生成する。
const { privateKey: googleKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const googleEnv = { GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'play@test.iam.example', private_key: googleKey.export({ type: 'pkcs8', format: 'pem' }) }) }
const googlePurchase = (extra = {}, line = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  lineItems: [{ productId: product.productId, expiryTime: new Date(now + 3600000).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, ...line }], ...extra,
})

function googleWorker(purchase) {
  const calls = []
  const service = createSubscriptionWorker({
    googleFetch: async (url, init) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.test', expires_in: 3600 })
      return typeof purchase === 'function' ? purchase(url, init) : Response.json(purchase)
    }, clock: () => now,
  })
  const post = (body, config = googleEnv) => service.fetch(new Request('https://example.test/v1/subscriptions/verify', { method: 'POST', body: JSON.stringify(body) }), config)
    .then(async result => ({ status: result.status, body: await result.json() }))
  return { post, calls }
}

test('Google Playの状態を購読確認の形へ写し、無料期間・解約済み・猶予・保留・期限切れを区別する', async () => {
  const past = new Date(now - 1000).toISOString()
  for (const [purchase, entitled, state, isTrial, autoRenewing, environment] of [
    [googlePurchase(), true, 'active', false, true, 'Production'],
    [googlePurchase({ testPurchase: {} }, { offerPhase: { freeTrial: {} } }), true, 'active', true, true, 'Sandbox'],
    [googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_CANCELED' }, { autoRenewingPlan: { autoRenewEnabled: false } }), true, 'active', false, false, 'Production'],
    [googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_CANCELED' }, { expiryTime: past }), false, 'expired', false, false, 'Production'],
    [googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', inGracePeriodStateContext: { gracePeriodEndTime: new Date(now + 7200000).toISOString() } }, { expiryTime: past }), true, 'grace', false, false, 'Production'],
    [googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }, { expiryTime: past }), false, 'billing_retry', false, false, 'Production'],
    [googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }), false, 'expired', false, false, 'Production'],
    [googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_PAUSED' }), false, 'expired', false, false, 'Production'],
  ]) {
    const result = await googleWorker(purchase).post({ googlePurchaseToken: 'token-1' })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual([result.body.entitled, result.body.state, result.body.isTrial, result.body.autoRenewing, result.body.environment], [entitled, state, isTrial, autoRenewing, environment])
    assert.deepEqual([result.body.source, result.body.productId, result.body.validUntil === null], ['google', product.productId, !entitled])
    assert.equal(JSON.stringify(result.body).includes('token-1'), false)
  }
})

test('Google Playへは署名したJWTで認証し、購入トークンは商品の購読にだけ使う。トークンは使い回し、401なら一度だけ作り直す', async () => {
  const { post, calls } = googleWorker(() => Response.json(googlePurchase()))
  await post({ googlePurchaseToken: 'token-1' })
  await post({ googlePurchaseToken: 'token-2' })
  assert.deepEqual(calls.map(call => call.url), [
    'https://oauth2.googleapis.com/token',
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${product.bundleId}/purchases/subscriptionsv2/tokens/token-1`,
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${product.bundleId}/purchases/subscriptionsv2/tokens/token-2`,
  ])
  const assertion = calls[0].init.body.get('assertion')
  const [header, claims, signature] = assertion.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/androidpublisher')
  assert.equal(verifySignature('sha256', Buffer.from(`${header}.${claims}`), createPublicKey(googleKey), Buffer.from(signature, 'base64url')), true)
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ya29.test')
  let first = true
  const retried = googleWorker(() => { const stale = first; first = false; return stale ? new Response('', { status: 401 }) : Response.json(googlePurchase()) })
  assert.equal((await retried.post({ googlePurchaseToken: 'token-1' })).status, 200)
  assert.equal(retried.calls.filter(call => call.url === 'https://oauth2.googleapis.com/token').length, 2)
})

test('Google Playの別商品・無効なトークン・未確定の購入・通信失敗・未設定を期限切れへ置き換えずエラーで返す', async () => {
  const wrongProduct = await googleWorker(googlePurchase({}, { productId: 'other.product' })).post({ googlePurchaseToken: 't' })
  assert.deepEqual([wrongProduct.status, wrongProduct.body.error.code], [400, 'INVALID_PRODUCT'])
  for (const status of [400, 404, 410]) {
    const rejected = await googleWorker(() => new Response('', { status })).post({ googlePurchaseToken: 't' })
    assert.deepEqual([rejected.status, rejected.body.error.code], [400, 'INVALID_GOOGLE_PROOF'])
  }
  const forbidden = await googleWorker(() => new Response('', { status: 403 })).post({ googlePurchaseToken: 't' })
  assert.deepEqual([forbidden.status, forbidden.body.error.code], [502, 'GOOGLE_API_ERROR'])
  const pending = await googleWorker(googlePurchase({ subscriptionState: 'SUBSCRIPTION_STATE_PENDING' })).post({ googlePurchaseToken: 't' })
  assert.deepEqual([pending.status, pending.body.error.code], [409, 'GOOGLE_PURCHASE_PENDING'])
  const broken = await googleWorker(() => { throw new Error('offline') }).post({ googlePurchaseToken: 't' })
  assert.deepEqual([broken.status, broken.body.error.code], [502, 'GOOGLE_API_ERROR'])
  const malformed = await googleWorker({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{ productId: product.productId }] }).post({ googlePurchaseToken: 't' })
  assert.deepEqual([malformed.status, malformed.body.error.code], [502, 'INVALID_GOOGLE_RESPONSE'])
  for (const config of [{}, { GOOGLE_PLAY_SERVICE_ACCOUNT: 'not json' }, { GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a', private_key: 'bad' }) }]) {
    const missing = await googleWorker(googlePurchase()).post({ googlePurchaseToken: 't' }, config)
    assert.deepEqual([missing.status, missing.body.error.code], [503, 'SUBSCRIPTION_NOT_CONFIGURED'])
  }
  for (const googlePurchaseToken of ['', 'a/b', 'x'.repeat(5000), 7]) {
    const invalid = await googleWorker(googlePurchase()).post({ googlePurchaseToken })
    assert.deepEqual([invalid.status, invalid.body.error.code], [400, 'INVALID_REQUEST'])
  }
})
