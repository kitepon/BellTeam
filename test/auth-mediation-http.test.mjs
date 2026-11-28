import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('http rotation: the module refreshes a long-lived token itself, keeps the newest in a 0600 state file, and an item value changed by Sakura wins', async () => {
  const { mkdtemp, readFile, stat } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { createTokenState } = await import('../src/auth-mediation/http.mjs'); const dir = await mkdtemp(join(tmpdir(), 'rot-')), file = join(dir, 'http-tokens.json')
  const fields = { http_base: 'https://graph.example.com', http_auth: 'query:access_token', http_secret: 'old-token-aaaaaa', http_methods: 'GET', http_rotate_path: '/refresh_access_token', http_rotate_query: 'grant_type=th_refresh_token', http_rotate_days: '7' }
  const answer = (url) => String(url).includes('/refresh_access_token') ? new Response(JSON.stringify({ access_token: 'new-token-bbbbbb', expires_in: 5184000 })) : new Response('seen ' + new URL(url).searchParams.get('access_token'))
  const make = item => { const t = setup({ item, answer }); return t }
  const t = make(fields); const { createAuthCore } = await import('../src/auth-mediation/core.mjs')
  const core = createAuthCore({ store: t.store, items: createItemCache({ runOp: async () => itemJson(fields) }), tokenState: createTokenState(file), audit: l => t.lines.push(l), roots: () => ({ 'bot-a': CWD }), fetchImpl: async (url, o) => { t.seen.push({ url: String(url) }); return answer(url, o) } })
  const call = () => core.http({ name: 'stripe', method: 'GET', path: '/v1/me', via: 'host-socket', cwd: UNIT, unit: UNIT })
  const first = await call(); assert.equal(text(first), 'seen [redacted]'); assert.match(t.seen[0].url, /refresh_access_token\?grant_type=th_refresh_token&access_token=old-token-aaaaaa/u); assert.match(t.seen[1].url, /access_token=new-token-bbbbbb/u)
  await call(); assert.equal(t.seen.filter(s => s.url.includes('refresh_access_token')).length, 1) // not again within 7 days
  assert.equal(JSON.parse(await readFile(file, 'utf8'))['http stripe'].token, 'new-token-bbbbbb'); assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify(t.lines).includes('new-token-bbbbbb')); assert.ok(t.lines.some(l => l.outcome === 'rotated'))
  // Sakura writes a new item value: it wins and is refreshed from, not the kept token
  fields.http_secret = 'changed-token-cccccc'; const items2 = createItemCache({ runOp: async () => itemJson(fields) }); const core2 = createAuthCore({ store: t.store, items: items2, tokenState: createTokenState(file), audit: () => {}, roots: () => ({ 'bot-a': CWD }), fetchImpl: async (url) => { t.seen.push({ url: String(url) }); return answer(url) } })
  await core2.http({ name: 'stripe', method: 'GET', path: '/v1/me', via: 'host-socket', cwd: UNIT, unit: UNIT }); assert.match(t.seen.at(-2).url, /refresh_access_token.*access_token=changed-token-cccccc/u)
})

test('http rotation: an http:// non-private base makes no network call at all (the token never goes out in clear); a broken state file is replaced', async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { createTokenState } = await import('../src/auth-mediation/http.mjs'); const { createAuthCore } = await import('../src/auth-mediation/core.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'rot-')), file = join(dir, 'http-tokens.json')
  const mk = fields => { const t = setup({ item: fields }); const core = createAuthCore({ store: t.store, items: createItemCache({ runOp: async () => itemJson(fields) }), tokenState: createTokenState(file), audit: () => {}, roots: () => ({ 'bot-a': CWD }), fetchImpl: async url => { t.seen.push({ url: String(url) }); return new Response(String(url).includes('refresh') ? '{"access_token":"fresh-token-dddd"}' : 'ok') } }); return { t, call: () => core.http({ name: 'stripe', method: 'GET', path: '/v1/me', via: 'host-socket', cwd: UNIT, unit: UNIT }) } }
  const plain = mk({ http_base: 'http://graph.example.com/v1', http_auth: 'bearer', http_secret: 'old-token-aaaaaa', http_rotate_path: '/refresh_access_token' }); const r = await plain.call()
  assert.equal(r.outcome, 'error'); assert.equal(plain.t.seen.length, 0)
  await writeFile(file, '{broken'); const ok = mk({ http_base: 'https://graph.example.com', http_auth: 'bearer', http_secret: 'old-token-aaaaaa', http_rotate_path: '/refresh_access_token' })
  assert.equal((await ok.call()).outcome, 'granted'); assert.equal(JSON.parse(await readFile(file, 'utf8'))['http stripe'].token, 'fresh-token-dddd')
  const before = await readFile(file, 'utf8'); await ok.call(); assert.equal(await readFile(file, 'utf8'), before)
})

test('http aws-sigv4: the module signs with the item key; matches the AWS published S3 test vector; the secret never shows', async () => {
  const { sigv4 } = await import('../src/auth-mediation/http.mjs')
  const signed = sigv4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'), headers: {}, accessKey: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', date: new Date('2013-05-24T00:00:00Z') })
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543')
  const t = setup({ item: { http_base: 'https://acct.r2.example.com', http_auth: 'aws-sigv4', http_secret: 'r2-secret-key-0123456789', http_aws_access_key: 'AKIDEXAMPLE000', http_methods: 'GET PUT' }, answer: () => new Response('echo r2-secret-key-0123456789') })
  const r = await ask(t, { method: 'PUT', path: '/bucket/obj.bin', body: Buffer.from('data').toString('base64') })
  assert.match(t.seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE000\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u)
  assert.equal(t.seen[0].headers['x-amz-content-sha256'], createHash('sha256').update('data').digest('hex')); assert.equal(text(r), 'echo [redacted]')
  assert.ok(!JSON.stringify(t.lines).includes('r2-secret-key'))
})

test('http aws-sigv4: object keys with ! \' ( ) * are signed in their re-encoded form (AWS canonical path), other characters keep their encoding', async () => {
  const { sigv4 } = await import('../src/auth-mediation/http.mjs'), base = { method: 'GET', headers: {}, accessKey: 'AK', secret: 'sk', region: 'auto', service: 's3', date: new Date('2026-11-28T00:00:00Z') }
  const raw = sigv4({ ...base, url: new URL('https://h.example/b/a!b(c)*d\'e') }).authorization, enc = sigv4({ ...base, url: new URL('https://h.example/b/a%21b%28c%29%2Ad%27e') }).authorization
  assert.equal(raw, enc) // AWS canonical form is the same whichever way the caller wrote the key
})

test('http exact base: path "/" on a base with a path sends exactly the stored URL WITH the item credential (bearer or header), and nothing else is added', async () => {
  const hook = 'https://hooks.example.com/switchboard/AbCdEfGhIjKlMnOpQrSt0123'
  const bearer = setup({ item: { http_base: hook, http_auth: 'bearer', http_secret: 'key-secret-abcdef', http_methods: 'POST' }, answer: () => new Response('ok AbCdEfGhIjKlMnOpQrSt0123') })
  const r = await ask(bearer, { method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"a":1}').toString('base64') })
  assert.equal(bearer.seen[0].url, hook); assert.equal(bearer.seen[0].headers.authorization, 'Bearer key-secret-abcdef'); assert.equal(text(r), 'ok [redacted]')
  const header = setup({ item: { http_base: hook, http_auth: 'header:Authorization', http_secret: 'Bearer stored-value-123', http_methods: 'POST' } })
  await ask(header, { method: 'POST', path: '/', body: Buffer.from('{}').toString('base64') }); assert.equal(header.seen[0].url, hook); assert.equal(header.seen[0].headers.authorization, 'Bearer stored-value-123')
  assert.equal((await ask(setup({ item: { http_base: 'https://api.example.com/v1', http_auth: 'bearer', http_secret: 'sk_live_abcdef123456' } }), { path: '/' })).outcome, 'granted') // a plain API base: '/' is its own prefix URL, as before
})

test('http aws-sigv4 for multipart R2: the query (?uploads, ?partNumber=&uploadId=) is signed, listed caller headers (range, x-amz-copy-source) are signed too, content-range and accept-ranges are shown, binary body intact', async () => {
  const body = Buffer.alloc(6 * 1048576); for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 255
  const t = setup({ item: { http_base: 'https://acct.r2.example.com/bucket', http_auth: 'aws-sigv4', http_secret: 'r2-secret-key-0123456789', http_aws_access_key: 'AKID', http_methods: 'GET HEAD PUT POST DELETE', http_allow_headers: 'range, x-amz-copy-source' }, answer: () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/10', 'accept-ranges': 'bytes' } }) })
  const first = await ask(t, { method: 'POST', path: '/bucket/obj.bin?uploads' }); assert.equal(first.outcome, 'granted', JSON.stringify(first)); assert.equal(t.seen[0].url, 'https://acct.r2.example.com/bucket/obj.bin?uploads')
  const put = await ask(t, { method: 'PUT', path: '/bucket/obj.bin?partNumber=1&uploadId=U1', headers: { range: 'bytes=0-0', 'x-amz-copy-source': '/bucket/src.bin', 'content-type': 'application/octet-stream' }, body: body.toString('base64') })
  assert.equal(put.outcome, 'granted', JSON.stringify(put).slice(0, 200)); const sent = t.seen[1]; assert.match(sent.headers.authorization, /SignedHeaders=content-type;host;range;x-amz-content-sha256;x-amz-copy-source;x-amz-date,/u)
  assert.equal(sent.headers['x-amz-content-sha256'], createHash('sha256').update(body).digest('hex')); assert.ok(Buffer.from(sent.body).equals(body))
  assert.equal(put.headers['content-range'], 'bytes 0-0/10'); assert.equal(put.headers['accept-ranges'], 'bytes'); assert.equal(put.status, 206)
})

test('http proxy: the module tunnels to the origin through the item\'s proxy (CONNECT with the proxy login, TLS to the origin), picks the discovered *.nordvpn.com host else the fixed one, GET only, the proxy login never shows', async () => {
  const { execFileSync } = await import('node:child_process'); const { mkdtemp, readFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { createServer: tlsServer } = await import('node:https'); const { createServer: httpServer } = await import('node:http'); const net = await import('node:net'); const { callHttp } = await import('../src/auth-mediation/http.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'px-')); execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=origin.example.com', '-addext', 'subjectAltName=DNS:origin.example.com'], { stdio: 'ignore' })
  const cert = await readFile(join(dir, 'c.pem')), key = await readFile(join(dir, 'k.pem')), seen = []
  const origin = tlsServer({ cert, key }, (req, res) => { seen.push(req.method + ' ' + req.url + ' ' + (req.headers['proxy-authorization'] ?? '-')); res.setHeader('x-ratelimit-remaining', '3'); res.end('korea ' + 'pw-proxy-secret') }); await new Promise(r => origin.listen(0, r))
  const proxy = tlsServer({ cert, key }); proxy.on('connect', (req, socket) => { seen.push('CONNECT ' + req.url + ' ' + req.headers['proxy-authorization']); const up = net.connect(origin.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(socket); socket.pipe(up); socket.on('close', () => up.destroy()); up.on('close', () => socket.destroy()) }) }); await new Promise(r => proxy.listen(0, r))
  const fields = { http_base: 'https://origin.example.com:' + origin.address().port + '/api', http_auth: 'header:x-none', http_secret: 'unused-secret-1', http_methods: 'GET POST', http_proxy_host: '127.0.0.1', http_proxy_port: String(proxy.address().port), http_proxy_user: 'nord-user', http_proxy_password: 'pw-proxy-secret' }
  try {
    const r = await callHttp(fields, { method: 'GET', path: '/api/items?x=1' }, async () => { throw new Error('no direct call') }, null, { tls: { ca: cert }, proxyTls: { ca: cert, checkServerIdentity: () => undefined } })
    assert.equal(r.status, 200); assert.equal(Buffer.from(r.body, 'base64').toString(), 'korea [redacted]'); assert.equal(r.headers['x-ratelimit-remaining'], '3')
    assert.equal(seen[0], 'CONNECT origin.example.com:' + origin.address().port + ' Basic ' + Buffer.from('nord-user:pw-proxy-secret').toString('base64')); assert.equal(seen[1], 'GET /api/items?x=1 -')
    await assert.rejects(callHttp(fields, { method: 'POST', path: '/api/x' }, fetch, null, { tls: { ca: cert }, proxyTls: { ca: cert, checkServerIdentity: () => undefined } }), /GET only/u)
    // discovery: a host outside nordvpn.com is never taken, the fixed host stays
    const discovered = []; const viaApi = { ...fields, http_proxy_discover: 'https://api.example.com/servers' }
    const fake = async url => { discovered.push(String(url)); return new Response(JSON.stringify([{ hostname: 'evil.example.org' }])) }
    await callHttp(viaApi, { method: 'GET', path: '/api/items' }, async (u, o) => String(u).includes('/servers') ? fake(u) : (() => { throw new Error('direct') })(), null, { tls: { ca: cert }, proxyTls: { ca: cert, checkServerIdentity: () => undefined } })
    assert.equal(discovered.length, 1); assert.equal(seen.filter(l => l.startsWith('CONNECT')).length, 2) // still the fixed 127.0.0.1 proxy
  } finally { proxy.closeAllConnections(); origin.closeAllConnections(); proxy.close(); origin.close() }
})

test('http oauth2-refresh (Google style): the module gets the access token from the token URL, keeps it, adds the bearer; a returned refresh token is kept in the state file; a code exchange keeps its refresh token for the named item and shows [stored]', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { createTokenState, forgetTokens } = await import('../src/auth-mediation/http.mjs'); const { createAuthCore } = await import('../src/auth-mediation/core.mjs'); forgetTokens()
  const file = join(await mkdtemp(join(tmpdir(), 'oar-')), 'http-tokens.json'), seen = []
  const fields = { http_base: 'https://www.googleapis.com/webmasters/v3', http_auth: 'oauth2-refresh', http_secret: 'refresh-token-old-123', http_oauth_client_id: 'cid-123', http_oauth_client_secret: 'csecret-abcdef', http_methods: 'GET POST' }
  const answer = (url, o) => { seen.push({ url: String(url), body: o?.body ? String(o.body) : '', auth: o?.headers?.authorization }); return String(url).endsWith('/token') ? new Response(JSON.stringify({ access_token: 'access-aaaaaa-1', expires_in: 3599, refresh_token: 'refresh-token-NEW-456' })) : new Response('rows for csecret-abcdef') }
  const t0 = setup({ item: fields }), core = createAuthCore({ store: t0.store, items: createItemCache({ runOp: async () => itemJson(fields) }), tokenState: createTokenState(file), audit: l => t0.lines.push(l), roots: () => ({ 'bot-a': CWD }), fetchImpl: async (u, o) => answer(u, o) })
  const call = (path = '/webmasters/v3/sites/x/sitemaps') => core.http({ name: 'stripe', method: 'GET', path, via: 'host-socket', cwd: UNIT, unit: UNIT })
  const r = await call(); await call()
  assert.equal(Buffer.from(r.body, 'base64').toString(), 'rows for [redacted]'); assert.equal(seen.filter(x => x.url.endsWith('/token')).length, 1)
  assert.equal(seen.find(x => x.url.endsWith('/token')).body, 'client_id=cid-123&client_secret=csecret-abcdef&refresh_token=refresh-token-old-123&grant_type=refresh_token'); assert.equal(seen.find(x => !x.url.endsWith('/token')).auth, 'Bearer access-aaaaaa-1')
  assert.equal(JSON.parse(await readFile(file, 'utf8'))['http stripe'].token, 'refresh-token-NEW-456'); assert.ok(!JSON.stringify(t0.lines).includes('refresh-token'))
  // a code exchange through a capture item keeps the refresh token for 'http stripe' and shows [stored]
  const cap = { http_base: 'https://oauth2.googleapis.com', http_auth: 'form', http_form_fields: 'client_id=cid-123&client_secret=csecret-abcdef', http_methods: 'POST', http_capture_for: 'http stripe' }
  const state = createTokenState(file), exch = await (await import('../src/auth-mediation/http.mjs')).callHttp(cap, { method: 'POST', path: '/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from('code=abc&grant_type=authorization_code').toString('base64') }, async () => new Response(JSON.stringify({ access_token: 'x', refresh_token: 'refresh-token-CONSENT-789' })), { state, item: 'http exchange' })
  assert.match(Buffer.from(exch.body, 'base64').toString(), /"refresh_token":"\[stored\]"/u); assert.equal(JSON.parse(await readFile(file, 'utf8'))['http stripe'].token, 'refresh-token-CONSENT-789')
})

test('http oauth2-refresh: a stop drops the kept access token (resume fetches a new one); a changed refresh token or client secret is another key; a form-encoded code answer is stored too', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { createTokenState, forgetTokens, callHttp } = await import('../src/auth-mediation/http.mjs'); forgetTokens()
  const base = { http_base: 'https://api.example.com/v1', http_auth: 'oauth2-refresh', http_secret: 'refresh-aaaaaa', http_oauth_client_id: 'cid', http_oauth_client_secret: 'csecret-bbbbbb', http_methods: 'GET' }
  const t = setup({ item: base, answer: u => String(u).endsWith('/token') ? new Response(JSON.stringify({ access_token: 'acc-' + Math.random().toString(36).slice(2, 10), expires_in: 3599 })) : new Response('ok') })
  const tokenCalls = () => t.seen.filter(x => x.url.endsWith('/token')).length
  await ask(t); await ask(t); assert.equal(tokenCalls(), 1)
  t.store.policy.stopped = ['http stripe']; assert.equal((await ask(t)).outcome, 'stopped'); t.store.policy.stopped = []
  await ask(t); assert.equal(tokenCalls(), 2) // resume: a new access token
  const fx = async (url, o) => { t.seen.push({ url: String(url) }); return String(url).endsWith('/token') ? new Response('{"access_token":"x-yyyyyy"}') : new Response('ok') }
  forgetTokens(); await callHttp(base, { method: 'GET', path: '/v1/a' }, fx); await callHttp(base, { method: 'GET', path: '/v1/a' }, fx); const n1 = tokenCalls()
  await callHttp({ ...base, http_secret: 'refresh-CHANGED' }, { method: 'GET', path: '/v1/a' }, fx); assert.equal(tokenCalls(), n1 + 1)
  await callHttp({ ...base, http_oauth_client_secret: 'csecret-CHANGED' }, { method: 'GET', path: '/v1/a' }, fx); assert.equal(tokenCalls(), n1 + 2)
  const file = join(await mkdtemp(join(tmpdir(), 'cap-')), 'http-tokens.json'), state = createTokenState(file)
  const exch = await callHttp({ http_base: 'https://oauth2.googleapis.com', http_auth: 'form', http_form_fields: 'client_id=c&client_secret=csecret-bbbbbb', http_methods: 'POST', http_capture_for: 'http stripe' }, { method: 'POST', path: '/', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from('code=1').toString('base64') }, async () => new Response('access_token=a&refresh_token=1%2FREFRESH-form-token-99&expires_in=3'), { state, item: 'http exchange' })
  assert.ok(!Buffer.from(exch.body, 'base64').toString().includes('REFRESH-form')) // the caller never sees it
})

test('http proxy discovery: krNNN.nordvpn.com becomes krNNN.proxy.nordvpn.com; anything else is not taken and the fixed host stays', async () => {
  const { proxyChoice } = await import('../src/auth-mediation/http.mjs'); const base = { http_proxy_host: 'kr229.proxy.nordvpn.com', http_proxy_user: 'u', http_proxy_password: 'pw', http_proxy_discover: 'https://api.example.com/rec' }
  const pick = hostname => proxyChoice(base, async () => new Response(JSON.stringify([{ hostname }]))).then(p => p.host)
  assert.equal(await pick('kr202.nordvpn.com'), 'kr202.proxy.nordvpn.com'); assert.equal(await pick('kr7.proxy.nordvpn.com'), 'kr7.proxy.nordvpn.com')
  for (const bad of ['evil.example.org', 'kr202.nordvpn.com.evil.org', 'x.y.nordvpn.com', 'kr202.nordvpn.com@evil']) assert.equal(await pick(bad), 'kr229.proxy.nordvpn.com', bad)
})
