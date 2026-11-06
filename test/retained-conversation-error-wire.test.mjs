import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { createConversationPeer } from '../src/conversation-channel.mjs'

function pair(legacyChild) {
  const endpoints = [new EventEmitter(), new EventEmitter()]
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const copy = deserialize(serialize(frame))
      setImmediate(() => {
        if (endpoint.connected) {
          // Retained91d9 channel177: the error DTO has exactly these three keys.
          if (legacyChild && index === 0 && copy.capability?.type === 'error'
            && Object.keys(copy.capability.error).sort().join(',') !== 'code,outcome,status') endpoint.disconnect()
          else endpoints[1 - index].emit('message', copy)
        }
        callback?.()
      })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) if (peer.connected) { peer.connected = false; peer.emit('disconnect') } }
  }
  return endpoints
}

for (const phase of ['accept', 'execute']) test(`retained child survives parent ${phase} failure and a subsequent request`, { timeout: 2000 }, async t => {
  const endpoints = pair(true)
  let refuse = true
  const error = Object.assign(new Error('private exception'), { code: 'AI_GLOBAL_PAUSED', status: 409 })
  const parent = createConversationPeer(endpoints[0], { side: 'parent', validateResult() {},
    accept: () => {
      if (refuse && phase === 'accept') throw error
      return () => { if (refuse) throw error; return { acknowledged: true } }
    } })
  const child = createConversationPeer(endpoints[1], { side: 'child', validateResult() {}, accept: assert.fail })
  t.after(() => { parent.reaped(); child.reaped() })
  const failed = child.call('diagnostic', 'diagnostic', { code: 'FIXTURE_ONLY' })
  await assert.rejects(failed, { code: 'AI_GLOBAL_PAUSED', status: 409, outcome: phase === 'accept' ? 'not_accepted' : 'unknown' })
  await assert.rejects(failed.completion, { code: 'AI_GLOBAL_PAUSED' })
  assert.equal(endpoints[1].connected, true)
  refuse = false
  const next = child.call('diagnostic', 'diagnostic', { code: 'FIXTURE_ONLY' })
  assert.deepEqual(await next, { acknowledged: true })
  await next.completion
})

test('child-to-parent operation errors retain sanitized delivery metadata', { timeout: 2000 }, async t => {
  const endpoints = pair(false)
  const parent = createConversationPeer(endpoints[0], { side: 'parent', validateResult() {}, accept: assert.fail })
  const child = createConversationPeer(endpoints[1], { side: 'child', validateResult() {},
    accept: () => () => { throw Object.assign(new Error('private exception'), { code: 'BOT_LAUNCH_FAILED', status: 503 }) } })
  t.after(() => { parent.reaped(); child.reaped() })
  const failed = parent.call('diagnostic', 'diagnostic', { code: 'FIXTURE_ONLY' })
  await assert.rejects(failed, error => {
    assert.equal(error.code, 'BOT_LAUNCH_FAILED')
    assert.equal(error.message, 'BOT_LAUNCH_FAILED')
    assert.deepEqual(error.delivery_error, { code: 'BOT_LAUNCH_FAILED' })
    return true
  })
  await assert.rejects(failed.completion, { code: 'BOT_LAUNCH_FAILED' })
  assert.equal(endpoints[0].connected, true)
})
