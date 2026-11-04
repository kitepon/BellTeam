import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const done = { outcome: 'done', turn_id: 'synthetic-turn' }
function fixture(t, { kinds = [], dispatch = async () => ({ applied: true }), receipt } = {}) {
  const gate = new ConversationLifetimes('synthetic-native'), root = gate.enter(), waiting = Promise.withResolvers()
  let sends = 0, waits = 0
  const delivery = gate.registerDelivery(root, { deliveryId: 'delivery-native', target: 'bot-native', kinds, dispatch })
  const binding = { generation: root.generation, operationId: root.correlation, deliveryId: 'delivery-native', target: 'bot-native' }
  const transport = new AitermTransport({ conversationAdmission: gate,
    waitProcess: () => { waits++; return waiting.promise }, client: { async call(name) {
      if (name === 'pty_send') { sends++; return { structuredContent: receipt ?? { mode: 'agent_dispatch', event_cursor: 1,
        wait_process: { executable: 'synthetic-only', args: [] } } } }
      assert.equal(name, 'pty_read'); return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: done.turn_id, text: 'synthetic reply' } }
    }, async close() {} } })
  const turn = () => transport.turn({ id: 'bot-native', session: 'bot-native' }, 'synthetic only', {
    queue: { groupId: binding.deliveryId }, conversationDelivery: delivery,
  })
  let closeFailure = null
  t.after(async () => {
    waiting.resolve(done)
    if (closeFailure) await assert.rejects(transport.close(), error => error === closeFailure)
    else await transport.close()
    gate.finish(root)
  })
  return { gate, root, delivery, binding, waiting, transport, turn, sends: () => sends, waits: () => waits, expectCloseFailure: error => { closeFailure = error } }
}

test('registration and claim alone never expose a native continuation promise', () => {
  const gate = new ConversationLifetimes('synthetic'), root = gate.enter()
  const delivery = gate.registerDelivery(root, { deliveryId: 'd', target: 'bot-a', kinds: [], dispatch() {} })
  const binding = { generation: root.generation, operationId: root.correlation, deliveryId: 'd', target: 'bot-a' }
  assert.equal(gate.getNativeContinuation(delivery, binding), null)
  gate.claimNative(delivery, { deliveryId: 'd', target: 'bot-a', kind: 'turn' })
  assert.equal(gate.getNativeContinuation(delivery, binding), null)
  assert.equal(gate.getNativeContinuation({ ...delivery }, binding), null)
  gate.finish(delivery); gate.finish(root)
})

test('Q native proof is its real waiter while user.complete ACK retains an independent lifetime', async t => {
  const ack = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(() => ack.resolve({ applied: true }))
  const f = fixture(t, { kinds: ['user.complete'], dispatch: () => { entered.resolve(); return ack.promise } })
  const result = f.turn(); await result.accepted
  const native = f.gate.getNativeContinuation(f.delivery, f.binding)
  assert.ok(native instanceof Promise); assert.notEqual(native, result)
  for (const key of Object.keys(f.binding)) assert.equal(f.gate.getNativeContinuation(f.delivery, { ...f.binding, [key]: 'wrong' }), null)
  for (const binding of [null, {}, { ...f.binding, extra: true }]) assert.equal(f.gate.getNativeContinuation(f.delivery, binding), null)
  assert.equal(f.gate.getNativeContinuation(f.delivery, Object.assign(Object.create(f.binding), { a: 1, b: 2, c: 3, d: 4 })), null)
  assert.equal(f.gate.getNativeContinuation(f.root, f.binding), null)
  f.waiting.resolve(done); await entered.promise
  assert.equal(f.gate.getNativeContinuation(f.delivery, f.binding), null)
  assert.ok(f.gate.snapshot().active >= 2)
  assert.equal((await native).turn_id, done.turn_id)
  ack.resolve({ applied: true }); assert.equal(await result, 'synthetic reply'); await tick()
  assert.equal(f.gate.getNativeContinuation(f.delivery, f.binding), null)
  assert.equal(f.sends(), 1); assert.equal(f.waits(), 1)
})

test('Q real native waiter is registered before the still-pending running ACK', async t => {
  const ack = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(() => ack.resolve({ applied: true }))
  const f = fixture(t, { kinds: ['delivery.status'], dispatch: async (_kind, params) => {
    if (params.delivery === 'running') { entered.resolve(); return ack.promise }
    return { applied: true }
  } })
  const result = f.turn(); await entered.promise
  const native = f.gate.getNativeContinuation(f.delivery, f.binding)
  assert.ok(native instanceof Promise); assert.notEqual(native, result)
  assert.equal(f.waits(), 1)
  ack.resolve({ applied: true }); await result.accepted
  assert.equal(f.gate.getNativeContinuation(f.delivery, f.binding), native)
  f.waiting.resolve(done); await result
})

test('Q unknown native rejection ends positive proof but preserves physical occupation and the original failure', async t => {
  const f = fixture(t), result = f.turn(), failure = Error('synthetic unknown')
  result.catch(() => {}); await result.accepted
  assert.ok(f.gate.getNativeContinuation(f.delivery, f.binding) instanceof Promise)
  f.expectCloseFailure(failure)
  f.waiting.reject(failure); await assert.rejects(result, error => error === failure); await tick()
  assert.equal(f.gate.getNativeContinuation(f.delivery, f.binding), null)
  assert.equal(f.sends(), 1); assert.equal(f.transport.isIdle('bot-native'), false)
})

test('accepted steer without a real follow handle does not expose an invented native wait', async t => {
  const f = fixture(t, { receipt: { mode: 'agent_steer' } }), result = f.turn()
  assert.equal((await result.accepted).delivery, 'steered'); await result
  assert.equal(f.gate.getNativeContinuation(f.delivery, f.binding), null)
  assert.equal(f.waits(), 0); assert.equal(f.sends(), 1)
})
