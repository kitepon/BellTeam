import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutionDispatcher, EXECUTION_METHODS } from '../src/execution-dispatcher.mjs'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MembersAdmission } from '../src/members-admission.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const bot = { id: 'bot-synthetic', session: 'bot-synthetic', harness: 'codex', project: '/synthetic' }
const request = (method, ...args) => ({ method, args })
async function fixture(t, nativeCall, { handoff, generation = 'first', waitProcess = async () => ({ outcome: 'done', turn_id: 'turn' }), continuation, initialize = true } = {}) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'execution-factory-'))
  t.after(() => rm(storageRoot, { recursive: true, force: true }))
  const bots = new Map([[bot.id, bot]]), calls = []
  bots.refresh = async () => {}
  let closes = 0
  const ports = { native: { async call(name, args, options) {
    calls.push(name)
    if (nativeCall) { const value = await nativeCall(name, args, options); if (value !== undefined) return value }
    if (name === 'pty_list') return { content: [{ type: 'text', text: `${bot.session}\tstub` }] }
    if (name === 'pty_observe') return { structuredContent: { exists: true, state: 'idle' } }
    if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', session_id: bot.session,
      vendor: 'codex', launch_id: 'a'.repeat(32), event_cursor: 1, wait_process: { executable: 'stub', args: [] } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'synthetic answer', turn_id: 'turn' } }
    throw Error(`unexpected ${name}`)
  }, async close() { closes++ } }, bots, rooms: {}, membersAdmission: new MembersAdmission(),
    configurationStorage: { root: join(storageRoot, 'intents'), ownerUid: process.getuid() }, access: { assertWorkAllowed() {} },
    seat: { waitProcess },
    observer: { report() {} }, diagnostics: { record() {} }, ...(continuation ? { continuation } : {}) }
  const engine = createExecutionDispatcher({ generation, ports, handoff })
  t.after(async () => {
    try { await engine.control('quiesce', { timeoutMs: 200 }); await engine.disconnect() } catch {}
  })
  if (initialize) await engine.control('initialize')
  return { engine, ports, bots, calls, closes: () => closes }
}

test('factory owns real engine and preserves synchronous projections; retire fences captured calls without closing shared native', async t => {
  const f = await fixture(t)
  const project = f.engine.project
  assert.equal(project(request('transport.session', bot)), bot.session)
  assert.equal(project(request('transport.isIdle', bot.id)), true)
  assert.throws(() => f.engine.validateRequest(request('transport.dispatch', bot, 'body')), { code: 'EXECUTION_REQUEST_INVALID' })
  assert.throws(() => f.engine.project(request('constructor.constructor')), { code: 'EXECUTION_REQUEST_INVALID' })
  assert.ok(EXECUTION_METHODS.dispatch.includes('administration.remove'))
  await f.engine.control('quiesce')
  const handoff = f.engine.exportState()
  await f.engine.disconnect()
  assert.equal(f.closes(), 0)
  assert.throws(() => project(request('transport.session', bot)), { code: 'EXECUTION_NOT_ACCEPTING' })
  const next = await fixture(t, null, { generation: 'second', handoff })
  assert.equal(next.engine.project(request('transport.session', bot)), bot.session)
})

test('quiesce does not retire an actual native read after its caller has stopped waiting, and old engine can resume', async t => {
  const read = deferred()
  const f = await fixture(t, name => name === 'pty_observe' ? read.promise : undefined)
  const operation = f.engine.dispatch(request('transport.observe', bot))
  await tick()
  await assert.rejects(f.engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  assert.throws(() => f.engine.exportState(), { code: 'EXECUTION_BUSY' })
  assert.throws(() => f.engine.dispatch(request('transport.observe', bot)), { code: 'EXECUTION_NOT_ACCEPTING' })
  await assert.rejects(f.engine.disconnect(), { code: 'EXECUTION_BUSY' })
  assert.deepEqual(await f.engine.control('resume'), { resumed: true })
  read.resolve({ structuredContent: { exists: true, state: 'idle' } }); await operation
  await f.engine.control('quiesce')
  await f.engine.disconnect(); assert.equal(f.closes(), 0)
})

test('accepted delivery remains live through the real waiter and delayed saved answer ACK', async t => {
  const wait = deferred(), answer = deferred()
  const f = await fixture(t)
  f.ports.seat.waitProcess = () => wait.promise
  // A new generation constructs its own Transport with the fixed wait port.
  await f.engine.control('quiesce'); const state = f.engine.exportState(); await f.engine.disconnect()
  const engine = createExecutionDispatcher({ generation: 'second', ports: f.ports, handoff: state })
  await engine.control('initialize')
  const accepted = await engine.dispatch(request('transport.notify', bot, 'SYNTHETIC_BODY', { onAnswer: () => answer.promise }))
  assert.equal(accepted.delivery, 'running')
  await assert.rejects(engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  wait.resolve({ outcome: 'done', turn_id: 'turn' }); await tick()
  await assert.rejects(engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  answer.resolve(); await engine.control('quiesce', { timeoutMs: 200 })
  await engine.disconnect(); assert.equal(f.closes(), 0)
})

test('handoff keeps uncertainty, stop versions, original preparation identity and CurrentWork metadata without recreating missing stage', async t => {
  const f = await fixture(t)
  await f.engine.control('quiesce')
  const state = f.engine.exportState(), m = state.metadata
  const original = { binding: { id: 'old-request' } }
  m.sessions.set(bot.id, 'preserved-session'); m.stopVersions.set(bot.id, 9)
  m.uncertainty.set(bot.id, 'agent_configure'); m.uncertaintyVersions.set(bot.id, { request: original.binding })
  m.requests.pending.set(bot.id, original); m.requests.latest.set(bot.id, { intent: original, receipt: null })
  m.requests.rejectedPreparations.set(bot.id, { original, preparation: { state: 'not_returned', publication: 'unknown' } })
  await f.engine.disconnect()
  const n = await fixture(t, null, { generation: 'second', handoff: state })
  assert.equal(n.engine.project(request('transport.session', bot)), 'preserved-session')
  await n.engine.control('quiesce')
  const after = n.engine.exportState().metadata
  assert.equal(after.stopVersions.get(bot.id), 9)
  assert.equal(after.uncertainty.get(bot.id), 'agent_configure')
  assert.equal(after.requests.pending.get(bot.id), after.requests.rejectedPreparations.get(bot.id).original)
  assert.equal(after.requests.latest.get(bot.id).intent, after.requests.pending.get(bot.id))
  assert.equal(after.requests.latest.get(bot.id).preparation, undefined)
  assert.equal(after.requests.rejectedPreparations.get(bot.id).preparation.publication, 'unknown')
})

test('retirement cancels producer timers and old callback handles cannot issue new native work', async t => {
  const f = await fixture(t)
  await tick()
  await f.engine.control('quiesce')
  const before = f.calls.length
  await f.engine.disconnect()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.calls.length, before)
  await assert.rejects(f.engine.control('resume'), { code: 'EXECUTION_GENERATION_RETIRED' })
  assert.throws(() => createExecutionDispatcher({ generation: 'bad', ports: { ...f.ports, arbitraryRpc() {} } }), { code: 'EXECUTION_PORTS_INVALID' })
})

test('202 deletion keeps the engine live until background cleanup and its final callback really finish', async t => {
  const removal = deferred()
  const f = await fixture(t)
  // Existing retired member cleanup does not issue native stop.
  f.bots.delete(bot.id)
  f.bots.hasPendingRemoval = async () => true
  f.bots.remove = () => removal.promise
  assert.deepEqual(await f.engine.dispatch(request('administration.remove', bot.id)), { deleting: bot.id })
  await assert.rejects(f.engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  removal.resolve({ removed: true }); await f.engine.control('quiesce', { timeoutMs: 200 })
  await f.engine.disconnect(); assert.equal(f.closes(), 0)
})

test('an observer admitted before quiesce cannot create a new watch after its native await', async t => {
  const observed = deferred(), read = deferred()
  let waits = 0
  const f = await fixture(t, name => name === 'pty_list' ? observed.promise : undefined,
    { waitProcess: () => { waits++; return new Promise(() => {}) } })
  // The real timer has already entered its native read when the root closes.
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(f.calls.includes('pty_list'))
  await assert.rejects(f.engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  observed.resolve({ _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [{
    session_id: bot.session, turn: { state: 'running', turn_id: 'unowned', wait_process: { executable: 'stub', args: [] } },
  }] } } })
  await f.engine.control('quiesce', { timeoutMs: 200 })
  assert.equal(waits, 0)
  await f.engine.disconnect()
})

 test('a failure completed during drain defers its new recovery root until old-generation resume', async t => {
  const wait = deferred(); let authCalls = 0
  const f = await fixture(t, null, { waitProcess: () => wait.promise,
    continuation: { models: {}, messenger: {}, harnessAuth: { status: async () => { authCalls++; return { status: 'unauthenticated' } } } } })
  await f.engine.dispatch(request('transport.notify', bot, 'synthetic', { queue: { groupId: '11111111-1111-4111-8111-111111111111' } }))
  await assert.rejects(f.engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  wait.resolve({ schema: 'aiterm.agent-wait-result.v1', outcome: 'error', error: 'synthetic capacity', vendor: 'codex',
    session_id: bot.session, launch_id: 'a'.repeat(32), operation_id: null, turn_id: 'turn',
    failure: { category: 'capacity', execution: 'unknown', terminal: true, future_effects: 'unknown',
      boundary: { event_cursor: 1, operation_id: null, turn_id: 'turn' } } })
  await tick(); await tick()
  await assert.rejects(f.engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  assert.equal(authCalls, 0)
  await f.engine.control('resume'); await tick(); await tick()
  assert.ok(authCalls > 0)
  await f.engine.control('quiesce', { timeoutMs: 200 }); await f.engine.disconnect()
})


test('an uninitialized candidate can be discarded once without closing the shared native client', async t => {
  const f = await fixture(t, null, { initialize: false })
  const cleanup = f.engine.disconnect()
  await assert.rejects(f.engine.control('initialize'), { code: 'EXECUTION_GENERATION_RETIRED' })
  assert.deepEqual(await cleanup, { closed: true })
  assert.deepEqual(await f.engine.disconnect(), { closed: true })
  await assert.rejects(f.engine.control('initialize'), { code: 'EXECUTION_GENERATION_RETIRED' })
  assert.equal(f.calls.length, 0); assert.equal(f.closes(), 0)
})

test('a failed real configuration restore candidate can be discarded and does not keep observer timers', async t => {
  const f = await fixture(t, null, { initialize: false })
  // A file at the configured directory is a real restore/storage failure.
  await writeFile(f.ports.configurationStorage.root, 'synthetic invalid storage')
  await assert.rejects(f.engine.control('initialize'))
  const before = f.calls.length
  assert.deepEqual(await f.engine.disconnect(), { closed: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.calls.length, before); assert.equal(f.closes(), 0)
})

test('an initialization still awaiting actual storage cannot be discarded after a caller timeout', async t => {
  const f = await fixture(t, null, { initialize: false })
  const storage = f.ports.configurationStorage.root
  await mkdir(storage, { mode: 0o700 })
  // Block the actual directory read without replacing a business factory port.
  const { ConfigurationIntents } = await import('../src/configuration-intents.mjs')
  const original = ConfigurationIntents.prototype.pending, read = deferred()
  t.after(() => { ConfigurationIntents.prototype.pending = original })
  ConfigurationIntents.prototype.pending = function () { return this.root === storage ? read.promise : original.call(this) }
  const initializing = f.engine.control('initialize')
  await assert.rejects(f.engine.disconnect(), { code: 'EXECUTION_BUSY' })
  read.reject(Error('synthetic late storage failure'))
  await assert.rejects(initializing, /synthetic late storage failure/)
  assert.deepEqual(await f.engine.disconnect(), { closed: true })
  assert.equal(f.closes(), 0)
})

test('resume ACK retry is idempotent for the already running retained engine', async t => {
  const f = await fixture(t)
  await f.engine.control('quiesce')
  assert.deepEqual(await f.engine.control('resume'), { resumed: true })
  const calls = [...f.calls]
  assert.deepEqual(await f.engine.control('resume'), { resumed: true })
  assert.deepEqual(f.calls, calls, 'an ACK retry performs no native/recovery replay')
})

test('busy exchange hands an accepted running turn to the successor instead of refusing, and reads stay available', async t => {
  const wait = deferred(), answer = deferred()
  const f = await fixture(t)
  f.ports.seat.waitProcess = () => wait.promise
  const accepted = await f.engine.dispatch(request('transport.notify', bot, 'SYNTHETIC_BODY', { onAnswer: () => answer.promise }))
  assert.equal(accepted.delivery, 'running')
  // The full drain (close / install proof) still refuses while the turn runs.
  await assert.rejects(f.engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  await f.engine.control('resume')
  await f.engine.control('quiesce', { timeoutMs: 200, handover: true })
  // Reads keep answering from the old engine during the exchange; new work does not.
  assert.equal(f.engine.project(request('transport.queueItems')).length, 1)
  assert.deepEqual([...await f.engine.dispatch(request('transport.runningBots', [bot]))], [bot.id])
  assert.throws(() => f.engine.dispatch(request('transport.notify', bot, 'LATE')), { code: 'EXECUTION_NOT_ACCEPTING' })
  const state = f.engine.exportState({ handover: true })
  const next = createExecutionDispatcher({ generation: 'second', ports: f.ports, handoff: state })
  t.after(async () => { try { await next.control('quiesce', { timeoutMs: 200 }); await next.disconnect() } catch {} })
  await next.control('initialize')
  // The successor sees the same live turn (stop/queue/isIdle) and is not blocked by it.
  assert.equal(next.project(request('transport.queueItems')).length, 1)
  assert.equal(next.project(request('transport.isIdle', bot.id)), false)
  await next.control('quiesce', { timeoutMs: 200 }); await next.control('resume')
  let released = false
  void state.released.then(() => { released = true })
  await tick(); assert.equal(released, false)
  wait.resolve({ outcome: 'done', turn_id: 'turn' }); answer.resolve()
  await state.released
  assert.deepEqual(await f.engine.disconnect(), { closed: true })
  assert.equal(next.project(request('transport.queueItems')).length, 0)
  assert.equal(next.project(request('transport.isIdle', bot.id)), true)
  assert.equal(f.closes(), 0)
})
