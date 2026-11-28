import assert from 'node:assert/strict'
import test from 'node:test'
import { nudgeSweep, nudgeMessage } from '../src/lattice/nudge.mjs'
import { laneResolver } from '../src/lattice/projection.mjs'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { createLatticeCore } from '../src/lattice/core.mjs'
import { validateLatticeEffect, validateLatticeEffectResult, validateLatticeRequest, validateLatticeResult } from '../src/lattice-protocol.mjs'

const members = ['bot-a', 'bot-b', 'bot-c', 'bot-del'].map(id => ({ id, name: id === 'bot-c' ? 'Cee' : id, color: 'sky', avatarVersion: 'v1', deleting: id === 'bot-del' }))
const card = (taskId, state, lane) => ({ plan: 'p1', taskId, title: taskId.toUpperCase(), state, lane })

function rig({ charts, turns = {}, deliveries = {}, turnsFail = false }) {
  const sent = [], logs = [], reads = [], warned = new Map()
  const effect = async (method, params) => {
    if (method === 'turns.read') { reads.push(params.botIds); if (turnsFail) throw new Error('down'); return { turns } }
    assert.equal(method, 'messages.send')
    sent.push(params)
    return { delivery: deliveries[params.target] ?? 'running', deliveryId: 'd' }
  }
  return { sent, logs, reads, charts, go: () => nudgeSweep(charts, { laneOf: laneResolver(members), log: line => logs.push(line), effect, warned }) }
}

test('nudge: in-progress and startable cards, ONE prompt per lane Bot that is not working; no todo nudge, no other condition', async () => {
  const x = rig({
    charts: [
      { projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'in-progress', 'bot-a'), card('t3', 'ready', 'bot-b'), card('t4', 'ready', 'owner'),
        card('t5', 'blocked', 'bot-a'), card('t6', 'pending', 'bot-a'), card('t7', 'done', 'bot-a'), card('t8', 'retired', 'bot-a'), card('t9', 'ready', 'stranger')] },
      { projectId: 'beta', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'in-progress', 'Cee'), card('t3', 'ready', 'bot-del')] },
      { projectId: 'empty', cards: [] },
    ],
    turns: { 'bot-a': 'idle', 'bot-b': 'working', 'bot-c': 'unknown' },
  })
  const out = await x.go()
  assert.deepEqual(x.reads, [['bot-a', 'bot-b', 'bot-c'], ['bot-a'], ['bot-c']], 'owner, deleting and non-roster lanes have no seat; a lane by name resolves; each Bot to be prompted is read again right before its send')
  assert.deepEqual(x.sent.map(item => [item.from, item.target]), [['scheduler', 'bot-a'], ['scheduler', 'bot-c']], 'a working Bot is not prompted')
  const text = x.sent[0].message
  assert.ok(text.startsWith('Lattice: you are not running') && text.includes('Start at least one now.'))
  assert.ok(text.includes('lattice todo predecessor add') && text.includes('--before <T>') && text.includes('lattice todo retract') && text.includes('lattice todo connect condition add') && text.includes('lattice todo block'))
  assert.ok(text.indexOf('lattice todo block') > text.indexOf('lattice todo add') && text.includes('no AI can operate at all') && text.includes('as the last resort') && text.includes('--lane <member Bot id> --before <T>'), 'a stop is the last resort, only for what no AI can operate (Owner, task a58)')
  assert.ok(!text.includes('such as apple') && !text.includes('done yourself'))
  assert.ok(text.endsWith('\nChart alpha (lattice tool, project alpha):\n- p1/t1 「T1」: can start -> `lattice todo start --plan p1 --task t1`\n- p1/t2 「T2」: in progress'
    + '\nChart beta (lattice tool, project beta):\n- p1/t1 「T1」: can start -> `lattice todo start --plan p1 --task t1`'))
  assert.ok(!text.includes('t5') && !text.includes('t6') && !text.includes('t7') && !text.includes('t8'), 'stopped, waiting on prerequisites and finished cards are not prompted')
  assert.deepEqual(out, { charts: 3, prompted: 2, skipped: 1, failed: 0 })
})

// Owner 2026-11-28 rate-limit order: a Claude seat is started only while fewer than cap Claude seats work; fairest first; others and a failed read are not capped.
function capRig({ load, turns = {} }) {
  const sent = [], logs = [], promptedAt = new Map()
  const effect = async (method, params) => {
    if (method === 'claude.load') { if (load instanceof Error) throw load; return load }
    if (method === 'turns.read') return { turns: Object.fromEntries(params.botIds.map(id => [id, turns[id] ?? 'idle'])) }
    sent.push(params.target)
    return { delivery: 'running', deliveryId: 'd' }
  }
  const charts = [{ projectId: 'alpha', cards: ['bot-a', 'bot-b', 'bot-c'].map(lane => card('t-' + lane, 'ready', lane)) }]
  return { sent, logs, promptedAt, go: () => nudgeSweep(charts, { laneOf: laneResolver(members), log: line => logs.push(line), effect, promptedAt }) }
}

test('nudge cap: at or above the cap no Claude seat is prompted; below it at most cap - working, the one prompted longest ago first', async () => {
  const full = capRig({ load: { cap: 2, claude: ['bot-a', 'bot-b', 'bot-c', 'bot-x'], working: ['bot-x', 'bot-y'] } })
  assert.deepEqual(await full.go(), { charts: 1, prompted: 0, skipped: 3, failed: 0 })
  assert.deepEqual([full.sent, full.logs], [[], ['lattice-nudge-cap 2/2']], 'nothing is sent; the tick says why')
  const some = capRig({ load: { cap: 3, claude: ['bot-a', 'bot-b', 'bot-c', 'bot-x'], working: ['bot-x', 'bot-y'] } })
  some.promptedAt.set('bot-a', 5); some.promptedAt.set('bot-b', 1)
  assert.deepEqual(await some.go(), { charts: 1, prompted: 1, skipped: 2, failed: 0 })
  assert.deepEqual(some.sent, ['bot-c'], 'one place: the Bot never prompted goes before the older and the newer prompt')
  assert.ok(some.promptedAt.has('bot-c'))
  const again = capRig({ load: { cap: 3, claude: ['bot-a', 'bot-b', 'bot-c'], working: [] } })
  again.promptedAt.set('bot-a', 5); again.promptedAt.set('bot-b', 1); again.promptedAt.set('bot-c', 3)
  await again.go()
  assert.deepEqual(again.sent, ['bot-b', 'bot-c', 'bot-a'], 'three places: all are sent, longest ago first')
})

test('nudge cap: a seat that is not Claude, a seat already working and a failed claude.load are not limited', async () => {
  const other = capRig({ load: { cap: 1, claude: ['bot-a'], working: ['bot-y'] } })
  assert.deepEqual(await other.go(), { charts: 1, prompted: 2, skipped: 1, failed: 0 })
  assert.deepEqual(other.sent, ['bot-b', 'bot-c'], 'bot-a (Claude, cap full) is held; the others go')
  const failed = capRig({ load: new Error('old body') })
  assert.deepEqual(await failed.go(), { charts: 1, prompted: 3, skipped: 0, failed: 0 })
  assert.deepEqual(failed.logs, [], 'an unknown load is no cap and no noise')
})

test('nudge: a Bot that started a turn after the batch read is not prompted (a481)', async () => {
  const sent = [], effect = async (method, params) => method === 'claude.load' ? {} : method === 'turns.read'
    ? { turns: { 'bot-a': params.botIds.length > 1 ? 'idle' : 'working', 'bot-c': 'idle' } }
    : (sent.push(params.target), { delivery: 'running' })
  const out = await nudgeSweep([{ projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'ready', 'bot-c')] }], { laneOf: laneResolver(members), log() {}, effect })
  assert.deepEqual(sent, ['bot-c'])
  assert.deepEqual(out, { charts: 1, prompted: 1, skipped: 1, failed: 0 })
})

test('nudge: a failed turns read prompts every Bot; a send not accepted counts failed and the next tick sends again', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'ready', 'bot-b')] }], turnsFail: true, deliveries: { 'bot-b': 'refused' } })
  assert.deepEqual(await x.go(), { charts: 1, prompted: 1, skipped: 0, failed: 1 })
  assert.deepEqual(x.sent.map(item => item.target), ['bot-a', 'bot-b'])
  assert.deepEqual(x.logs, ['lattice-nudge-send bot-b not accepted'])
  const quiet = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'done', 'bot-a')] }] })
  assert.deepEqual(await quiet.go(), { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  assert.deepEqual(quiet.reads, [], 'nothing actionable: no turn read')
})

test('nudge: a task list over 4000 chars is ONE send per Bot, bounded, the rest counted', async () => {
  const cards = Array.from({ length: 40 }, (_, i) => ({ ...card(`t${i}`, 'ready', 'bot-a'), title: 'x'.repeat(80) }))
  const sends = []
  const effect = async (method, params) => method === 'claude.load' ? {} : method === 'turns.read' ? { turns: { 'bot-a': 'idle' } } : (sends.push(params), { delivery: 'running' })
  const out = await nudgeSweep([{ projectId: 'a', cards }], { laneOf: lane => lane, log: () => {}, effect })
  assert.equal(sends.length, 1, 'exactly one prompt')
  assert.deepEqual([out.prompted, out.failed], [1, 0])
  const text = sends[0].message
  assert.ok(text.length <= 4000)
  const shown = text.split('「').length - 1
  assert.ok(shown > 0 && shown < 40)
  assert.ok(text.endsWith(`... and ${40 - shown} more of your tasks are in progress or can start: see \`lattice status\` on each chart.`))
  assert.equal(nudgeMessage(cards.slice(0, 2).map(c => ({ projectId: 'a', card: c }))).includes('more of your tasks'), false, 'a short list has no tail')
})

test('nudge a145: a card whose lane is no Bot and not the Owner goes to the chart creator in its ONE message; no creator is logged once per chart', async () => {
  const x = rig({
    charts: [
      { projectId: 'alpha', createdBy: 'bot-b', cards: [card('t1', 'ready', 'stranger'), card('t2', 'in-progress', 'bot-del'), card('t3', 'ready', ''),
        card('t4', 'ready', 'bot-a'), card('t5', 'pending', 'stranger'), card('t6', 'ready', 'owner')] },
      { projectId: 'beta', createdBy: null, cards: [card('t1', 'ready', 'ghost'), card('t2', 'ready', 'ghost')] },
      { projectId: 'gamma', createdBy: 'bot-a', cards: [card('t1', 'ready', 'ghost')] },
    ],
  })
  const out = await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b', 'bot-a'])
  const creator = x.sent[0].message
  assert.ok(creator.startsWith('Lattice: on charts you created') && !creator.includes('you are not running'), 'a creator with only reassignments gets no start head')
  assert.ok(creator.includes('lattice plan revise --plan <P>') && creator.includes('--lane <Bot id or approval-box>'))
  assert.ok(creator.endsWith('\nChart alpha (lattice tool, project alpha):\n- p1/t1 「T1」: lane "stranger" is not a Bot\n- p1/t2 「T2」: lane "bot-del" is not a Bot\n- p1/t3 「T3」: lane is empty'),
    'a deleting Bot and an empty lane are no Bot; pending and Owner cards are not listed')
  const both = x.sent[1].message
  assert.ok(both.startsWith('Lattice: you are not running') && both.indexOf('Lattice: on charts you created') > both.indexOf('p1/t4'), 'own tasks first, then reassignments, one message')
  assert.ok(both.endsWith('\nChart gamma (lattice tool, project gamma):\n- p1/t1 「T1」: lane "ghost" is not a Bot'))
  assert.deepEqual(x.logs, ['lattice-nudge-lane beta no-creator'])
  assert.deepEqual(out, { charts: 3, prompted: 2, skipped: 0, failed: 0 })
})

test('protocol: root nudge and effect turns.read', () => {
  const context = { generation: 'g1' }
  validateLatticeRequest('nudge', { projectIds: ['alpha', 'beta'] }, context)
  validateLatticeRequest('nudge', { projectIds: [] }, context)
  for (const params of [{}, { projectIds: ['Bad'] }, { projectIds: ['alpha', 'alpha'] }]) {
    assert.throws(() => validateLatticeRequest('nudge', params, context), { code: 'LATTICE_INVALID' })
  }
  validateLatticeResult('nudge', { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  assert.throws(() => validateLatticeResult('nudge', { charts: 1 }), { code: 'LATTICE_IPC_INVALID' })
  validateLatticeEffect('turns.read', { botIds: ['bot-a'] })
  for (const botIds of [[], ['a', 'a'], [''], 'bot-a']) assert.throws(() => validateLatticeEffect('turns.read', { botIds }), { code: 'LATTICE_INVALID' })
  validateLatticeEffectResult('turns.read', { turns: { 'bot-a': 'working', 'bot-b': 'unknown' } })
  validateLatticeEffect('claude.load', {})
  assert.throws(() => validateLatticeEffect('claude.load', { botIds: ['a'] }), { code: 'LATTICE_INVALID' })
  validateLatticeEffectResult('claude.load', { cap: 5, claude: ['bot-a'], working: [] })
  for (const bad of [{ cap: 0, claude: [], working: [] }, { cap: 5, claude: 'a', working: [] }, { cap: 5, claude: [] }]) assert.throws(() => validateLatticeEffectResult('claude.load', bad), { code: 'LATTICE_IPC_INVALID' })
  assert.throws(() => validateLatticeEffectResult('turns.read', { turns: { 'bot-a': 'busy' } }), { code: 'LATTICE_IPC_INVALID' })
})

// Task a60 (Lattice 0.99.0): a task waiting on a task of another chart is prompted only after that task is done.
const bin = new URL('../distribution/lattice/node_modules/@quolu/lattice/bin/lattice.mjs', import.meta.url).pathname
test('real Lattice: a predecessor on another chart holds the prompt until it is done, and the snapshot names it', { skip: !existsSync(bin) && 'distribution/lattice not installed' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-cross-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const core = createLatticeCore({ cli: createLatticeCli({ bin, chartsRoot: join(root, 'charts'), home: join(root, 'home') }), firstNudgeMs: 0, log: () => {} })
  const sent = []
  const effect = async (method, params) => method === 'members.list' ? { members: ['bot-a', 'bot-b'].map(id => ({ id, name: id, color: 'c', avatarVersion: 'v', deleting: false })) }
    : method === 'claude.load' ? {} : method === 'turns.read' ? { turns: {} } : (sent.push(params), { delivery: 'queued', deliveryId: 'd' })
  const run = (from, projectId, args, input = null) => core.run({ from, projectId, args, input }, effect)
  const plan = (key, lane) => ({ schema: 'lattice.plan_create_input.v5', plan_key: key, phases: [{ phase_id: 'a', title: 'A' }],
    tasks: [{ task_id: 't1', title: `${key} one`, phase_id: 'a', design_memo: 'm', lane }], hard_dependencies: [] })
  assert.equal((await run('bot-a', 'alpha', ['plan', 'create', '--json'], plan('p1', 'bot-a'))).exitCode, 0)
  // a102: K1/K2 on the real Lattice: the chart, its creator (the seat whose run made the store) and its token.
  const cli = createLatticeCli({ bin, chartsRoot: join(root, 'charts'), home: join(root, 'home') })
  const [row] = await cli.list()
  assert.deepEqual([row.id, row.createdBy, typeof row.source], ['alpha', 'bot-a', 'string'])
  assert.deepEqual([...await cli.sources(['alpha', 'nochart'])], [['alpha', row.source], ['nochart', null]])
  assert.equal((await run('bot-b', 'beta', ['plan', 'create', '--json'], plan('p1', 'bot-b'))).exitCode, 0)
  assert.equal((await core.nudge({ projectIds: ['alpha', 'deleted-chart'] }, effect)).charts, 1)
  assert.deepEqual(sent.map(item => item.target), ['bot-a'], 'beta is ready but OFF; a deleted chart is ignored')
  sent.length = 0
  await run('bot-a', 'alpha', ['todo', 'start', '--plan', 'p1', '--task', 't1'])
  const connect = await run('bot-b', 'beta', ['todo', 'dependency', 'connect', '--from-project', 'alpha', '--from-plan', 'p1', '--from-task', 't1', '--to-plan', 'p1', '--to-task', 't1', '--reason', 'waits on alpha'])
  assert.equal(connect.exitCode, 0, connect.stderr)
  await core.nudge({ projectIds: ['alpha', 'beta'] }, effect)
  assert.deepEqual(sent.map(item => item.target), ['bot-a'], 'bot-b waits on alpha/p1/t1 and is not prompted')
  const before = await core.chart({ projectId: 'beta' }, effect)
  assert.equal(before.cards[0].state, 'pending')
  assert.deepEqual(before.externals, [{ id: 'alpha:p1/t1', projectId: 'alpha', cardId: 'p1/t1', chartName: null, title: 'p1 one', state: 'in-progress', finished: false, producer: 'bot-a' }])
  assert.deepEqual([before.edges, before.waits], [[], []], 'a 接続 is never an edge or a wait (a161)')
  assert.deepEqual(before.cards[0].connections.map(item => [item.kind, item.ref, item.reason]), [['task', 'alpha:p1/t1', 'waits on alpha']])
  await run('bot-a', 'alpha', ['todo', 'done', '--plan', 'p1', '--task', 't1', '--message', 'ok'])
  sent.length = 0
  await core.nudge({ projectIds: ['alpha', 'beta'] }, effect)
  assert.deepEqual(sent.map(item => item.target), ['bot-b'], 'prompted once the other chart\'s task is done')
  assert.match(sent[0].message, /beta[\s\S]*p1\/t1 「p1 one」: can start/u)
})

test('nudge b25: the creator warning about one task is sent once; again only when the task changes; own tasks still repeat', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', createdBy: 'bot-b', cards: [card('t1', 'ready', 'mac-bench'), card('t2', 'ready', 'bot-a')] }], deliveries: { 'bot-b': 'running' } })
  await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b', 'bot-a'])
  await x.go(); await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b', 'bot-a', 'bot-a', 'bot-a'], 'the creator is not warned again; the lane Bot is nudged every sweep (Owner design)')
  x.charts[0].cards[0] = card('t1', 'in-progress', 'mac-bench')
  await x.go()
  assert.equal(x.sent.at(-2).target, 'bot-b', 'a changed task (state) warns the creator again')
  x.charts[0].cards[0] = card('t1', 'ready', 'bot-c')
  await x.go()
  x.charts[0].cards[0] = card('t1', 'in-progress', 'mac-bench')
  await x.go()
  assert.equal(x.sent.filter(item => item.target === 'bot-b').length, 3, 'a task that left the warning and came back is warned again')
})

test('nudge b25: a warning that was not accepted is sent again at the next sweep', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', createdBy: 'bot-b', cards: [card('t1', 'ready', 'mac-bench')] }], deliveries: { 'bot-b': 'refused' } })
  await x.go(); await x.go()
  assert.equal(x.sent.length, 2)
})

test('nudge a509: a child answers the ticks of its first 3 minutes with the empty result and does nothing; from then on it sweeps', async () => {
  const clock = { now: 1_000_000 }, calls = []
  const cli = new Proxy({}, { get: (_, name) => async () => { calls.push(String(name)); throw Object.assign(new Error('down'), { code: 'LATTICE_UNAVAILABLE' }) } })
  const core = createLatticeCore({ cli, now: () => clock.now, log: () => {} })
  const effect = async method => { calls.push(method); return {} }
  const empty = { charts: 0, prompted: 0, skipped: 0, failed: 0, filed: 0, routed: 0 }
  for (const at of [0, 60_000, 179_999]) {
    clock.now = 1_000_000 + at
    assert.deepEqual(await core.nudge({ projectIds: ['alpha', 'beta'] }, effect), empty)
  }
  assert.deepEqual(calls, [], 'nothing read, nothing sent inside the first 3 minutes')
  assert.doesNotThrow(() => validateLatticeResult('nudge', empty), 'the empty result is a valid nudge result')
  clock.now = 1_000_000 + 180_000
  assert.deepEqual(await core.nudge({ projectIds: [] }, effect), empty)
  assert.deepEqual(calls, [], 'a tick with all charts OFF does no work')
  await core.nudge({ projectIds: ['alpha', 'beta'] }, effect).catch(() => {})
  assert.ok(calls.length > 0, 'at 3 minutes the sweep starts (it reaches for the CLI)')
})

// Connection news (README L26): first sight silent; a different state or content digest is ONE line in the lane's one message; the record advances only on an accepted send or an Owner lane.
test('news: first sight is recorded silently; a state or content change is one line in the lane\'s one sweep message; the record advances only on an accepted send', async () => {
  const record = { value: {} }, io = { read: async () => record.value, write: async value => { record.value = JSON.parse(JSON.stringify(value)) } }
  const sent = [], accept = { value: 'running' }
  const effect = async (method, params) => method === 'claude.load' ? {} : method === 'turns.read' ? { turns: { 'bot-a': 'idle', 'bot-b': 'idle' } } : (sent.push(params), { delivery: accept.value })
  const item = (extra = {}) => ({ cardId: 'p1/t1', ref: 'other/q/x', kind: 'task', state: 'open', reason: null, content: 'c1', targetTitle: 'X', chartName: 'Other', ...extra })
  const chart = (items, cards = [{ id: 'p1/t1', plan: 'p1', taskId: 't1', title: 'T1', state: 'pending', lane: 'bot-a' }], extra = {}) => ({ projectId: 'alpha', createdBy: 'bot-b', cards, news: items, verified: true, ...extra })
  const go = items => nudgeSweep([chart(items)], { laneOf: laneResolver(members), log() {}, effect, news: io })
  await go([item()])
  assert.deepEqual([sent.length, record.value['alpha/p1/t1/other/q/x']], [0, { state: 'open', content: 'c1' }], 'first sight: recorded, nothing sent')
  await go([item({ content: 'c1' })])
  assert.equal(sent.length, 0, 'same state and digest: nothing')
  accept.value = 'failed'
  await go([item({ state: 'gone', reason: 'target_retired' })])
  assert.equal(sent.length, 1)
  assert.equal(record.value['alpha/p1/t1/other/q/x'].state, 'open', 'not accepted: the record has not advanced')
  accept.value = 'running'
  const out = await go([item({ state: 'gone', reason: 'target_retired' })])
  assert.deepEqual([sent.length, sent[1].target, out.prompted], [2, 'bot-a', 1])
  assert.ok(sent[1].message.startsWith('Lattice: something a task of yours is connected to has changed.\n') && sent[1].message.includes('- p1/t1 「T1」 is connected to other/q/x 「X」 (Other): the target was retired'), sent[1].message)
  assert.ok(!sent[1].message.includes('can start now'), 'a pending card gets no start line')
  assert.deepEqual(record.value['alpha/p1/t1/other/q/x'], { state: 'gone', content: 'c1' })
  await go([item({ state: 'gone', reason: 'target_retired' })])
  assert.equal(sent.length, 2, 'one line per change: the accepted record is not told again')
  await go([item({ state: 'open', content: 'c2' })])
  assert.equal(sent.length, 3)
  assert.ok(sent[2].message.includes('the target was reopened: the task waits again; its content also changed'), sent[2].message)
  await go([item({ state: 'open', content: 'c3' })])
  assert.ok(sent[3].message.includes("the target's content changed (title, done condition, lane or split)") && !sent[3].message.includes('reopened'), sent[3].message)
  await go([item({ state: 'open', content: null })])
  assert.equal(sent.length, 4, 'a null digest (target unread) is no change and keeps the record\'s digest')
  assert.equal(record.value['alpha/p1/t1/other/q/x'].content, 'c3')
  const ready = [{ id: 'p1/t1', plan: 'p1', taskId: 't1', title: 'T1', state: 'ready', lane: 'bot-a' }]
  await nudgeSweep([chart([item({ state: 'settled', reason: 'target_done', content: 'c3' })], ready)], { laneOf: laneResolver(members), log() {}, effect, news: io })
  assert.ok(sent.at(-1).message.includes('the target is done -> it can start now: `lattice todo start --plan p1 --task t1`'), sent.at(-1).message)
  assert.equal(sent.filter(message => message.message.startsWith('Lattice: you are not running')).length, 1, 'a ready card also gets its own sweep line, in the same one message')
})

test('news: an Owner lane advances silently, a lane that is no Bot goes to the creator, a verified read drops rows whose entry is gone', async () => {
  const record = { value: { 'alpha/p1/t1/other/q/x': { state: 'open', content: null }, 'alpha/p1/t2/other/q/x': { state: 'open', content: null }, 'alpha/gone/t/other/q/x': { state: 'open', content: null }, 'beta/p/t/r': { state: 'open', content: null } } }
  const io = { read: async () => record.value, write: async value => { record.value = JSON.parse(JSON.stringify(value)) } }
  const sent = [], effect = async (method, params) => method === 'claude.load' ? {} : method === 'turns.read' ? { turns: { 'bot-b': 'idle' } } : (sent.push(params), { delivery: 'running' })
  const item = cardId => ({ cardId, ref: 'other/q/x', kind: 'task', state: 'settled', reason: 'target_done', content: null, targetTitle: null, chartName: null })
  const cards = [{ id: 'p1/t1', plan: 'p1', taskId: 't1', title: 'T1', state: 'pending', lane: 'owner' }, { id: 'p1/t2', plan: 'p1', taskId: 't2', title: 'T2', state: 'pending', lane: 'stranger' }]
  const out = await nudgeSweep([{ projectId: 'alpha', createdBy: 'bot-b', cards, news: [item('p1/t1'), item('p1/t2')], verified: true }, { projectId: 'beta', createdBy: 'bot-b', cards: [], news: [], verified: false }], { laneOf: laneResolver(members), log() {}, effect, news: io })
  assert.deepEqual([sent.map(message => message.target), out.prompted], [['bot-b'], 1])
  assert.ok(sent[0].message.includes('p1/t2') && !sent[0].message.includes('p1/t1 '), 'the Owner lane is not sent')
  assert.deepEqual(record.value, { 'alpha/p1/t1/other/q/x': { state: 'settled', content: null }, 'alpha/p1/t2/other/q/x': { state: 'settled', content: null }, 'beta/p/t/r': { state: 'open', content: null } },
    'both rows advanced; the row of a gone entry on a verified chart is deleted; an unverified chart keeps its rows')
})
