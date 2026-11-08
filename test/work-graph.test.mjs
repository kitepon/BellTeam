import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createWorkGraphApi } from '../src/work-graph/http-api.mjs'
import { createWorkGraphHub } from '../src/work-graph/hub.mjs'
import { diffGraph, projectGraph } from '../src/work-graph/projection.mjs'

const T0 = Date.parse('2026-11-08T10:00:00.000Z')
const member = (id, extra = {}) => ({ id, name: id.toUpperCase(), color: 'sky', avatarVersion: 'v1', ...extra })
const job = (extra = {}) => ({ status: 'running', context: 'direct', contextId: 'x', groupId: 'g1', from: 'a', target: 'b', message: 'hello', startedAt: '2026-11-08T10:00:01.000Z', ...extra })
const project = (input) => projectGraph({ members: [member('a'), member('b'), member('c')], turns: {}, queue: [], responders: {}, now: T0, ...input })
const working = (...ids) => Object.fromEntries(ids.map(id => [id, { state: 'working', turnId: 't' }]))

test('edge rules: only running direct/room deliveries between two members', () => {
  const queue = [job(), job({ groupId: 'self', from: 'a', target: 'a' }), job({ groupId: 'user', from: 'user' }), job({ groupId: 'f', status: 'failed' }),
    job({ groupId: 'ctx', context: 'self' }), job({ groupId: 'r1', context: 'room', contextId: 'room' }),
    job({ groupId: 'r2', context: 'room', contextId: 'room', target: 'c', steered: true, message: '\n  \nsecond line' })]
  const { edges, nodes } = project({ queue, responders: { r2: ['c'], r1: ['c'] } })
  assert.deepEqual(edges.map(edge => edge.id), ['g1:b', 'r2:c'])
  assert.deepEqual(edges[1], { id: 'r2:c', requestId: 'r2', from: 'a', to: 'c', context: 'room', roomId: 'room', label: 'second line', state: 'steered', startedAt: '2026-11-08T10:00:01.000Z' })
  assert.deepEqual(nodes.map(node => [node.botId, node.state]), [['a', 'linked'], ['b', 'linked'], ['c', 'linked']])
})

test('label: 40 chars, image-only, empty', () => {
  const label = message => project({ queue: [job(message)] }).edges[0].label
  assert.equal(label({ message: 'x'.repeat(60) }), 'x'.repeat(40))
  assert.equal(label({ message: '', image: true }), '画像')
  assert.equal(label({ message: '' }), '')
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

// Fake ports and timers for hub and api tests.
function rig(overrides = {}) {
  const state = { members: [member('a'), member('b')], turns: {}, queue: [], pages: {}, time: T0, fail: new Set() }
  const listeners = new Set(), timers = new Set()
  const guard = name => { if (state.fail.has(name)) throw Object.assign(new Error(name), { code: name === 'turn-unsupported' ? 'EXECUTION_REQUEST_INVALID' : 'X' }) }
  const ports = {
    bots: { listForClient: async () => { guard('members'); return state.members } },
    rooms: {},
    transport: {
      currentTurn: async id => { guard('turn'); guard('turn-unsupported'); return state.turns[id] ?? { state: 'idle', turnId: null } },
      queueItems: async () => { guard('queue'); return state.queue },
      watchQueue: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    messagePage: async (kind, id) => { guard('responders'); return { items: state.pages[id] ?? [] } },
    now: () => state.time, coalesceMs: 0, leaveGraceMs: 4000,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer },
    clearTimer: timer => timers.delete(timer),
    ...overrides,
  }
  const settle = async () => {
    for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); for (const timer of [...timers].filter(timer => timer.ms === 0)) { timers.delete(timer); await timer.fn() } }
    await new Promise(resolve => setImmediate(resolve))
  }
  const signal = async () => { for (const listener of listeners) listener({}); await settle() }
  return { state, ports, listeners, timers, settle, signal }
}

test('hub: snapshot without subscribers is fresh and starts no watcher', async () => {
  const { ports, state, listeners } = rig()
  state.turns.a = { state: 'working', turnId: 't' }
  const hub = createWorkGraphHub(ports)
  const snapshot = await hub.snapshot()
  assert.equal(snapshot.schema, 'bellteam.work-graph.v1')
  assert.equal(snapshot.version, 0)
  assert.deepEqual([snapshot.nodes.map(node => node.botId), snapshot.degraded, listeners.size], [['a'], [], 0])
})

test('hub: batches bump version by one, in README order, from watchers', async () => {
  const { ports, state, signal, settle, listeners } = rig()
  const hub = createWorkGraphHub(ports)
  const batches = []
  const stop = hub.subscribe(batch => batches.push(batch))
  await settle()
  assert.equal(listeners.size, 1)
  assert.equal((await hub.snapshot()).version, 0)
  state.turns.a = { state: 'working', turnId: 't' }
  state.queue = [job()]
  await signal()
  assert.deepEqual(batches.map(batch => [batch.epoch === hub.epoch, batch.version, batch.changes.map(change => change.type)]),
    [[true, 1, ['member-enter', 'member-enter', 'edge-start']]])
  await signal()
  assert.equal(batches.length, 1)
  state.queue = []
  await signal()
  assert.deepEqual(batches[1].changes.map(change => change.type), ['edge-end'])
  assert.equal(batches[1].version, 2)
  stop()
  assert.equal(listeners.size, 0)
})

test('hub: leave grace via scheduled recompute', async () => {
  const { ports, state, signal, settle, timers } = rig()
  const hub = createWorkGraphHub(ports)
  const batches = []
  hub.subscribe(batch => batches.push(batch))
  await settle()
  state.turns.a = { state: 'working', turnId: 't' }
  await signal()
  state.turns.a = { state: 'idle', turnId: null }
  state.time += 1000
  await signal()
  assert.equal(batches.length, 1)
  assert.equal([...timers].some(timer => timer.ms === 4000), true)
  state.time += 4000
  const [grace] = [...timers]
  timers.delete(grace); grace.fn()
  await settle()
  assert.deepEqual(batches.at(-1).changes, [{ type: 'member-leave', botId: 'a' }])
})

test('hub: room edges need a final responder list, cached per message', async () => {
  const { ports, state, signal, settle } = rig()
  state.queue = [job({ context: 'room', contextId: 'room', groupId: 'm1' })]
  state.pages.room = [{ id: 'm1', routing: { status: 'pending', responders: [] } }]
  let reads = 0
  const read = ports.messagePage
  ports.messagePage = async (...args) => { reads++; return read(...args) }
  const hub = createWorkGraphHub(ports)
  const batches = []
  hub.subscribe(batch => batches.push(batch))
  await settle()
  assert.equal((await hub.snapshot()).edges.length, 0)
  reads = 0
  state.pages.room = [{ id: 'm1', routing: { status: 'ready', responders: ['b'] } }]
  await signal()
  await signal()
  assert.deepEqual(batches.map(batch => batch.changes.map(change => change.type)), [['member-enter', 'member-enter', 'edge-start']])
  assert.equal(reads, 1)
})

test('hub: failing sources keep last good data and report degraded, then recover', async () => {
  const { ports, state, signal, settle } = rig()
  state.turns.a = { state: 'working', turnId: 't' }
  const hub = createWorkGraphHub(ports)
  const batches = []
  hub.subscribe(batch => batches.push(batch))
  await settle()
  assert.equal((await hub.snapshot()).nodes.length, 1)
  state.fail.add('turn'); state.fail.add('queue'); state.fail.add('members')
  state.members = []
  await signal()
  assert.deepEqual(batches.at(-1).degraded, ['members', 'queue', 'turn'].sort())
  assert.deepEqual(batches.at(-1).changes, [])
  assert.equal((await hub.snapshot()).nodes.length, 1)
  state.fail.clear()
  state.members = [member('a')]
  await signal()
  assert.deepEqual(batches.at(-1).degraded, [])
  const responders = rig()
  responders.state.fail.add('responders')
  responders.state.queue = [job({ context: 'room', contextId: 'room', groupId: 'm1' })]
  assert.deepEqual((await createWorkGraphHub(responders.ports).snapshot()).degraded, ['responders'])
})

test('hub: old engine reports turn-unsupported and shows linked nodes only', async () => {
  const { ports, state } = rig()
  state.fail.add('turn-unsupported')
  state.queue = [job()]
  const snapshot = await createWorkGraphHub(ports).snapshot()
  assert.deepEqual([snapshot.degraded, snapshot.nodes.map(node => node.state)], [['turn-unsupported'], ['linked', 'linked']])
})

function fakeConnection(method = 'GET') {
  const request = new EventEmitter(), chunks = []
  request.method = method
  const response = { head: null, writeHead(status, headers) { this.head = [status, headers] }, write: chunk => chunks.push(chunk), end(chunk) { if (chunk) chunks.push(chunk); this.ended = true } }
  return { request, response, chunks }
}

test('http-api: routes, auth and SSE framing', async () => {
  const { ports, state, signal, settle } = rig()
  const api = createWorkGraphApi({ ...ports, heartbeatMs: 1e9 })
  const call = async (path, method, internalApi = api) => {
    const { request, response, chunks } = fakeConnection(method)
    const result = await internalApi(request, response, new URL(path, 'http://x'))
    return { request, response, chunks, result }
  }
  assert.equal((await call('/api/other')).result, false)
  const forbidden = await call('/api/work-graph', 'GET', createWorkGraphApi({ ...ports, internal: true }))
  assert.deepEqual([forbidden.response.head[0], forbidden.chunks[0].includes('WORK_GRAPH_OWNER_REQUIRED')], [403, true])
  assert.equal((await call('/api/work-graph', 'POST')).response.head[0], 405)
  const plain = await call('/api/work-graph', 'GET')
  assert.equal(plain.response.head[0], 200)
  assert.equal(JSON.parse(plain.chunks[0]).schema, 'bellteam.work-graph.v1')

  const sse = await call('/api/work-graph/events', 'GET')
  assert.deepEqual([sse.response.head[0], sse.response.head[1]['content-type']], [200, 'text/event-stream'])
  assert.match(sse.chunks[0], /^event: snapshot\ndata: \{.*"version":0.*\}\n\n$/u)
  state.turns.a = { state: 'working', turnId: 't' }
  await signal()
  const frame = sse.chunks[1]
  assert.match(frame, /^event: change\nid: [0-9a-f-]+:1\ndata: /u)
  assert.equal(JSON.parse(frame.split('data: ')[1]).changes[0].type, 'member-enter')
  sse.request.emit('close')
  await settle()
  state.turns.b = { state: 'working', turnId: 't' }
  await signal()
  assert.equal(sse.chunks.length, 2)
})

test('activeSince: a linked member that starts working begins a new span', () => {
  const linked = project({ queue: [job()], turns: working('a') })
  const now = project({ queue: [job()], turns: { ...working('a'), b: { state: 'working', startedAt: '2026-11-08T10:00:07.000Z' } }, previous: linked, now: T0 + 9000 })
  assert.deepEqual(now.nodes.map(node => [node.botId, node.state, node.activeSince]),
    [['a', 'working', '2026-11-08T10:00:00.000Z'], ['b', 'working', '2026-11-08T10:00:07.000Z']])
})

test('hub: resubscribe during an in-flight pass still gets a full baseline snapshot', { timeout: 2000 }, async () => {
  let release
  const { ports, state, settle } = rig()
  state.turns.a = { state: 'working', turnId: 't' }
  const list = ports.bots.listForClient
  const hub = createWorkGraphHub({ ...ports, bots: { listForClient: async () => { await new Promise(resolve => { release = resolve }); return list() } } })
  const first = hub.subscribe(() => {})
  await settle()
  first()
  const second = hub.subscribe(() => {})
  release()
  await settle()
  release?.()
  await settle()
  assert.deepEqual((await hub.snapshot()).nodes.map(node => node.botId), ['a'])
  second()
})
