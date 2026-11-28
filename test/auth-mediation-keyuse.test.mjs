import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { useKey } from '../src/auth-mediation/keyuse.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest, validateAuthMediationResult } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const KEY = Buffer.alloc(32, 7).toString('base64'), UNIT = '/srv/bellteam/shared/tools/auth-mediation/callers/mmobank/mmobank.sock'
const itemJson = fields => JSON.stringify({ fields: Object.entries(fields).map(([label, value]) => ({ label, value })) })
const plain = Buffer.alloc(32, 9).toString('base64')

function setup({ grants = ['wrapkey mm-v1 wrap', 'wrapkey mm-v1 unwrap'], stopped = [], item = { wrap_key: KEY } } = {}) {
  let reads = 0, clock = 1_000_000
  const store = { policy: { ...emptyPolicy(), vault: 'v', units: { [UNIT]: { grants: grants.map(command => ({ command })) } }, stopped }, read: async () => structuredClone(store.policy), write: async p => { store.policy = p } }
  const items = createItemCache({ now: () => clock, runOp: async args => { reads++; if (args[2] !== 'wrapkey mm-v1') throw new Error('x'); return itemJson(item) } })
  const lines = []
  const core = createAuthCore({ store, items, audit: l => lines.push(l), roots: () => ({}) })
  return { core, lines, reads: () => reads, tick: ms => { clock += ms } }
}
const call = (t, action, data, extra = {}) => t.core.keyuse({ action, name: 'mm-v1', data, unit: UNIT, ...extra })

test('wrap then unwrap returns the same 32 bytes; the blob is not the key; aad binds it to its context', async () => {
  const t = setup()
  const w = await call(t, 'wrap', plain, { aad: 'ledger-1' })
  assert.equal(w.outcome, 'granted'); assert.notEqual(w.data, plain); assert.equal(Buffer.from(w.data, 'base64').length, 12 + 32 + 16)
  assert.deepEqual(await call(t, 'unwrap', w.data, { aad: 'ledger-1' }), { outcome: 'granted', data: plain })
  for (const wrong of [{ aad: 'ledger-2' }, {}]) assert.deepEqual(await call(t, 'unwrap', w.data, wrong), { outcome: 'error', error: 'Cannot unwrap.' })
  const flipped = Buffer.from(w.data, 'base64'); flipped[20] ^= 1
  assert.equal((await call(t, 'unwrap', flipped.toString('base64'), { aad: 'ledger-1' })).outcome, 'error')
  assert.notEqual((await call(t, 'wrap', plain, { aad: 'ledger-1' })).data, w.data) // a fresh nonce each time
})

test('grants decide: wrap and unwrap are separate grants; none, stopped, or an unknown key refuses before any key read; a bad key field is an error', async () => {
  const t = setup({ grants: ['wrapkey mm-v1 unwrap'] })
  assert.equal((await call(t, 'wrap', plain)).outcome, 'denied'); assert.equal(t.reads(), 0)
  assert.equal((await t.core.keyuse({ action: 'unwrap', name: 'other', data: plain, unit: UNIT })).outcome, 'denied')
  assert.equal((await t.core.keyuse({ action: 'unwrap', name: 'mm-v1', data: plain, unit: '/somewhere/else.sock' })).outcome, 'denied'); assert.equal(t.reads(), 0)
  const s = setup({ stopped: ['wrapkey mm-v1 wrap'] }); assert.equal((await call(s, 'wrap', plain)).outcome, 'stopped'); assert.equal(s.reads(), 0)
  const missing = setup({ grants: ['wrapkey nope wrap'] }); assert.equal((await missing.core.keyuse({ action: 'wrap', name: 'nope', data: plain, unit: UNIT })).outcome, 'not-registered')
  const bad = setup({ item: { wrap_key: 'AAAA' } }); assert.deepEqual(await call(bad, 'wrap', plain), { outcome: 'error', error: 'Cannot wrap.' })
  assert.throws(() => useKey('wrap', { wrap_key: KEY }, 'not base64!'), /KEYUSE_REFUSED/u)
  assert.throws(() => useKey('wrap', { wrap_key: KEY }, ''), /KEYUSE_REFUSED/u)
})

test('the audit has caller, key name, action, aad and outcome, never the key, the data or the result', async () => {
  const t = setup(); const w = await call(t, 'wrap', plain, { aad: 'ledger-1' }); await call(t, 'unwrap', w.data, { aad: 'ledger-1' })
  await new Promise(r => setImmediate(r))
  const text = JSON.stringify(t.lines)
  assert.deepEqual(t.lines.map(l => [l.outcome, l.item, l.via, l.caller, l.aad]), [['granted', 'wrapkey mm-v1 wrap', 'caller-socket', 'unit:' + UNIT, 'ledger-1'], ['granted', 'wrapkey mm-v1 unwrap', 'caller-socket', 'unit:' + UNIT, 'ledger-1']])
  for (const secret of [KEY, plain, w.data]) assert.ok(!text.includes(secret))
})

test('per-key cache period: the item field cache_seconds decides (0 = never kept); without it the policy period applies; it never leaves as an env value', async () => {
  const run = async fields => {
    let reads = 0, clock = 0
    const c = createItemCache({ now: () => clock, runOp: async () => { reads++; return itemJson(fields) } })
    await c.get('x', 'v', 3600); const again = await c.get('x', 'v', 3600); clock = 61_000; const later = await c.get('x', 'v', 3600)
    return { reads, again: again.hit, later: later.hit }
  }
  assert.deepEqual(await run({ A: '1' }), { reads: 1, again: true, later: true })
  assert.deepEqual(await run({ A: '1', cache_seconds: '0' }), { reads: 3, again: false, later: false })
  assert.deepEqual(await run({ A: '1', cache_seconds: '60' }), { reads: 2, again: true, later: false })
  assert.deepEqual(await run({ A: '1', cache_seconds: 'forever' }), { reads: 1, again: true, later: true })
  assert.deepEqual(await run({ A: '1', cache_seconds: '999999' }), { reads: 1, again: true, later: true })
})

test('caller-socket frames reach the facade as key use only, with the relay-named unit; exec, admin and a client-made peer are refused', async () => {
  const seen = []; const facade = { keyuse: async p => (seen.push(p), { outcome: 'granted', data: 'AA==' }), containerSocket: async () => assert.fail(), hostSocket: async () => assert.fail(), admin: async () => assert.fail() }
  const frame = request => ({ via: 'caller-socket', unit: UNIT, peer: null, request })
  assert.deepEqual(await relayAnswer(frame({ op: 'wrap', name: 'mm-v1', data: 'AA==', aad: 'l1', unit: '/claimed' }), facade), { outcome: 'granted', data: 'AA==' })
  assert.deepEqual(seen[0], { action: 'wrap', name: 'mm-v1', data: 'AA==', aad: 'l1', via: 'caller-socket', unit: UNIT })
  const bad = { outcome: 'error', error: 'Bad request.' }
  for (const f of [frame({ op: 'exec', command: ['a'], cwd: '/x' }), frame({ op: 'admin', verb: 'show' }), { ...frame({ op: 'wrap' }), unit: 'rel' }, { ...frame({ op: 'wrap' }), unit: undefined }, { ...frame({ op: 'wrap' }), peer: { uid: 1000, cwd: '/x' } }])
    assert.deepEqual(await relayAnswer(f, facade), bad)
})

test('protocol: key use takes exactly its fields; a result carries only outcome, error and data', () => {
  const ctx = { generation: 'g1' }, ok = { action: 'unwrap', name: 'mm-v1', data: 'AAAA', unit: UNIT }
  assert.doesNotThrow(() => validateAuthMediationRequest('keyuse', { ...ok, aad: 'l1' }, ctx))
  for (const bad of [{ ...ok, action: 'verify' }, { ...ok, data: 'not base64!' }, { ...ok, unit: 'rel' }, { ...ok, name: '../x' }, { ...ok, extra: 1 }, { ...ok, aad: 'x'.repeat(257) }, { action: 'wrap', name: 'a', data: 'AA==' }])
    assert.throws(() => validateAuthMediationRequest('keyuse', bad, ctx), /AUTH_MEDIATION_INVALID/u)
  assert.doesNotThrow(() => validateAuthMediationResult('keyuse', { outcome: 'granted', data: 'AA==' }))
  assert.throws(() => validateAuthMediationResult('keyuse', { outcome: 'granted', data: 'AA==', env: {} }))
})

test('relay.py: each container caller gets its own socket (0666 in a 0755 folder) and the frame names it; wrap/unwrap lines pass, the reply comes back unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-callers-')), bodyPath = join(dir, 'body.sock'), frames = []
  const server = createServer(c => { let buf = ''; c.on('data', d => { buf += d; if (buf.includes('\n')) { frames.push(JSON.parse(buf)); c.end(JSON.stringify({ outcome: 'granted', data: 'AA==' }) + '\n') } }) })
  await new Promise(r => server.listen(bodyPath, r))
  const child = spawn(new URL('../scripts/auth-mediation/relay.py', import.meta.url).pathname, [], { env: { ...process.env, AUTH_RELAY_DIR: join(dir, 'share'), AUTH_RELAY_BODY: bodyPath } })
  await new Promise(resolve => child.stdout.once('data', resolve))
  try {
    const sock = join(dir, 'share', 'callers', 'mmobank', 'mmobank.sock')
    assert.equal((await stat(sock)).mode & 0o777, 0o666); assert.equal((await stat(join(dir, 'share', 'callers', 'mmobank'))).mode & 0o777, 0o755)
    const out = await new Promise((resolve, reject) => { const c = connect(sock); let o = ''; c.on('connect', () => c.write(JSON.stringify({ op: 'wrap', name: 'mm-v1', data: 'AA==' }) + '\n')); c.on('data', d => { o += d }); c.on('end', () => resolve(o)); c.on('error', reject) })
    assert.deepEqual(JSON.parse(out), { outcome: 'granted', data: 'AA==' })
    assert.deepEqual(frames[0], { via: 'caller-socket', peer: null, request: { op: 'wrap', name: 'mm-v1', data: 'AA==' }, unit: sock })
  } finally { child.kill('SIGTERM'); server.close(); await rm(dir, { recursive: true, force: true }) }
})
