import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const setup = dispatch => {
  const gate = new ConversationLifetimes(), root = gate.enter()
  const delivery = gate.registerDelivery(root, { deliveryId: 'delivery-a', target: 'bot-a', kinds: ['user.complete'], dispatch })
  return { gate, root, delivery }
}

test('caller deadline preserves original callback actual ACK and permits old resume while busy', async () => {
  const actual = Promise.withResolvers(), callerError = Object.assign(Error('caller deadline'), { code: 'CONVERSATION_IPC_TIMEOUT' })
  const caller = Promise.reject(callerError); caller.catch(() => {}); caller.completion = actual.promise
  const { gate, root, delivery } = setup(() => caller)
  const callback = gate.invoke(delivery, 'user.complete', { reply: { text: 'saved' } })
  let settled = false; callback.then(() => { settled = true }, () => { settled = true })
  gate.finish(delivery); gate.finish(root); const ticket = gate.close()
  await tick(); assert.equal(settled, false); assert.equal(gate.snapshot().unconfirmed, false)
  assert.deepEqual(await gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  gate.resume(ticket); gate.assertLease(root); gate.assertLease(delivery)
  actual.resolve({ applied: true }); assert.deepEqual(await callback, { applied: true })
  await tick(); assert.equal(gate.snapshot().active, 0); assert.equal(gate.snapshot().unconfirmed, false)
})

test('caller success cannot substitute for still pending actual save ACK', async () => {
  const actual = Promise.withResolvers(), caller = Promise.resolve({ applied: true }); caller.completion = actual.promise
  const { gate, delivery } = setup(() => caller)
  let settled = false; const callback = gate.invoke(delivery, 'user.complete', {})
  callback.then(() => { settled = true }, () => { settled = true }); await tick(); assert.equal(settled, false)
  actual.resolve({ applied: true }); await callback; assert.equal(gate.snapshot().unconfirmed, false)
})

test('actual callback rejection preserves the original error and fails protocol', async () => {
  const actual = Promise.withResolvers(), caller = Promise.resolve({ applied: true }); caller.completion = actual.promise
  const { gate, delivery } = setup(() => caller), original = Error('actual save rejected')
  const callback = gate.invoke(delivery, 'user.complete', {}), rejected = assert.rejects(callback, error => error === original)
  actual.reject(original); await rejected; assert.equal(gate.snapshot().unconfirmed, true)
  await assert.rejects(gate.drain(gate.close()), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
})

test('invalid actual ACK remains protocol failure even when caller claimed success', async () => {
  const caller = Promise.resolve({ applied: true }); caller.completion = Promise.resolve({ applied: true, extra: true })
  const { gate, delivery } = setup(() => caller)
  await assert.rejects(gate.invoke(delivery, 'user.complete', {}), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.equal(gate.snapshot().unconfirmed, true)
})
