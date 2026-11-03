import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { createConversationPeer } from '../src/conversation-channel.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => Promise.withResolvers()
function fixture(t, { native, method = 'user.turn', admitted = true, disconnect = false } = {}) {
  const endpoints = [new EventEmitter(), new EventEmitter()], result = deferred(), accepted = deferred()
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const copy = deserialize(serialize(frame))
      setImmediate(() => { if (endpoint.connected && !disconnect) endpoints[1 - index].emit('message', copy); callback?.(null) })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) if (peer.connected) { peer.connected = false; peer.emit('disconnect') } }
  }
  result.promise.accepted = accepted.promise
  if (admitted) accepted.resolve({ delivery: 'running' })
  const parent = createConversationPeer(endpoints[0], { side: 'parent', validateResult: () => {} })
  const child = createConversationPeer(endpoints[1], { side: 'child', accept: () => () => result.promise, validateResult: () => {} })
  const attempt = parent.call('root', method, {}, { getNativeContinuation: native })
  t.after(() => { parent.close(); parent.reaped(); child.reaped() })
  return { parent, child, attempt, result, accepted }
}

test('accepted native result reference survives caller expiry and restores the ordinary deadline after real completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const native = deferred(); let reads = 0, callerDone = false, actualDone = false, nativePending = true
  const f = fixture(t, { native: () => { reads++; return nativePending ? native.promise : null } })
  f.attempt.then(() => { callerDone = true }, () => { callerDone = true })
  f.attempt.completion.then(() => { actualDone = true }, () => { actualDone = true })
  await f.attempt.accepted
  t.mock.timers.tick(60000); await turn()
  t.mock.timers.tick(120000); await turn()
  assert.equal(reads, 1); assert.equal(callerDone, false); assert.equal(actualDone, false)
  assert.equal(f.parent.snapshot().root, 0)
  nativePending = false; native.resolve(); await turn()
  t.mock.timers.tick(59999); await turn(); assert.equal(callerDone, false)
  const expired = assert.rejects(f.attempt, { code: 'CONVERSATION_IPC_TIMEOUT' })
  t.mock.timers.tick(1); await expired
  assert.equal(actualDone, false); assert.equal(f.parent.snapshot().pending, 1)
  f.result.resolve({ done: true }); await f.attempt.completion
  assert.equal(actualDone, true)
})

test('unaccepted and ordinary roots cannot use a native continuation, and unknown proof retains the 60s deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const native = deferred(); let reads = 0
  const missing = fixture(t, { admitted: false, native: () => { reads++; return native.promise } })
  const ordinary = fixture(t, { method: 'rooms.list', native: () => { reads++; return native.promise } })
  const unknown = fixture(t, { native: () => { throw new Error('no positive owner evidence') } })
  await unknown.attempt.accepted; await turn()
  const rejected = [missing, ordinary, unknown].map(f => assert.rejects(f.attempt, { code: 'CONVERSATION_IPC_TIMEOUT' }))
  t.mock.timers.tick(60000); await Promise.all(rejected)
  assert.equal(reads, 0)
  for (const f of [missing, ordinary, unknown]) assert.equal(f.parent.snapshot().pending, 1)
})

test('native result rejection restarts ordinary inactivity without succeeding the RPC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const native = deferred(); let pending = true
  const f = fixture(t, { native: () => pending ? native.promise : null })
  await f.attempt.accepted
  t.mock.timers.tick(60000); await turn()
  pending = false; native.reject(new Error('native outcome unknown')); await turn()
  const rejected = assert.rejects(f.attempt, { code: 'CONVERSATION_IPC_TIMEOUT' })
  t.mock.timers.tick(60000); await rejected
  assert.equal(f.parent.snapshot().pending, 1)
})

test('native continuation never changes the five second call acknowledgement deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { disconnect: true, native: () => assert.fail('no acknowledged native can exist') })
  await turn()
  const rejected = assert.rejects(f.attempt, { code: 'CONVERSATION_IPC_ACK_TIMEOUT' })
  t.mock.timers.tick(5000); await rejected
})
