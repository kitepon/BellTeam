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
  return { core, seen, lines, store }
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
  assert.equal((await ask(setup({ item: { ...ITEM, http_auth: 'bogus' } }))).outcome, 'error')
})

test('http: the path cannot leave the item\'s origin and prefix; the method must be allowed; redirects are not followed; bodies are capped', async () => {
  const t = setup()
  for (const path of ['//evil.com/x', '/v1/../admin', '/other', '/v2/x', '/v1x/y', 'v1/x', '/v1/a b', '/v1\\x'])
    assert.equal((await ask(t, { path })).outcome, 'error', path)
  assert.equal(t.seen.length, 0)
  assert.equal((await ask(t, { method: 'DELETE' })).outcome, 'error'); assert.equal((await ask(t, { method: 'GET', body: Buffer.from('x').toString('base64') })).outcome, 'error')
  assert.equal((await ask(t, { method: 'POST', body: Buffer.alloc(9 * 1048576 + 1).toString('base64') })).outcome, 'error')
  assert.equal((await ask(t, { method: 'POST', body: Buffer.from('a=1').toString('base64') })).outcome, 'granted'); assert.equal(String(t.seen[0].body), 'a=1')
  const redirect = setup({ answer: () => new Response('', { status: 302, headers: { location: 'https://evil.com/' } }) }); const r = await ask(redirect)
  assert.equal(r.status, 302); assert.equal(r.headers.location, 'https://evil.com/'); assert.equal(redirect.seen.length, 1)
  for (const base of ['http://api.example.com', 'https://u:p@api.example.com', 'nope', undefined]) assert.equal((await ask(setup({ item: { ...ITEM, http_base: base } }))).outcome, 'error')
  assert.equal((await ask(setup({ item: { ...ITEM, http_secret: undefined } }))).outcome, 'error')
})

test('http: the response never shows the credential: not in the body (raw or base64) nor in a Location header; only request-id style x- headers pass', async () => {
  const basic = setup({ item: { ...ITEM, http_auth: 'basic', http_secret: 'user:password1' }, answer: () => new Response('b64 ' + Buffer.from('user:password1').toString('base64') + ' raw user:password1', { headers: { location: 'https://api.example.com/v1/x?k=user:password1' } }) })
  const r = await ask(basic, { headers: { 'x-http-method-override': 'DELETE', 'x-request-id': 'r1' } })
  assert.equal(text(r), 'b64 [redacted] raw [redacted]'); assert.equal(r.headers.location, 'https://api.example.com/v1/x?k=[redacted]')
  assert.deepEqual(Object.keys(basic.seen[0].headers).sort(), ['authorization', 'x-request-id'])
})

test('http: a path that hides a separator is refused (%2f %5c %00 %2e, any case, backslash) before any call, in the query it is allowed', async () => {
  const t = setup({ item: { ...ITEM, http_base: 'https://api.example.com/v1', http_passthrough_paths: '/v1/token' } })
  for (const path of ['/v1/items%2f..%2ftoken/x', '/v1/items%2F..%2Ftoken/x', '/v1/a%5cb', '/v1/a%5Cb', '/v1/a%00b', '/v1/%2e%2e/items', '/v1/%2E./items', '/v1/a%2e%2e/b', '/v1/token%3fx', '/v1/token%3Fx', '/v1/token%23x', '/v1\\x'])
    assert.equal((await ask(t, { path })).outcome, 'error', path)
  assert.equal(t.seen.length, 0)
  assert.equal((await ask(t, { path: '/v1/items?next=a%2fb&x=%2e' })).outcome, 'granted') // the query is the server's data, not a route
  assert.equal((await ask(t, { path: '/v1/items/a%20b' })).outcome, 'granted')
})

test('http: a response is cut at 11 MiB and any copy of the credential in it is replaced; the audit never holds headers, bodies or the credential', async () => {
  const big = setup({ answer: () => new Response('a'.repeat(12 * 1048576)) }); const r = await ask(big)
  assert.equal(r.truncated, true); assert.equal(Buffer.from(r.body, 'base64').length, 11 << 20)
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

test('http plain: http:// only with http_allow_plain=1 AND a private IPv4 literal host; never a name, a public address or the flag missing', async () => {
  const plain = { ...ITEM, http_base: 'http://192.168.1.2:39310/ledger', http_allow_plain: '1' }
  const ok = setup({ item: plain }); const r = await ask(ok, { path: '/ledger/api/x' }); assert.equal(r.outcome, 'granted'); assert.equal(ok.seen[0].url, 'http://192.168.1.2:39310/ledger/api/x'); assert.equal(ok.seen[0].headers.authorization, 'Bearer ' + SECRET)
  for (const base of ['http://192.168.1.2/x', 'http://10.0.0.5', 'http://172.16.0.1', 'http://172.31.255.254', 'http://127.0.0.1:39301']) assert.equal((await ask(setup({ item: { ...plain, http_base: base } }), { path: '/x' })).outcome, 'granted', base) // every private range, dotted IPv4 only
  for (const base of ['http://8.8.8.8', 'http://172.32.0.1', 'http://172.15.0.1', 'http://192.169.1.1', 'http://11.0.0.1', 'http://localhost:1', 'http://printer.local', 'http://[::1]:80', 'http://010.0.0.1', 'http://192.168.1.256', 'http://user:p@192.168.1.2']) assert.equal((await ask(setup({ item: { ...plain, http_base: base } }), { path: '/x' })).outcome, 'error', base)
  assert.equal((await ask(setup({ item: { ...plain, http_allow_plain: undefined } }), { path: '/ledger/x' })).outcome, 'error'); assert.equal((await ask(setup({ item: { ...plain, http_allow_plain: 'yes' } }), { path: '/ledger/x' })).outcome, 'error')
})

test('http passthrough paths: on the listed paths the CALLER\'s own Authorization goes and the module adds none; elsewhere the module\'s credential, and a caller Authorization is still ignored', async () => {
  const item = { ...ITEM, http_base: 'https://api.example.com/pages', http_passthrough_paths: '/pages/assets, /pages/upload' }
  const t = setup({ item })
  await ask(t, { path: '/pages/assets/check-missing', method: 'POST', headers: { Authorization: 'Bearer upload-jwt-123' } }); assert.equal(t.seen[0].headers.authorization, 'Bearer upload-jwt-123')
  await ask(t, { path: '/pages/upload?x=1', method: 'POST', headers: { authorization: 'Bearer other-token-9' } }); assert.equal(t.seen[1].headers.authorization, 'Bearer other-token-9')
  await ask(t, { path: '/pages/projects', headers: { Authorization: 'Bearer stolen' } }); assert.equal(t.seen[2].headers.authorization, 'Bearer ' + SECRET)
  await ask(t, { path: '/pages/assets2/x', headers: { Authorization: 'Bearer stolen' } }); assert.equal(t.seen[3].headers.authorization, 'Bearer ' + SECRET) // a prefix means a path segment
  assert.equal((await ask(t, { path: '/pages/assets/check-missing', method: 'POST' })).outcome, 'error'); assert.equal((await ask(t, { path: '/pages/assets/x', method: 'POST', headers: { authorization: 'Bearer a\r\nb' } })).outcome, 'error')
  assert.equal(t.seen.length, 4)
  const echo = setup({ item, answer: () => new Response('token upload-jwt-123 seen') }); const r = await ask(echo, { path: '/pages/assets/x', method: 'POST', headers: { Authorization: 'Bearer upload-jwt-123' } }); assert.equal(text(r), 'token [redacted] seen')
})

test('http form auth: the module appends its fields to the caller\'s form body, cannot be overridden, needs a form content type; secrets are scrubbed', async () => {
  const item = { http_base: 'https://oauth.example.com', http_auth: 'form', http_form_fields: 'client_id=cid-123456&client_secret=sec-abcdef-987', http_methods: 'POST' }
  const t = setup({ item })
  const body = text2 => Buffer.from(text2).toString('base64')
  const r = await ask(t, { method: 'POST', path: '/token', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: body('grant_type=authorization_code&code=abc&client_secret=forged') })
  assert.equal(r.outcome, 'granted'); const sent = new URLSearchParams(String(t.seen[0].body))
  assert.equal(sent.get('client_secret'), 'sec-abcdef-987'); assert.equal(sent.get('client_id'), 'cid-123456'); assert.equal(sent.get('grant_type'), 'authorization_code'); assert.equal(sent.get('code'), 'abc'); assert.deepEqual([...sent.getAll('client_secret')], ['sec-abcdef-987'])
  assert.equal(t.seen[0].headers['content-type'], 'application/x-www-form-urlencoded'); assert.ok(!t.seen[0].headers.authorization)
  await ask(t, { method: 'POST', path: '/token' }); assert.equal(new URLSearchParams(String(t.seen[1].body)).get('client_id'), 'cid-123456') // no caller body: just the fields
  for (const bad of [{ headers: { 'content-type': 'application/json' }, body: body('{}') }, { method: 'GET' }]) assert.equal((await ask(t, { method: 'POST', path: '/token', ...bad })).outcome, 'error')
  assert.equal((await ask(setup({ item: { ...item, http_form_fields: '' } }), { method: 'POST', path: '/token' })).outcome, 'error')
  const echo = setup({ item, answer: () => new Response('{"echo":"sec-abcdef-987","id":"cid-123456"}') }); const e = await ask(echo, { method: 'POST', path: '/token' }); assert.equal(text(e), '{"echo":"[redacted]","id":"[redacted]"}')
})

const tokenSetup = (answer, extra = {}) => setup({ item: { http_base: 'https://ip.example.jp', http_auth: 'oauth2-password', http_token_path: '/auth/token', http_token_fields: 'grant_type=password&username=u&password=pw-secret-1', http_methods: 'GET', ...extra }, answer })
const jpoAnswer = ({ stale = 0 } = {}) => { let n = 0; return (url, options) => {
  if (String(url).endsWith('/auth/token')) return new Response(JSON.stringify({ access_token: 'tok-' + (++n) + '-abcdef', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } })
  return stale && options.headers.authorization === 'Bearer tok-1-abcdef' ? new Response('{"result":{"statusCode":210}}', { headers: { 'content-type': 'application/json' } }) : new Response('{"result":{"statusCode":100},"tok":"' + options.headers.authorization + '"}', { headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'set-cookie': 'a=b' } })
} }
test('http oauth2-password: the module fetches the token, keeps it in memory, adds it, and shows nothing of it', async () => {
  const { forgetTokens } = await import('../src/auth-mediation/http.mjs'); forgetTokens()
  const t = tokenSetup(jpoAnswer()); const r = await ask(t, { path: '/api/patent/x' }); const r2 = await ask(t, { path: '/api/patent/y' })
  assert.equal(r.status, 200); assert.equal(text(r), '{"result":{"statusCode":100},"tok":"Bearer [redacted]"}')
  assert.deepEqual(r.headers, { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' })
  const posts = t.seen.filter(s => s.url.endsWith('/auth/token')); assert.equal(posts.length, 1); assert.equal(posts[0].body, 'grant_type=password&username=u&password=pw-secret-1'); assert.equal(r2.status, 200)
  assert.ok(!JSON.stringify(t.lines).includes('pw-secret-1'))
})
test('http oauth2-password: on 401 or result.statusCode 210 it renews once and repeats; the second answer is returned as it is', async () => {
  const { forgetTokens } = await import('../src/auth-mediation/http.mjs'); forgetTokens()
  const t = tokenSetup(jpoAnswer({ stale: 1 })); const r = await ask(t, { path: '/api/patent/x' })
  assert.equal(r.status, 200); assert.match(text(r), /"statusCode":100/u); assert.equal(t.seen.filter(s => s.url.endsWith('/auth/token')).length, 2)
  forgetTokens(); const always = tokenSetup((url) => String(url).endsWith('/auth/token') ? new Response('{"access_token":"tok-zzzzzz"}') : new Response('no', { status: 401 })); const a = await ask(always, { path: '/api/x' })
  assert.equal(a.status, 401); assert.equal(always.seen.length, 4) // token, call, token, call: no third round
  forgetTokens(); const bad = tokenSetup(() => new Response('{"error":"x"}', { status: 400 })); const b = await ask(bad, { path: '/api/x' })
  assert.deepEqual(b, { outcome: 'error', error: 'The token request failed.' })
})
test('http none: the base URL is the credential (full secret URL), path / is exactly that URL, and its secret part is scrubbed from what is shown', async () => {
  const hook = 'https://discord.example.com/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz0123'
  const t = setup({ item: { http_base: hook, http_auth: 'none', http_methods: 'POST' }, answer: () => new Response('echo AbCdEfGhIjKlMnOpQrStUvWxYz0123') })
  const r = await ask(t, { method: 'POST', path: '/', body: Buffer.from('{"content":"hi"}').toString('base64') })
  assert.equal(t.seen[0].url, hook); assert.equal(text(r), 'echo [redacted]'); assert.equal(t.seen[0].headers.authorization, undefined)
  assert.equal((await ask(t, { method: 'POST', path: '/other' })).outcome, 'error')
})
test('http jwt-es256: the module signs a short-lived ES256 token with the item key and sends it as the bearer', async () => {
  const { generateKeyPairSync, createVerify } = await import('node:crypto'); const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const t = setup({ item: { http_base: 'https://api.example.com', http_auth: 'jwt-es256', http_jwt_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), http_jwt_kid: 'KID1', http_jwt_iss: 'ISS1', http_jwt_aud: 'aud1', http_jwt_ttl: '300', http_jwt_claims: '{"bid":"com.x"}' } })
  await ask(t, { path: '/v1/apps' }); const [h, c, sig] = t.seen[0].headers.authorization.slice(7).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KID1', typ: 'JWT' }); const claims = JSON.parse(Buffer.from(c, 'base64url'))
  assert.equal(claims.iss, 'ISS1'); assert.equal(claims.aud, 'aud1'); assert.equal(claims.bid, 'com.x'); assert.equal(claims.exp - claims.iat, 300)
  assert.ok(createVerify('sha256').update(h + '.' + c).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')))
})
test('http: item extra headers are set last, listed caller headers pass, others do not', async () => {
  const t = setup({ item: { ...ITEM, http_extra_headers: '{"X-Api-Version":"2025-01","authorization":"x"}', http_allow_headers: 'x-trace, authorization' } })
  await ask(t, { headers: { 'X-Trace': 't1', 'X-Api-Version': 'evil', 'X-Other': 'no', Authorization: 'Bearer stolen' } })
  assert.deepEqual(t.seen[0].headers, { 'x-trace': 't1', 'x-api-version': '2025-01', authorization: 'x' })
})

test('http oauth2-password: a stop flushes the kept token (the next request after resume fetches a new one); cache_seconds=0 keeps none', async () => {
  const { forgetTokens } = await import('../src/auth-mediation/http.mjs'); forgetTokens()
  const t = tokenSetup(jpoAnswer()); await ask(t, { path: '/api/a' }); await ask(t, { path: '/api/b' })
  const fetches = () => t.seen.filter(s => s.url.endsWith('/auth/token')).length
  assert.equal(fetches(), 1)
  t.store.policy.stopped = ['http stripe']; assert.equal((await ask(t, { path: '/api/c' })).outcome, 'stopped')
  t.store.policy.stopped = []; await ask(t, { path: '/api/d' }); assert.equal(fetches(), 2)
  forgetTokens(); const never = tokenSetup(jpoAnswer(), { cache_seconds: '0' }); await ask(never, { path: '/api/a' }); await ask(never, { path: '/api/b' })
  assert.equal(never.seen.filter(s => s.url.endsWith('/auth/token')).length, 2)
})
