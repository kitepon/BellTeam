import assert from 'node:assert/strict'
import test from 'node:test'
import { createMessageEvents } from '../src/http-events.mjs'

test('監視の開始途中で失敗したら取得済みの監視を閉じ、元の失敗を返す', async () => {
  const stopped = []
  const failure = new Error('synthetic rooms watch failure')
  const events = createMessageEvents({
    store: { async watch() { return () => stopped.push('store') } },
    secretRequests: { watch() { return () => stopped.push('requests') } },
    rooms: { async watch() { throw failure } },
  })
  await assert.rejects(events.startMessageWatch(), error => error === failure)
  assert.deepEqual(stopped, ['store', 'requests'])
  events.stopWatching()
  assert.deepEqual(stopped, ['store', 'requests'])
})

test('監視を閉じる途中の失敗を返し、後続の監視も閉じる', async () => {
  const failure = new Error('synthetic watch close failure'), stopped = []
  const events = createMessageEvents({
    store: { async watch() { return () => { stopped.push('store'); throw failure } } },
    rooms: { async watch() { return () => stopped.push('rooms') } },
  })
  await events.startMessageWatch()
  assert.throws(() => events.stopWatching(), error => error instanceof AggregateError && error.errors[0] === failure)
  assert.deepEqual(stopped, ['store', 'rooms'])
  events.stopWatching()
  assert.deepEqual(stopped, ['store', 'rooms'])
})

test('開始の失敗と監視を閉じる失敗を両方残す', async () => {
  const start = new Error('synthetic start failure'), close = new Error('synthetic close failure')
  const events = createMessageEvents({
    store: { async watch() { return () => { throw close } } },
    rooms: { async watch() { throw start } },
  })
  await assert.rejects(events.startMessageWatch(), error => error instanceof AggregateError
    && error.errors[0] === start && error.errors[1].errors[0] === close)
})
