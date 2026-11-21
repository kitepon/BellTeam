import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogin, loginNeeded, loginView, readSession } from '../web/login-screen.js'

const err = status => Object.assign(new Error('HTTP'), { status })

test('a485: a server without `login` in /api/session keeps today\'s path; one that states it and is unauthenticated shows the code screen', () => {
  assert.equal(loginNeeded({ authenticated: false, authMode: 'cloudflare' }), false)
  assert.equal(loginNeeded({ authenticated: false, authMode: 'local', login: null }), false)
  assert.equal(loginNeeded({ authenticated: true, authMode: 'local', login: { capability: true, bound: true, enforced: true } }), false)
  assert.equal(loginNeeded({ authenticated: false, authMode: 'local', login: { capability: true, bound: true, enforced: true } }), true)
})

test('a485: the screen shows the code and check number exactly as given (leading zeros kept), and a QR only as an img data URL made from the SVG the server sends', () => {
  const phone = loginView({ phase: 'phone', code: 'ABCD-EFGH-JKMNP', check: '042', expiresAt: '2026-11-21T12:00:00.000Z' })
  assert.equal(phone.code, 'ABCD-EFGH-JKMNP'); assert.equal(phone.check, '042'); assert.equal(phone.cancel, true); assert.match(phone.until, /まで有効/u)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
  assert.equal(loginView({ phase: 'phone', code: 'C', check: '042', qr: svg }).qr, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  assert.equal(loginView({ phase: 'phone', code: 'C', check: '042', qr: '<?xml version="1.0"?>' + svg }).qr.startsWith('data:image/svg+xml'), true)
  for (const bad of ['<div onclick="x"></div>', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, 'x'.repeat(200_000) + '<svg>']) assert.equal(loginView({ phase: 'phone', code: 'C', check: '042', qr: bad }).qr, '')
  assert.equal(loginView({ phase: 'second_hand' }).code, '')
  assert.equal(loginView({ phase: 'ended', message: 'x' }).again, true)
})

// Runs createLogin with a scripted API; `wait` resolves at once so the loop is driven by the script.
function run(script, extra = {}) {
  const calls = [], states = []
  let approved = 0
  const api = async (path, init) => {
    calls.push([init?.method ?? 'GET', path, init?.body])
    const next = script.shift()
    if (next instanceof Error) throw next
    return next
  }
  const login = createLogin({ api, show: state => states.push(state), onApproved: () => { approved++ }, wait: async () => {}, ...extra })
  return { login, calls, states, approved: () => approved }
}

test('a485: start (kind web) -> second hand -> phone code -> approved boots the app again, polling the same login id', async () => {
  const t = run([{ loginId: 'L1', status: 'waiting_second_hand' }, { status: 'waiting_phone', phone: { shortCode: 'ABCD-EFGH-JKMNP', checkNumber: '042', qr: 'bt://x', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }, expiresAt: '2026-11-21T12:00:00.000Z', pollAfterMs: 3000 }, { status: 'approved' }])
  await t.login.start()
  assert.deepEqual(t.calls, [['POST', '/api/login/start', '{"kind":"web","carrier":"cookie"}'], ['GET', '/api/login/L1', undefined], ['GET', '/api/login/L1', undefined]])
  assert.deepEqual(t.states.map(state => state.phase), ['starting', 'second_hand', 'phone'])
  assert.equal(t.approved(), 1)
})

test('a485: a transient poll failure keeps waiting; 404 and refused/expired end the login with a plain sentence', async () => {
  let t = run([{ loginId: 'L1', status: 'waiting_phone', phone: { shortCode: 'C', checkNumber: '1' } }, err(503), { status: 'delivered' }])
  await t.login.start(); assert.equal(t.approved(), 1)
  t = run([{ loginId: 'L1', status: 'waiting_phone', phone: { shortCode: 'C', checkNumber: '1' } }, err(404)])
  await t.login.start(); assert.equal(t.approved(), 0); assert.match(t.states.at(-1).message, /時間が切れました/u)
  t = run([{ loginId: 'L1', status: 'refused', reason: 'not_owner_account' }])
  await t.login.start(); assert.match(t.states.at(-1).message, /オーナーのアカウントではない/u)
  t = run([err(429)])
  await t.login.start(); assert.match(t.states.at(-1).message, /少し待って/u); assert.equal(t.approved(), 0)
  t = run([Object.assign(err(503), { code: 'LOGIN_OPERATOR_UNREACHABLE' })])
  await t.login.start(); assert.match(t.states.at(-1).message, /コンソール/u)
  for (const [reason, text] of [['phone_denied', /携帯で拒否/u], ['second_hand_denied', /許可されませんでした/u]]) {
    t = run([{ loginId: 'L1', status: 'refused', reason }]); await t.login.start(); assert.match(t.states.at(-1).message, text)
  }
  t = run([{ loginId: 'L1', status: 'waiting_second_hand' }, { status: 'cancelled' }]); await t.login.start(); assert.match(t.states.at(-1).message, /取り消しました/u)
})

test('a485: 「やめる」 stops the loop and cancels that login id; the console code boots on success and explains 400/429', async () => {
  const t = run([{ loginId: 'L9', status: 'waiting_phone', phone: { shortCode: 'C', checkNumber: '1' } }, {}])
  let release; const gate = new Promise(resolve => { release = resolve })
  const slow = createLogin({ api: async (path, init) => { t.calls.push([init?.method ?? 'GET', path]); return path === '/api/login/start' ? { loginId: 'L9', status: 'waiting_phone', phone: { shortCode: 'C', checkNumber: '1' } } : {} },
    show: state => t.states.push(state), onApproved: () => {}, wait: () => gate })
  const started = slow.start()
  await Promise.resolve(); await Promise.resolve()
  await slow.cancel()
  release(); await started
  assert.deepEqual(t.calls.filter(call => call[1].includes('cancel')), [['POST', '/api/login/L9/cancel']])
  assert.equal(t.states.at(-1).phase, 'ended')
  assert.equal(t.calls.filter(call => call[0] === 'GET').length, 0)

  const c = run([{}], {})
  assert.equal(await c.login.useConsoleCode('ABCD-EFGH-JKMNP'), ''); assert.equal(c.approved(), 1)
  assert.deepEqual(c.calls, [['POST', '/api/login/console', '{"code":"ABCD-EFGH-JKMNP","kind":"web","carrier":"cookie"}']])
  assert.match(await run([err(403)]).login.useConsoleCode('x'), /コードが違う/u)
  assert.match(await run([err(429)]).login.useConsoleCode('x'), /しばらくしてから/u)
})

test('a485: a 503 SESSION_STORE_UNAVAILABLE probe is waited out with 1, 2, 4 ... 30 s backoff; a 401 or another error is not retried', async () => {
  const waits = []; let waiting = 0
  const unavailable = Object.assign(new Error('x'), { status: 503, code: 'SESSION_STORE_UNAVAILABLE' })
  const script = [unavailable, unavailable, unavailable, unavailable, unavailable, unavailable, unavailable, { authenticated: true }]
  const session = await readSession(async () => { const next = script.shift(); if (next instanceof Error) throw next; return next }, { onWaiting: () => waiting++, wait: async ms => { waits.push(ms) } })
  assert.deepEqual(session, { authenticated: true }); assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]); assert.equal(waiting, 7)
  await assert.rejects(readSession(async () => { throw err(401) }, { wait: async () => { throw new Error('no wait') } }), { status: 401 })
})
