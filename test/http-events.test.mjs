import assert from 'node:assert/strict'
import test from 'node:test'
import { createMessageEvents } from '../src/http-events.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'

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

test('更新の知らせは内容が変わった時だけ、updates topic だけで流す', async () => {
  let fire, jobs = [{ jobId: 'j1', state: 'queued' }]
  const written = [], handlers = {}
  const events = createMessageEvents({
    store: { async watch() { return () => {} } },
    updateCenter: { watch(listener) { fire = listener; return () => {} }, jobs: async () => ({ jobs }) },
    eventKeepalive: 60000,
  })
  events.connect({ on(name, handler) { handlers[name] = handler } }, { writeHead() {}, write(chunk) { written.push(chunk) }, writableEnded: false })
  await events.startMessageWatch()
  fire(); await new Promise(resolve => setTimeout(resolve, 0))
  fire(); await new Promise(resolve => setTimeout(resolve, 0))
  jobs = [{ jobId: 'j1', state: 'ready' }]
  fire(); await new Promise(resolve => setTimeout(resolve, 0))
  const payloads = written.filter(chunk => chunk.startsWith('event: messages')).map(chunk => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)))
  assert.equal(payloads.length, 2)
  for (const payload of payloads) assert.deepEqual([payload.type, payload.topics, payload.all, payload.botIds, payload.roomIds], ['updates', ['updates'], false, [], []])
  assert.deepEqual(payloads.map(payload => payload.jobs[0].state), ['queued', 'ready'])
  events.stopWatching()
  handlers.close()
})


test('completion during a jobs read survives coalescing without repeating ordinary invalidations', async t => {
  const data = { jobs: [{ jobId: 'j1', state: 'ready' }] }, written = [], handlers = {}
  let release, blocked = false
  const center = createUpdateCenter({ jobReader: { jobs: () => blocked
    ? new Promise(resolve => { release = () => resolve(data) }) : Promise.resolve(data) } })
  const events = createMessageEvents({ store: { async watch() { return () => {} } }, updateCenter: center, eventKeepalive: 60000 })
  events.connect({ on(name, handler) { handlers[name] = handler } }, { writeHead() {}, writableEnded: false, write(chunk) { written.push(chunk) } })
  t.after(() => { release?.(); events.stopWatching(); handlers.close() })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const payloads = () => written.filter(chunk => chunk.startsWith('event: messages')).map(chunk => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)))
  await events.startMessageWatch()
  center.notify(); await tick()
  assert.equal(payloads().length, 1)
  blocked = true; center.notify(); await tick()
  center.notify({ operationCompleted: true }); center.notify()
  blocked = false; release(); await tick()
  assert.equal(payloads().length, 2)
  center.notify(); await tick(); center.notify(); await tick()
  assert.equal(payloads().length, 2)
  for (const value of payloads()) {
    assert.deepEqual([value.topics, value.all, value.jobs], [['updates'], false, data.jobs])
    assert.equal('operationCompleted' in value, false)
  }
})
