import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createAuthCore } from '../src/auth-mediation/core.mjs'
import { createItemCache } from '../src/auth-mediation/items.mjs'
import { emptyPolicy } from '../src/auth-mediation/policy.mjs'
import { validateAuthMediationRequest } from '../src/auth-mediation-protocol.mjs'
import { relayAnswer } from '../src/auth-mediation-relay.mjs'

const SHA = 'a'.repeat(64), PATH = '/app/scripts/auth-mediation/grant'
const entry = { path: PATH, sha256: SHA }
const from = { ...entry, sealed: true }
const decision = { id: 'D1', role: 'main adoption', record: 'chart a', need: 'standing', reason: 'installs every release', secret: 'dropped' }

function setup(policy = {}) {
  const store = { policy: { ...emptyPolicy(), vault: 'v', admins: ['bot-admin'], ...policy }, read: async () => structuredClone(store.policy), write: async p => { store.policy = p } }
  const lines = []
  const core = createAuthCore({ store, items: createItemCache({ runOp: async () => '{}' }), audit: l => lines.push(l), roots: () => ({}) })
  const grant = (program, args = { bot: 'bot-a', command: 'gh x', decision }, verb = 'grant') => core.admin('bot-admin', verb, args, program)
  return { store, lines, core, grant }
}
const last = t => new Promise(r => setImmediate(r)).then(() => t.lines.at(-1))

test('no entry registered: the gate is off; entry.set registers it (admins only, a shape is required) and a re-registration replaces it', async () => {
  const t = setup()
  assert.equal((await t.grant(null)).outcome, 'ok')
  assert.equal((await t.core.admin('bot-a', 'entry.set', entry)).outcome, 'denied')
  assert.equal((await t.core.admin('bot-admin', 'entry.set', { path: 'rel', sha256: SHA })).outcome, 'error')
  assert.equal((await t.core.admin('bot-admin', 'entry.set', { path: PATH, sha256: 'xyz' })).outcome, 'error')
  assert.equal((await t.core.admin('bot-admin', 'entry.set', entry)).outcome, 'ok'); assert.deepEqual(t.store.policy.entry, entry)
  assert.deepEqual((await last(t)).entry, entry)
  const next = { path: PATH, sha256: 'b'.repeat(64) }
  assert.equal((await t.core.admin('bot-admin', 'entry.set', next)).outcome, 'ok'); assert.deepEqual(t.store.policy.entry, next)
})

test('with an entry: grant, revoke and import need that exact sealed program and the decision record; anything else is denied, audited, and changes nothing', async () => {
  const t = setup({ entry })
  const before = JSON.stringify(t.store.policy)
  for (const program of [null, undefined, { ...from, sealed: false }, { ...from, sha256: 'b'.repeat(64) }, { ...from, path: '/app/scripts/auth-mediation/auth-admin' }]) {
    for (const verb of ['grant', 'revoke', 'import']) {
      const r = await t.grant(program, { bot: 'bot-a', command: 'gh x', decision }, verb)
      assert.equal(r.outcome, 'denied', verb); assert.match(r.error, /registered grant entry program/u)
    }
  }
  assert.equal(JSON.stringify(t.store.policy), before)
  const refused = await last(t); assert.equal(refused.outcome, 'denied'); assert.equal(refused.refused, 'not-entry'); assert.equal(refused.via, 'admin')
  for (const bad of [undefined, {}, { id: 'D1' }, { reason: 'r' }, { id: '', reason: 'r' }]) {
    const r = await t.grant(from, { bot: 'bot-a', command: 'gh x', ...(bad ? { decision: bad } : {}) })
    assert.equal(r.outcome, 'denied'); assert.match(r.error, /decision record/u)
  }
  assert.equal(JSON.stringify(t.store.policy), before)
})

test('the entry program grants and revokes; the audit keeps the decision (known keys only), the target and the expiry, never a secret', async () => {
  const t = setup({ entry })
  assert.equal((await t.grant(from, { bot: 'bot-a', command: 'gh x', cwd: '/srv/bellteam/bots/bot-a', expires: '2099-01-01T00:00:00+00:00', decision })).outcome, 'ok')
  assert.deepEqual(t.store.policy.bots['bot-a'].grants, [{ command: 'gh x', cwd: '/srv/bellteam/bots/bot-a', expires: '2099-01-01T00:00:00+00:00' }])
  const line = await last(t)
  assert.deepEqual(line.decision, { id: 'D1', role: 'main adoption', record: 'chart a', need: 'standing', reason: 'installs every release' })
  assert.equal(line.outcome, 'grant'); assert.equal(line.target, 'bot-a'); assert.equal(line.expires, '2099-01-01T00:00:00+00:00'); assert.equal(line.item, 'gh x')
  assert.equal((await t.grant(from, { bot: 'bot-a', command: 'gh x', decision: { id: 'D2', reason: 'retired' } }, 'revoke')).outcome, 'ok')
  assert.deepEqual(t.store.policy.bots['bot-a'].grants, []); assert.deepEqual((await last(t)).decision, { id: 'D2', reason: 'retired' })
})

test('the other verbs are not gated by the entry', async () => {
  const t = setup({ entry })
  for (const verb of ['stop', 'resume', 'flush', 'show']) assert.equal((await t.core.admin('bot-admin', verb, { command: 'gh x' }, null)).outcome, 'ok', verb)
})

test('relay endpoint passes the peer program to the facade for admin only and refuses a malformed one; the client line cannot carry it', async () => {
  const seen = []; const facade = { admin: async p => (seen.push(p), { outcome: 'ok' }) }
  const peer = { uid: 1000, cwd: '/srv/bellteam/bots/bot-a', program: from }
  await relayAnswer({ via: 'container-socket', peer, request: { op: 'admin', verb: 'grant', args: {}, program: { path: '/x', sha256: SHA, sealed: true } } }, facade)
  assert.deepEqual(seen[0], { cwd: peer.cwd, verb: 'grant', args: {}, program: from })
  await relayAnswer({ via: 'container-socket', peer: { ...peer, program: null }, request: { op: 'admin', verb: 'show' } }, facade)
  assert.deepEqual(seen[1], { cwd: peer.cwd, verb: 'show', args: undefined })
  for (const program of [{ path: 'rel', sha256: SHA, sealed: true }, { path: PATH, sha256: 'zz', sealed: true }, { path: PATH, sha256: SHA, sealed: 'yes' }, 'x'])
    assert.deepEqual(await relayAnswer({ via: 'container-socket', peer: { ...peer, program }, request: { op: 'admin', verb: 'show' } }, facade), { outcome: 'error', error: 'Bad request.' })
})

test('protocol: an admin request may carry a well-formed program and nothing else new', () => {
  const ctx = { generation: 'g1' }, ok = { verb: 'grant', cwd: '/srv/bellteam/bots/bot-a', args: {} }
  assert.doesNotThrow(() => validateAuthMediationRequest('admin', { ...ok, program: from }, ctx))
  for (const program of [{ ...from, sha256: 'zz' }, { ...from, sealed: 1 }, { path: PATH, sha256: SHA }, { ...from, extra: 1 }, 'x'])
    assert.throws(() => validateAuthMediationRequest('admin', { ...ok, program }, ctx), /AUTH_MEDIATION_INVALID/u)
})

const RELAY = new URL('../scripts/auth-mediation/relay.py', import.meta.url).pathname
const program = (pid, seatUid) => JSON.parse(spawnSync('python3', ['-I', '-c', 'import importlib.util,json,sys\ns=importlib.util.spec_from_file_location("relay",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.program_of(int(sys.argv[2]))))', RELAY, String(pid)],
  { env: { ...process.env, AUTH_RELAY_SEAT_UID: String(seatUid) }, encoding: 'utf8' }).stdout)

test('relay program_of: argv[1] of "interpreter /abs/script", its sha256, sealed only when no folder or file on the path belongs to the seat uid or is group/other-writable', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.auth-entry-test-'))
  const script = join(dir, 'prog.py'), body = 'import time\ntime.sleep(30)\n'
  await writeFile(script, body)
  const sha = createHash('sha256').update(body).digest('hex')
  const peers = [spawn('python3', [script]), spawn('python3', ['-c', 'import time;time.sleep(30)']), spawn('python3', ['prog.py'], { cwd: dir })]
  try {
    await new Promise(r => setTimeout(r, 400))
    const seat = process.getuid()
    assert.deepEqual(program(peers[0].pid, seat), { path: script, sha256: sha, sealed: false }) // the file is the seat's own: editable
    let tight = true; for (let d = dir; ; d = dirname(d)) { if (statSync(d).mode & 0o022) tight = false; if (d === '/') break } // a checkout under sticky /tmp is never sealed
    assert.deepEqual(program(peers[0].pid, seat + 1), { path: script, sha256: sha, sealed: tight }) // a root-owned copy would read like this
    assert.equal(program(peers[1].pid, seat), null) // -c: no script
    assert.equal(program(peers[2].pid, seat), null) // relative script path
    assert.equal(program(2 ** 22 + 1, seat), null) // no such process
  } finally { for (const p of peers) p.kill(); await rm(dir, { recursive: true, force: true }) }
})
