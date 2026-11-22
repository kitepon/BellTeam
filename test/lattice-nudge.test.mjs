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

test('nudge: a Bot that started a turn after the batch read is not prompted (a481)', async () => {
  const sent = [], effect = async (method, params) => method === 'turns.read'
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
  const effect = async (method, params) => method === 'turns.read' ? { turns: { 'bot-a': 'idle' } } : (sends.push(params), { delivery: 'running' })
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
  validateLatticeRequest('nudge', {}, context)
  assert.throws(() => validateLatticeRequest('nudge', { x: 1 }, context), { code: 'LATTICE_INVALID' })
  validateLatticeResult('nudge', { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  assert.throws(() => validateLatticeResult('nudge', { charts: 1 }), { code: 'LATTICE_IPC_INVALID' })
  validateLatticeEffect('turns.read', { botIds: ['bot-a'] })
  for (const botIds of [[], ['a', 'a'], [''], 'bot-a']) assert.throws(() => validateLatticeEffect('turns.read', { botIds }), { code: 'LATTICE_INVALID' })
  validateLatticeEffectResult('turns.read', { turns: { 'bot-a': 'working', 'bot-b': 'unknown' } })
  assert.throws(() => validateLatticeEffectResult('turns.read', { turns: { 'bot-a': 'busy' } }), { code: 'LATTICE_IPC_INVALID' })
})

// Task a60 (Lattice 0.99.0): a task waiting on a task of another chart is prompted only after that task is done.
const bin = new URL('../distribution/lattice/node_modules/@quolu/lattice/bin/lattice.mjs', import.meta.url).pathname
test('real Lattice: a predecessor on another chart holds the prompt until it is done, and the snapshot names it', { skip: !existsSync(bin) && 'distribution/lattice not installed' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-cross-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const core = createLatticeCore({ cli: createLatticeCli({ bin, chartsRoot: join(root, 'charts'), home: join(root, 'home') }), log: () => {} })
  const sent = []
  const effect = async (method, params) => method === 'members.list' ? { members: ['bot-a', 'bot-b'].map(id => ({ id, name: id, color: 'c', avatarVersion: 'v', deleting: false })) }
    : method === 'turns.read' ? { turns: {} } : (sent.push(params), { delivery: 'queued', deliveryId: 'd' })
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
  await run('bot-a', 'alpha', ['todo', 'start', '--plan', 'p1', '--task', 't1'])
  const connect = await run('bot-b', 'beta', ['todo', 'dependency', 'connect', '--from-project', 'alpha', '--from-plan', 'p1', '--from-task', 't1', '--to-plan', 'p1', '--to-task', 't1', '--reason', 'waits on alpha'])
  assert.equal(connect.exitCode, 0, connect.stderr)
  await core.nudge({}, effect)
  assert.deepEqual(sent.map(item => item.target), ['bot-a'], 'bot-b waits on alpha/p1/t1 and is not prompted')
  const before = await core.chart({ projectId: 'beta' }, effect)
  assert.equal(before.cards[0].state, 'pending')
  assert.deepEqual(before.externals, [{ id: 'alpha:p1/t1', projectId: 'alpha', cardId: 'p1/t1', chartName: null, title: 'p1 one', state: 'in-progress', finished: false, producer: 'bot-a' }])
  assert.deepEqual([before.edges, before.waits], [[], []], 'a 接続 is never an edge or a wait (a161)')
  assert.deepEqual(before.cards[0].connections.map(item => [item.kind, item.ref, item.reason]), [['task', 'alpha:p1/t1', 'waits on alpha']])
  await run('bot-a', 'alpha', ['todo', 'done', '--plan', 'p1', '--task', 't1', '--message', 'ok'])
  sent.length = 0
  await core.nudge({}, effect)
  assert.deepEqual(sent.map(item => item.target), ['bot-b'], 'prompted once the other chart\'s task is done')
  assert.match(sent[0].message, /beta[\s\S]*p1\/t1 「p1 one」: can start/u)
})

test('nudge b25: the creator warning about one task is sent once; again only when the task changes', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', createdBy: 'bot-b', cards: [card('t1', 'ready', 'mac-bench'), card('t2', 'ready', 'bot-a')] }], deliveries: { 'bot-b': 'running' } })
  await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b', 'bot-a'])
  await x.go(); await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b', 'bot-a'], 'neither the creator nor the lane Bot is told again (a502)')
  x.charts[0].cards[0] = card('t1', 'in-progress', 'mac-bench')
  await x.go()
  assert.equal(x.sent.at(-1).target, 'bot-b', 'a changed task (state) warns the creator again')
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

test('nudge a502: a task is told to its Bot once; a start is no change; leaving and coming back, a moved lane or a new task tells again; a Bot with nothing new is not even read', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a')] }] })
  await x.go(); await x.go(); await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-a'])
  assert.equal(x.reads.length, 2, 'only the first tick reads turns (batch + the pre-send check, a481); later ticks have nothing new')
  x.charts[0].cards[0] = card('t1', 'in-progress', 'bot-a')
  await x.go()
  assert.equal(x.sent.length, 1, 'the Bot started it itself: not told again')
  x.charts[0].cards[0] = card('t1', 'pending', 'bot-a')
  await x.go()
  x.charts[0].cards[0] = card('t1', 'ready', 'bot-a')
  await x.go()
  assert.equal(x.sent.length, 2, 'retracted, then startable again: told again')
  x.charts[0].cards.push(card('t2', 'ready', 'bot-a'))
  await x.go()
  assert.equal(x.sent.length, 3)
  assert.ok(x.sent[2].message.includes('p1/t2') && !x.sent[2].message.includes('p1/t1'), 'only the new task is listed')
  x.charts[0].cards[1] = card('t2', 'ready', 'bot-c')
  await x.go()
  assert.deepEqual(x.sent.at(-1).target, 'bot-c', 'a task moved to another lane is told to its new Bot')
})

test('nudge a502: a working Bot and an unaccepted send are not recorded; a degraded chart keeps what was told', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'ready', 'bot-b')] }], turns: { 'bot-a': 'working', 'bot-b': 'idle' }, deliveries: { 'bot-b': 'refused' } })
  await x.go()
  assert.deepEqual(x.sent.map(item => item.target), ['bot-b'])
  await x.go()
  assert.equal(x.sent.length, 2, 'refused: tried again')
  assert.equal(x.sent[1].target, 'bot-b')
  const ok = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a')] }] })
  await ok.go()
  ok.charts[0] = { projectId: 'alpha', cards: [], degraded: ['lattice-read'] }
  await ok.go()
  ok.charts[0] = { projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a')] }
  await ok.go()
  assert.equal(ok.sent.length, 1, 'an unread chart did not make the task leave')
})

test('nudge a502: the told record survives a new core (child restart) and a failed record read starts empty without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'told-'))
  try {
    const cli = createLatticeCli({ bin: 'x', chartsRoot: dir, stateDir: dir })
    assert.deepEqual(await cli.readNudgeRecord(), {})
    await cli.writeNudgeRecord({ 'a\0p\0t\0bot-a': 'bot-a' })
    assert.deepEqual(await createLatticeCli({ bin: 'x', chartsRoot: dir, stateDir: dir }).readNudgeRecord(), { 'a\0p\0t\0bot-a': 'bot-a' })
    assert.deepEqual(await cli.readOwnerRecord(), {}, 'a separate file from the filing record')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
