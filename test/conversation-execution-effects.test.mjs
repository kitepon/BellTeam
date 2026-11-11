import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationExecutionEffects } from '../src/conversation-execution-effects.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const admission = new ConversationLifetimes('synthetic'), lease = admission.enter(undefined, 'operation-a')
  const members = new MembersAdmission(), bot = { id: 'bot-a' }, actual = deferred(), controller = { callback() {} }, check = () => {}, operations = Object.freeze({ membersLease: members.enter() })
  const context = { generation: 'synthetic', operationId: 'operation-a', rootMethod: 'direct.post', conversationLease: lease,
    operationContext: operations, actualCompletion: actual.promise, admissionCheck: check, capturedAuthority: Object.freeze({}) }
  const services = { aiControl: { assertEnabled() {} }, bots: { async refresh(options) { assert.equal(options, operations) }, get: id => id === bot.id ? bot : null }, transport: {} }
  const effect = createConversationExecutionEffects({ getServices: () => services, getController: () => controller, admission })
  const params = { deliveryId: 'delivery-a', target: bot.id, message: 'synthetic', images: [], queue: { groupId: 'delivery-a', target: bot.id }, kinds: [] }
  return { admission, members, lease, context, bot, services, effect, params, controller }
}
test('native adapter preserves original opaque options and guard, uses registered delivery once and returns accepted only', async () => {
  const f = fixture(), wait = deferred(); let calls = 0
  f.context.conversationDelivery = f.admission.registerDelivery(f.lease, { deliveryId: 'delivery-a', target: f.bot.id, kinds: [], dispatch() {} })
  f.services.transport.turn = (bot, message, options) => {
    calls++; assert.equal(bot, f.bot); assert.equal(options.admissionCheck, f.context.admissionCheck)
    for (const key of ['conversationDelivery', 'conversationLease', 'operationContext', 'actualCompletion', 'capturedAuthority']) assert.equal(options[key], f.context[key])
    assert.equal(options.membersLease, f.context.operationContext.membersLease)
    const result = wait.promise; result.accepted = Promise.resolve({ delivery: 'running' }); return result
  }
  assert.deepEqual(await f.effect('execution.turn', f.params, f.context), { delivery: 'running' }); assert.equal(calls, 1)
  wait.resolve('reply'); f.admission.finish(f.context.conversationDelivery); f.admission.finish(f.lease)
})
test('fresh await rechecks captured guard and refuses native call on cancellation or wrong delivery binding', async () => {
  const f = fixture(); let valid = true, calls = 0
  f.context.admissionCheck = () => { if (!valid) throw Error('cancelled') }
  f.context.conversationDelivery = f.admission.registerDelivery(f.lease, { deliveryId: 'delivery-a', target: f.bot.id, kinds: [], dispatch() {} })
  f.services.bots.refresh = async () => { valid = false }; f.services.transport.notify = () => { calls++ }
  await assert.rejects(f.effect('execution.notify', f.params, f.context), /cancelled/); assert.equal(calls, 0)
  valid = true; await assert.rejects(f.effect('execution.notify', { ...f.params, target: 'other' }, f.context)); assert.equal(calls, 0)
})
test('recovery object is bound to original operation/target/delivery and consumed once without reconstructing native receipt', async () => {
  const f = fixture(), target = { session_id: 'bot-a', launch_id: 'a'.repeat(32) }, native = { reservation: {}, binding: { target: { launch: target } } }
  f.services.transport.reconcileLaunch = async (bot, request, originalTarget) => { assert.deepEqual(request, { kind: 'delivery', delivery_id: 'delivery-a', target_session_id: 'bot-a' }); assert.equal(originalTarget, target); return native }
  const { recoveryId } = await f.effect('execution.reconcile', { botId: 'bot-a', deliveryId: 'delivery-a', target }, f.context)
  f.context.conversationDelivery = f.admission.registerDelivery(f.lease, { deliveryId: 'delivery-a', target: f.bot.id, kinds: [], dispatch() {} })
  f.services.transport.notify = async (bot, message, options) => { assert.equal(options.recoveredExecution, native); return { delivery: 'running' } }
  assert.deepEqual(await f.effect('execution.notify', { ...f.params, recoveryId }, f.context), { delivery: 'running' })
  await assert.rejects(f.effect('execution.notify', { ...f.params, recoveryId }, f.context), { code: 'CONVERSATION_EXECUTION_INVALID' })
})
test('closed launch receipt stays parent-only and same operation may consume it once', async () => {
  const f = fixture(), receipt = Object.freeze({ native: 'synthetic' }), target = { session_id: 'bot-a', launch_id: 'a'.repeat(32) }
  f.services.transport.closeLaunch = async () => receipt
  const result = await f.effect('execution.closeLaunch', { botId: 'bot-a', deliveryId: 'delivery-a', target }, f.context)
  assert.deepEqual(Object.keys(result), ['closureId'])
  assert.throws(() => f.effect.consumeClosure(result.closureId, {}), { code: 'CONVERSATION_EXECUTION_INVALID' })
  assert.equal(f.effect.consumeClosure(result.closureId, f.context.operationContext), receipt)
  assert.throws(() => f.effect.consumeClosure(result.closureId, f.context.operationContext), { code: 'CONVERSATION_EXECUTION_INVALID' })
})
test('shown handle keeps original object/prefix and cannot consume from another operation or a replacement watch', async () => {
  const f = fixture(); f.context.rootMethod = 'observation.poll'
  const shown = { words: ['old'], endedAt: 42 }; let current = shown
  f.services.transport.shownInSelfTurn = () => current
  f.services.transport.consumeShownWords = (id, captured, prefix) => { assert.equal(captured, shown); assert.deepEqual(prefix, ['old']); return current === captured }
  const handle = await f.effect('execution.shown.read', { botId: 'bot-a' }, f.context)
  shown.words.push('new'); assert.deepEqual(handle.words, ['old'])
  await assert.rejects(f.effect('execution.shown.consume', { botId: 'bot-a', shownId: handle.shownId }, { ...f.context, operationContext: {} }))
  current = { words: ['replacement'], endedAt: 43 }
  assert.deepEqual(await f.effect('execution.shown.consume', { botId: 'bot-a', shownId: handle.shownId }, f.context), { applied: false })
  await assert.rejects(f.effect('execution.background.begin', {}, f.context), { code: 'CONVERSATION_EXECUTION_INVALID' })
  await assert.rejects(f.effect('constructor', {}, f.context), { code: 'CONVERSATION_EXECUTION_INVALID' })
})
test('operationCompletion is the same real done Promise through delivery and release ACK; fake/delivery getters refused', async () => {
  const gate = new ConversationLifetimes('synthetic'), operation = gate.enter(), actual = gate.operationCompletion(operation), ack = deferred()
  assert.equal(gate.operationCompletion(operation), actual)
  const delivery = gate.registerDelivery(operation, { deliveryId: 'delivery-a', target: 'bot-a', kinds: [], dispatch() {} })
  assert.throws(() => gate.operationCompletion(delivery), { code: 'CONVERSATION_NOT_ACCEPTED' }); assert.throws(() => gate.operationCompletion({}), { code: 'CONVERSATION_NOT_ACCEPTED' })
  gate.trackCompletion(operation, ack.promise); gate.finish(operation); let ended = false; actual.then(() => { ended = true })
  gate.finish(delivery); await tick(); assert.equal(ended, false)
  ack.resolve(); await actual; assert.equal(ended, true)
  assert.throws(() => gate.operationCompletion(operation), { code: 'CONVERSATION_NOT_ACCEPTED' })
})

test('only registered unclaimed preparation refusal may finish early; native claimed and already finished do not', () => {
  const gate = new ConversationLifetimes('synthetic'), root = gate.enter()
  const options = deliveryId => ({ deliveryId, target: 'bot-a', kinds: [], dispatch() {} })
  const refused = gate.registerDelivery(root, options('refused')), issued = gate.registerDelivery(root, options('issued'))
  assert.equal(gate.finishUnclaimedDelivery(refused), true); assert.equal(gate.finishUnclaimedDelivery(refused), false)
  gate.claimNative(issued, { deliveryId: 'issued', target: 'bot-a', kind: 'notify' })
  assert.equal(gate.finishUnclaimedDelivery(issued), false); gate.assertDelivery(issued)
  assert.throws(() => gate.finishUnclaimedDelivery({}), { code: 'CONVERSATION_NOT_ACCEPTED' })
  gate.finish(issued); gate.finish(root)
})
test('adapter uses real Transport once and registered callback reaches same parent controller through actual done', async () => {
  const f = fixture(), calls = []; let delivery
  f.controller.callback = async (kind, params, options) => { assert.equal(options.conversationDelivery, delivery); calls.push([kind, params.delivery]); return { applied: true } }
  delivery = f.admission.registerDelivery(f.lease, { deliveryId: 'delivery-a', target: f.bot.id, kinds: ['delivery.status'],
    dispatch: (kind, params) => f.controller.callback(kind, params, { conversationDelivery: delivery }) })
  f.context.conversationDelivery = delivery
  const opDone = f.admission.operationCompletion(f.lease)
  f.services.transport = new AitermTransport({ conversationAdmission: f.admission, membersAdmission: f.members, client: { async call(name) {
    assert.equal(name, 'pty_send'); return { structuredContent: { mode: 'agent_dispatch', session_id: 'bot-a', launch_id: 'a'.repeat(32), event_cursor: 1, wait_process: { executable: 'synthetic', args: [] } } }
  } }, waitProcess: async () => ({ outcome: 'done', turn_id: 'synthetic' }) })
  assert.deepEqual(await f.effect('execution.notify', { ...f.params, kinds: ['delivery.status'] }, f.context), { delivery: 'running' })
  f.admission.finish(f.lease); await opDone
  assert.deepEqual(calls, [['delivery.status', 'running'], ['delivery.status', 'delivered']])
  await f.services.transport.close()
})
test('execution.fork (fork.md B7): same delivery binding and guard as notify, forkInquiry with the registered delivery, typed refusal kept', async () => {
  const f = fixture(); let calls = 0
  f.context.rootMethod = 'fork.ask'
  f.context.conversationDelivery = f.admission.registerDelivery(f.lease, { deliveryId: 'delivery-a', target: f.bot.id, kinds: ['delivery.status'], dispatch() {} })
  const params = { deliveryId: 'delivery-a', target: f.bot.id, forkId: 'fork-a', message: 'question', queue: f.params.queue, kinds: ['delivery.status'] }
  f.services.transport.forkInquiry = async (bot, message, options) => {
    calls++; assert.equal(bot, f.bot); assert.equal(message, 'question')
    assert.deepEqual(Object.keys(options).sort(), ['admissionCheck', 'conversationDelivery', 'deliveryId', 'forkId', 'membersLease', 'queue'])
    assert.equal(options.conversationDelivery, f.context.conversationDelivery); assert.equal(options.admissionCheck, f.context.admissionCheck)
    assert.equal(options.membersLease, f.context.operationContext.membersLease); assert.equal(options.queue, params.queue)
    assert.equal(options.forkId, 'fork-a'); assert.equal(options.deliveryId, 'delivery-a')
    return { delivery: 'running', forkId: 'fork-a' }
  }
  assert.deepEqual(await f.effect('execution.fork', params, f.context), { delivery: 'running', forkId: 'fork-a' }); assert.equal(calls, 1)
  await assert.rejects(f.effect('execution.fork', { ...params, target: 'other' }, f.context)); assert.equal(calls, 1)
  f.services.transport.forkInquiry = async () => { throw Object.assign(new Error('FORK_UNAVAILABLE'), { code: 'FORK_UNAVAILABLE', status: 503, effect: 'not_started' }) }
  await assert.rejects(f.effect('execution.fork', params, f.context), { code: 'FORK_UNAVAILABLE', status: 503 })
})
// fork-inquiry.md "Live relay members lease" (production 2026-11-12): the fork.ask root returned, so its members lease ended; the
// answer relay's execution.notify (a fork callback) re-enters members once with a fresh lease, like execution.report.
test('fork answer relay: execution.notify after the fork.ask root returned uses a fresh members lease and succeeds once', async () => {
  const f = fixture(); let calls = 0
  f.context.rootMethod = 'fork.ask'
  f.context.conversationDelivery = f.admission.registerDelivery(f.lease, { deliveryId: 'delivery-a', target: f.bot.id, kinds: [], dispatch() {} })
  const root = f.context.operationContext.membersLease
  f.members.finish(root)
  assert.throws(() => f.members.assertLease(root), 'the root lease is returned with the root result')
  f.services.bots.readMember = async (id, membersContext) => { f.members.assertLease(membersContext.membersLease) }
  f.services.transport.membersAdmission = f.members
  f.services.transport.notify = async (bot, message, options) => {
    calls++; assert.equal(bot, f.bot); assert.notEqual(options.membersLease, root)
    f.members.assertLease(options.membersLease)
    assert.equal(options.operationContext, f.context.operationContext, 'the conversation context is kept, only the members lease is fresh')
    return { delivery: 'running' }
  }
  assert.deepEqual(await f.effect('execution.notify', f.params, f.context), { delivery: 'running' }); assert.equal(calls, 1)
  // Any other root keeps its own members lease (unchanged): a direct.post notify on the ended lease is refused.
  f.context.rootMethod = 'direct.post'
  await assert.rejects(f.effect('execution.notify', f.params, f.context)); assert.equal(calls, 1)
  f.admission.finish(f.context.conversationDelivery); f.admission.finish(f.lease)
})
