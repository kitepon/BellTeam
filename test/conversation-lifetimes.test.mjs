import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const register = (gate, root, fields = {}) => gate.registerDelivery(root, { deliveryId: 'delivery-a', target: 'bot-a', kinds: ['delivery.status', 'delivery.words', 'delivery.answer', 'user.complete', 'turn.end'], dispatch: async () => ({ applied: true }), ...fields })

test('admission is synchronous and unlimited lifetimes do not consume the separate eight root slots', async () => {
  const gate = new ConversationLifetimes('builtin:test'), roots = Array.from({ length: 12 }, (_, n) => gate.enter(gate.capture(), `operation-${n}`))
  const ticket = gate.close(); assert.throws(() => gate.enter(), { code: 'CONVERSATION_NOT_ACCEPTED' }); assert.equal(gate.tryEnter(), null)
  for (const root of roots) { gate.assertLease(root); gate.finish(root) }
  assert.deepEqual(await gate.drain(ticket), { status: 'drained' }); gate.adopt(ticket, 'signed:new'); gate.resume(ticket)
  assert.equal(gate.capture().generation, 'signed:new')
})
test('accepted caller completion requests finish but real job and callback ACK keep old generation live', async () => {
  const gate = new ConversationLifetimes(), actual = deferred(), ack = deferred()
  let root, delivery
  await gate.withLease(lease => { root = lease; delivery = register(gate, lease, { dispatch: () => ack.promise }); gate.trackCompletion(delivery, actual.promise); return { accepted: true } })
  gate.finish(delivery); const ticket = gate.close(), waiting = gate.drain(ticket)
  const status = gate.invoke(delivery, 'delivery.status', { delivery: 'running' }); actual.resolve(); await tick()
  assert.equal(gate.snapshot().active, 2); gate.assertLease(root); gate.assertLease(delivery)
  ack.resolve({ applied: true }); await status
  assert.deepEqual(await waiting, { status: 'drained' })
})
test('60-second busy keeps same live capabilities; old resume opens new roots without AI abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = new ConversationLifetimes(), root = gate.enter(), actual = deferred()
  gate.trackCompletion(root, actual.promise); gate.finish(root); const ticket = gate.close(), waiting = gate.drain(ticket)
  t.mock.timers.tick(60_000); assert.deepEqual(await waiting, { status: 'busy' })
  gate.assertLease(root); assert.throws(() => gate.adopt(ticket, 'new'))
  gate.resume(ticket); const another = gate.enter(); gate.finish(another); actual.resolve(); await tick()
  assert.equal(gate.snapshot().active, 0)
})
test('generation/correlation/object identity remain authoritative after closure', () => {
  const gate = new ConversationLifetimes(), root = gate.enter(undefined, 'root'), ticket = gate.close()
  gate.assertLease(root, { generation: 'builtin', correlation: 'root' })
  assert.throws(() => gate.assertLease({ ...root })); assert.throws(() => gate.assertLease(root, { correlation: 'other' }))
  gate.finish(root); gate.adopt(ticket, 'new'); assert.throws(() => gate.assertLease(root)); gate.resume(ticket)
})
test('registered correlation pins all five callback keys and refuses forged or late callbacks', async () => {
  const gate = new ConversationLifetimes(), root = gate.enter(undefined, 'operation-a'), seen = []
  const delivery = register(gate, root, { dispatch: async (kind, args, binding) => { seen.push(binding); return { applied: true } } })
  const binding = gate.binding(delivery, 'delivery.words'); gate.assertCallback(delivery, binding)
  await gate.invoke(delivery, 'delivery.words', { words: [{ text: 'work' }] })
  assert.deepEqual(seen, [{ generation: 'builtin', operationId: 'operation-a', deliveryId: 'delivery-a', target: 'bot-a', callbackKind: 'delivery.words' }])
  assert.throws(() => gate.assertCallback(delivery, { ...binding, target: 'other' }), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  gate.finish(delivery); gate.finish(root); await tick(); const ticket = gate.close()
  await assert.rejects(gate.drain(ticket), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.throws(() => gate.adopt(ticket, 'new'))
})
test('callback after terminal cannot be dropped as success or revive a new generation', async () => {
  const gate = new ConversationLifetimes(), root = gate.enter(), delivery = register(gate, root)
  gate.finish(delivery); gate.finish(root); await tick(); const ticket = gate.close()
  assert.deepEqual(await gate.drain(ticket), { status: 'drained' })
  assert.throws(() => gate.invoke(delivery, 'delivery.answer', { text: 'late' }), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.throws(() => gate.adopt(ticket, 'new'))
})
test('non-awaited turn.end registers background before return; one report continues under the old operation', async () => {
  const gate = new ConversationLifetimes(), root = gate.enter(), end = deferred(), actualReport = deferred()
  let source, report
  source = register(gate, root, { dispatch: async (kind) => {
    if (kind === 'turn.end') {
      report = gate.deriveReport(source, { deliveryId: 'report-a', reason: 'missing', dispatch: async () => ({ applied: true }) })
      gate.trackCompletion(report, actualReport.promise); gate.finish(report); await end.promise
    }
    return { applied: true }
  } })
  const background = gate.invoke(source, 'turn.end', { startedAt: 'a', endedAt: 'b' })
  gate.finish(source); gate.finish(root); const ticket = gate.close(), waiting = gate.drain(ticket)
  assert.equal(gate.snapshot().active, 3)
  end.resolve(); await background; await tick(); gate.assertLease(report)
  actualReport.resolve(); assert.deepEqual(await waiting, { status: 'drained' })
})
test('report rights are target-fixed, one-shot and cannot recur', async () => {
  const gate = new ConversationLifetimes(), root = gate.enter(), source = register(gate, root)
  let report
  await gate.runBackground(source, async () => {
    report = gate.deriveReport(source, { deliveryId: 'report-a', reason: 'content', dispatch: async () => ({ applied: true }) })
    assert.equal(gate.binding(report, 'delivery.answer').target, 'bot-a')
    assert.throws(() => gate.deriveReport(source, { deliveryId: 'report-b', reason: 'content', dispatch() {} }), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
    assert.throws(() => gate.runBackground(report, () => Promise.resolve()), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  })
  gate.finish(report); gate.finish(source); gate.finish(root); await tick()
})
test('missing or malformed save ACK is protocol unknown and cannot permit a successful drain', async () => {
  for (const result of [undefined, { applied: false }, { applied: true, extra: true }]) {
    const gate = new ConversationLifetimes(), root = gate.enter(), delivery = register(gate, root, { dispatch: async () => result })
    await assert.rejects(gate.invoke(delivery, 'delivery.status', { delivery: 'running' }), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
    gate.finish(delivery); gate.finish(root); await tick(); await assert.rejects(gate.drain(gate.close()))
  }
})
