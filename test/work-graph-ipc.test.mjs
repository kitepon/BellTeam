import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import test from 'node:test'
import { createWorkGraphParentChannel } from '../src/work-graph-ipc.mjs'
import { projectGraph } from '../src/work-graph/projection.mjs'
import { WORK_GRAPH_STATE_COMPATIBILITY, validateWorkGraphControl, validateWorkGraphControlResult, validateWorkGraphEffect,
  validateWorkGraphEffectResult, validateWorkGraphReady, validateWorkGraphRequest, validateWorkGraphResult, workGraphWireError } from '../src/work-graph-protocol.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

const generation = 'builtin:fixture'
const bad = (fn, code) => assert.throws(fn, error => code ? error.code === code : true)

test('protocol: requests and effects reject extra keys and bad shapes', () => {
  validateWorkGraphRequest('refresh', {}, { generation })
  validateWorkGraphRequest('snapshot', {}, { generation })
  bad(() => validateWorkGraphRequest('refresh', { x: 1 }, { generation }), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphRequest('refresh', {}, { generation, extra: 1 }), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphRequest('other', {}, { generation }), 'WORK_GRAPH_INVALID')
  validateWorkGraphEffect('members.list', {})
  validateWorkGraphEffect('queue.read', {})
  validateWorkGraphEffect('turns.read', { botIds: ['a'] })
  validateWorkGraphEffect('room.messages', { roomId: 'r' })
  bad(() => validateWorkGraphEffect('members.list', { x: 1 }), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphEffect('turns.read', { botIds: [] }), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphEffect('turns.read', { botIds: Array.from({ length: 201 }, (_, i) => `b${i}`) }), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphEffect('turns.read', { botIds: ['a'], extra: 1 }), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphEffect('room.messages', {}), 'WORK_GRAPH_INVALID')
  bad(() => validateWorkGraphEffect('nope', {}), 'WORK_GRAPH_INVALID')
})

test('protocol: effect results are exact', () => {
  const member = { id: 'a', name: 'A', color: '', avatarVersion: '', deleting: false }
  const item = { status: 'running', context: 'direct', contextId: null, groupId: 'g', from: 'a', target: 'b', requestSummary: null, image: false, steered: false, startedAt: 12 }
  validateWorkGraphEffectResult('members.list', { members: [member] })
  validateWorkGraphEffectResult('turns.read', { turns: { a: { state: 'working', turnId: null, startedAt: '2026-11-08T10:00:00.000Z' }, b: { state: 'idle', turnId: 't' } } })
  validateWorkGraphEffectResult('turns.read', { unsupported: true })
  validateWorkGraphEffectResult('turns.read', { turns: { a: { state: 'working', turnId: 't', summary: '確認している', summaryStatus: 'current' }, b: { state: 'idle', turnId: null, summary: null, summaryStatus: 'missing' } } })
  bad(() => validateWorkGraphEffectResult('turns.read', { turns: { a: { state: 'working', turnId: 't', summaryStatus: 'fresh' } } }))
  bad(() => validateWorkGraphEffectResult('turns.read', { turns: { a: { state: 'working', turnId: 't', summary: 'x'.repeat(201) } } }))
  validateWorkGraphEffectResult('queue.read', { items: [item] })
  validateWorkGraphEffectResult('room.messages', { items: [{ id: 'm', routing: null }, { id: 'n', routing: { responders: ['a'], status: 'ready' } }] })
  bad(() => validateWorkGraphEffectResult('members.list', { members: [{ ...member, extra: 1 }] }))
  bad(() => validateWorkGraphEffectResult('members.list', { members: [{ ...member, deleting: 'no' }] }))
  bad(() => validateWorkGraphEffectResult('members.list', { members: [], extra: 1 }))
  bad(() => validateWorkGraphEffectResult('turns.read', { turns: { a: { state: 'busy', turnId: null } } }))
  bad(() => validateWorkGraphEffectResult('turns.read', { unsupported: false }))
  bad(() => validateWorkGraphEffectResult('turns.read', { turns: {}, unsupported: true }))
  bad(() => validateWorkGraphEffectResult('queue.read', { items: [{ ...item, extra: 1 }] }))
  bad(() => validateWorkGraphEffectResult('queue.read', { items: [{ ...item, image: 0 }] }))
  bad(() => validateWorkGraphEffectResult('queue.read', { items: [{ ...item, message: 'raw body' }] }))
  const { requestSummary, ...legacy } = item
  validateWorkGraphEffectResult('queue.read', { items: [{ ...legacy, message: 'Admi -> Centi: raw body' }] })
  bad(() => validateWorkGraphEffectResult('queue.read', { items: [{ ...legacy, message: 1 }] }))
  assert.equal(projectGraph({ members: [member, { ...member, id: 'b' }], queue: [{ ...legacy, message: 'Admi -> Centi: raw body' }], now: 0 }).edges[0].label, '依頼を処理中')
  bad(() => validateWorkGraphEffectResult('queue.read', { items: [{ ...item, requestSummary: 1 }] }))
  bad(() => validateWorkGraphEffectResult('room.messages', { items: [{ id: 'm', routing: { responders: ['a'] } }] }))
  bad(() => validateWorkGraphEffectResult('nope', {}))
})

test('protocol: root results, controls and ready', () => {
  const node = { botId: 'a', name: 'A', color: 'sky', avatarVersion: '', state: 'working', activeSince: '2026-11-08T10:00:00.000Z' }
  const edge = { id: 'g:b', requestId: 'g', from: 'a', to: 'b', context: 'direct', roomId: null, label: 'hi', state: 'running', startedAt: '2026-11-08T10:00:00.000Z' }
  const head = { epoch: 'e', version: 1, at: '2026-11-08T10:00:00.000Z', degraded: [] }
  validateWorkGraphResult('refresh', { batch: null, nextRefreshMs: null })
  validateWorkGraphResult('refresh', { batch: { ...head, changes: [{ type: 'member-enter', node }, { type: 'edge-start', edge }, { type: 'edge-end', edgeId: 'x' }, { type: 'member-leave', botId: 'a' }] }, nextRefreshMs: 0 })
  validateWorkGraphResult('snapshot', { schema: 'bellteam.work-graph.v1', ...head, version: 0, nodes: [node], edges: [edge] })
  bad(() => validateWorkGraphResult('refresh', { batch: null, nextRefreshMs: -1 }))
  bad(() => validateWorkGraphResult('refresh', { batch: null }))
  bad(() => validateWorkGraphResult('refresh', { batch: { ...head, changes: [{ type: 'member-enter', node: { ...node, extra: 1 } }] }, nextRefreshMs: null }))
  bad(() => validateWorkGraphResult('refresh', { batch: { ...head, version: 0, changes: [] }, nextRefreshMs: null }))
  bad(() => validateWorkGraphResult('snapshot', { schema: 'x', ...head, nodes: [], edges: [] }))
  validateWorkGraphControl('initialize', { generation, mode: 'restore' })
  validateWorkGraphControl('quiesce', {})
  bad(() => validateWorkGraphControl('initialize', { generation, mode: 'other' }), 'WORK_GRAPH_CONTROL_INVALID')
  bad(() => validateWorkGraphControl('resume', { x: 1 }), 'WORK_GRAPH_CONTROL_INVALID')
  bad(() => validateWorkGraphControl('stop', {}), 'WORK_GRAPH_CONTROL_INVALID')
  validateWorkGraphControlResult('initialize', { stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY })
  validateWorkGraphControlResult('quiesce', { quiesced: false })
  validateWorkGraphControlResult('resume', { resumed: true })
  validateWorkGraphControlResult('exit', { closed: true })
  bad(() => validateWorkGraphControlResult('resume', { resumed: false }))
  bad(() => validateWorkGraphControlResult('initialize', { stateCompatibility: { state: 'x' } }), 'WORK_GRAPH_STATE_INCOMPATIBLE')
  validateWorkGraphReady({ versionId: null, protocolVersion: 1, stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY })
  validateWorkGraphReady({ versionId: 'a'.repeat(64), protocolVersion: 1, stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY })
  bad(() => validateWorkGraphReady({ versionId: 'zz', protocolVersion: 1, stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY }), 'WORK_GRAPH_READY_INVALID')
  bad(() => validateWorkGraphReady({ versionId: null, protocolVersion: 2, stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY }), 'WORK_GRAPH_READY_INVALID')
  assert.deepEqual(workGraphWireError(new Error('secret path /srv'), 'unknown'), { code: 'WORK_GRAPH_OPERATION_FAILED', status: 503, outcome: 'unknown' })
  assert.equal(workGraphWireError({ code: 'WORK_GRAPH_INVALID' }, 'unknown').status, 400)
})

// A fake child end of the IPC pipe: the test sends raw frames to the parent channel.
function fakeEndpoint() {
  const endpoint = new EventEmitter(), sent = []
  Object.assign(endpoint, { connected: true, send: (message, done) => { sent.push(message); done?.(); return true }, disconnect() { this.connected = false } })
  return { endpoint, sent }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('parent: effect without a pending root operation is rejected', async () => {
  const { endpoint, sent } = fakeEndpoint()
  const effects = []
  const channel = createWorkGraphParentChannel(endpoint, { generation, onEffect: async (...args) => { effects.push(args); return { members: [] } } })
  endpoint.emit('message', { type: 'call', kind: 'effect', id: 1, method: 'members.list', params: {}, context: { operation: 99 } })
  await tick()
  assert.deepEqual(sent.map(message => message.type + ':' + (message.ok ?? '')), ['result:false'])
  assert.deepEqual([sent[0].error.code, sent[0].error.outcome], ['WORK_GRAPH_IPC_INVALID', 'not_accepted'])
  assert.equal(effects.length, 0)
  channel.reaped()
})

test('parent: effects inside a pending root call run onEffect and map failures to a fixed code', async () => {
  const { endpoint, sent } = fakeEndpoint()
  const effects = []
  let answer = async () => ({ members: [] })
  const channel = createWorkGraphParentChannel(endpoint, { generation, onEffect: async (...args) => { effects.push(args); return answer() } })
  await assert.rejects(channel.request('refresh', { x: 1 }), { code: 'WORK_GRAPH_INVALID' })
  assert.throws(() => channel.control('initialize', { generation: 'other', mode: 'restore' }), { code: 'WORK_GRAPH_IPC_INVALID' })
  const root = channel.request('refresh', {})
  root.catch(() => {})
  const call = sent[0]
  assert.deepEqual([call.type, call.kind, call.method, call.context], ['call', 'root', 'refresh', { generation }])
  const effect = (id, method, params, operation = call.id) => endpoint.emit('message', { type: 'call', kind: 'effect', id, method, params, context: { operation } })
  effect(1, 'members.list', {})
  await tick()
  assert.deepEqual(sent.slice(1).map(message => [message.type, message.ok]), [['accepted', undefined], ['result', true]])
  assert.deepEqual(effects, [['members.list', {}]])
  effect(2, 'queue.read', {}); answer = async () => { throw new Error('/srv/secret') }
  await tick()
  assert.deepEqual(sent.at(-1).error, { code: 'WORK_GRAPH_EFFECT_FAILED', outcome: 'unknown', status: 503 })
  answer = async () => ({ items: [{ extra: 1 }] })
  effect(3, 'queue.read', {})
  await tick()
  assert.equal(sent.at(-1).error.code, 'WORK_GRAPH_EFFECT_FAILED')
  effect(4, 'members.list', { x: 1 })
  await tick()
  assert.equal(sent.at(-1).error.code, 'WORK_GRAPH_INVALID')
  channel.reaped()
  await assert.rejects(root, { code: 'WORK_GRAPH_IPC_DISCONNECTED' })
})

test('actual IPC: initialize, ready, resume, refresh with effects, snapshot, quiesce, exit', { timeout: 15000 }, async t => {
  const child = fork(new URL('./fixtures/work-graph-child.mjs', import.meta.url).pathname, [], { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' })
  const ended = waitNotificationsChildClose(child)
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  const world = { turns: { a: { state: 'working', turnId: 't', startedAt: '2026-11-08T10:00:00.000Z' } }, queue: [], calls: [] }
  const channel = createWorkGraphParentChannel(child, { generation, onEffect: async (method, params) => {
    world.calls.push(method)
    if (method === 'members.list') return { members: ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), color: 'sky', avatarVersion: '', deleting: false })) }
    if (method === 'turns.read') return { turns: Object.fromEntries(params.botIds.map(id => [id, world.turns[id] ?? { state: 'idle', turnId: null }])) }
    if (method === 'queue.read') return { items: world.queue }
    return { items: [] }
  } })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.reaped() })
  assert.deepEqual(await channel.control('initialize', { generation, mode: 'restore' }, 15000), { stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY })
  assert.deepEqual(await channel.ready, { versionId: null, protocolVersion: 1, stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY })
  await assert.rejects(channel.request('refresh', {}), { outcome: 'not_accepted' })
  assert.deepEqual(await channel.control('resume'), { resumed: true })
  assert.deepEqual(await channel.request('refresh', {}), { batch: null, nextRefreshMs: null })
  world.queue = [{ status: 'running', context: 'direct', contextId: null, groupId: 'g1', from: 'a', target: 'b', requestSummary: '確認の依頼', image: false, steered: false, startedAt: null }]
  const { batch } = await channel.request('refresh', {})
  assert.deepEqual([batch.version, batch.changes.map(change => change.type)], [1, ['member-enter', 'edge-start']])
  const snapshot = await channel.request('snapshot', {})
  assert.deepEqual([snapshot.version, snapshot.nodes.map(node => [node.botId, node.state]), snapshot.edges.map(edge => edge.id)],
    [1, [['a', 'working'], ['b', 'linked']], ['g1:b']])
  assert.equal(snapshot.epoch, batch.epoch)
  assert.equal(world.calls.filter(method => method === 'members.list').length, 2)
  assert.equal(channel.snapshot().root, 0)
  assert.deepEqual(await channel.control('quiesce', {}, 15000), { quiesced: true })
  await assert.rejects(channel.request('snapshot', {}), { outcome: 'not_accepted' })
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
  assert.equal(stderr, '')
})
