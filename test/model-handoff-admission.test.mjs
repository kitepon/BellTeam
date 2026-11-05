import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelHandoff } from '../src/model-handoff.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const binding = { id: '6cfad3b3-3d2d-4cc9-8cd0-4e632ac25728', session_id: 'seat', launch_id: 'a'.repeat(32), digest: 'b'.repeat(64) }
function fixture() {
  const calls = [], tracked = [], savingStop = deferred(), bindingReply = deferred()
  let failTerminal = false
  const requests = { claimHandoff() {}, intents: { saveHandoffStop: () => savingStop.promise }, recordHandoff: async (_bot, snapshot) => {
    if (failTerminal) throw Error('disk unavailable')
    return snapshot
  } }
  const handoff = new ModelHandoff({ transport: {}, requests, records: new Map(), trackCompletion: value => tracked.push(value) })
  const operation = handoff.begin({ context: { operation: binding, native_call: { server_instance: 'server', thread_id: 'thread', turn_id: 'turn' } }, original: { requested: {} },
    anchor: { target: 'bot-one', deliveryId: 'delivery' }, assertCurrent() {}, connection: { currentConnection: () => ({}), control(input) {
      calls.push(input)
      return input.action === 'bind' ? bindingReply.promise : Promise.resolve({ status: 'not_recorded' })
    } } })
  return { handoff, operation, calls, tracked, savingStop, bindingReply, setFailTerminal: value => { failTerminal = value } }
}

test('owner stop closes only this Bot admission before durable save and revokes independently of a held bind', async () => {
  const { handoff, operation, calls, tracked, savingStop, bindingReply } = fixture()
  const stopping = handoff.ownerStop('bot-one')
  assert.equal(handoff.ownerStop('bot-one'), stopping)
  assert.throws(() => handoff.assertAdmission('bot-one'), { effect: 'not_started' })
  assert.doesNotThrow(() => handoff.assertAdmission('bot-two'))
  assert.equal(handoff.projection(operation).stopIntent, 'accepted')
  savingStop.resolve()
  await stopping
  assert.deepEqual(calls.map(value => value.action), ['bind', 'revoke'])
  assert.equal(calls[1].reason, 'owner_stop')
  assert.equal(handoff.current('bot-one'), operation)
  assert.ok(tracked.includes(operation.completion))
  assert.ok(tracked.includes(bindingReply.promise))
  bindingReply.resolve({ status: 'not_recorded' })
})

test('ordinary stop remains unconfirmed without its adapter while the original handoff is revoked', async () => {
  const transport = new AitermTransport()
  const stopped = []
  transport.modelHandoff = { ownerStop: botId => stopped.push(botId) }
  await assert.rejects(transport.interrupt({ id: 'bot-one' }), { code: 'BOT_STOP_UNCONFIRMED' })
  assert.deepEqual(stopped, ['bot-one'])
})

test('native terminal cannot release the gate until its terminal snapshot is durable', async () => {
  const { handoff, operation, bindingReply, setFailTerminal } = fixture()
  bindingReply.resolve({ status: 'not_recorded' })
  const snapshot = { operation: binding, context_digest: operation.contextDigest,
    ...operation.context.native_call, revision: '2', state: 'terminal', later_effect: 'excluded',
    in_flight: [], resumed: null, revocation: 'durable', phases: { interrupt: { state: 'rejected', effect: 'not_started' } } }
  setFailTerminal(true)
  await assert.rejects(handoff.accept(operation, { status: 'recorded', snapshot }), /disk unavailable/)
  assert.equal(handoff.current('bot-one'), operation)
  assert.equal(operation.finished, undefined)
  setFailTerminal(false)
  await handoff.accept(operation, { status: 'recorded', snapshot })
  assert.equal(await operation.completion, snapshot)
  assert.equal(handoff.current('bot-one'), null)
})
