import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createModuleEndpoint, MODULE_CONCURRENCY } from '../src/module-ipc.mjs'
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

test('shared business lanes admit 64 each, root overflow waits and the others reject, and retain completion independently of control', async t => {
  const [parent, child] = pair(), held = Promise.withResolvers()
  const a = createModuleEndpoint(parent, { validateResult: () => true, onRequest: () => assert.fail() })
  const b = createModuleEndpoint(child, { validateResult: () => true, onRequest: () => () => held.promise })
  t.after(() => { held.resolve({}); a.reaped(); b.reaped() })
  const calls = []
  for (const [kind, limit] of [['root', MODULE_CONCURRENCY], ['effect', MODULE_CONCURRENCY], ['callback', MODULE_CONCURRENCY], ['projection', 1], ['control', 16]]) {
    calls.push(...Array.from({ length: limit }, () => a.call(kind, 'fixture', {}, kind === 'control' ? null : {})))
    if (kind === 'root') calls.push(a.call(kind, 'overflow', {}, {}))
    else await assert.rejects(a.call(kind, 'overflow', {}, kind === 'control' ? null : {}), { code: 'MODULE_IPC_CAPACITY', outcome: 'not_accepted' })
    assert.equal(a.snapshot()[kind], limit)
  }
  held.resolve({}); await Promise.all(calls.map(call => call.completion))
  for (const kind of ['root', 'effect', 'callback', 'projection', 'control']) assert.equal(a.snapshot()[kind], 0)
})

// BugHub ef83d4ee: 123 avatar reads at once must wait for the 64 slots, not fail with 503.
test('root calls beyond 64 wait in order, all resolve, and the in-flight count never passes 64', async t => {
  const [parent, child] = pair(); let live = 0, peak = 0; const release = []
  const a = createModuleEndpoint(parent, { validateResult: () => true, onRequest: () => assert.fail() })
  const b = createModuleEndpoint(child, { validateResult: () => true, onRequest: () => () => { peak = Math.max(peak, ++live); return new Promise(resolve => release.push(() => { live--; resolve({}) })) } })
  t.after(() => { a.reaped(); b.reaped() })
  const order = [], calls = Array.from({ length: 130 }, (_, index) => a.call('root', 'read', { index }, {}).then(() => order.push(index)))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.snapshot().root, MODULE_CONCURRENCY); assert.equal(release.length, MODULE_CONCURRENCY)
  while (order.length < 130) { release.splice(0).forEach(done => done()); await new Promise(resolve => setImmediate(resolve)) }
  await Promise.all(calls)
  assert.equal(peak, MODULE_CONCURRENCY); assert.equal(a.snapshot().root, 0)
  assert.deepEqual([...order].sort((x, y) => x - y), Array.from({ length: 130 }, (_, index) => index))
})

test('a root waiter past its own timeout fails not_accepted without being sent, and leaves the queue', async t => {
  const [parent, child] = pair(), sent = []
  const a = createModuleEndpoint(parent, { validateResult: () => true, onRequest: () => assert.fail() })
  const b = createModuleEndpoint(child, { validateResult: () => true, onRequest: message => { sent.push(message.params.index); return () => new Promise(() => {}) } })
  t.after(() => { a.reaped(); b.reaped() })
  Array.from({ length: MODULE_CONCURRENCY }, (_, index) => a.call('root', 'read', { index }, {}, { timeout: 5000 }).catch(() => {}))
  const late = a.call('root', 'read', { index: 'late' }, {}, { timeout: 30 })
  await assert.rejects(late, { code: 'MODULE_IPC_TIMEOUT', outcome: 'not_accepted' })
  assert.equal(sent.includes('late'), false); assert.equal(a.snapshot().root, MODULE_CONCURRENCY)
})

test('a slot held by an in-flight call that already timed out still reaches the next waiter when its result arrives', async t => {
  const [parent, child] = pair(), gates = []
  const a = createModuleEndpoint(parent, { validateResult: () => true, onRequest: () => assert.fail() })
  const b = createModuleEndpoint(child, { validateResult: () => true, onRequest: () => () => new Promise(resolve => gates.push(resolve)) })
  t.after(() => { a.reaped(); b.reaped() })
  const first = a.call('root', 'read', {}, {}, { timeout: 20 })
  const rest = Array.from({ length: MODULE_CONCURRENCY - 1 }, () => a.call('root', 'read', {}, {}))
  await assert.rejects(first, { code: 'MODULE_IPC_TIMEOUT' })
  const waiter = a.call('root', 'read', {}, {})
  await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, MODULE_CONCURRENCY)
  gates[0]({}); await first.completion
  await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, MODULE_CONCURRENCY + 1)
  gates.slice(1).forEach(done => done({})); await Promise.all([waiter, ...rest])
})

test('a lost connection drains every waiting root call as not_accepted', async t => {
  const [parent, child] = pair()
  const a = createModuleEndpoint(parent, { validateResult: () => true, onRequest: () => assert.fail() })
  const b = createModuleEndpoint(child, { validateResult: () => true, onRequest: () => () => new Promise(() => {}) })
  t.after(() => { a.reaped(); b.reaped() })
  Array.from({ length: MODULE_CONCURRENCY }, () => a.call('root', 'read', {}, {}).catch(() => {}))
  const waiter = a.call('root', 'read', {}, {})
  a.fail()
  await assert.rejects(waiter, { code: 'MODULE_IPC_DISCONNECTED', outcome: 'not_accepted' })
})

// a399: the two halves ship apart; a result one side cannot read is that call's failure, not the channel's.
test('a result this side cannot read fails that call only and the channel keeps working', async t => {
  const [parent, child] = pair(), disconnected = []
  const a = createModuleEndpoint(parent, { errorPrefix: 'USAGE', onRequest: () => assert.fail(), onDisconnect: () => disconnected.push('parent'),
    validateResult: (_kind, method, value) => method !== 'newer' && value.ok === true })
  const b = createModuleEndpoint(child, { errorPrefix: 'USAGE', validateResult: () => true, onDisconnect: () => disconnected.push('child'),
    onRequest: message => () => message.method === 'newer' ? { ok: true, added: 1 } : { ok: true } })
  t.after(() => { a.reaped(); b.reaped() })
  const refused = a.call('root', 'newer', {}, { generation: 'fixture' })
  await assert.rejects(refused, { code: 'USAGE_RESULT_INVALID', outcome: 'unknown', status: 503 })
  await assert.rejects(refused.completion, { code: 'USAGE_RESULT_INVALID' })
  assert.equal(a.snapshot().root, 0)
  assert.deepEqual(await a.call('root', 'read', {}, { generation: 'fixture' }), { ok: true })
  assert.deepEqual(disconnected, [])
})
