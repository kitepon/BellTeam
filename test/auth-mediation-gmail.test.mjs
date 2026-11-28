import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const ITEM = { gmail_client_id: 'cid', gmail_client_secret: 'csecret-value', gmail_refresh_token: 'rtoken-value', gmail_add_labels: 'Label_88, Label_89,Label_90', gmail_remove_labels: 'INBOX' }
const UNIT = '/home/kite/phantom'

function setup({ item = ITEM, grants = ['gmail box read', 'gmail box sort'], answer } = {}) {
  const calls = [], lines = []
  let clock = 1_000_000
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), ...init, headers: init.headers })
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return answer?.token ? answer.token() : new Response(JSON.stringify({ access_token: 'ya29.access-secret', expires_in: 3599 }), { status: 200 })
    return answer?.api ? answer.api(url, init) : new Response(JSON.stringify({ threads: [{ id: 't1' }] }), { status: 200 }) }
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } } }, read: async () => structuredClone(store.policy) }
  const items = createItemCache({ runOp: async args => { if (args[2] !== 'gmail box') throw new Error('x'); return JSON.stringify({ fields: Object.entries(item).map(([label, value]) => ({ label, value })) }) } })
  return { calls, lines, tick: ms => { clock += ms }, core: createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({}), fetchImpl, now: () => new Date(clock) }) }
}
const ask = (t, extra) => t.core.gmail({ name: 'box', via: 'host-socket', cwd: UNIT, unit: UNIT, ...extra })
const api = t => t.calls.filter(c => c.url.startsWith('https://gmail.googleapis.com'))

test('gmail: list and get are fixed calls for "me" with the module\'s access token; the caller gets Google\'s status and body unchanged and never the token', async () => {
  const t = setup(); const r = await ask(t, { action: 'list', q: 'in:inbox older_than:7d', max_results: 40, page_token: 'tok_1-x' })
  assert.deepEqual(r, { outcome: 'granted', status: 200, body: '{"threads":[{"id":"t1"}]}' })
  assert.equal(api(t)[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads?q=in%3Ainbox+older_than%3A7d&maxResults=40&pageToken=tok_1-x'); assert.equal(api(t)[0].headers.authorization, 'Bearer ya29.access-secret')
  const g = await ask(t, { action: 'get', id: 'abc123' }); assert.equal(g.status, 200); assert.equal(api(t)[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/abc123?format=full')
  assert.equal(t.calls.filter(c => c.url.includes('oauth2')).length, 1) // one token for both calls
  const tokenCall = t.calls[0]; assert.equal(tokenCall.body.get('grant_type'), 'refresh_token'); assert.equal(tokenCall.body.get('refresh_token'), 'rtoken-value')
  assert.ok(!JSON.stringify(r).includes('ya29') && !JSON.stringify(g).includes('csecret'))
})

test('gmail: modify only adds the item\'s labels and only removes INBOX (or the item\'s list); anything else is refused before any call', async () => {
  const t = setup(); const ok = await ask(t, { action: 'modify', id: 'abc123', add_labels: ['Label_89'], remove_labels: ['INBOX'] })
  assert.equal(ok.outcome, 'granted'); assert.equal(api(t)[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/threads/abc123/modify'); assert.equal(api(t)[0].method, 'POST'); assert.deepEqual(JSON.parse(api(t)[0].body), { addLabelIds: ['Label_89'], removeLabelIds: ['INBOX'] })
  const calls = t.calls.length
  for (const extra of [{ add_labels: ['Label_87'] }, { add_labels: ['INBOX'] }, { remove_labels: ['UNREAD'] }, { remove_labels: ['Label_88'] }, { add_labels: ['TRASH'] }, {}, { add_labels: ['Label_88'], remove_labels: ['INBOX', 'STARRED'] }, { add_labels: ['x y'] }, { add_labels: Array(9).fill('Label_88') }])
    assert.equal((await ask(t, { action: 'modify', id: 'abc123', ...extra })).error, 'GMAIL_REJECTED', JSON.stringify(extra))
  for (const id of ['', 'a/../b', 'a?x=1', 'a b']) assert.equal((await ask(t, { action: 'modify', id, add_labels: ['Label_88'] })).error, 'GMAIL_REJECTED')
  assert.equal(t.calls.length, calls) // nothing refused reached Google
})

test('gmail: list and get checks: q, max_results, page_token, format, id; the grants are separate (read does not allow modify)', async () => {
  const t = setup()
  for (const extra of [{ q: 'a\r\nb' }, { q: 'é' }, { q: 'x'.repeat(201) }, { max_results: 51 }, { max_results: 0 }, { page_token: 'a&b=c' }]) assert.equal((await ask(t, { action: 'list', ...extra })).error, 'GMAIL_REJECTED', JSON.stringify(extra))
  assert.equal((await ask(t, { action: 'get', id: 'abc', format: 'raw' })).error, 'GMAIL_REJECTED')
  const readOnly = setup({ grants: ['gmail box read'] }); assert.equal((await ask(readOnly, { action: 'list' })).outcome, 'granted'); assert.equal((await ask(readOnly, { action: 'modify', id: 'a', add_labels: ['Label_88'] })).outcome, 'denied'); assert.equal(api(readOnly).length, 1)
  const none = setup({ grants: [] }); assert.equal((await ask(none, { action: 'list' })).outcome, 'denied'); assert.equal(none.calls.length, 0)
})

test('gmail: Google\'s errors come back as they are (so the caller\'s backoff works); a failed token exchange or network error is a class, never a detail; a 401 drops the token', async () => {
  const rate = setup({ answer: { api: () => new Response('{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 }) } })
  const r = await ask(rate, { action: 'list' }); assert.equal(r.outcome, 'granted'); assert.equal(r.status, 403); assert.match(r.body, /rateLimitExceeded/u)
  assert.equal((await ask(setup({ answer: { token: () => new Response('{"error":"invalid_grant"}', { status: 400 }) } }), { action: 'list' })).error, 'GMAIL_AUTH')
  assert.equal((await ask(setup({ answer: { api: () => { throw new Error('socket hang up ya29.access-secret') } } }), { action: 'list' })).error, 'GMAIL_FAILED')
  const expired = setup({ answer: { api: () => new Response('{}', { status: 401 }) } }); await ask(expired, { action: 'list' }); await ask(expired, { action: 'list' })
  assert.equal(expired.calls.filter(c => c.url.includes('oauth2')).length, 2)
  const later = setup(); await ask(later, { action: 'list' }); later.tick(3600 * 1000); await ask(later, { action: 'list' }); assert.equal(later.calls.filter(c => c.url.includes('oauth2')).length, 2) // the token is renewed before it expires
  for (const item of [{ ...ITEM, gmail_refresh_token: undefined }, { ...ITEM, gmail_client_id: '' }]) assert.equal((await ask(setup({ item: Object.fromEntries(Object.entries(item).filter(([, v]) => v)) }), { action: 'list' })).error, 'GMAIL_REJECTED')
})

test('gmail: a response that echoes the token is scrubbed; the audit has action and status only, never query, ids, labels or body', async () => {
  const t = setup({ answer: { api: () => new Response('{"echo":"ya29.access-secret"}') } }); const r = await ask(t, { action: 'get', id: 'secretthread1' })
  assert.equal(r.body, '{"echo":"[redacted]"}')
  await ask(t, { action: 'list', q: 'from:boss@example.com' }); await new Promise(res => setImmediate(res)); const log = JSON.stringify(t.lines)
  for (const secret of ['secretthread1', 'boss@example.com', 'ya29', 'rtoken', 'csecret']) assert.ok(!log.includes(secret), secret)
  assert.deepEqual(t.lines.map(l => [l.item, l.action, l.status, l.outcome]), [['gmail box read', 'get', 200, 'granted'], ['gmail box read', 'list', 200, 'granted']])
})

test('gmail relay and protocol: per-action fields only; the transport names the caller', async () => {
  const seen = []; const facade = { gmail: async p => (seen.push(p), { outcome: 'granted', status: 200, body: '{}' }) }
  await relayAnswer({ via: 'host-socket', peer: null, request: { op: 'gmail-modify', name: 'box', cwd: '/c', id: 'abc', add_labels: ['Label_88'], remove_labels: ['INBOX'], junk: 1 } }, facade)
  await relayAnswer({ via: 'caller-socket', unit: '/x/a.sock', peer: null, request: { op: 'gmail-list', name: 'box', q: 'in:inbox', max_results: 5 } }, facade)
  assert.deepEqual(seen[0], { action: 'modify', name: 'box', id: 'abc', add_labels: ['Label_88'], remove_labels: ['INBOX'], via: 'host-socket', cwd: '/c', unit: '/c' })
  assert.deepEqual(seen[1], { action: 'list', name: 'box', q: 'in:inbox', max_results: 5, via: 'caller-socket', unit: '/x/a.sock' })
  const ctx = { generation: 'g1' }, base = { name: 'box', via: 'host-socket', cwd: '/c' }
  assert.doesNotThrow(() => validateAuthMediationRequest('gmail', { ...base, action: 'get', id: 'abc', format: 'metadata' }, ctx))
  for (const bad of [{ ...base, action: 'list', id: 'abc' }, { ...base, action: 'get' }, { ...base, action: 'get', id: 'abc', q: 'x' }, { ...base, action: 'modify', id: 'a', format: 'full' }, { ...base, action: 'list', q: 'a\nb' }, { ...base, action: 'send' }])
    assert.throws(() => validateAuthMediationRequest('gmail', bad, ctx), /AUTH_MEDIATION_INVALID/u)
})
