import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => Promise.withResolvers()
const register = (gate, root, dispatch = async () => ({ applied: true })) => gate.registerDelivery(root,
  { deliveryId: 'delivery-a', target: 'bot-a', kinds: ['delivery.words'], dispatch })
const unknown = { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' }
const refused = { code: 'CONVERSATION_NOT_ACCEPTED' }

async function failedGeneration() {
  const failures = [], gate = new ConversationLifetimes('old', { onProtocolFailure: value => failures.push(value) })
  const root = gate.enter(), delivery = register(gate, root, async () => ({ applied: false })), callbacks = gate.callbacks(delivery)
  await assert.rejects(callbacks.onInterim(['old']), unknown)
  gate.finish(delivery); gate.finish(root); await tick()
  return { gate, root, delivery, callbacks, failures, ticket: gate.close() }
}

test('failed generation recovers closed; retired callbacks fail without poisoning a new root or drain', async () => {
  const { gate, root, delivery, callbacks, failures, ticket } = await failedGeneration()
  await assert.rejects(gate.drain(ticket), unknown)
  assert.throws(() => gate.adopt(ticket, 'new'), refused)
  gate.recover(ticket, 'old', 'new')
  assert.deepEqual(gate.snapshot(), { generation: 'new', closed: true, active: 0, unconfirmed: false })
  assert.throws(() => gate.enter(), refused)
  // The controller owns restore/ready and child resume ACK before opening the same ticket.
  gate.resume(ticket)
  const fresh = gate.enter(), actual = deferred()
  gate.trackCompletion(fresh, actual.promise); gate.finish(fresh)
  const freshTicket = gate.close(), draining = gate.drain(freshTicket)
  for (const operation of [
    () => callbacks.onInterim(['late']),
    () => gate.assertCallback(delivery, { generation: 'new' }),
    () => gate.deliveryFor(root, { deliveryId: 'delivery-a', target: 'bot-a' }),
    () => gate.runBackground(delivery, () => Promise.resolve()),
  ]) assert.throws(operation, unknown)
  assert.deepEqual(failures, [{ code: unknown.code, generation: 'old' }])
  assert.equal(gate.snapshot().unconfirmed, false)
  actual.resolve(); assert.deepEqual(await draining, { status: 'drained' })
  gate.adopt(freshTicket, 'third'); gate.resume(freshTicket)
})

test('recovery waits real native, parent effect and release ACK; preserves original native rejection', async () => {
  const gate = new ConversationLifetimes('old'), root = gate.enter(), delivery = register(gate, root)
  const native = deferred(), effect = deferred(), releaseAck = deferred(), nativeError = new Error('original native unknown')
  const nativeResult = native.promise.catch(error => error)
  gate.claimNative(delivery, { deliveryId: 'delivery-a', target: 'bot-a', kind: 'notify' })
  gate.trackCompletion(delivery, native.promise); gate.trackCompletion(root, effect.promise); gate.trackCompletion(root, releaseAck.promise)
  gate.trackNativeContinuation(delivery, { mode: 'agent_dispatch', event_cursor: 3, wait_process: 'original' }, native.promise)
  const originalDone = gate.operationCompletion(root)
  assert.throws(() => gate.assertCallback(delivery, {}), unknown)
  gate.finish(delivery); gate.finish(root); const ticket = gate.close()
  assert.throws(() => gate.recover(ticket, 'old', 'new'), refused)
  assert.equal(gate.operationCompletion(root), originalDone)
  native.reject(nativeError); assert.equal(await nativeResult, nativeError); await tick()
  assert.throws(() => gate.recover(ticket, 'old', 'new'), refused)
  effect.resolve(); await tick()
  assert.throws(() => gate.recover(ticket, 'old', 'new'), refused)
  releaseAck.reject(new Error('old ACK missing')); await originalDone
  gate.recover(ticket, 'old', 'new')
  assert.equal(gate.snapshot().active, 0)
})

test('recovery requires exact ticket, its original generation and a distinct valid next generation', async () => {
  const { gate, ticket } = await failedGeneration()
  for (const [candidate, previous, next] of [
    [{ ...ticket }, 'old', 'new'], [ticket, 'wrong', 'new'], [ticket, 'old', 'old'],
    [ticket, 'old', ''], [ticket, 'old', 'invalid generation'],
  ]) {
    assert.throws(() => gate.recover(candidate, previous, next), refused)
    assert.deepEqual(gate.snapshot(), { generation: 'old', closed: true, active: 0, unconfirmed: true })
  }
  gate.recover(ticket, 'old', 'new')
  assert.throws(() => gate.recover(ticket, 'old', 'another'), refused)
  assert.throws(() => gate.recover(ticket, 'new', 'another'), refused)
  gate.resume(ticket); assert.throws(() => gate.recover(ticket, 'new', 'another'), refused)
})

test('self-declared retired generation does not exempt a forged capability from current protocol failure', async () => {
  const { gate, delivery, failures, ticket } = await failedGeneration()
  gate.recover(ticket, 'old', 'new'); gate.resume(ticket)
  assert.throws(() => gate.invoke({ ...delivery }, 'delivery.words', { words: ['forged'] }), unknown)
  assert.equal(gate.snapshot().unconfirmed, true)
  assert.deepEqual(failures.map(value => value.generation), ['old', 'new'])
})

test('abnormal exit can recover a drained generation without requiring a callback failure', async () => {
  const gate = new ConversationLifetimes('old'), root = gate.enter(), ticket = gate.close()
  assert.throws(() => gate.recover(ticket, 'old', 'new'), refused)
  const done = gate.operationCompletion(root)
  gate.finish(root); await done
  gate.recover(ticket, 'old', 'new'); gate.resume(ticket)
  const next = gate.enter(); gate.finish(next)
  assert.equal(gate.snapshot().unconfirmed, false)
})

test('accepted transport native keeps recovery closed until its original waiter really settles, without another send', async t => {
  const gate = new ConversationLifetimes('old'), root = gate.enter(), waiting = deferred()
  const delivery = gate.registerDelivery(root, { deliveryId: 'native-a', target: 'bot-a', kinds: [], dispatch() {} })
  let sends = 0
  const transport = new AitermTransport({ conversationAdmission: gate,
    waitProcess: () => waiting.promise, client: { async call(name) {
      if (name === 'pty_send') { sends++; return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1,
        wait_process: { executable: 'synthetic-only', args: [] } } } }
      assert.equal(name, 'pty_read')
      return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'native-turn', text: 'original' } }
    }, async close() {} } })
  t.after(async () => { waiting.resolve({ outcome: 'done', turn_id: 'native-turn' }); await transport.close() })
  const result = transport.turn({ id: 'bot-a', session: 'bot-a' }, 'synthetic only', {
    queue: { groupId: 'native-a' }, conversationDelivery: delivery })
  await result.accepted
  const original = gate.operationCompletion(root), ticket = gate.close()
  gate.finish(root)
  assert.throws(() => gate.recover(ticket, 'old', 'new'), refused)
  assert.equal(gate.operationCompletion(root), original)
  waiting.resolve({ outcome: 'done', turn_id: 'native-turn' })
  assert.equal(await result, 'original'); await original
  gate.recover(ticket, 'old', 'new'); gate.resume(ticket)
  assert.equal(sends, 1)
})
