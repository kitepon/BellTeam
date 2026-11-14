import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLatticeParentChannel } from '../src/lattice-ipc.mjs'
import { LATTICE_STATE_COMPATIBILITY, validateLatticeControl, validateLatticeControlResult, validateLatticeEffect, validateLatticeEffectResult,
  validateLatticeReady, validateLatticeRequest, validateLatticeResult, latticeWireError, latticeRunReads } from '../src/lattice-protocol.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

const generation = 'builtin:fixture'
const context = { generation }
const bad = (fn, code) => assert.throws(fn, error => code ? error.code === code : true)

test('protocol: latticeRunReads names only commands that write nothing (README L3)', () => {
  for (const args of [['--version'], ['help'], ['status', '--json'], ['session-context'], ['plan', 'show', '--plan', 'p'], ['todo', 'show', '--plan', 'p', '--task', 't'],
    ['todo', 'status'], ['todo', 'blockers', '--json'], ['todo', 'display', 'read', '--json'], ['todo', 'note', 'list'], ['todo', 'notice', 'list']]) assert.equal(latticeRunReads(args), true, args.join(' '))
  for (const args of [['todo', 'start'], ['todo', 'note', '--message', 'x'], ['todo', 'notice', 'ack'], ['todo', 'add'], ['plan', 'create'], ['plan', 'revise'], ['todo'], [], 'status'])
    assert.equal(latticeRunReads(args), false, String(args))
  assert.equal(latticeRunReads(['status'], { a: 1 }), false, 'an input always writes')
})

test('protocol: request validators are exact', () => {
  validateLatticeRequest('charts', {}, context)
  validateLatticeRequest('chart', { projectId: 'a' }, context)
  validateLatticeRequest('chart', { projectId: 'a'.repeat(63) }, context)
  validateLatticeRequest('refresh', { projectIds: ['a', 'b-2'] }, context)
  validateLatticeRequest('run', { from: 'bot-a', projectId: 'p1', args: ['status'], input: null }, context)
  validateLatticeRequest('run', { from: 'bot-a', projectId: 'p1', args: [], input: { a: [1] } }, context)
  bad(() => validateLatticeRequest('charts', { x: 1 }, context), 'LATTICE_INVALID')
  bad(() => validateLatticeRequest('charts', {}, { generation, extra: 1 }), 'LATTICE_INVALID')
  bad(() => validateLatticeRequest('other', {}, context), 'LATTICE_INVALID')
  for (const projectId of ['', 'A', '-a', 'a_b', 'a/b', '..', 'a'.repeat(64), 5]) bad(() => validateLatticeRequest('chart', { projectId }, context), 'LATTICE_PROJECT_INVALID')
  bad(() => validateLatticeRequest('chart', { projectId: 'a', extra: 1 }, context), 'LATTICE_INVALID')
  bad(() => validateLatticeRequest('refresh', { projectIds: [] }, context), 'LATTICE_INVALID')
  bad(() => validateLatticeRequest('refresh', { projectIds: ['a', 'a'] }, context), 'LATTICE_INVALID')
  bad(() => validateLatticeRequest('refresh', { projectIds: Array.from({ length: 51 }, (_, i) => `p${i}`) }, context), 'LATTICE_INVALID')
  validateLatticeRequest('refresh', { projectIds: Array.from({ length: 50 }, (_, i) => `p${i}`) }, context)
  bad(() => validateLatticeRequest('refresh', { projectIds: ['a', 'B'] }, context), 'LATTICE_PROJECT_INVALID')
  const run = { from: 'bot-a', projectId: 'p1', args: ['status'], input: null }
  for (const patch of [{ from: '' }, { from: 'x'.repeat(129) }, { args: 'status' }, { args: [1] }, { args: ['x'.repeat(8193)] }, { args: Array(201).fill('a') },
    { input: [] }, { input: 'x' }, { input: undefined }, { extra: 1 }]) bad(() => validateLatticeRequest('run', { ...run, ...patch }, context), 'LATTICE_INVALID')
  validateLatticeRequest('run', { ...run, args: ['x'.repeat(8192)] }, context)
  validateLatticeRequest('run', { ...run, args: Array(200).fill('a') }, context)
  validateLatticeRequest('run', { ...run, args: [], name: 'Lattice組込' }, context)
  for (const name of ['', ' a', 'a ', 'a\nb', 'x'.repeat(41), 5, null]) bad(() => validateLatticeRequest('run', { ...run, name }, context), 'LATTICE_NAME_INVALID')
  bad(() => validateLatticeRequest('run', { ...run, projectId: 'Bad' }, context), 'LATTICE_PROJECT_INVALID')
})

test('protocol: effect and its result', () => {
  const member = { id: 'a', name: 'A', color: '', avatarVersion: '', deleting: false }
  validateLatticeEffect('members.list', {})
  bad(() => validateLatticeEffect('members.list', { x: 1 }), 'LATTICE_INVALID')
  bad(() => validateLatticeEffect('queue.read', {}), 'LATTICE_INVALID')
  validateLatticeEffectResult('members.list', { members: [member] })
  bad(() => validateLatticeEffectResult('members.list', { members: [{ ...member, extra: 1 }] }))
  bad(() => validateLatticeEffectResult('members.list', { members: [{ ...member, deleting: 'no' }] }))
  bad(() => validateLatticeEffectResult('members.list', { members: [], extra: 1 }))
  bad(() => validateLatticeEffectResult('turns.read', {}))
})

const card = { id: 'p1/t1', plan: 'p1', taskId: 't1', title: 'A', doneCondition: null, designMemo: null, state: 'ready', lane: null, producer: null,
  startedAt: null, changedAt: null, blockedReason: null, depth: 0 }
const snapshot = { schema: 'bellteam.lattice-chart.v1', epoch: 'e', version: 1, at: '2026-11-11T10:00:00.000Z', projectId: 'alpha', name: null, createdBy: null, coordinator: false, state: 'verified',
  verifiedAt: null, degraded: [], members: [{ botId: 'a', name: 'A', color: 'sky', avatarVersion: '' }], cards: [card],
  edges: [{ from: 'p1/t1', to: 'p1/t2', waiting: true }],
  waits: [{ waiter: null, waitingCard: 'p1/t2', forCard: 'p1/t1', producer: 'a', producerState: 'ready', since: null }] }
const summary = { projectId: 'alpha', name: null, coordinator: true, createdBy: null, counts: { total: 1, done: 0, working: 0, waiting: 0, blocked: 0 }, activeMembers: [], updatedAt: null, state: 'unavailable' }

test('protocol: root results are exact', () => {
  validateLatticeResult('chart', snapshot)
  validateLatticeResult('chart', { ...snapshot, degraded: ['lattice-read', 'members'], state: 'last_verified', verifiedAt: 'x' })
  validateLatticeResult('charts', { schema: 'bellteam.lattice-charts.v1', at: 'x', charts: [summary] })
  validateLatticeResult('chart', { ...snapshot, phases: [{ id: 'p1/ph1', title: null }], cards: [{ ...card, phase: 'p1/ph1', parent: null, doneAt: null, archived: false }] }) // tree and archive keys are optional
  // Predecessors on another chart (task a60): optional externals, edge flag, unread state null.
  const ext = { id: 'other:p1/t1', projectId: 'other', cardId: 'p1/t1', chartName: null, title: null, state: null, finished: false, producer: null }
  validateLatticeResult('chart', { ...snapshot, externals: [ext, { ...ext, state: 'in-progress', title: 'T', chartName: 'O', producer: 'bot-a' }],
    edges: [{ from: 'other:p1/t1', to: 'p1/t1', waiting: true, external: true }],
    waits: [{ waiter: null, waitingCard: 'p1/t1', forCard: 'other:p1/t1', producer: null, producerState: null, since: null }] })
  for (const patch of [{ externals: [{ ...ext, projectId: 'Bad' }] }, { externals: [{ ...ext, state: 'weird' }] }, { externals: [{ ...ext, finished: null }] }, { externals: [{ ...ext, extra: 1 }] },
    { edges: [{ from: 'a', to: 'b', waiting: true, external: false }] }]) bad(() => validateLatticeResult('chart', { ...snapshot, ...patch }))
  validateLatticeResult('refresh', { snapshots: [snapshot], nextRefreshMs: 2000 })
  validateLatticeResult('refresh', { snapshots: [], nextRefreshMs: 0 })
  for (const result of [{ exitCode: 0, result: { a: 1 }, stdout: null, stderr: '' }, { exitCode: null, result: null, stdout: 'text', stderr: 'LATTICE_CLI_TIMEOUT' },
    { exitCode: 1, result: [1, 'x', null], stdout: null, stderr: 'e' }]) validateLatticeResult('run', result)
  for (const patch of [{ extra: 1 }, { schema: 'x' }, { version: 0 }, { epoch: '' }, { projectId: 'Bad' }, { state: 'weird' }, { degraded: ['codes'] }, { coordinator: 1 },
    { members: [{ botId: 'a' }] }, { cards: [{ ...card, state: 'weird' }] }, { cards: [{ ...card, depth: -1 }] }, { cards: [{ ...card, extra: 1 }] },
    { edges: [{ from: 'a', to: 'b' }] }, { waits: [{ waiter: null }] }, { phases: [{ id: 'p1/ph1' }] }, { phases: 'x' }, { cards: [{ ...card, phase: 1 }] }, { cards: [{ ...card, archived: 'no' }] }, { cards: [{ ...card, doneAt: 3 }] }]) bad(() => validateLatticeResult('chart', { ...snapshot, ...patch }))
  bad(() => validateLatticeResult('charts', { schema: 'bellteam.lattice-charts.v1', at: 'x', charts: [{ ...summary, counts: { total: 1 } }] }))
  bad(() => validateLatticeResult('charts', { schema: 'bellteam.lattice-charts.v1', at: 'x', charts: [{ ...summary, createdBy: 1 }] }))
  bad(() => validateLatticeResult('refresh', { snapshots: [snapshot] }))
  bad(() => validateLatticeResult('refresh', { snapshots: [snapshot], nextRefreshMs: -1 }))
  bad(() => validateLatticeResult('run', { exitCode: '0', result: null, stdout: null, stderr: '' }))
  bad(() => validateLatticeResult('run', { exitCode: 0, result: null, stdout: null }))
  bad(() => validateLatticeResult('run', { exitCode: 0, stdout: null, stderr: '' }))
  bad(() => validateLatticeResult('nope', {}))
})

test('protocol: controls, ready and wire errors', () => {
  validateLatticeControl('initialize', { generation, mode: 'restore' })
  validateLatticeControl('quiesce', {})
  bad(() => validateLatticeControl('initialize', { generation, mode: 'other' }), 'LATTICE_CONTROL_INVALID')
  bad(() => validateLatticeControl('resume', { x: 1 }), 'LATTICE_CONTROL_INVALID')
  bad(() => validateLatticeControl('stop', {}), 'LATTICE_CONTROL_INVALID')
  validateLatticeControlResult('initialize', { stateCompatibility: LATTICE_STATE_COMPATIBILITY })
  validateLatticeControlResult('quiesce', { quiesced: false })
  validateLatticeControlResult('resume', { resumed: true })
  validateLatticeControlResult('exit', { closed: true })
  bad(() => validateLatticeControlResult('resume', { resumed: false }))
  bad(() => validateLatticeControlResult('initialize', { stateCompatibility: { state: 'x' } }), 'LATTICE_STATE_INCOMPATIBLE')
  validateLatticeReady({ versionId: null, protocolVersion: 1, stateCompatibility: LATTICE_STATE_COMPATIBILITY })
  validateLatticeReady({ versionId: 'a'.repeat(64), protocolVersion: 1, stateCompatibility: LATTICE_STATE_COMPATIBILITY })
  bad(() => validateLatticeReady({ versionId: 'zz', protocolVersion: 1, stateCompatibility: LATTICE_STATE_COMPATIBILITY }), 'LATTICE_READY_INVALID')
  bad(() => validateLatticeReady({ versionId: null, protocolVersion: 2, stateCompatibility: LATTICE_STATE_COMPATIBILITY }), 'LATTICE_READY_INVALID')
  assert.deepEqual(latticeWireError(new Error('secret path /srv'), 'unknown'), { code: 'LATTICE_OPERATION_FAILED', status: 503, outcome: 'unknown' })
  const statuses = { LATTICE_INVALID: 400, LATTICE_CONTROL_INVALID: 400, LATTICE_CHART_NOT_FOUND: 404, LATTICE_PROJECT_INVALID: 400, LATTICE_INPUT_CONFLICT: 400,
    LATTICE_COMMAND_NOT_SEAT_SURFACE: 400, LATTICE_NOT_ACCEPTED: 503, LATTICE_UNAVAILABLE: 503, LATTICE_NOT_QUIESCED: 503, LATTICE_EFFECT_FAILED: 503 }
  for (const [code, status] of Object.entries(statuses)) assert.deepEqual(latticeWireError({ code }, 'unknown'), { code, status, outcome: 'unknown' })
})

// A fake child end of the IPC pipe: the test sends raw frames to the parent channel.
function fakeEndpoint() {
  const endpoint = new EventEmitter(), sent = []
  Object.assign(endpoint, { connected: true, send: (message, done) => { sent.push(message); done?.(); return true }, disconnect() { this.connected = false } })
  return { endpoint, sent }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('parent: an effect outside a pending root call is rejected', async () => {
  const { endpoint, sent } = fakeEndpoint()
  const effects = []
  const channel = createLatticeParentChannel(endpoint, { generation, onEffect: async (...args) => { effects.push(args); return { members: [] } } })
  endpoint.emit('message', { type: 'call', kind: 'effect', id: 1, method: 'members.list', params: {}, context: { operation: 99 } })
  await tick()
  assert.deepEqual(sent.map(message => message.type + ':' + (message.ok ?? '')), ['result:false'])
  assert.deepEqual([sent[0].error.code, sent[0].error.outcome], ['LATTICE_IPC_INVALID', 'not_accepted'])
  assert.equal(effects.length, 0)
  channel.reaped()
})

test('parent: root calls validate first, run gets a longer timeout, effects map failures to a fixed code except the two decisions outcomes', async () => {
  const { endpoint, sent } = fakeEndpoint()
  const effects = []
  let answer = async () => ({ members: [] })
  const channel = createLatticeParentChannel(endpoint, { generation, onEffect: async (...args) => { effects.push(args); return answer() } })
  await assert.rejects(channel.request('chart', { projectId: 'Bad' }), { code: 'LATTICE_PROJECT_INVALID' })
  await assert.rejects(channel.request('charts', { x: 1 }), { code: 'LATTICE_INVALID' })
  assert.equal(sent.length, 0)
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, ms, ...rest) }
  const root = channel.request('charts', {}); root.catch(() => {})
  const running = channel.request('run', { from: 'bot-a', projectId: 'p1', args: ['status'], input: null }); running.catch(() => {})
  globalThis.setTimeout = realSetTimeout
  assert.deepEqual(timers.slice(-4), [5000, 60000, 5000, 70000])
  const call = sent[0]
  assert.deepEqual([call.type, call.kind, call.method, call.context], ['call', 'root', 'charts', { generation }])
  const effect = (id, method, params, operation = call.id) => endpoint.emit('message', { type: 'call', kind: 'effect', id, method, params, context: { operation } })
  effect(1, 'members.list', {})
  await tick()
  assert.deepEqual(effects, [['members.list', {}]])
  answer = async () => { throw new Error('/srv/secret') }
  effect(2, 'members.list', {})
  await tick()
  assert.deepEqual(sent.at(-1).error, { code: 'LATTICE_EFFECT_FAILED', outcome: 'unknown', status: 503 })
  answer = async () => ({ members: [{ extra: 1 }] })
  effect(3, 'members.list', {})
  await tick()
  assert.equal(sent.at(-1).error.code, 'LATTICE_EFFECT_FAILED')
  answer = async () => { throw Object.assign(new Error('LATTICE_DECISIONS_REFUSED'), { code: 'LATTICE_DECISIONS_REFUSED', status: 409 }) }
  effect(4, 'members.list', {})
  await tick()
  assert.deepEqual(sent.at(-1).error, { code: 'LATTICE_DECISIONS_REFUSED', outcome: 'unknown', status: 409 })
  answer = async () => { throw Object.assign(new Error('LATTICE_DECISIONS_UNAVAILABLE'), { code: 'LATTICE_DECISIONS_UNAVAILABLE', status: 418 }) }
  effect(5, 'members.list', {})
  await tick()
  assert.deepEqual(sent.at(-1).error, { code: 'LATTICE_DECISIONS_UNAVAILABLE', outcome: 'unknown', status: 503 })
  effect(8, 'members.list', { x: 1 })
  await tick()
  assert.equal(sent.at(-1).error.code, 'LATTICE_INVALID')
  effect(9, 'turns.read', {})
  await tick()
  assert.equal(sent.at(-1).error.code, 'LATTICE_INVALID')
  channel.reaped()
  await assert.rejects(root, { code: 'LATTICE_IPC_DISCONNECTED' })
})

const CHILD = base => `import { createLatticeCore } from '${base}/src/lattice/core.mjs'
import { createLatticeDispatcher } from '${base}/src/lattice-dispatcher.mjs'
import { createLatticeChildChannel } from '${base}/src/lattice-ipc.mjs'
const read = { state: 'verified', verified_at: '2026-11-11T10:00:00.000Z', store: { members: [{ plan: { plan_key: 'p1', tasks: [{ task_id: 't1', title: 'A' }] },
  tasks: [{ task_id: 't1', status: 'in-progress' }], journal: { events: [{ kind: 'start', task_id: 't1', actor: { agent: 'a' }, recorded_at: '2026-11-11T10:00:00.000Z' }] }, plan_scoped: { events: [] } }] } }
const ok = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
const cli = { list: async () => ['alpha'], source: async () => ({ n: 1 }), exists: async id => id === 'alpha', ensure: async () => ({ created: false }), meta: async () => ({ name: 'Lattice組込', createdBy: null }), setMeta: async () => {}, prune: async () => {},
  run: async ({ args, env }) => args.join(' ') === 'todo display source --json' ? ok({ n: 1 }) : args.join(' ') === 'todo display read --json' ? ok(read)
    : args[0] === 'todo' && args[1] === 'slow' ? new Promise(resolve => setTimeout(() => resolve(ok({ slow: true })), 800)) : ok({ args, seat: env.LATTICE_SEAT_ID }) }
createLatticeChildChannel({ dispatcher: createLatticeDispatcher({ core: createLatticeCore({ cli }) }), versionId: null })
`

test('actual IPC: initialize, ready, resume, charts, chart, refresh, run, errors, quiesce, exit', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lattice-child-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = join(dir, 'child.mjs')
  await writeFile(script, CHILD(new URL('..', import.meta.url).pathname.replace(/\/$/u, '')))
  const child = fork(script, [], { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' })
  const ended = waitNotificationsChildClose(child)
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  const effects = []
  const channel = createLatticeParentChannel(child, { generation, onEffect: async method => {
    effects.push(method)
    return { members: [{ id: 'a', name: 'A', color: 'sky', avatarVersion: 'v', deleting: false }] }
  } })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.reaped() })
  assert.deepEqual(await channel.control('initialize', { generation, mode: 'restore' }, 15000), { stateCompatibility: LATTICE_STATE_COMPATIBILITY })
  assert.deepEqual(await channel.ready, { versionId: null, protocolVersion: 1, stateCompatibility: LATTICE_STATE_COMPATIBILITY })
  await assert.rejects(channel.request('charts', {}), { outcome: 'not_accepted' })
  assert.deepEqual(await channel.control('resume'), { resumed: true })
  const list = await channel.request('charts', {})
  assert.deepEqual(list.charts.map(chart => [chart.projectId, chart.state, chart.activeMembers]), [['alpha', 'verified', ['a']]])
  const first = await channel.request('chart', { projectId: 'alpha' })
  assert.deepEqual([first.version, first.members.map(member => member.name), first.cards.map(card => card.producer)], [1, ['A'], ['a']])
  assert.deepEqual((await channel.request('refresh', { projectIds: ['alpha'] })).snapshots.map(s => s.version), [1])
  assert.deepEqual((await channel.request('refresh', { projectIds: ['alpha'] })).snapshots, [])
  assert.deepEqual(await channel.request('run', { from: 'bot-a', projectId: 'alpha', args: ['status'], input: null }),
    { exitCode: 0, result: { args: ['status'], seat: 'bot-a' }, stdout: null, stderr: '' })
  await assert.rejects(channel.request('chart', { projectId: 'nope' }), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 })
  // Reads never wait behind a write (README L3, incident 2026-11-14); writes keep their order.
  const order = []
  const slow = channel.request('run', { from: 'bot-a', projectId: 'alpha', args: ['todo', 'slow'], input: null }).then(() => order.push('slow run'))
  const next = channel.request('run', { from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'], input: null }).then(() => order.push('next run'))
  await channel.request('chart', { projectId: 'alpha' }).then(() => order.push('chart'))
  await channel.request('charts', {}).then(() => order.push('charts'))
  // A read-only seat run (Centi Z2: --version waited 37 s behind a write) goes beside the write too.
  await channel.request('run', { from: 'bot-b', projectId: 'alpha', args: ['--version'], input: null }).then(() => order.push('seat read'))
  await Promise.all([slow, next])
  assert.deepEqual(order, ['chart', 'charts', 'seat read', 'slow run', 'next run'])
  await assert.rejects(channel.request('run', { from: 'bot-a', projectId: 'alpha', args: ['setup'], input: null }), { code: 'LATTICE_COMMAND_NOT_SEAT_SURFACE', status: 400 })
  assert.equal(effects.length >= 1, true)
  assert.equal(channel.snapshot().root, 0)
  assert.deepEqual(await channel.control('quiesce', {}, 15000), { quiesced: true })
  await assert.rejects(channel.request('charts', {}), { outcome: 'not_accepted' })
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
  assert.equal(stderr, '')
})
