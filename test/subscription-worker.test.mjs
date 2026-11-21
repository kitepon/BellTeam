import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createTestKit } from '@kitepon/login-billing/testing'
import { MemoryStorage } from '@kitepon/login-billing/server'
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { createLoginBillingWorker } from '../services/subscriptions/worker.mjs'

// These tests cover how the Worker mounts the library (login-billing 0.10.0): configuration, routing, billing mode, the callback GET and
// the limiter. The library's own behaviour (passes, handoff, proof codes, tickets, the Durable Object storage) is the library's suite.
const b64 = byte => Buffer.alloc(32, byte).toString('base64url')
const base = { LB_KKEY: b64(7), LB_PASS_KEY_CURRENT: b64(9), LB_PASS_KEY_CURRENT_ID: 'k1', APPLE_SIGNIN_AUDIENCES: product.bundleId, GOOGLE_SIGNIN_AUDIENCES: 'google-client' }
const ORIGIN = 'https://worker.test'
const sha256 = value => createHash('sha256').update(value).digest('hex')

async function setup(overrides = {}, { configured = true } = {}) {
  const kit = await createTestKit()
  const { google, apple } = kit.webClients()
  const env = {
    ...base, LB_PUBLIC_ORIGIN: ORIGIN,
    WEBSIGNIN_GOOGLE_CLIENT_ID: google.clientId, WEBSIGNIN_GOOGLE_CLIENT_SECRET: google.clientSecret,
    WEBSIGNIN_APPLE_SERVICES_ID: apple.servicesId, WEBSIGNIN_APPLE_TEAM_ID: apple.teamId, WEBSIGNIN_APPLE_KEY_ID: apple.keyId, WEBSIGNIN_APPLE_PRIVATE_KEY: apple.privateKey,
    ...overrides,
  }
  const storage = new MemoryStorage()
  const worker = createLoginBillingWorker({
    storage: () => storage,
    extra: { fetch: kit.fetch, stores: { apple: kit.appleStore(product.bundleId), google: kit.googleStore(product.bundleId) } },
  })
  const send = (path, { method = 'POST', body = {}, pass, headers = {} } = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
    method, redirect: 'manual', ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(pass ? { authorization: `Bearer ${pass}` } : {}), ...headers },
  }), configured ? env : {})
  const call = async (path, options) => { const response = await send(path, options); return { status: response.status, body: await response.json(), headers: response.headers } }
  return { kit, call, send, env }
}

test('an unconfigured Worker answers 503 and opens no free path', async () => {
  const { call } = await setup({}, { configured: false })
  assert.deepEqual((await call('/auth/v1/signin/nonce')).body, { error: 'not_configured' })
  assert.equal((await call('/auth/v1/signin/nonce')).status, 503)
})

test('only the library prefix is served; the old verify, Stripe and entitlement routes are gone', async () => {
  const { send } = await setup()
  for (const path of ['/v1/subscriptions/verify', '/v1/subscriptions/stripe/checkout', '/v1/subscriptions/stripe/portal', '/v1/entitlement']) {
    assert.equal((await send(path)).status, 404, path)
  }
  assert.equal((await send('/auth/v1/signin/nonce', { method: 'GET' })).status, 405)
  assert.equal((await send('/auth/v1/websignin/callback', { method: 'POST' })).status, 405, 'the callback is a GET')
})

test('billing is "store" unless the test Worker sets LB_BILLING=off: a signed-in pass without a purchase has no contract', async () => {
  for (const [billing, entitled] of [[undefined, 0], ['off', 1]]) {
    const { kit, call } = await setup(billing ? { LB_BILLING: billing } : {})
    const { body: { nonce } } = await call('/auth/v1/signin/nonce')
    const idToken = await kit.appleIdToken({ aud: product.bundleId, sub: 'subject-1', nonce })
    const signed = await call('/auth/v1/signin', { body: { provider: 'apple', idToken, nonce, deviceLabel: 'iPhone' } })
    assert.equal(signed.status, 200)
    assert.equal(signed.body.entitlements.length, entitled, `billing ${billing ?? 'store'}`)
  }
})

test('web sign-in: start, the provider callback (GET, 302 to the stored return, no referrer), take', async () => {
  const { kit, call, send } = await setup({ LB_BILLING: 'off' })
  const secret = 'device-secret-0123456789abcdef'
  const ret = 'http://127.0.0.1:51234/abcdefghijklmnopqrstuv'
  const started = await call('/auth/v1/websignin/start', { body: { provider: 'google', return: ret, secretHash: sha256(secret) } })
  assert.equal(started.status, 200)
  assert.ok(started.body.providerUrl.startsWith('https://accounts.google.com/'))
  const callback = await kit.signInAtProvider(started.body.providerUrl, { sub: 'g-subject' })
  const redirected = await send(new URL(callback).pathname + new URL(callback).search, { method: 'GET' })
  assert.equal(redirected.status, 302)
  assert.equal(redirected.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(redirected.headers.get('cache-control'), 'no-store')
  const location = new URL(redirected.headers.get('location'))
  assert.equal(`${location.origin}${location.pathname}`, ret)
  const taken = await call('/auth/v1/websignin/take', { body: { loginId: started.body.loginId, secret, resultCode: location.searchParams.get('result') } })
  assert.equal(taken.status, 200)
  assert.ok(taken.body.pass)
  const again = await call('/auth/v1/websignin/take', { body: { loginId: started.body.loginId, secret, resultCode: location.searchParams.get('result') } })
  assert.equal(again.body.error, 'login_gone', 'a result is spent once')
})

test('the return is checked strictly: another host, a custom scheme not on the list and a path with no random segment are refused', async () => {
  const { call } = await setup()
  const secretHash = sha256('device-secret-0123456789abcdef')
  for (const ret of ['http://localhost:5000/abcdefghijklmnopqrstuv', 'https://evil.example/', 'myapp://cb', 'http://127.0.0.1:5000/']) {
    const result = await call('/auth/v1/websignin/start', { body: { provider: 'google', return: ret, secretHash } })
    assert.equal(result.status, 400, ret)
    assert.equal(result.body.error, 'return_refused')
  }
  const listed = await setup({ LB_RETURN_SCHEMES: 'dev.kitepon.bellbot' })
  assert.equal((await listed.call('/auth/v1/websignin/start', { body: { provider: 'google', return: 'dev.kitepon.bellbot://cb', secretHash } })).status, 200)
})

test('without a web client or a public origin the provider is unknown (web sign-in off)', async () => {
  const { call } = await setup({ WEBSIGNIN_GOOGLE_CLIENT_SECRET: undefined, WEBSIGNIN_APPLE_PRIVATE_KEY: undefined })
  const result = await call('/auth/v1/websignin/start', { body: { provider: 'google', return: 'http://127.0.0.1:5000/abcdefghijklmnopqrstuv', secretHash: sha256('device-secret-0123456789abcdef') } })
  assert.equal(result.status, 400)
})

test('the library limits the anonymous paths per caller (CF-Connecting-IP), not for everyone; the Worker adds no limiter of its own', async () => {
  const { call } = await setup()
  const first = { 'cf-connecting-ip': '192.0.2.1' }
  for (let index = 0; index < 10; index++) assert.equal((await call('/auth/v1/handoff/start', { body: { deviceLabel: 'a' }, headers: first })).status, 200)
  const limited = await call('/auth/v1/handoff/start', { body: { deviceLabel: 'a' }, headers: first })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.error, 'rate_limited')
  assert.equal((await call('/auth/v1/handoff/start', { body: { deviceLabel: 'a' }, headers: { 'cf-connecting-ip': '192.0.2.2' } })).status, 200)
  assert.equal((await call('/auth/v1/signin/nonce', { headers: first })).status, 200, 'another path has its own count')
})
