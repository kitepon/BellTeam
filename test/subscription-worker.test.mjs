import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createTestKit } from '@kitepon/login-billing/testing'
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { createLoginBillingWorker, libraryStorage } from '../services/subscriptions/worker.mjs'
import { createSqlStorage } from '../services/subscriptions/sql-storage.mjs'

const b64 = byte => Buffer.alloc(32, byte).toString('base64url')
const env = { LB_KKEY: b64(7), LB_PASS_KEY_CURRENT: b64(9), LB_PASS_KEY_CURRENT_ID: 'k1', APPLE_SIGNIN_AUDIENCES: product.bundleId, GOOGLE_SIGNIN_AUDIENCES: 'google-client' }

// The Durable Object's SQL interface over an in-memory SQLite: the same storage code runs in the test.
function sqlOf(database) {
  return { exec: (query, ...binds) => { const rows = database.prepare(query).all(...binds); return { toArray: () => rows } } }
}

async function setup({ configured = true, max } = {}) {
  const kit = await createTestKit()
  const storage = createSqlStorage(sqlOf(new DatabaseSync(':memory:')), { max })
  const worker = createLoginBillingWorker({
    storage: libraryStorage(() => storage),
    extra: { fetch: kit.fetch, stores: { apple: kit.appleStore(product.bundleId), google: kit.googleStore(product.bundleId) } },
  })
  const call = async (path, body = {}, pass, headers = {}) => {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(pass ? { authorization: `Bearer ${pass}` } : {}), ...headers },
    }), configured ? env : {})
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  const signIn = async (provider = 'apple', sub = 'subject-1') => {
    const { body: { nonce } } = await call('/auth/v1/signin/nonce')
    const idToken = provider === 'apple'
      ? await kit.appleIdToken({ aud: product.bundleId, sub, nonce })
      : await kit.googleIdToken({ aud: 'google-client', sub, nonce })
    const result = await call('/auth/v1/signin', { provider, idToken, nonce, deviceLabel: 'iPhone' })
    assert.equal(result.status, 200)
    return result.body
  }
  return { kit, call, signIn, worker }
}

const entitlement = (context, pass) => context.call('/v1/entitlement', {}, pass)

test('an unconfigured Worker answers 503 and opens no free path', async () => {
  const { call } = await setup({ configured: false })
  assert.deepEqual((await call('/v1/entitlement', {}, 'x')).body, { error: 'not_configured' })
  assert.equal((await call('/auth/v1/signin/nonce')).status, 503)
})

test('only POST on the wire prefix and the product route; anything else is 404', async () => {
  const { worker } = await setup()
  assert.equal((await worker.fetch(new Request('https://worker.test/v1/entitlement'), env)).status, 405)
  assert.equal((await worker.fetch(new Request('https://worker.test/v1/subscriptions/verify', { method: 'POST', body: '{}' }), env)).status, 404)
  assert.equal((await worker.fetch(new Request('https://worker.test/v1/subscriptions/stripe/checkout', { method: 'POST', body: '{}' }), env)).status, 404)
})

test('a signed-in pass with no contract is not entitled; a purchase made with the mark makes it entitled (Apple)', async () => {
  const context = await setup()
  const signed = await context.signIn()
  assert.deepEqual((await entitlement(context, signed.pass)).body, { entitled: false })
  const expiresDate = Date.now() + 5 * 86400_000
  context.kit.apple.transactions['1001'] = {
    transactionId: '1001', originalTransactionId: '1001', productId: product.productId, bundleId: product.bundleId,
    type: 'Auto-Renewable Subscription', expiresDate, appAccountToken: signed.purchaseMark,
  }
  const attached = await context.call('/auth/v1/receipt', { receipts: [{ store: 'apple', transactionId: '1001' }] }, signed.pass)
  assert.equal(attached.body.receiptResults[0].result, 'attached')
  const result = await entitlement(context, attached.body.pass)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { entitled: true, source: 'apple', validUntil: new Date(expiresDate).toISOString() })
})

test('a Google subscription is entitled with source google', async () => {
  const context = await setup()
  const signed = await context.signIn('google', 'g-1')
  context.kit.google.subscriptions.gt = {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: signed.purchaseMark },
    lineItems: [{ productId: product.productId, expiryTime: new Date(Date.now() + 86400_000).toISOString() }],
  }
  const attached = await context.call('/auth/v1/receipt', { receipts: [{ store: 'google', productId: product.productId, purchaseToken: 'gt' }] }, signed.pass)
  assert.equal(attached.body.receiptResults[0].result, 'attached')
  const result = await entitlement(context, attached.body.pass)
  assert.equal(result.body.entitled, true)
  assert.equal(result.body.source, 'google')
})

test('the entitlement answer names no account, pass or store identifier', async () => {
  const context = await setup()
  const signed = await context.signIn()
  const body = (await entitlement(context, signed.pass)).body
  assert.deepEqual(Object.keys(body), ['entitled'])
  assert.ok(!JSON.stringify(body).includes(signed.k))
})

test('a bad, signed-out or refused pass is 401 with the library code', async () => {
  const context = await setup()
  assert.deepEqual((await entitlement(context, 'not-a-pass')).body, { error: 'pass_invalid' })
  assert.equal((await entitlement(context, 'not-a-pass')).status, 401)
  assert.equal((await context.call('/v1/entitlement')).status, 401)
  const signed = await context.signIn()
  await context.call('/auth/v1/signout', {}, signed.pass)
  const refused = await entitlement(context, signed.pass)
  assert.equal(refused.status, 401)
  assert.equal(refused.body.error, 'pass_refused')
})

test('QR handoff: a server takes a handoff pass the phone approved, and that pass is entitled; stopping it ends it', async () => {
  const context = await setup()
  const phone = await context.signIn()
  const expiresDate = Date.now() + 86400_000
  context.kit.apple.transactions['1002'] = {
    transactionId: '1002', originalTransactionId: '1002', productId: product.productId, bundleId: product.bundleId,
    type: 'Auto-Renewable Subscription', expiresDate, appAccountToken: phone.purchaseMark,
  }
  const store = (await context.call('/auth/v1/receipt', { receipts: [{ store: 'apple', transactionId: '1002' }] }, phone.pass)).body.pass
  const started = (await context.call('/auth/v1/handoff/start', { deviceLabel: 'BellTeam server' })).body
  const approve = await context.call('/auth/v1/handoff/approve', { slotId: started.slotId }, store)
  assert.equal(approve.status, 200)
  assert.equal(approve.body.checkNumber, started.checkNumber)
  const confirm = await context.call('/auth/v1/handoff/confirm', { slotId: started.slotId }, store)
  assert.equal(confirm.status, 200)
  const taken = (await context.call('/auth/v1/handoff/take', { slotId: started.slotId, takeSecret: started.takeSecret })).body
  assert.equal(taken.status, 'ready')
  assert.equal((await entitlement(context, taken.pass)).body.entitled, true)
  assert.equal((await context.call('/auth/v1/refuse', { passId: confirm.body.issuedPassId }, store)).status, 200)
  assert.equal((await entitlement(context, taken.pass)).body.error, 'pass_refused')
})

test('a handoff pass cannot approve, attach receipts or refuse', async () => {
  const context = await setup()
  const phone = await context.signIn()
  const started = (await context.call('/auth/v1/handoff/start', { deviceLabel: 'BellTeam server' })).body
  const expiresDate = Date.now() + 86400_000
  context.kit.apple.transactions['1003'] = {
    transactionId: '1003', originalTransactionId: '1003', productId: product.productId, bundleId: product.bundleId,
    type: 'Auto-Renewable Subscription', expiresDate, appAccountToken: phone.purchaseMark,
  }
  const store = (await context.call('/auth/v1/receipt', { receipts: [{ store: 'apple', transactionId: '1003' }] }, phone.pass)).body.pass
  await context.call('/auth/v1/handoff/approve', { slotId: started.slotId }, store)
  await context.call('/auth/v1/handoff/confirm', { slotId: started.slotId }, store)
  const handoff = (await context.call('/auth/v1/handoff/take', { slotId: started.slotId, takeSecret: started.takeSecret })).body.pass
  assert.equal((await context.call('/auth/v1/receipt', { receipts: [] }, handoff)).body.error, 'not_store_device')
  assert.equal((await context.call('/auth/v1/handoff/start', { deviceLabel: 'x' }, handoff)).status, 200)
})

test('the anonymous writers are limited per caller, not for everyone', async () => {
  const context = await setup()
  const first = { 'cf-connecting-ip': '192.0.2.1' }
  for (let index = 0; index < 30; index++) assert.equal((await context.call('/auth/v1/handoff/start', { deviceLabel: 'a' }, undefined, first)).status, 200)
  const limited = await context.call('/auth/v1/handoff/start', { deviceLabel: 'a' }, undefined, first)
  assert.equal(limited.status, 429)
  assert.equal(limited.body.error, 'rate_limited')
  assert.equal((await context.call('/auth/v1/handoff/start', { deviceLabel: 'a' }, undefined, { 'cf-connecting-ip': '192.0.2.2' })).status, 200)
  assert.equal((await context.call('/auth/v1/signin/nonce', {}, undefined, first)).status, 200, 'another route has its own count')
})

test('a full storage answers rate_limited (the library maps StorageFull)', async () => {
  const context = await setup({ max: 3 })
  const statuses = []
  for (let index = 0; index < 5; index++) statuses.push((await context.call('/auth/v1/signin/nonce')).status)
  assert.deepEqual(statuses, [200, 200, 200, 429, 429])
})

test('SQL storage: values expire, expired rows are swept to make room, delete works', () => {
  let clock = 1_000_000
  const storage = createSqlStorage(sqlOf(new DatabaseSync(':memory:')), { now: () => clock, max: 2 })
  assert.equal(storage.put('a', '1', 1000), 'ok')
  assert.equal(storage.put('b', '2', 5000), 'ok')
  assert.equal(storage.put('c', '3', 5000), 'full')
  assert.equal(storage.get('a'), '1')
  clock += 1500
  assert.equal(storage.get('a'), undefined, 'expired')
  assert.equal(storage.put('c', '3', 5000), 'ok', 'the expired row was swept')
  storage.delete('b')
  assert.equal(storage.get('b'), undefined)
  assert.equal(storage.put('a', '9', 1000), 'ok')
  assert.equal(storage.get('a'), '9')
})
