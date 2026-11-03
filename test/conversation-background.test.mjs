import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationBackground } from '../src/conversation/background.mjs'

const context = { generation: 'generation-a', operationId: 'operation-a', actor: { kind: 'observer' }, continuation: false }
const source = () => ({ deliveryId: 'delivery-a', target: 'bot-a' })

test('background count is synchronous, parent registration precedes work and root may finish after begin ACK', async () => {
  const begin = Promise.withResolvers(), work = Promise.withResolvers(), end = Promise.withResolvers()
  const calls = [], tracked = []
  const background = new ConversationBackground({ effect: async (method, params, captured) => {
    assert.equal(captured, context); calls.push(method)
    return method.endsWith('.begin') ? begin.promise : end.promise
  }, trackBackground(id, captured, actual) { tracked.push({ id, captured, actual }); calls.push('registered') } })
  const completion = background.start(source, context, async () => { calls.push('work'); return work.promise })
  assert.deepEqual(background.snapshot(), { pending: 1, starting: 1 })
  assert.deepEqual(calls, [])
  let rootEnded = false
  const root = background.awaitStarted(context).then(() => { rootEnded = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(rootEnded, false)
  begin.resolve({ backgroundId: 'background-a' })
  await root
  assert.deepEqual(calls, ['execution.background.begin', 'registered', 'work'])
  assert.equal(tracked[0].captured, context)
  assert.equal(background.snapshot().pending, 1)
  work.resolve('result')
  let actualEnded = false
  tracked[0].actual.then(() => { actualEnded = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(actualEnded, false)
  end.resolve({ requested: true })
  assert.equal(await completion, 'result')
  await background.drain()
  assert.deepEqual(background.snapshot(), { pending: 0, starting: 0 })
})

test('background actual work does not await the channel completion ACK and preserves both failures', async () => {
  const checkFailure = new Error('check failed'), endFailure = new Error('end failed')
  const completionAck = Promise.withResolvers()
  let actual
  const background = new ConversationBackground({ effect: async method => {
    if (method.endsWith('.begin')) return { backgroundId: 'background-a' }
    throw endFailure
  }, trackBackground(_id, _context, value) { actual = value; void completionAck.promise } })
  const task = background.start(source, context, () => { throw checkFailure })
  await task.started
  await assert.rejects(task, error => error instanceof AggregateError && error.errors[0] === checkFailure && error.errors[1] === endFailure)
  await assert.rejects(actual, AggregateError)
  // The runtime's completion ACK belongs to its drain, never to this actual promise.
  completionAck.resolve()
})

test('source/begin failures prevent work and another operation does not wait for their admission', async () => {
  const denied = new Error('begin denied'), work = []
  const background = new ConversationBackground({ effect: async () => { throw denied }, trackBackground() { assert.fail('not registered') } })
  const task = background.start(source, context, () => work.push('issued'))
  await background.awaitStarted({ ...context, operationId: 'other-operation' })
  await assert.rejects(task.started, error => error === denied)
  await assert.rejects(task, error => error === denied)
  // Poll/save can reach its final root ACK after a fast admission has failed.
  await assert.rejects(background.awaitStarted(context), error => error === denied)
  assert.deepEqual(work, [])
  assert.deepEqual(background.snapshot(), { pending: 0, starting: 0 })
})
