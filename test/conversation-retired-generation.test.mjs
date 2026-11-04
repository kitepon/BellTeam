import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { createConversationExecutionEffects } from '../src/conversation-execution-effects.mjs'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const register = (gate, root, dispatch = async () => ({ applied: true })) => gate.registerDelivery(root, {
  deliveryId: 'delivery', target: 'bot-a', kinds: ['delivery.status'], dispatch,
})

test('retired real completions survive candidate failure and current admission; old effects fail without new failure', async () => {
  let dispatches = 0, failures = 0
  const gate = new ConversationLifetimes('old', { onProtocolFailure: () => failures++ })
  const root = gate.enter(undefined, 'old-operation'), delivery = register(gate, root, async () => { dispatches++; return { applied: true } })
  const actual = deferred(), rootDone = gate.operationCompletion(root), deliveryDone = gate.deliveryCompletion(delivery)
  gate.claimNative(delivery, { deliveryId: 'delivery', target: 'bot-a', kind: 'notify' })
  const ticket = gate.close()
  gate.recoverFailedGeneration(ticket, 'old', 'candidate')
  gate.trackNativeContinuation(delivery, { mode: 'agent_dispatch', event_cursor: 1, wait_process: 'wait' }, actual.promise)
  gate.finish(delivery); gate.finish(root)
  assert.equal(gate.operationCompletion(root), rootDone); assert.equal(gate.deliveryCompletion(delivery), deliveryDone)
  gate.assertLease(root, { generation: 'old', correlation: 'old-operation' })
  assert.throws(() => gate.recoverFailedGeneration(ticket, 'old', 'wrong'))
  assert.throws(() => gate.recoverFailedGeneration(ticket, 'candidate', 'old'))
  assert.throws(() => gate.recoverFailedGeneration({ ...ticket }, 'candidate', 'wrong'))
  gate.recoverFailedGeneration(ticket, 'candidate', 'new')
  assert.throws(() => gate.enter())
  gate.resume(ticket)
  assert.throws(() => gate.invoke(delivery, 'delivery.status', { delivery: 'running' }), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED', status: 503 })
  assert.throws(() => gate.claimNative(delivery, { deliveryId: 'delivery', target: 'bot-a', kind: 'notify' }))
  assert.throws(() => gate.registerDelivery(root, { deliveryId: 'new-delivery', target: 'bot-b', kinds: [], dispatch() {} }))
  assert.equal(dispatches, 0); assert.equal(failures, 0)
  assert.throws(() => gate.enter(undefined, 'old-operation'))
  const fresh = gate.enter(undefined, 'new-operation'); gate.finish(fresh)
  assert.equal(gate.snapshot().active, 2)
  let ended = false; rootDone.then(() => { ended = true }); await tick(); assert.equal(ended, false)
  const closeTicket = gate.close(), close = gate.drainForClose(closeTicket)
  let closed = false; const rejectedClose = assert.rejects(close, { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' }).then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  actual.resolve(); await rejectedClose; await rootDone; await deliveryDone
  assert.equal(gate.snapshot().active, 0)
})

test('failure before retirement does not prevent fresh writer resume; close waits real reference then reports original unknown', async () => {
  const gate = new ConversationLifetimes('old'), root = gate.enter(), actual = deferred()
  const original = new Error('dead writer'), delivery = register(gate, root, async () => { throw original })
  gate.trackCompletion(delivery, actual.promise)
  await assert.rejects(gate.invoke(delivery, 'delivery.status', { delivery: 'running' }), error => error === original)
  gate.finish(delivery); gate.finish(root)
  const ticket = gate.close(); gate.recoverFailedGeneration(ticket, 'old', 'new'); gate.resume(ticket)
  const fresh = gate.enter(); gate.finish(fresh)
  const closeTicket = gate.close()
  await assert.rejects(gate.drain(closeTicket), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.deepEqual(await gate.drainForClose(closeTicket, { timeoutMs: 0 }), { status: 'busy' })
  const close = assert.rejects(gate.drainForClose(closeTicket), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  actual.resolve(); await close
})

test('whole close drains both live generations with no unknown; normal recover and adopt remain global active-zero', async () => {
  const gate = new ConversationLifetimes('old'), old = gate.enter(), actual = deferred()
  gate.trackCompletion(old, actual.promise); gate.finish(old)
  const ticket = gate.close(); gate.recoverFailedGeneration(ticket, 'old', 'new'); gate.resume(ticket)
  const current = gate.enter(), next = deferred(); gate.trackCompletion(current, next.promise); gate.finish(current)
  const closeTicket = gate.close()
  assert.throws(() => gate.adopt(closeTicket, 'adopted')); assert.throws(() => gate.recover(closeTicket, 'new', 'recovered'))
  let done = false; const close = gate.drainForClose(closeTicket).then(value => { done = true; return value })
  actual.resolve(); await tick(); assert.equal(done, false)
  next.resolve(); assert.deepEqual(await close, { status: 'drained' }); assert.equal(gate.snapshot().active, 0)
})

test('fixed execution effect rejects genuine retired context before service access; cleanup keeps original lease', async () => {
  const gate = new ConversationLifetimes('old'), root = gate.enter()
  const ticket = gate.close(); gate.recoverFailedGeneration(ticket, 'old', 'new'); gate.resume(ticket)
  let serviceReads = 0
  const effect = createConversationExecutionEffects({ admission: gate, getServices: () => { serviceReads++; return {} }, getController: () => ({}) })
  await assert.rejects(effect('execution.shown.read', {}, { conversationLease: root, generation: 'old', operationId: root.correlation }),
    { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.equal(serviceReads, 0); gate.finish(root)
  const fresh = gate.enter(); gate.finish(fresh)
})
