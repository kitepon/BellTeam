import assert from 'node:assert/strict'
import { createPublicKey, sign, verify as verifySignature } from 'node:crypto'
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
