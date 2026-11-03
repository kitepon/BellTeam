import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createModuleEndpoint } from '../src/module-ipc.mjs'
import { createModuleStreams, encodeModuleJson } from '../src/module-streams.mjs'

function pair() {
  const a = new EventEmitter(), b = new EventEmitter()
  for (const [local, peer] of [[a, b], [b, a]]) {
    local.connected = true
    local.send = (frame, callback) => queueMicrotask(() => { peer.emit('message', frame); callback() })
    local.disconnect = () => { local.connected = false; local.emit('disconnect') }
  }
  return [a, b]
}

test('a shared endpoint keeps root credit and real completion until the streamed result body ends', async t => {
  const [parent, child] = pair(), body = Promise.withResolvers()
  const a = createModuleEndpoint(parent, { streamed: true, errorPrefix: 'DIAGNOSTICS', validateResult: () => true,
    onRequest: () => assert.fail(), afterResult: () => body.promise })
  const b = createModuleEndpoint(child, { streamed: true, errorPrefix: 'DIAGNOSTICS', validateResult: () => true,
    onRequest: () => () => ({ streamed: true }) })
  t.after(() => { a.reaped(); b.reaped() })
  const request = a.call('root', 'list', {}, { generation: 'fixture' })
  assert.deepEqual(await request, { streamed: true })
  assert.equal(a.snapshot().root, 1)
  let complete = false; request.completion.then(() => { complete = true })
  await Promise.resolve(); assert.equal(complete, false)
  body.resolve(); await request.completion
  assert.equal(a.snapshot().root, 0)
})

test('RPC and chunk frames share an endpoint without consuming one another', async t => {
  const [parent, child] = pair(), chunks = []
  const a = createModuleEndpoint(parent, { streamed: true, errorPrefix: 'USAGE', validateResult: () => true, onRequest: () => assert.fail() })
  const b = createModuleEndpoint(child, { streamed: true, errorPrefix: 'USAGE', validateResult: () => true, onRequest: () => () => ({ applied: true }) })
  const sender = createModuleStreams(parent, { rpcFrames: true, onStream: () => assert.fail(), onFailure: assert.fail })
  const receiver = createModuleStreams(child, { rpcFrames: true, onFailure: assert.fail,
    onStream: async (_meta, body) => { for await (const bytes of body) chunks.push(bytes) } })
  t.after(() => { a.reaped(); b.reaped(); sender.close(); receiver.close() })
  const buffer = Buffer.alloc(700000, 'a')
  const [value] = await Promise.all([
    a.call('root', 'read', {}, { generation: 'fixture' }),
    sender.write([buffer], { lane: 'history', operation: 1, length: buffer.length }),
  ])
  assert.deepEqual(value, { applied: true })
  assert.deepEqual(Buffer.concat(chunks), buffer)
  assert.equal(a.snapshot().root, 0)
  assert.equal(receiver.snapshot().unconsumedBytes, 0)
})

test('legacy endpoints still reject a foreign stream and keep their error prefix', async t => {
  const endpoint = new EventEmitter(); endpoint.connected = true
  endpoint.send = (_frame, callback) => callback()
  endpoint.disconnect = () => { endpoint.connected = false; endpoint.emit('disconnect') }
  const rpc = createModuleEndpoint(endpoint, { errorPrefix: 'MEMBERS', validateResult: () => true, onRequest: () => () => null })
  t.after(() => rpc.reaped())
  endpoint.emit('message', { type: 'open', stream: 1, lane: 'history', operation: 1, length: 0 })
  assert.equal(endpoint.connected, false)
  await assert.rejects(rpc.call('root', 'read', {}, {}), { code: 'MEMBERS_IPC_DISCONNECTED' })
})

test('new module wire preserves HTTP error status while a legacy endpoint can retain its closed status set', async t => {
  for (const [status, statusCodes, expected] of [[426, undefined, 426], [500, undefined, 500], [502, undefined, 502], [500, [400, 403, 404, 409, 503], 503]]) {
    const [parent, child] = pair()
    const a = createModuleEndpoint(parent, { validateResult: () => true, onRequest: () => assert.fail(), statusCodes })
    const b = createModuleEndpoint(child, { validateResult: () => true, statusCodes,
      onRequest: () => () => { throw Object.assign(new Error('private message'), { code: 'USAGE_REJECTED', status }) } })
    t.after(() => { a.reaped(); b.reaped() })
    await assert.rejects(a.call('root', 'test', {}, {}), error => error.status === expected && error.code === 'USAGE_REJECTED' && error.message === 'USAGE_REJECTED')
  }
})

test('a body failure after metadata keeps credit and actual completion until the OS reaping barrier', async t => {
  const [parent, child] = pair(), body = Promise.withResolvers()
  const a = createModuleEndpoint(parent, { streamed: true, validateResult: () => true, onRequest: () => assert.fail(), afterResult: () => body.promise })
  const b = createModuleEndpoint(child, { streamed: true, validateResult: () => true, onRequest: () => () => ({ streamed: true }) })
  t.after(() => { a.reaped(); b.reaped() })
  const request = a.call('root', 'list', {}, {})
  await request
  let completed = false
  request.completion.then(() => { completed = true }, () => { completed = true })
  body.reject(new Error('stream disconnected'))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(a.snapshot().root, 1)
  assert.equal(completed, false)
  const reaped = assert.rejects(request.completion, { code: 'MODULE_CHILD_EXITED' })
  a.reaped(); await reaped
})

test('parent drain holds incoming effects and result commit work after IPC disconnect', async t => {
  for (const bodyCommit of [false, true]) {
    const [parent, child] = pair(), work = Promise.withResolvers(), started = Promise.withResolvers()
    const a = createModuleEndpoint(parent, { validateResult: () => true,
      onRequest: () => async () => { started.resolve(); await work.promise; return {} },
      ...(bodyCommit ? { afterResult: () => { started.resolve(); return work.promise } } : {}),
    })
    const b = createModuleEndpoint(child, { validateResult: () => true, onRequest: () => () => ({}) })
    t.after(() => { a.reaped(); b.reaped() })
    const request = bodyCommit ? a.call('root', 'list', {}, {}) : b.call('effect', 'write', {}, {})
    request.catch(() => {}); request.completion.catch(() => {})
    await started.promise
    parent.disconnect()
    let settled = false; const draining = a.drainIncoming().then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false)
    work.resolve(); await draining; assert.equal(settled, true)
  }
})

test('JSONの符号化は小さな断片を枠の上限までまとめ、行数に比例した枠を作らない', async () => {
  const rows = Array.from({ length: 20000 }, (_, index) => ({ id: `row-${index}`, at: '2026-11-04T08:00:00+09:00', text: '日本語', images: [] }))
  const iterable = { async *[Symbol.asyncIterator]() { yield* rows } }
  const chunks = []
  for await (const chunk of encodeModuleJson(iterable)) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  assert.deepEqual(JSON.parse(body.toString('utf8')), rows)
  assert.ok(chunks.length <= Math.ceil(body.length / (256 * 1024)) + 1, `${chunks.length} chunks`)
})
