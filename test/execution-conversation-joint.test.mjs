import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const bot = { id: 'bot-synthetic', session: 'bot-synthetic', harness: 'codex' }, launch = 'a'.repeat(32)
const group = '11111111-1111-4111-8111-111111111111'
const done = { schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: bot.id, launch_id: launch, vendor: 'codex', turn_id: 'turn-a', operation_id: null }
function fixture(t, { kinds, dispatch, ...options }) {
  const gate = new ConversationLifetimes('synthetic'), wait = deferred(); let sends = 0
  const transport = new AitermTransport({ conversationAdmission: gate, waitProcess: () => wait.promise,
    client: { async call(name, args, options) {
      if (name === 'pty_send') { options.admissionCheck(); sends++; return { structuredContent: { mode: 'agent_dispatch', session_id: bot.id, launch_id: launch, vendor: 'codex', event_cursor: 1, wait_process: { executable: 'fake', args: [] } } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'reply', turn_id: 'turn-a' } }
      throw Error('unexpected ' + name)
    } }, ...options })
  const root = gate.enter(), delivery = gate.registerDelivery(root, { deliveryId: group, target: bot.id, kinds, dispatch })
  t.after(async () => { wait.resolve(done); await transport.close() })
  return { gate, root, delivery, transport, wait, sends: () => sends }
}
test('notify keeps captured admission check after fresh await and holds failed callback ACK without native resend', async t => {
  const fresh = deferred(), ack = deferred(), began = deferred(); let valid = true
  const f = fixture(t, { kinds: ['delivery.status'], requireAccess: () => fresh.promise,
    dispatch: async (kind, params) => { assert.equal(params.delivery, 'failed'); began.resolve(); return ack.promise } })
  const accepted = f.transport.notify(bot, 'synthetic', { queue: { groupId: group }, conversationDelivery: f.delivery,
    admissionCheck: () => { if (!valid) throw Object.assign(Error('superseded'), { code: 'SUPERSEDED' }) } })
  valid = false; fresh.resolve(); await assert.rejects(accepted, { code: 'SUPERSEDED' }); await began.promise
  f.gate.finish(f.root); const ticket = f.gate.close()
  assert.equal(f.sends(), 0); assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  ack.resolve({ applied: true }); await f.transport.idle(bot.id); await tick()
  assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' })
})
test('saved user completion ACK stays live while only native completion clears capacity state', async t => {
  const ack = deferred(), began = deferred(), successes = [], failures = []
  const f = fixture(t, { kinds: ['user.complete'], dispatch: async () => { began.resolve(); return ack.promise } })
  f.transport.continuation = { async close() {}, succeeded: (...args) => successes.push(args), failed: context => failures.push(context) }
  const result = f.transport.turn(bot, 'synthetic', { queue: { groupId: group }, conversationDelivery: f.delivery, admissionCheck() {} })
  await result.accepted; f.gate.finish(f.root); const ticket = f.gate.close(); f.wait.resolve(done); await began.promise
  assert.deepEqual(successes, [[bot.id, group]]); assert.equal(failures.length, 0)
  assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  ack.resolve({ applied: true }); assert.equal(await result, 'reply'); await tick()
  assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' }); assert.equal(f.sends(), 1)
})
test('bound capacity terminal remains eligible after failed-status ACK, with same native failure and no replay', async t => {
  const ack = deferred(), began = deferred(), recovered = []
  const f = fixture(t, { kinds: ['delivery.status'], dispatch: async (kind, params) => {
    if (params.delivery === 'failed') { began.resolve(); return ack.promise } return { applied: true }
  } })
  f.transport.continuation = { async close() {}, failed: context => recovered.push(context), succeeded: () => assert.fail('failed turn succeeded') }
  const result = f.transport.submit(bot, 'synthetic', { info: { groupId: group }, conversationDelivery: f.delivery, admissionCheck() {} })
  const rejected = assert.rejects(result, { waitOutcome: 'error' })
  await result.accepted; f.gate.finish(f.root); const ticket = f.gate.close()
  f.wait.resolve({ ...done, outcome: 'error', error: 'capacity', failure: { category: 'capacity', execution: 'unknown', terminal: true,
    future_effects: 'unknown', boundary: { event_cursor: 1, operation_id: null, turn_id: 'turn-a' } } })
  await began.promise; assert.equal(recovered.length, 0)
  assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  ack.resolve({ applied: true }); await rejected; await tick()
  assert.equal(recovered.length, 1); assert.equal(recovered[0].deliveryId, group); assert.equal(recovered[0].failure.execution, 'unknown')
  recovered[0].check(); assert.equal(f.sends(), 1); assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' })
})
test('real dispatcher passes parent dual reservation to deletion and tracks actual cleanup after 202', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-conversation-joint-')); t.after(() => rm(root, { recursive: true, force: true }))
  const members = new MembersAdmission(), gate = new ConversationLifetimes('synthetic'), release = deferred(), began = deferred()
  let context, finishes = 0, closes = 0
  const moduleOperations = { reserve() { assert.equal(context, undefined); return context = Object.freeze({ membersLease: members.enter(), conversationLease: gate.enter() }) },
    finish(actual) { assert.equal(actual, context); members.finish(actual.membersLease); gate.finish(actual.conversationLease); finishes++ } }
  const check = actual => { assert.equal(actual, context); members.assertLease(actual.membersLease); gate.assertLease(actual.conversationLease) }
  const bots = { get: () => null, list: () => [], async refresh(options) { check(options) }, async hasPendingRemoval(id, options) { check(options); return true },
    async remove(id, options) { check(options); began.resolve(); await release.promise; return { id } } }
  const engine = createExecutionDispatcher({ generation: 'synthetic', ports: { native: { async call(name) { assert.equal(name, 'pty_list'); return { content: [{ type: 'text', text: '' }] } }, async close() { closes++ } },
    membersAdmission: members, conversationAdmission: gate, moduleOperations, bots, rooms: {}, configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() }, access: { assertWorkAllowed() {} } } })
  await engine.control('initialize')
  assert.deepEqual(await engine.dispatch({ method: 'administration.remove', args: [bot.id] }), { deleting: bot.id }); await began.promise
  assert.equal(finishes, 0); await assert.rejects(engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  members.assertLease(context.membersLease); gate.assertLease(context.conversationLease)
  release.resolve(); await engine.control('quiesce', { timeoutMs: 500 }); await engine.disconnect()
  assert.equal(finishes, 1); assert.equal(closes, 0); assert.equal(gate.snapshot().active, 0)
})

test('real engine stays busy for gate-generated background callback after native job idle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-callback-joint-')); t.after(() => rm(root, { recursive: true, force: true }))
  const gate = new ConversationLifetimes('synthetic'), ack = deferred(), began = deferred()
  const bots = new Map([[bot.id, bot]]); bots.list = () => []; let closes = 0, sends = 0
  const engine = createExecutionDispatcher({ generation: 'synthetic', ports: { native: { async call(name) {
    if (name === 'pty_list') return { content: [{ type: 'text', text: '' }] }
    if (name === 'pty_send') { sends++; return { structuredContent: { mode: 'agent_dispatch', session_id: bot.id, launch_id: launch, vendor: 'codex', event_cursor: 1, wait_process: { executable: 'fake', args: [] } } } }
    throw Error('unexpected ' + name)
  }, async close() { closes++ } }, bots, rooms: {}, membersAdmission: new MembersAdmission(), conversationAdmission: gate,
    configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() }, access: { assertWorkAllowed() {} }, seat: { waitProcess: async () => done } } })
  await engine.control('initialize')
  const operation = gate.enter(), delivery = gate.registerDelivery(operation, { deliveryId: group, target: bot.id, kinds: ['turn.end'], dispatch: async () => { began.resolve(); return ack.promise } })
  assert.deepEqual(await engine.dispatch({ method: 'transport.notify', args: [bot, 'synthetic', { queue: { groupId: group }, conversationDelivery: delivery }] }), { delivery: 'running' })
  gate.finish(operation); await began.promise
  await engine.dispatch({ method: 'transport.idle', args: [bot.id] })
  await assert.rejects(engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  ack.resolve({ applied: true }); await engine.control('quiesce', { timeoutMs: 500 }); await engine.disconnect()
  assert.equal(sends, 1); assert.equal(closes, 0); assert.equal(gate.snapshot().active, 0)
})
