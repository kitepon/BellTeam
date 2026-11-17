import test from 'node:test'
import assert from 'node:assert/strict'
import { createBillingSettings } from '../web/billing.js'
import { Element } from './helpers/editor-dom.mjs'

const sub = (over = {}) => ({ entitled: false, accessMode: 'subscription', state: 'not_purchased', isTrial: false, validUntil: null, autoRenewing: false, ...over })
const paid = sub({ entitled: true, state: 'active', isTrial: true, validUntil: '2026-12-17T03:00:00.000Z', autoRenewing: true })
const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code })

function fixture({ current = sub(), checkout, verify = paid, location = { search: '', pathname: '/' } } = {}) {
  const root = new Element(), node = key => root.querySelector(`[data-billing-${key}]`)
  const calls = [], store = new Map(), tab = { location: {}, closed: false, close() { this.closed = true } }
  const browser = { location, open: () => tab, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }, history: { replaceState() {} } }
  const api = async (path, options) => {
    calls.push([path, options?.body ? JSON.parse(options.body) : null])
    if (path === '/api/subscription') return { subscription: current }
    if (path === '/api/subscription/stripe/checkout') { if (checkout instanceof Error) throw checkout; return checkout ?? { url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' } }
    if (path === '/api/subscription/stripe/verify') return { subscription: verify }
    if (path === '/api/subscription/refresh') return { subscription: current }
    throw Error('unexpected ' + path)
  }
  const view = createBillingSettings(root, api, browser)
  return { node, calls, store, tab, view, click: name => node(name).handlers.click() }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('opening reads the plan and never creates a checkout session', async () => {
  const f = fixture(); await f.view.open()
  assert.deepEqual(f.calls, [['/api/subscription', null]])
  assert.equal(f.node('start').hidden, false); assert.equal(f.node('caption').hidden, false); assert.equal(f.node('confirm').hidden, true)
})

test('start opens the checkout once, keeps the session, then 購入を確認 verifies it and shows the plan', async () => {
  const f = fixture(); await f.view.open()
  f.click('start'); await settle()
  assert.equal(f.calls.filter(c => c[0].endsWith('/checkout')).length, 1)
  assert.equal(f.tab.location.href, 'https://checkout.stripe.com/c/pay/cs_test_1')
  assert.equal(f.store.get('bellteam.stripe-session'), 'cs_test_1'); assert.equal(f.node('confirm').hidden, false)
  f.click('confirm'); await settle()
  assert.deepEqual(f.calls.at(-1), ['/api/subscription/stripe/verify', { stripeSessionId: 'cs_test_1' }])
  assert.equal(f.node('start').hidden, true); assert.equal(f.node('confirm').hidden, true); assert.equal(f.store.size, 0)
  assert.match(f.node('state').textContent, /有効期限：.*無料期間中です。/u)
})

test('the entry hides only for Stripe dark (503 NOT_CONFIGURED) and developer servers (409); other failures keep it', async () => {
  for (const code of ['SUBSCRIPTION_NOT_CONFIGURED', 'SUBSCRIPTION_NOT_REQUIRED']) {
    const f = fixture({ checkout: fail(code === 'SUBSCRIPTION_NOT_CONFIGURED' ? 503 : 409, code) }); await f.view.open()
    f.click('start'); await settle()
    assert.equal(f.node('start').hidden, true, code); assert.equal(f.tab.closed, true); assert.equal(f.store.size, 0)
  }
  const down = fixture({ checkout: fail(503, 'SUBSCRIPTION_CONNECTION_FAILED', '購読確認サービスへ接続できません。') }); await down.view.open()
  down.click('start'); await settle()
  assert.equal(down.node('start').hidden, false); assert.equal(down.node('notice').textContent, '購読確認サービスへ接続できません。')
})

test('hidden when already entitled or on a developer server; an https-only checkout URL is required', async () => {
  const on = fixture({ current: paid }); await on.view.open(); assert.equal(on.node('start').hidden, true)
  assert.equal(on.node('state').textContent.includes('自動更新は停止'), false)
  const dev = fixture({ current: sub({ accessMode: 'developer' }) }); await dev.view.open()
  assert.equal(dev.node('start').hidden, true); assert.match(dev.node('state').textContent, /購入は不要/u)
  const bad = fixture({ checkout: { url: 'http://evil.example/', sessionId: 'cs_test_1' } }); await bad.view.open()
  bad.click('start'); await settle()
  assert.equal(bad.tab.location.href, undefined); assert.equal(bad.store.size, 0)
})

test('returning with ?session_id verifies once on open and 再確認 refreshes', async () => {
  const f = fixture({ location: { search: '?session_id=cs_live_9', pathname: '/' } }); await f.view.open()
  assert.deepEqual(f.calls.map(c => c[0]), ['/api/subscription', '/api/subscription/stripe/verify'])
  await f.view.recheck(); assert.equal(f.calls.at(-1)[0], '/api/subscription/refresh')
})
