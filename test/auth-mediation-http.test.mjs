import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest, validateAuthMediationResult } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const SECRET = 'sk_live_abcdef123456', UNIT = '/home/kite/soda', CWD = '/srv/bellteam/bots/bot-a'
const itemJson = fields => JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ label, value })) })
const ITEM = { http_base: 'https://api.example.com/v1', http_auth: 'bearer', http_secret: SECRET, http_methods: 'GET POST' }

function setup({ item = ITEM, grants = ['http stripe'], answer } = {}) {
  const seen = [], lines = []
  const fetchImpl = async (url, options) => { seen.push({ url: String(url), ...options }); return answer ? answer(url, options) : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', etag: 'W/1' } }) }
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } }, bots: { 'bot-a': { grants: grants.map(command => ({ command })) } } }, read: async () => structuredClone(store.policy) }
  const items = createItemCache({ runOp: async args => { if (args[2] !== 'http stripe') throw new Error('x'); return itemJson(item) } })
  const core = createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({ 'bot-a': CWD }), fetchImpl })
  return { core, seen, lines }
}
const ask = (t, extra = {}) => t.core.http({ name: 'stripe', method: 'GET', path: '/v1/charges?limit=3', via: 'host-socket', cwd: UNIT, unit: UNIT, ...extra })
const text = r => Buffer.from(r.body, 'base64').toString()

test('http: the module adds the credential, the caller gets only the response (status, a few headers, body)', async () => {
  const t = setup(); const r = await ask(t, { headers: { Authorization: 'Bearer stolen', Accept: 'application/json', Cookie: 'x=y', 'Stripe-Version': '2024-01-01' } })
  assert.equal(r.outcome, 'granted'); assert.equal(r.status, 200); assert.equal(text(r), '{"ok":true}')
  assert.deepEqual(r.headers, { 'content-type': 'application/json', etag: 'W/1' }) // no set-cookie
  assert.equal(t.seen[0].url, 'https://api.example.com/v1/charges?limit=3'); assert.equal(t.seen[0].redirect, 'manual')
  assert.deepEqual(t.seen[0].headers, { accept: 'application/json', 'stripe-version': '2024-01-01', authorization: 'Bearer ' + SECRET })
})

test('http: credential styles basic, header and query; a caller cannot set the credential parameter itself', async () => {
  const basic = setup({ item: { ...ITEM, http_auth: 'basic', http_secret: 'user:pw' } }); await ask(basic)
  assert.equal(basic.seen[0].headers.authorization, 'Basic ' + Buffer.from('user:pw').toString('base64'))
  const header = setup({ item: { ...ITEM, http_auth: 'header:X-Api-Key' } }); await ask(header, { headers: { 'x-api-key': 'mine' } })
  assert.equal(header.seen[0].headers['x-api-key'], SECRET)
  const query = setup({ item: { ...ITEM, http_auth: 'query:key' } }); await ask(query, { path: '/v1/x?key=mine&a=1' })
  assert.equal(new URL(query.seen[0].url).searchParams.get('key'), SECRET); assert.equal(new URL(query.seen[0].url).searchParams.get('a'), '1')
  assert.equal((await ask(setup({ item: { ...ITEM, http_auth: 'none' } }))).outcome, 'error')
})

test('http: the path cannot leave the item\'s origin and prefix; the method must be allowed; redirects are not followed; bodies are capped', async () => {
  const t = setup()
  for (const path of ['//evil.com/x', '/v1/../admin', '/other', '/v2/x', '/v1x/y', 'v1/x', '/v1/a b', '/v1\\x'])
    assert.equal((await ask(t, { path })).outcome, 'error', path)
  assert.equal(t.seen.length, 0)
  assert.equal((await ask(t, { method: 'DELETE' })).outcome, 'error'); assert.equal((await ask(t, { method: 'GET', body: Buffer.from('x').toString('base64') })).outcome, 'error')
  assert.equal((await ask(t, { method: 'POST', body: Buffer.alloc(40000).toString('base64') })).outcome, 'error')
  assert.equal((await ask(t, { method: 'POST', body: Buffer.from('a=1').toString('base64') })).outcome, 'granted'); assert.equal(String(t.seen[0].body), 'a=1')
  const redirect = setup({ answer: () => new Response('', { status: 302, headers: { location: 'https://evil.com/' } }) }); const r = await ask(redirect)
  assert.equal(r.status, 302); assert.equal(r.headers.location, 'https://evil.com/'); assert.equal(redirect.seen.length, 1)
  for (const base of ['http://api.example.com', 'https://u:p@api.example.com', 'nope', undefined]) assert.equal((await ask(setup({ item: { ...ITEM, http_base: base } }))).outcome, 'error')
  assert.equal((await ask(setup({ item: { ...ITEM, http_secret: undefined } }))).outcome, 'error')
})

test('http: a response is cut at 256 KiB and any copy of the credential in it is replaced; the audit never holds headers, bodies or the credential', async () => {
  const big = setup({ answer: () => new Response('a'.repeat(300000)) }); const r = await ask(big)
  assert.equal(r.truncated, true); assert.equal(Buffer.from(r.body, 'base64').length, 262144)
  const echo = setup({ answer: () => new Response('your key is ' + SECRET + '!') }); const e = await ask(echo, { path: '/v1/echo?token=1&b=2' })
  assert.equal(text(e), 'your key is [redacted]!')
  await new Promise(r => setImmediate(r)); const log = JSON.stringify(echo.lines)
  assert.ok(!log.includes(SECRET)); assert.equal(echo.lines[0].path, '/v1/echo'); assert.equal(echo.lines[0].item, 'http stripe'); assert.equal(echo.lines[0].status, 200)
  const down = setup({ answer: () => { throw new Error('boom ' + SECRET) } }); const d = await ask(down)
  assert.deepEqual(d, { outcome: 'error', error: 'The request failed.' })
})

test('http: same grants as exec: no grant, stopped or an unknown caller is refused before any item read; a Bot caller is found by its folder', async () => {
  const none = setup({ grants: [] }); assert.equal((await ask(none)).outcome, 'denied'); assert.equal(none.seen.length, 0)
  const bot = setup(); assert.equal((await bot.core.http({ name: 'stripe', method: 'GET', path: '/v1/x', via: 'container-socket', cwd: CWD })).outcome, 'granted')
  assert.equal((await bot.core.http({ name: 'stripe', method: 'GET', path: '/v1/x', via: 'container-socket', cwd: '/tmp' })).outcome, 'unknown-caller')
  assert.equal((await ask(setup(), { name: 'other', unit: UNIT })).outcome, 'denied')
  const sock = setup(); assert.equal((await sock.core.http({ name: 'stripe', method: 'GET', path: '/v1/x', via: 'caller-socket', unit: UNIT })).outcome, 'granted') // a caller socket: the unit is the socket path
})

test('relay: http reaches the facade with who is calling named by the transport; the client line cannot name it', async () => {
  const seen = []; const facade = { http: async p => (seen.push(p), { outcome: 'granted', status: 200 }) }
  const line = { op: 'http', name: 'stripe', method: 'GET', path: '/v1/x', headers: { accept: 'a' }, body: 'AA==', timeout_sec: 5, unit: '/claimed', cwd: '/claimed' }
  const base = { name: 'stripe', method: 'GET', path: '/v1/x', headers: { accept: 'a' }, body: 'AA==', timeoutSec: 5 }
  await relayAnswer({ via: 'container-socket', peer: { uid: 1000, cwd: CWD }, request: line }, facade)
  await relayAnswer({ via: 'host-socket', peer: null, request: line }, facade)
  await relayAnswer({ via: 'caller-socket', unit: '/srv/x/callers/mm/mm.sock', peer: null, request: line }, facade)
  assert.deepEqual(seen, [{ ...base, via: 'container-socket', cwd: CWD }, { ...base, via: 'host-socket', cwd: '/claimed', unit: '/claimed' }, { ...base, via: 'caller-socket', unit: '/srv/x/callers/mm/mm.sock' }])
  assert.deepEqual(await relayAnswer({ via: 'host-socket', peer: null, request: { ...line, cwd: undefined } }, facade), { outcome: 'error', error: 'Bad request.' })
})

test('protocol: http takes exactly its fields; a result carries status, headers, body and truncated only', () => {
  const ctx = { generation: 'g1' }, ok = { name: 'stripe', method: 'POST', path: '/v1/x', via: 'host-socket', cwd: UNIT, unit: UNIT }
  assert.doesNotThrow(() => validateAuthMediationRequest('http', { ...ok, headers: { accept: 'a' }, body: 'AA==', timeoutSec: 5 }, ctx))
  assert.doesNotThrow(() => validateAuthMediationRequest('http', { name: 'a', method: 'GET', path: '/x', via: 'caller-socket', unit: UNIT }, ctx))
  for (const bad of [{ ...ok, method: 'TRACE' }, { ...ok, path: 'x' }, { ...ok, via: 'mcp' }, { ...ok, timeoutSec: 61 }, { ...ok, body: 'not base64!' }, { ...ok, headers: { a: 1 } }, { ...ok, extra: 1 }, { ...ok, cwd: undefined, via: 'container-socket' }, { name: 'a', method: 'GET', path: '/x', via: 'caller-socket' }])
    assert.throws(() => validateAuthMediationRequest('http', bad, ctx), /AUTH_MEDIATION_INVALID/u)
  assert.doesNotThrow(() => validateAuthMediationResult('http', { outcome: 'granted', status: 200, headers: { 'content-type': 'x' }, body: 'AA==', truncated: false }))
  assert.throws(() => validateAuthMediationResult('http', { outcome: 'granted', status: 99 }))
})
