import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createWorkGraphApi } from '../src/work-graph/http-api.mjs'
import { createWorkGraphCore } from '../src/work-graph/core.mjs'
import { diffGraph, projectGraph } from '../src/work-graph/projection.mjs'

const T0 = Date.parse('2026-11-08T10:00:00.000Z')
const member = (id, extra = {}) => ({ id, name: id.toUpperCase(), color: 'sky', avatarVersion: 'v1', ...extra })
const job = (extra = {}) => ({ status: 'running', context: 'direct', contextId: 'x', groupId: 'g1', from: 'a', target: 'b', requestSummary: null, startedAt: '2026-11-08T10:00:01.000Z', ...extra })
const project = (input) => projectGraph({ members: [member('a'), member('b'), member('c')], turns: {}, queue: [], responders: {}, now: T0, ...input })
const working = (...ids) => Object.fromEntries(ids.map(id => [id, { state: 'working', turnId: 't' }]))

test('edge rules: only running direct/room deliveries between two members', () => {
  const queue = [job(), job({ groupId: 'self', from: 'a', target: 'a' }), job({ groupId: 'user', from: 'user' }), job({ groupId: 'f', status: 'failed' }),
    job({ groupId: 'ctx', context: 'self' }), job({ groupId: 'r1', context: 'room', contextId: 'room' }),
    job({ groupId: 'r2', context: 'room', contextId: 'room', target: 'c', steered: true, requestSummary: ' \n ' })]
  const { edges, nodes } = project({ queue, responders: { r2: ['c'], r1: ['c'] } })
  assert.deepEqual(edges.map(edge => edge.id), ['g1:b', 'r2:c'])
  assert.deepEqual(edges[1], { id: 'r2:c', requestId: 'r2', from: 'a', to: 'c', context: 'room', roomId: 'room', label: '依頼を処理中', state: 'steered', startedAt: '2026-11-08T10:00:01.000Z' })
  assert.deepEqual(nodes.map(node => [node.botId, node.state]), [['a', 'linked'], ['b', 'linked'], ['c', 'linked']])
})

test('label: the once-per-request summary, else neutral; receiver work summary is not used', () => {
  const current = { b: { state: 'working', turnId: 't', summary: '別の作業', summaryStatus: 'current' } }
  const label = requestSummary => project({ queue: [job({ requestSummary })], turns: current }).edges[0].label
  assert.equal(label(' 相関図の線を直す依頼 '), '相関図の線を直す依頼')
  assert.equal(label(null), '依頼を処理中')
  assert.equal(label(''), '依頼を処理中')
  assert.equal(label(undefined), '依頼を処理中')
})

test('nodes: working beats linked, defaults, deleting excluded, unknown holds presence', () => {
  const members = [member('a', { color: '', avatarVersion: undefined }), member('b', { deleting: true }), member('c')]
  const first = project({ members, turns: { ...working('a', 'b'), c: { state: 'idle' } } })
  assert.deepEqual(first.nodes, [{ botId: 'a', name: 'A', color: 'violet', avatarVersion: '', state: 'working', activeSince: '2026-11-08T10:00:00.000Z' }])
  const held = project({ members, turns: { a: { state: 'unknown' } }, previous: first, now: T0 + 60000 })
  assert.deepEqual(held.nodes, first.nodes)
  assert.equal(project({ members, turns: { a: { state: 'unknown' } } }).nodes.length, 0)
})

test('activeSince: startedAt when valid, else first seen, kept while on screen', () => {
  const given = project({ turns: { a: { state: 'working', startedAt: '2026-11-08T09:59:00.000Z' }, b: { state: 'working', startedAt: 'nope' } } })
  assert.deepEqual(given.nodes.map(node => node.activeSince), ['2026-11-08T09:59:00.000Z', '2026-11-08T10:00:00.000Z'])
  const later = project({ turns: { a: { state: 'working', startedAt: '2026-11-08T09:59:30.000Z' }, b: working('b').b }, previous: given, now: T0 + 5000 })
  assert.deepEqual(later.nodes.map(node => node.activeSince), given.nodes.map(node => node.activeSince))
})

test('leave grace: kept 4 s, silent on return, then member-leave', () => {
  const on = project({ turns: working('a') })
  const idle = { a: { state: 'idle' } }
  const gone = project({ turns: idle, previous: on, now: T0 + 1000 })
  assert.equal(gone.nodes.length, 1)
  assert.equal(gone.nextAt, T0 + 5000)
  assert.deepEqual(diffGraph(on, gone), [])
  const back = project({ turns: working('a'), previous: gone, now: T0 + 3000 })
  assert.deepEqual(diffGraph(gone, back), [])
  assert.equal(back.nextAt, null)
  const out = project({ turns: idle, previous: gone, now: T0 + 5000 })
  assert.deepEqual(diffGraph(gone, out), [{ type: 'member-leave', botId: 'a' }])
})

test('diff order: enter, update, edge-start, edge-update, edge-end, leave', () => {
  const prev = project({ turns: working('a', 'c'), queue: [job({ groupId: 'old', target: 'c' }), job({ groupId: 'keep' })] })
  const renamed = [member('a', { name: 'Renamed' }), member('b'), member('c')]
  const next = project({ members: renamed, turns: { ...working('a', 'b'), c: { state: 'idle' } }, queue: [job({ groupId: 'keep', steered: true }), job({ groupId: 'new', target: 'c' })], previous: prev, now: T0 + 9000 })
  const name = change => change.type + ':' + (change.node?.botId ?? change.edge?.id ?? change.edgeId ?? change.botId)
  assert.deepEqual(diffGraph(prev, next).map(name),
    ['member-update:a', 'member-update:b', 'member-update:c', 'edge-start:new:c', 'edge-update:keep:b', 'edge-end:old:c'])
  const turns = { ...working('c'), a: { state: 'idle' } }
  const lone = project({ turns, previous: project({ turns, previous: prev, now: T0 + 1000 }), now: T0 + 9000 })
  assert.deepEqual(diffGraph(prev, lone).map(name).slice(-4), ['edge-end:old:c', 'edge-end:keep:b', 'member-leave:a', 'member-leave:b'])
})

// Fake provider effects for core tests.
function rig(options = {}) {
  const state = { members: [member('a'), member('b')], turns: {}, queue: [], pages: {}, time: T0, fail: new Set(), unsupported: false, calls: [], busy: 0, overlap: false }
  const effect = async (method, params) => {
    state.calls.push([method, params])
    if (++state.busy > 1) state.overlap = true
    await new Promise(resolve => setImmediate(resolve))
    state.busy--
    if (state.fail.has(method)) throw Object.assign(new Error('WORK_GRAPH_EFFECT_FAILED'), { code: 'WORK_GRAPH_EFFECT_FAILED' })
    if (method === 'members.list') return { members: state.members.map(item => ({ color: '', avatarVersion: '', deleting: false, ...item })) }
    if (method === 'turns.read') return state.unsupported ? { unsupported: true }
      : { turns: Object.fromEntries(params.botIds.map(id => [id, state.turns[id] ?? { state: 'idle', turnId: null }])) }
    if (method === 'queue.read') return { items: state.queue }
    return { items: state.pages[params.roomId] ?? [] }
  }
  const core = createWorkGraphCore({ now: () => state.time, ...options })
  return { state, effect, core, refresh: () => core.refresh(effect), snapshot: () => core.snapshot(effect),
    count: name => state.calls.filter(([method]) => method === name).length }
}
const types = batch => batch.changes.map(change => change.type)

test('core: first refresh is the baseline, snapshot without baseline computes one', async () => {
  const x = rig()
  x.state.turns.a = { state: 'working', turnId: 't' }
  assert.deepEqual(await x.refresh(), { batch: null, nextRefreshMs: null })
  const y = rig()
  y.state.turns.a = { state: 'working', turnId: 't' }
  const snapshot = await y.snapshot()
  assert.equal(snapshot.schema, 'bellteam.work-graph.v1')
  assert.equal(snapshot.version, 0)
  assert.deepEqual([snapshot.nodes.map(node => node.botId), snapshot.degraded], [['a'], []])
  assert.equal(y.count('members.list'), 1)
  await y.snapshot()
  assert.equal(y.count('members.list'), 1)
  assert.equal((await y.refresh()).batch, null)
})

test('core: batches bump version by one, in README order', async () => {
  const x = rig()
  await x.refresh()
  assert.equal((await x.snapshot()).version, 0)
  x.state.turns.a = { state: 'working', turnId: 't' }
  x.state.queue = [job()]
  const { batch } = await x.refresh()
  assert.deepEqual([batch.epoch === x.core.epoch, batch.version, types(batch)], [true, 1, ['member-enter', 'member-enter', 'edge-start']])
  assert.equal((await x.refresh()).batch, null)
  x.state.queue = []
  const second = (await x.refresh()).batch
  assert.deepEqual([second.version, types(second)], [2, ['edge-end']])
  assert.equal((await x.snapshot()).version, 2)
})

test('core: leave grace is reported as nextRefreshMs, then member-leave', async () => {
  const x = rig()
  await x.refresh()
  x.state.turns.a = { state: 'working', turnId: 't' }
  await x.refresh()
  x.state.turns.a = { state: 'idle', turnId: null }
  x.state.time += 1000
  assert.deepEqual(await x.refresh(), { batch: null, nextRefreshMs: 4000 })
  x.state.time += 4000
  const { batch, nextRefreshMs } = await x.refresh()
  assert.deepEqual([batch.changes, nextRefreshMs], [[{ type: 'member-leave', botId: 'a' }], null])
})

test('core: room edges need a final responder list, cached per message', async () => {
  const x = rig()
  x.state.queue = [job({ context: 'room', contextId: 'room', groupId: 'm1' })]
  x.state.pages.room = [{ id: 'm1', routing: { status: 'pending', responders: [] } }, { id: 'm2', routing: null }]
  await x.refresh()
  assert.equal((await x.snapshot()).edges.length, 0)
  x.state.pages.room = [{ id: 'm1', routing: { status: 'ready', responders: ['b'] } }]
  assert.deepEqual(types((await x.refresh()).batch), ['member-enter', 'member-enter', 'edge-start'])
  const reads = x.count('room.messages')
  await x.refresh()
  assert.equal(x.count('room.messages'), reads)
  assert.deepEqual(x.state.calls.find(([method]) => method === 'room.messages')[1], { roomId: 'room' })
})

test('core: failing sources keep last good data and report degraded, then recover', async () => {
  const x = rig()
  x.state.turns.a = { state: 'working', turnId: 't' }
  await x.refresh()
  x.state.fail.add('turns.read'); x.state.fail.add('queue.read'); x.state.fail.add('members.list')
  x.state.members = []
  const { batch } = await x.refresh()
  assert.deepEqual([batch.degraded, batch.changes], [['members', 'queue', 'turn'], []])
  assert.equal((await x.snapshot()).nodes.length, 1)
  x.state.fail.clear()
  x.state.members = [member('a')]
  assert.deepEqual((await x.refresh()).batch.degraded, [])
  const y = rig()
  y.state.fail.add('room.messages')
  y.state.queue = [job({ context: 'room', contextId: 'room', groupId: 'm1' })]
  assert.deepEqual((await y.snapshot()).degraded, ['responders'])
})

test('core: old engine reports turn-unsupported and shows linked nodes only', async () => {
  const x = rig()
  x.state.unsupported = true
  x.state.queue = [job()]
  const snapshot = await x.snapshot()
  assert.deepEqual([snapshot.degraded, snapshot.nodes.map(node => node.state)], [['turn-unsupported'], ['linked', 'linked']])
})

test('core: turns.read covers non-deleting members in chunks of 200', async () => {
  const x = rig()
  x.state.members = [...Array.from({ length: 450 }, (_, i) => member(`m${i}`)), member('gone', { deleting: true })]
  await x.refresh()
  const reads = x.state.calls.filter(([method]) => method === 'turns.read').map(([, params]) => params.botIds)
  assert.deepEqual(reads.map(ids => ids.length).sort((a, b) => a - b), [50, 200, 200])
  assert.equal(reads.flat().includes('gone'), false)
  const none = rig()
  none.state.members = []
  await none.refresh()
  assert.equal(none.count('turns.read'), 0)
})

test('core: concurrent calls never interleave their effects', async () => {
  const x = rig()
  await Promise.all([x.refresh(), x.snapshot(), x.refresh(), x.snapshot()])
  assert.equal(x.state.overlap, false)
})

function fakeConnection(method = 'GET') {
  const request = new EventEmitter(), chunks = []
  request.method = method
  const response = { head: null, writeHead(status, headers) { this.head = [status, headers] }, write: chunk => chunks.push(chunk), end(chunk) { if (chunk) chunks.push(chunk); this.ended = true } }
  return { request, response, chunks }
}

const snap = (version = 0) => ({ schema: 'bellteam.work-graph.v1', epoch: 'e1', version, at: '2026-11-08T10:00:00.000Z', degraded: [], nodes: [], edges: [] })
const unavailable = () => Object.assign(new Error('WORK_GRAPH_UNAVAILABLE'), { code: 'WORK_GRAPH_UNAVAILABLE' })
function fakeFacade(overrides = {}) {
  const facade = { senders: new Set(), snapshot: async () => snap(), subscribe(send) { facade.senders.add(send); return () => facade.senders.delete(send) }, ...overrides }
  return facade
}
const call = async (api, path, method = 'GET') => {
  const { request, response, chunks } = fakeConnection(method)
  const result = await api(request, response, new URL(path, 'http://x'))
  return { request, response, chunks, result }
}

test('http-api: routes and auth', async () => {
  const facade = fakeFacade()
  const api = createWorkGraphApi({ facade, heartbeatMs: 1e9 })
  assert.equal((await call(api, '/api/other')).result, false)
  const forbidden = await call(createWorkGraphApi({ facade, internal: true }), '/api/work-graph')
  assert.deepEqual([forbidden.response.head[0], forbidden.chunks[0].includes('WORK_GRAPH_OWNER_REQUIRED')], [403, true])
  assert.equal((await call(api, '/api/work-graph', 'POST')).response.head[0], 405)
  assert.equal((await call(api, '/api/work-graph/events', 'POST')).response.head[0], 405)
  const plain = await call(api, '/api/work-graph')
  assert.equal(plain.response.head[0], 200)
  assert.equal(JSON.parse(plain.chunks[0]).schema, 'bellteam.work-graph.v1')
})

test('http-api: SSE framing, held batches, heartbeat and close cleanup', async () => {
  let release
  const facade = fakeFacade({ snapshot: () => new Promise(resolve => { release = () => resolve(snap(5)) }) })
  const api = createWorkGraphApi({ facade, heartbeatMs: 5 })
  const { request, response, chunks } = fakeConnection()
  const pending = api(request, response, new URL('/api/work-graph/events', 'http://x'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.head, null)
  const batch = version => ({ epoch: 'e1', version, at: 'x', degraded: [], changes: [{ type: 'member-leave', botId: 'a' }] })
  for (const send of facade.senders) { send(batch(5)); send(batch(6)) }
  release()
  await pending
  assert.deepEqual([response.head[0], response.head[1]['content-type']], [200, 'text/event-stream'])
  assert.match(chunks[0], /^event: snapshot\ndata: \{.*"version":5.*\}\n\n$/u)
  assert.equal(chunks.length, 2)
  assert.match(chunks[1], /^event: change\nid: e1:6\ndata: \{.*"version":6.*\}\n\n$/u)
  for (const send of facade.senders) send(batch(7))
  assert.match(chunks[2], /^event: change\nid: e1:7\n/u)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(chunks.includes(': hb\n\n'), true)
  request.emit('close')
  const after = chunks.length
  assert.equal(facade.senders.size, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(chunks.length, after)
})

test('http-api: unavailable child answers 503 JSON before any SSE header', async () => {
  const facade = fakeFacade({ snapshot: async () => { throw unavailable() } })
  const api = createWorkGraphApi({ facade, heartbeatMs: 1e9 })
  for (const path of ['/api/work-graph', '/api/work-graph/events']) {
    const result = await call(api, path)
    assert.deepEqual([result.response.head[0], result.response.head[1]['content-type'], JSON.parse(result.chunks[0])],
      [503, 'application/json; charset=utf-8', { error: 'WORK_GRAPH_UNAVAILABLE' }])
  }
  assert.equal(facade.senders.size, 0)
})

test('http-api: other facade errors are rethrown after the subscription is dropped', async () => {
  const facade = fakeFacade({ snapshot: async () => { throw new Error('boom') } })
  const api = createWorkGraphApi({ facade })
  await assert.rejects(call(api, '/api/work-graph/events'), /boom/u)
  assert.equal(facade.senders.size, 0)
  await assert.rejects(call(api, '/api/work-graph'), /boom/u)
})

test('activeSince: a linked member that starts working begins a new span', () => {
  const linked = project({ queue: [job()], turns: working('a') })
  const now = project({ queue: [job()], turns: { ...working('a'), b: { state: 'working', startedAt: '2026-11-08T10:00:07.000Z' } }, previous: linked, now: T0 + 9000 })
  assert.deepEqual(now.nodes.map(node => [node.botId, node.state, node.activeSince]),
    [['a', 'working', '2026-11-08T10:00:00.000Z'], ['b', 'working', '2026-11-08T10:00:07.000Z']])
})
