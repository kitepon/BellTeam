import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { createLatticeCore } from '../src/lattice/core.mjs'
import { createLatticeApi } from '../src/lattice/http-api.mjs'
import { latticeToolHandlers, latticeTools } from '../src/lattice/mcp.mjs'
import { projectChart } from '../src/lattice/projection.mjs'

const ref = (plan, task) => ({ plan_key: plan, task_id: task })
const at = minute => `2026-11-11T10:${String(minute).padStart(2, '0')}:00.000Z`
const ev = (kind, task_id, agent, minute, extra = {}) => ({ kind, task_id, actor: { agent }, recorded_at: at(minute), ...extra })
const roster = ids => ids.map(id => ({ id, name: id.toUpperCase(), color: 'sky', avatarVersion: 'v1', deleting: false }))
const readOf = (members, extra = {}) => ({ state: 'verified', verified_at: at(59), store: { members }, ...extra })
const planMember = ({ plan = 'p1', tasks, states, events = [], scoped = [], deps = [], joins = [] }) => ({
  plan: { plan_key: plan, tasks, hard_dependencies: deps, joins },
  tasks: states.map(([task_id, status, blocked_reason]) => ({ task_id, status, blocked_reason })),
  journal: { events }, plan_scoped: { events: scoped } })

function mainPlan() {
  return planMember({
    tasks: [{ task_id: 't1', title: 'A' }, { task_id: 't2' }, { task_id: 't3', title: 'C', done_condition: 'done when', design_memo: 'memo' },
      { task_id: 't4', lane: 'bot-c' }, { task_id: 't5', lane: 'someone' }, { task_id: 't6' }, { task_id: 't7' }],
    states: [['t1', 'done'], ['t2', 'pending'], ['t3', 'in-progress'], ['t4', 'pending'], ['t5', 'blocked', 'x'], ['t6', 'retired'], ['t7', 'pending']],
    deps: [{ from: ref('p1', 't1'), to: ref('p1', 't2') }, { from: ref('p1', 't3'), to: ref('p1', 't4') }],
    joins: [{ after: [ref('p1', 't2'), ref('p1', 't4')], before: ref('p1', 't7') }],
    events: [ev('start', 't1', 'bot-a', 0), ev('done', 't1', 'bot-a', 5), ev('start', 't3', 'bot-x', 6), ev('start', 't3', 'bot-b', 10), ev('note', 't4', 'bot-d', 12)] })
}
const byId = result => Object.fromEntries(result.cards.map(card => [card.id, card]))
const ids = ['bot-a', 'bot-b', 'bot-c']

test('projection: cards, ready, producer (start beats lane), edges, waits, depth, counts', () => {
  const result = projectChart({ read: readOf([mainPlan()]), members: roster(ids) })
  const cards = byId(result)
  assert.equal(result.state, 'verified')
  assert.equal(result.verifiedAt, at(59))
  assert.deepEqual(Object.keys(cards), ['p1/t1', 'p1/t2', 'p1/t3', 'p1/t4', 'p1/t5', 'p1/t6', 'p1/t7'])
  assert.deepEqual(Object.values(cards).map(card => card.state), ['done', 'ready', 'in-progress', 'pending', 'blocked', 'retired', 'pending'])
  assert.deepEqual(cards['p1/t3'], { id: 'p1/t3', plan: 'p1', taskId: 't3', title: 'C', doneCondition: 'done when', designMemo: 'memo', state: 'in-progress',
    lane: null, producer: 'bot-b', startedAt: at(10), changedAt: at(10), blockedReason: null, depth: 0, phase: null, parent: null, doneAt: null, archived: false, counted: true })
  assert.deepEqual([cards['p1/t4'].producer, cards['p1/t4'].startedAt, cards['p1/t4'].changedAt], ['bot-c', null, at(12)])
  assert.deepEqual([cards['p1/t5'].producer, cards['p1/t5'].blockedReason, cards['p1/t1'].title, cards['p1/t2'].title], [null, 'x', 'A', 't2'])
  assert.deepEqual(result.edges, [{ from: 'p1/t1', to: 'p1/t2', waiting: false }, { from: 'p1/t3', to: 'p1/t4', waiting: true },
    { from: 'p1/t2', to: 'p1/t7', waiting: true }, { from: 'p1/t4', to: 'p1/t7', waiting: true }])
  assert.deepEqual(Object.values(cards).map(card => card.depth), [0, 1, 0, 1, 0, 0, 2])
  assert.deepEqual(result.waits, [
    { waiter: 'bot-c', waitingCard: 'p1/t4', forCard: 'p1/t3', producer: 'bot-b', producerState: 'in-progress', since: at(12) },
    { waiter: null, waitingCard: 'p1/t7', forCard: 'p1/t4', producer: 'bot-c', producerState: 'pending', since: at(12) },
    { waiter: null, waitingCard: 'p1/t7', forCard: 'p1/t2', producer: null, producerState: 'ready', since: null }])
  // No `trees` (an older Lattice): each card is a tree of one. t6 (retired, alone) is archived and uncounted;
  // t1 (done, next t2 unfinished) stays, but alone it is a finished tree, so it is not counted.
  assert.deepEqual(result.counts, { total: 5, done: 0, working: 1, blocked: 1, waiting: 2 })
  // With Lattice's trees (0.100.0): t1-t4,t7 one tree (1 of 5 finished), t5 alone, t6 alone and finished.
  const tree = (id, tasks, finished) => ({ tree_id: `p1/${id}`, tasks: tasks.map(task => ({ plan_key: 'p1', task_id: task })), total: tasks.length, finished })
  const withTrees = projectChart({ read: readOf([mainPlan()], { trees: [tree('t1', ['t1', 't2', 't3', 't4', 't7'], 1), tree('t5', ['t5'], 0), tree('t6', ['t6'], 1)] }), members: roster(ids) })
  assert.deepEqual(withTrees.counts, { total: 6, done: 1, working: 1, blocked: 1, waiting: 2 }, 'every task of an open tree counts; the finished tree t6 counts nowhere')
  assert.deepEqual(withTrees.cards.map(card => [card.taskId, card.archived, card.counted]),
    [['t1', false, true], ['t2', false, true], ['t3', false, true], ['t4', false, true], ['t5', false, true], ['t6', true, false], ['t7', false, true]])
  assert.deepEqual(result.memberIds, ['bot-a', 'bot-b', 'bot-c'])
  assert.deepEqual([result.createdBy, result.updatedAt], ['bot-a', at(12)])
})

test('projection: a lane that is not a roster Bot is no producer; a deleting Bot neither', () => {
  const read = readOf([mainPlan()])
  assert.equal(byId(projectChart({ read, members: roster(['bot-a']) }))['p1/t4'].producer, null)
  assert.equal(byId(projectChart({ read, members: [{ ...roster(['bot-c'])[0], deleting: true }] }))['p1/t4'].producer, null)
})

test('projection: a lane naming a member (Bot id or name, Latin case-insensitive) is the producer before a start', () => {
  const plan = planMember({ tasks: [{ task_id: 'a', lane: 'キロ' }, { task_id: 'b', lane: 'n102' }, { task_id: 'c', lane: 'kiro' }], states: [['a', 'pending'], ['b', 'pending'], ['c', 'pending']] })
  const members = [{ id: 'bot-k', name: 'キロ', color: 'mint', avatarVersion: '', deleting: false }, { id: 'bot-n', name: 'N102', color: 'sky', avatarVersion: '', deleting: false }]
  assert.deepEqual(projectChart({ read: readOf([plan]), members }).cards.map(card => [card.lane, card.producer]), [['キロ', 'bot-k'], ['n102', 'bot-n'], ['kiro', null]])
})

test('projection: a lane owner / 指揮官 is the reserved Owner value, never a member id', () => {
  const plan = planMember({ tasks: [{ task_id: 'a', lane: 'owner' }, { task_id: 'b', lane: 'Owner' }, { task_id: 'c', lane: '指揮官' }], states: [['a', 'pending'], ['b', 'pending'], ['c', 'pending']] })
  const result = projectChart({ read: readOf([plan]), members: [] })
  assert.deepEqual([result.cards.map(card => card.producer), result.memberIds], [['owner', 'owner', 'owner'], []])
})

test("projection: Lattice's default lane main is no lane (担当なし)", () => {
  const plan = planMember({ tasks: [{ task_id: 'a', lane: 'main' }, { task_id: 'b', lane: 'mainline' }], states: [['a', 'pending'], ['b', 'pending']] })
  assert.deepEqual(projectChart({ read: readOf([plan]), members: [] }).cards.map(card => card.lane), [null, 'mainline'])
})

test('projection: a finished card with a lane shows the lane owner, not the coordinator who closed it', () => {
  const start = id => ({ kind: 'start', task_id: id, actor: { agent: 'bot-co' }, recorded_at: at(5) })
  const plan = planMember({ tasks: [{ task_id: 'a', lane: 'キロ' }, { task_id: 'b', lane: 'kiro' }, { task_id: 'c' }, { task_id: 'd', lane: 'キロ' }],
    states: [['a', 'done'], ['b', 'done'], ['c', 'done'], ['d', 'in-progress']], events: ['a', 'b', 'c', 'd'].map(start) })
  const members = [{ id: 'bot-k', name: 'キロ', color: 'mint', avatarVersion: '', deleting: false }, { id: 'bot-co', name: 'トロニー', color: 'indigo', avatarVersion: '', deleting: false }]
  assert.deepEqual(projectChart({ read: readOf([plan]), members }).cards.map(card => card.producer), ['bot-k', null, 'bot-co', 'bot-co'])
})

test('projection: tree = phases in plan order, card phase, parent (existing, not self, no cycle)', () => {
  const plan = planMember({ tasks: [
    { task_id: 'a', phase_id: 'ph1' }, { task_id: 'b', phase_id: 'ph1', parent_task_id: 'a' }, { task_id: 'c', phase_id: 'zz', parent_task_id: 'c' },
    { task_id: 'd', parent_task_id: 'e' }, { task_id: 'e', parent_task_id: 'd' }, { task_id: 'f', parent_task_id: 'nope' }],
  states: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, 'pending']) })
  plan.plan.phases = [{ phase_id: 'ph1', title: '部品' }, { phase_id: 'ph2' }, { title: 'no id' }, { phase_id: 'ph1', title: 'dup' }]
  const result = projectChart({ read: readOf([plan]), members: [] })
  assert.deepEqual(result.phases, [{ id: 'p1/ph1', title: '部品' }, { id: 'p1/ph2', title: null }])
  assert.deepEqual(result.cards.map(card => [card.taskId, card.phase, card.parent]),
    [['a', 'p1/ph1', null], ['b', 'p1/ph1', 'p1/a'], ['c', null, null], ['d', null, 'p1/e'], ['e', null, null], ['f', null, null]])
})

test('projection: doneAt; archived = all next cards finished, or (no next card) its Lattice tree finished (Owner 2026-11-14)', () => {
  const plan = planMember({ tasks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(task_id => ({ task_id })),
    states: [['a', 'done'], ['b', 'done'], ['c', 'pending'], ['d', 'in-progress'], ['e', 'retired'], ['f', 'done'], ['g', 'done']],
    deps: [{ from: ref('p1', 'a'), to: ref('p1', 'c') }, { from: ref('p1', 'b'), to: ref('p1', 'd') }, { from: ref('p1', 'f'), to: ref('p1', 'g') }],
    events: [{ kind: 'done', task_id: 'e', actor: { agent: 'x' }, recorded_at: at(7) }, { kind: 'done', task_id: 'g', actor: { agent: 'x' }, recorded_at: at(9) }] })
  plan.tasks.find(task => task.task_id === 'a').done_at = at(3)
  const cards = byId(projectChart({ read: readOf([plan]), members: [] }))
  assert.deepEqual(Object.values(cards).map(card => [card.taskId, card.archived]),
    [['a', false], ['b', false], ['c', false], ['d', false], ['e', true], ['f', true], ['g', true]], 'a and b have unfinished next cards; f has its next card finished; e and g are finished trees')
  // A finished leaf stays while its tree is open; the whole tree leaves when the last card finishes.
  const leaf = planMember({ tasks: ['x', 'y', 'z'].map(task_id => ({ task_id })), states: [['x', 'done'], ['y', 'done'], ['z', 'in-progress']],
    deps: [{ from: ref('p1', 'x'), to: ref('p1', 'y') }] })
  const treeOf = (finished, tasks) => ({ tree_id: 'p1/x', tasks: tasks.map(task_id => ({ plan_key: 'p1', task_id })), total: tasks.length, finished })
  const open = byId(projectChart({ read: readOf([leaf], { trees: [{ ...treeOf(2, ['x', 'y', 'z']) }] }), members: [] }))
  assert.deepEqual(['x', 'y', 'z'].map(id => [open[`p1/${id}`].archived, open[`p1/${id}`].counted]), [[true, true], [false, true], [false, true]],
    'x: its next card y finished; y: no next card, tree still open (z); all counted')
  leaf.tasks.find(task => task.task_id === 'z').status = 'done'
  const closed = byId(projectChart({ read: readOf([leaf], { trees: [treeOf(3, ['x', 'y', 'z'])] }), members: [] }))
  assert.deepEqual(['x', 'y', 'z'].map(id => [closed[`p1/${id}`].archived, closed[`p1/${id}`].counted]), [[true, false], [true, false], [true, false]])
  assert.deepEqual([cards['p1/a'].doneAt, cards['p1/b'].doneAt, cards['p1/e'].doneAt, cards['p1/g'].doneAt, cards['p1/d'].doneAt], [at(3), null, at(7), at(9), null])
})

test('projection: depth counts shown cards only, so the leftmost shown card is column 0 (Owner 2026-11-14, a108)', () => {
  const chain = planMember({ tasks: ['a', 'b', 'c', 'd'].map(task_id => ({ task_id })), states: [['a', 'done'], ['b', 'done'], ['c', 'pending'], ['d', 'pending']],
    deps: [{ from: ref('p1', 'a'), to: ref('p1', 'b') }, { from: ref('p1', 'b'), to: ref('p1', 'c') }, { from: ref('p1', 'c'), to: ref('p1', 'd') }] })
  const cards = byId(projectChart({ read: readOf([chain], { trees: [{ tree_id: 'p1/a', tasks: ['a', 'b', 'c', 'd'].map(task_id => ({ plan_key: 'p1', task_id })), total: 4, finished: 2 }] }), members: [] }))
  assert.deepEqual(['a', 'b', 'c', 'd'].map(id => [cards[`p1/${id}`].archived, cards[`p1/${id}`].depth]), [[true, 0], [false, 0], [false, 1], [false, 2]],
    'a left the chart (its next card b is finished), so b is the first column')
})

test('projection: cross-plan edges minus tombstones', () => {
  const p1 = planMember({ tasks: [{ task_id: 't1' }, { task_id: 't2' }], states: [['t1', 'in-progress'], ['t2', 'pending']] })
  const p2 = planMember({ plan: 'p2', tasks: [{ task_id: 't1' }], states: [['t1', 'pending']], scoped: [
    { kind: 'cross_plan_dependency', event_digest: 'd1', payload: { from: ref('p1', 't1'), to: ref('p2', 't1') } },
    { kind: 'cross_plan_dependency', event_digest: 'd2', payload: { from: ref('p1', 't2'), to: ref('p2', 't1') } },
    { kind: 'cross_plan_dependency_removed', event_digest: 'd3', payload: { target_event_digest: 'd2' } },
    { kind: 'cross_plan_dependency', event_digest: 'd4', payload: { from: ref('p9', 't1'), to: ref('p2', 't1') } }] })
  const result = projectChart({ read: readOf([p1, p2]), members: [] })
  assert.deepEqual(result.edges, [{ from: 'p1/t1', to: 'p2/t1', waiting: true }])
  assert.equal(byId(result)['p2/t1'].depth, 1)
})

test('projection: a predecessor on another chart (task a60) keeps the card pending until Lattice reads it finished', () => {
  const xref = (project_id, plan, task) => ({ project_id, plan_key: plan, task_id: task })
  // The other chart's plan key equals a local one (p1): the external edge must not land on local p1/t1.
  const p1 = planMember({ tasks: [{ task_id: 't1' }, { task_id: 't2', lane: 'bot-b' }, { task_id: 't3' }], states: [['t1', 'pending'], ['t2', 'pending'], ['t3', 'pending']], scoped: [
    { kind: 'cross_plan_dependency', event_digest: 'e1', payload: { from: xref('other', 'p1', 't1'), to: xref('here', 'p1', 't2') } },
    { kind: 'cross_plan_dependency', event_digest: 'e2', payload: { from: xref('gone', 'q', 'x'), to: xref('here', 'p1', 't3') } },
    { kind: 'cross_plan_dependency', event_digest: 'e3', payload: { from: xref('other', 'p1', 't9'), to: xref('here', 'p1', 't3') } },
    { kind: 'cross_plan_dependency_removed', event_digest: 'e4', payload: { target_event_digest: 'e3' } }] })
  const external = (status, finished, reason = null) => [{ project_id: 'other', plan_key: 'p1', task_id: 't1', status, finished, reason, trigger: null },
    { project_id: 'gone', plan_key: 'q', task_id: 'x', status: null, finished: false, reason: 'chart_unreadable', trigger: null }]
  const elsewhere = (projectId, cardId) => projectId === 'other' && cardId === 'p1/t1' ? { chartName: 'Other', title: 'Release', producer: 'bot-c' } : null
  const open = projectChart({ read: readOf([p1], { external_tasks: external('in_progress', false) }), members: roster(['bot-b', 'bot-c']), elsewhere })
  const cards = byId(open)
  assert.deepEqual([cards['p1/t1'].state, cards['p1/t2'].state, cards['p1/t3'].state], ['ready', 'pending', 'pending'], 'unfinished and unread predecessors keep it pending')
  assert.deepEqual(open.edges, [{ from: 'other:p1/t1', to: 'p1/t2', waiting: true, external: true }, { from: 'gone:q/x', to: 'p1/t3', waiting: true, external: true }])
  assert.deepEqual(open.externals, [
    { id: 'other:p1/t1', projectId: 'other', cardId: 'p1/t1', chartName: 'Other', title: 'Release', state: 'in-progress', finished: false, producer: 'bot-c' },
    { id: 'gone:q/x', projectId: 'gone', cardId: 'q/x', chartName: null, title: null, state: null, finished: false, producer: null }])
  assert.deepEqual(open.waits.map(wait => [wait.waitingCard, wait.forCard, wait.waiter, wait.producer, wait.producerState]),
    [['p1/t2', 'other:p1/t1', 'bot-b', 'bot-c', 'in-progress'], ['p1/t3', 'gone:q/x', null, null, null]])
  assert.ok(open.memberIds.includes('bot-c'), 'the other chart\'s producer is named')
  assert.equal(open.counts.waiting, 2)
  assert.equal(cards['p1/t2'].depth, 0, 'the other chart is not walked')
  const done = byId(projectChart({ read: readOf([p1], { external_tasks: external('done', true) }), members: [] }))
  assert.deepEqual([done['p1/t2'].state, done['p1/t3'].state], ['ready', 'pending'])
  // No external_tasks (an older read) = not finished: the card waits.
  assert.equal(byId(projectChart({ read: readOf([p1]), members: [] }))['p1/t2'].state, 'pending')
})

test('projection: self, unknown-end, duplicate and cycle edges are dropped', () => {
  const plan = planMember({ tasks: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }], states: [['a', 'pending'], ['b', 'pending'], ['c', 'pending']],
    deps: [{ from: ref('p1', 'a'), to: ref('p1', 'b') }, { from: ref('p1', 'b'), to: ref('p1', 'c') }, { from: ref('p1', 'c'), to: ref('p1', 'a') },
      { from: ref('p1', 'a'), to: ref('p1', 'a') }, { from: ref('p1', 'a'), to: ref('p1', 'zzz') }, { from: ref('p1', 'a'), to: ref('p1', 'b') }],
    joins: [{ after: [ref('p1', 'c')], before: ref('p1', 'a') }] })
  const result = projectChart({ read: readOf([plan]), members: [] })
  assert.deepEqual(result.edges.map(edge => edge.from + '>' + edge.to), ['p1/a>p1/b', 'p1/b>p1/c'])
  assert.deepEqual(Object.values(byId(result)).map(card => [card.state, card.depth]), [['ready', 0], ['pending', 1], ['pending', 2]])
})

test('projection: unverified reads states from the snapshot and has the lane as the only producer', () => {
  const raw = { descriptor: {}, plan: { plan_key: 'p1', tasks: [{ task_id: 't1', lane: 'bot-a' }, { task_id: 't2', lane: 'bot-b' }],
    hard_dependencies: [{ from: ref('p1', 't1'), to: ref('p1', 't2') }] },
  snapshot: { tasks: [{ task_id: 't1', status: 'in_progress' }, { task_id: 't2', status: 'pending' }] } }
  const previous = { createdBy: 'bot-7b140b27', updatedAt: at(3) }
  const result = projectChart({ read: { state: 'unverified', verified_at: null, store: { members: [raw] } }, members: roster(['bot-a']), previous })
  assert.deepEqual([result.state, result.verifiedAt, result.createdBy, result.updatedAt], ['unverified', null, 'bot-7b140b27', at(3)])
  assert.deepEqual(result.cards.map(card => [card.state, card.producer, card.startedAt, card.changedAt]), [['in-progress', 'bot-a', null, null], ['pending', null, null, null]])
  assert.deepEqual(result.waits.map(wait => [wait.waiter, wait.producer, wait.since]), [[null, 'bot-a', null]])
})

test('projection: malformed pieces drop only themselves; unknown state is unavailable', () => {
  const bad = { plan: { plan_key: 'p1', tasks: [{ task_id: 'ok' }, { title: 'no id' }, { task_id: 'bad' }, 5, null], hard_dependencies: 'x',
    joins: [{ after: [{ plan_key: 'p1' }, ref('p1', 'ok')], before: null }] },
  tasks: [{ task_id: 'ok', status: 'done' }, { task_id: 'bad', status: 'weird' }],
  journal: { events: [null, { kind: 'start' }, { kind: 'start', task_id: 'ok', actor: { agent: 'bot-a' }, recorded_at: 'garbage' }] } }
  const result = projectChart({ read: readOf([null, { plan: {} }, bad]), members: [] })
  assert.deepEqual(result.cards.map(card => [card.id, card.producer, card.startedAt]), [['p1/ok', 'bot-a', null]])
  assert.deepEqual([result.edges, result.waits, result.updatedAt, result.createdBy], [[], [], null, null])
  for (const read of [null, {}, { state: 'weird' }, { state: 'verified', store: 5 }]) {
    const empty = projectChart({ read, members: [] })
    assert.deepEqual([empty.state, empty.cards, empty.counts.total], [read?.state === 'verified' ? 'verified' : 'unavailable', [], 0])
  }
})

test('projection: waits are oldest first, unknown time last', () => {
  const plan = planMember({ tasks: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }, { task_id: 'd' }], states: [['a', 'in-progress'], ['b', 'pending'], ['c', 'in-progress'], ['d', 'pending']],
    deps: [{ from: ref('p1', 'a'), to: ref('p1', 'b') }, { from: ref('p1', 'c'), to: ref('p1', 'd') }],
    events: [ev('start', 'a', 'bot-a', 30), ev('start', 'c', 'bot-b', 20)] })
  assert.deepEqual(projectChart({ read: readOf([plan]), members: [] }).waits.map(wait => [wait.forCard, wait.since]), [['p1/c', at(20)], ['p1/a', at(30)]])
})

function rig(extra = {}) {
  const clock = { now: Date.parse('2026-11-11T10:00:00.000Z') }
  const reply = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
  // The Lattice contract (README K1-K8): charts list / source, chart set, seat runs addressed by id.
  const cli = { charts: ['alpha'], reads: { alpha: chartRead() }, tokens: { alpha: 1 }, fail: new Set(), calls: [], runs: [], named: [], out: reply({ ok: true }), metas: {}, noStore: false,
    async list() {
      cli.calls.push('list')
      if (cli.fail.has('name')) throw Object.assign(new Error('x'), { code: 'LATTICE_UNAVAILABLE' })
      return cli.charts.map(id => ({ id, name: cli.metas[id]?.name ?? null, createdBy: cli.metas[id]?.createdBy ?? null, source: String(cli.tokens[id]) }))
    },
    async sources(ids) { cli.calls.push(`${SOURCE} ${ids.join(',')}`); if (cli.fail.has('source')) throw new Error('probe'); return new Map(ids.map(id => [id, cli.charts.includes(id) ? String(cli.tokens[id]) : null])) },
    exists: async id => cli.charts.includes(id),
    async setName(id, name, from) { cli.named.push([id, name, from]); cli.metas[id] = { ...cli.metas[id], name } },
    async migrateLegacy() { return { names: 0, record: false } },
    async run({ id, args, env, input }) {
      const key = args.join(' ')
      cli.calls.push(key === READ ? `${key} ${id}` : key)
      if (key === 'todo display read --json') return cli.fail.has('read') ? { exitCode: 1, stdout: '', stderr: 'boom' } : cli.fail.has('json') ? { exitCode: 0, stdout: 'nope', stderr: '' } : reply(cli.reads[id])
      cli.runs.push({ id, args, env, input })
      // A store-creating command makes the chart, and Lattice records the creator from LATTICE_SEAT_ID (K5).
      if (!cli.noStore && !cli.charts.includes(id)) { cli.charts.push(id); cli.metas[id] = { ...cli.metas[id], createdBy: env.LATTICE_SEAT_ID } }
      return cli.out
    } }
  const world = { members: roster(['bot-a', 'bot-b']), failMembers: false, effects: 0 }
  const effect = async method => { world.effects++; assert.equal(method, 'members.list'); if (world.failMembers) throw new Error('members down'); return { members: world.members } }
  const logs = []
  const core = createLatticeCore({ cli, now: () => clock.now, log: line => logs.push(line), ...extra })
  return { core, cli, world, clock, logs, effect, count: key => cli.calls.filter(call => call === key || call.startsWith(key + ' ')).length,
    chart: (projectId = 'alpha') => core.chart({ projectId }, effect) }
}
function chartRead({ agent = 'bot-7b140b27', minute = 1, status = 'in-progress' } = {}) {
  return readOf([planMember({ tasks: [{ task_id: 't1' }, { task_id: 't2' }], states: [['t1', status], ['t2', 'pending']],
    deps: [{ from: ref('p1', 't1'), to: ref('p1', 't2') }], events: [ev('plan', 't1', agent, minute), ev('start', 't1', 'bot-a', minute + 1)] })])
}
const READ = 'todo display read --json', SOURCE = 'charts source'

test('core: snapshot shape, members only for producers and waiters, coordinator flag', async () => {
  const x = rig()
  x.world.members = roster(['bot-a', 'bot-b', 'bot-z'])
  const snapshot = await x.chart()
  assert.deepEqual(Object.keys(snapshot), ['schema', 'epoch', 'version', 'at', 'projectId', 'name', 'createdBy', 'coordinator', 'state', 'verifiedAt', 'degraded', 'members', 'cards', 'edges', 'waits', 'phases', 'externals'])
  assert.deepEqual([snapshot.schema, snapshot.epoch, snapshot.version, snapshot.coordinator, snapshot.degraded], ['bellteam.lattice-chart.v1', x.core.epoch, 1, true, []])
  assert.deepEqual(snapshot.members, [{ botId: 'bot-a', name: 'BOT-A', color: 'sky', avatarVersion: 'v1' }])
  assert.equal(snapshot.waits[0].waiter, null)
  const other = rig(); other.cli.reads.alpha = chartRead({ agent: 'bot-b' })
  assert.equal((await other.chart()).coordinator, false)
})

test('core: a chart name is set by a seat, read beside the store, and a failed name read is degraded and recovers', async () => {
  const x = rig()
  assert.deepEqual([(await x.chart()).name, (await x.chart()).createdBy], [null, 'bot-7b140b27'])
  assert.deepEqual(await x.core.run({ from: 'bot-a', projectId: 'alpha', args: [], input: null, name: 'Lattice組込' }), { exitCode: 0, result: { name: 'Lattice組込' }, stdout: null, stderr: '' })
  assert.deepEqual(x.cli.runs, [], 'naming alone runs no Lattice command')
  const named = await x.chart()
  assert.deepEqual([named.name, named.version, (await x.core.charts({}, x.effect)).charts[0].name], ['Lattice組込', 2, 'Lattice組込'])
  await assert.rejects(x.core.run({ from: 'bot-a', projectId: 'alpha', args: [], input: null }), { code: 'LATTICE_COMMAND_NOT_SEAT_SURFACE' })
  await assert.rejects(x.core.run({ from: 'bot-a', projectId: 'nochart', args: [], input: null, name: '名前' }), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 })
  assert.deepEqual([x.cli.named.some(([id]) => id === 'nochart'), 'nochart' in x.cli.metas], [false, false], 'a rename of a missing chart writes nothing')
  x.cli.fail.add('name'); x.cli.tokens.alpha = 2
  const failed = await x.chart()
  assert.deepEqual([failed.name, failed.degraded], ['Lattice組込', ['lattice-read']])
  x.cli.fail.delete('name')
  assert.deepEqual((await x.chart()).degraded, [])
})

test('core: the creator is recorded once and never follows a later plan (Trony finding 2026-11-12)', async () => {
  const x = rig()
  x.cli.charts = []
  await x.core.run({ from: 'bot-7b140b27', projectId: 'bellteam', args: ['plan', 'create'], input: { a: 1 }, name: 'BellTeam開発' })
  assert.deepEqual(x.cli.metas.bellteam, { name: 'BellTeam開発', createdBy: 'bot-7b140b27' }, 'the store-making run records its seat')
  x.cli.reads.bellteam = chartRead({ agent: 'bot-7e777fe5' }); x.cli.tokens.bellteam = 1 // another member's plan now has the earliest event
  await x.core.run({ from: 'bot-7e777fe5', projectId: 'bellteam', args: ['plan', 'create'], input: { a: 2 } })
  await x.core.run({ from: 'bot-7e777fe5', projectId: 'bellteam', args: [], input: null, name: '別の名前' })
  const chart = await x.chart('bellteam')
  assert.deepEqual([chart.createdBy, chart.coordinator, chart.name], ['bot-7b140b27', true, '別の名前'], 'renaming a claimed chart keeps its creator')
  // A chart Lattice has no creator for: the earliest event; naming never claims it (the creator is Lattice's, K4; old ones came by the a102 migration).
  const old = rig(); old.cli.reads.alpha = chartRead({ agent: 'bot-7e777fe5' })
  assert.equal((await old.chart()).createdBy, 'bot-7e777fe5')
  await old.core.run({ from: 'bot-7b140b27', projectId: 'alpha', args: [], input: null, name: 'BellTeam開発' }); old.cli.tokens.alpha = 2
  assert.deepEqual([(await old.chart()).createdBy, (await old.chart()).coordinator, (await old.chart()).name], ['bot-7e777fe5', false, 'BellTeam開発'])
})

test('core: memo follows the token, runs and the roster; no time ceiling (task a95)', async () => {
  const x = rig()
  assert.equal((await x.chart()).version, 1)
  await x.chart()
  assert.deepEqual([x.count(READ), x.count(SOURCE), x.world.effects], [1, 2, 2])
  x.cli.tokens.alpha = 2
  assert.equal((await x.chart()).version, 1)
  assert.equal(x.count(READ), 2)
  x.clock.now += 3_600_000; await x.chart()
  assert.equal(x.count(READ), 2, 'an unchanged token is never re-read for age')
  await x.core.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'], input: null })
  await x.chart()
  assert.equal(x.count(READ), 3)
  x.cli.fail.add('source'); await x.chart()
  assert.equal(x.count(READ), 4)
  x.cli.fail.clear(); await x.chart()
  await x.chart()
  assert.equal(x.count(READ), 5)
  // A roster change alone re-projects the kept read: new member name, no CLI read.
  x.world.members = x.world.members.map(member => ({ ...member, name: member.id === 'bot-a' ? 'Renamed' : member.name }))
  const renamed = await x.chart()
  assert.deepEqual([renamed.members[0].name, renamed.version, x.count(READ)], ['Renamed', 2, 5])
  x.world.failMembers = true
  assert.deepEqual([(await x.chart()).degraded, x.count(READ)], [['members'], 5])
})

test('core: a chart waiting on another chart re-reads when that chart changes, not on a timer (task a95)', async () => {
  const x = rig()
  x.cli.reads.alpha = readOf([planMember({ tasks: [{ task_id: 't1' }], states: [['t1', 'pending']], events: [ev('plan', 't1', 'bot-7b140b27', 1)],
    scoped: [{ kind: 'cross_plan_dependency', event_digest: 'e1', payload: { from: { project_id: 'other', plan_key: 'q', task_id: 'x' }, to: { project_id: 'alpha', plan_key: 'p1', task_id: 't1' } } }] })],
    { external_tasks: [{ project_id: 'other', plan_key: 'q', task_id: 'x', status: 'in_progress', finished: false, reason: null, trigger: null }] })
  x.cli.charts.push('other'); x.cli.tokens.other = 1; x.cli.reads.other = chartRead()
  const alphaReads = () => x.cli.calls.filter(call => call === READ + ' alpha').length
  await x.chart('other')
  assert.deepEqual((await x.chart()).externals.map(item => [item.projectId, item.title]), [['other', null]])
  assert.equal((await x.chart()).externals[0].chartName, null, 'no other memo title in the projection yet')
  assert.equal(alphaReads(), 2, 'the first token had no externals yet, so the second sync reads once more')
  await x.chart(); x.clock.now += 3_600_000; await x.chart()
  assert.equal(alphaReads(), 2, 'stable while neither chart moves')
  x.cli.tokens.other = 2; await x.chart()
  assert.equal(alphaReads(), 3, "the other chart's source moved")
  x.cli.reads.other = chartRead({ status: 'done' }); await x.chart('other'); await x.chart()
  assert.equal(alphaReads(), 4, "the other chart's memo version moved (its cards changed)")
  await x.chart('other'); await x.chart()
  assert.equal(alphaReads(), 4)
})

test('core: version moves only when the projected content changes; refresh returns each change once', async () => {
  const x = rig()
  const refresh = async () => (await x.core.refresh({ projectIds: ['alpha', 'nope'] }, x.effect))
  const first = await refresh()
  assert.deepEqual([first.snapshots.map(s => [s.projectId, s.version]), first.nextRefreshMs], [[['alpha', 1]], 2000])
  assert.deepEqual((await refresh()).snapshots, [])
  x.cli.tokens.alpha = 2
  assert.deepEqual((await refresh()).snapshots, [])
  x.cli.reads.alpha = chartRead({ status: 'done' }); x.cli.tokens.alpha = 3
  const changed = await refresh()
  assert.deepEqual(changed.snapshots.map(s => [s.version, s.cards[0].state]), [[2, 'done']])
  await x.chart()
  x.cli.reads.alpha = chartRead({ status: 'blocked' }); x.cli.tokens.alpha = 4
  await x.chart()
  assert.equal((await refresh()).snapshots[0].version, 3)
})

test('core: a failed read keeps the snapshot, shows lattice-read, logs one code line, and recovers', async () => {
  const x = rig()
  const good = await x.chart()
  x.cli.fail.add('read'); x.cli.tokens.alpha = 2
  const kept = await x.chart()
  assert.deepEqual([kept.degraded, kept.cards, kept.version], [['lattice-read'], good.cards, 2])
  await x.chart(); await x.chart()
  assert.deepEqual(x.logs, ['lattice-read alpha LATTICE_CLI_EXIT_1'])
  assert.equal(JSON.stringify(kept).includes('LATTICE_CLI'), false)
  x.cli.fail.clear()
  const back = await x.chart()
  assert.deepEqual([back.degraded, back.version, back.cards], [[], 3, good.cards])
  x.cli.fail.add('json'); x.cli.tokens.alpha = 5
  await x.chart()
  assert.deepEqual(x.logs.at(-1), 'lattice-read alpha LATTICE_CLI_BAD_JSON')
})

test('core: a chart that was never readable is unavailable, empty and degraded', async () => {
  const x = rig()
  x.cli.fail.add('read')
  const snapshot = await x.chart()
  assert.deepEqual([snapshot.state, snapshot.cards, snapshot.members, snapshot.degraded, snapshot.coordinator], ['unavailable', [], [], ['lattice-read'], false])
  const timeout = rig()
  timeout.cli.run = async () => ({ exitCode: null, stdout: '', stderr: 'LATTICE_CLI_TIMEOUT' })
  await timeout.chart()
  assert.deepEqual(timeout.logs, ['lattice-read alpha LATTICE_CLI_TIMEOUT'])
})

test('core: a failed roster read keeps the last roster and reports members', async () => {
  const x = rig()
  assert.equal((await x.chart()).members.length, 1)
  x.world.failMembers = true; x.cli.tokens.alpha = 2
  const kept = await x.chart()
  assert.deepEqual([kept.degraded, kept.members.length], [['members'], 1])
  x.world.failMembers = false; x.cli.tokens.alpha = 3
  assert.deepEqual((await x.chart()).degraded, [])
  const none = rig(); none.world.failMembers = true
  assert.deepEqual([(await none.chart()).members, none.world.effects], [[], 1])
})

test('core: chart of an unknown id is not found; refresh skips it', async () => {
  const x = rig()
  await assert.rejects(x.chart('nope'), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 })
  assert.deepEqual((await x.core.refresh({ projectIds: ['nope'] }, x.effect)).snapshots, [])
})

test('core: charts lists every chart, coordinator first then newest update', async () => {
  const x = rig()
  x.cli.charts = ['gamma', 'beta', 'alpha', 'empty']
  Object.assign(x.cli.reads, { alpha: chartRead({ minute: 1 }), beta: chartRead({ agent: 'bot-b', minute: 20 }), gamma: chartRead({ agent: 'bot-b', minute: 10 }), empty: readOf([]) })
  Object.assign(x.cli.tokens, { beta: 1, gamma: 1, empty: 1 })
  const list = await x.core.charts({}, x.effect)
  assert.deepEqual([list.schema, list.charts.map(chart => chart.projectId)], ['bellteam.lattice-charts.v1', ['alpha', 'beta', 'gamma', 'empty']])
  assert.deepEqual(list.charts[0], { projectId: 'alpha', name: null, coordinator: true, createdBy: 'bot-7b140b27', counts: { total: 2, done: 0, working: 1, waiting: 1, blocked: 0 },
    activeMembers: ['bot-a'], updatedAt: at(2), state: 'verified' })
  assert.equal(x.world.effects, 1)
  x.cli.charts = ['alpha']; await x.core.charts({}, x.effect)
  assert.equal((await x.core.charts({}, x.effect)).charts.length, 1)
})

test('core: a read-only seat run on an existing chart skips the chart lock; on a missing chart it keeps it (README L3)', async () => {
  const x = rig()
  let release
  const slowRun = x.cli.run
  x.cli.run = async params => params.args[0] === 'todo' && params.args[1] === 'start' ? new Promise(resolve => { release = () => resolve(x.cli.out) }) : slowRun(params)
  const order = []
  const write = x.core.run({ from: 'bot-a', projectId: 'alpha', args: ['todo', 'start'], input: null }).then(() => order.push('write'))
  await new Promise(resolve => setImmediate(resolve))
  await x.core.run({ from: 'bot-b', projectId: 'alpha', args: ['status'], input: null }).then(() => order.push('read'))
  release(); await write
  assert.deepEqual(order, ['read', 'write'])
  // A read on a missing chart takes the locked path (Lattice answers it; nothing is made by BellTeam).
  await x.core.run({ from: 'bot-b', projectId: 'fresh', args: ['status'], input: null })
  assert.deepEqual(x.cli.runs.at(-1).id, 'fresh')
})

test('core: run passes the seat id, parses JSON, falls back to stdout, and refuses before creating anything', async () => {
  const x = rig()
  const run = (args, input = null, projectId = 'fresh') => x.core.run({ from: 'bot-a', projectId, args, input })
  assert.deepEqual(await run(['session-context']), { exitCode: 0, result: { ok: true }, stdout: null, stderr: '' })
  assert.deepEqual([x.cli.runs[0].env, x.cli.runs[0].id], [{ LATTICE_SEAT_ID: 'bot-a' }, 'fresh'])
  x.cli.out = { exitCode: 2, stdout: 'x'.repeat(100000), stderr: 'bad' }
  const text = await run(['help'])
  assert.deepEqual([text.exitCode, text.result, text.stdout.length, text.stderr], [2, null, 65536, 'bad'])
  const refusal = { schema: 'lattice.cli_error.v2', code: 'DESIGN_MEMO_REQUIRED', detail: { pointer: '/tasks/0/design_memo', next_action: 'lattice plan create --json' } }
  x.cli.out = { exitCode: 1, stdout: '', stderr: JSON.stringify(refusal) }
  assert.deepEqual((await run(['plan', 'create', '--json'], { a: 1 })).result, refusal, 'a refusal on stderr is the result')
  x.cli.out = { exitCode: 1, stdout: 'Usage', stderr: JSON.stringify(refusal) }
  assert.deepEqual([(await run(['help'])).result, (await run(['help'])).stdout], [null, 'Usage'], 'stdout text wins over stderr')
  x.cli.out = { exitCode: 0, stdout: 'null', stderr: '' }
  assert.deepEqual(await run(['status']), { exitCode: 0, result: null, stdout: null, stderr: '' }, 'JSON null on stdout is a parsed result')
  x.cli.out = { exitCode: 1, stdout: 'null', stderr: JSON.stringify(refusal) }
  assert.deepEqual([(await run(['status'])).result, (await run(['status'])).stdout], [null, null], 'JSON null on stdout wins over stderr')
  x.cli.out = { exitCode: 1, stdout: '', stderr: 'plain text' }
  assert.deepEqual(await run(['status']), { exitCode: 1, result: null, stdout: '', stderr: 'plain text' }, 'non-JSON stderr is not a result')
  const before = x.cli.runs.length
  await assert.rejects(run(['setup'], null, 'other'), { code: 'LATTICE_COMMAND_NOT_SEAT_SURFACE', status: 400 })
  await assert.rejects(run(['plan', 'create', '--input', 'f'], { a: 1 }, 'other'), { code: 'LATTICE_INPUT_CONFLICT' })
  assert.deepEqual([x.cli.runs.length, x.cli.charts.includes('other')], [before, false], 'refused before anything reached Lattice')
  await run(['plan', 'create'], { a: 1 })
  assert.deepEqual(x.cli.runs.at(-1).input, { a: 1 })
})

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'lattice-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin.mjs')
  await writeFile(bin, `import { readFileSync, statSync, existsSync } from 'node:fs'
const argv = process.argv.slice(2), i = argv.indexOf('--input')
console.log(JSON.stringify({ argv, env: process.env, cwd: process.cwd(), input: i < 0 ? null : JSON.parse(readFileSync(argv[i + 1], 'utf8')),
  mode: i < 0 ? null : statSync(argv[i + 1]).mode & 0o777 }))
if (argv[0] === 'help') console.error('e'.repeat(70000))`)
  return { root, bin, chartsRoot: join(root, 'charts'), home: join(root, 'home') }
}

test('cli: a seat run goes to Lattice by project id (K8) with exactly the agreed env, then removes the input file', async t => {
  const { bin, chartsRoot, home } = await scratch(t)
  const cli = createLatticeCli({ bin, chartsRoot, home })
  const plain = await cli.run({ id: 'alpha', args: ['todo', 'start'], env: { LATTICE_SEAT_ID: 'bot-a' } })
  const out = JSON.parse(plain.stdout)
  assert.deepEqual([plain.exitCode, plain.stderr, out.argv, out.cwd], [0, '', ['todo', 'start'], home], 'cwd is Lattice HOME, never a chart path')
  assert.deepEqual(out.env, { PATH: process.env.PATH, HOME: home, LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_CHARTS_ROOT: chartsRoot, GIT_CONFIG_NOSYSTEM: '1', LATTICE_PROJECT_ID: 'alpha', LATTICE_SEAT_ID: 'bot-a' })
  const withInput = JSON.parse((await cli.run({ id: 'alpha', args: ['plan', 'create'], input: { title: '日本語' } })).stdout)
  assert.deepEqual([withInput.argv[0], withInput.argv[1], withInput.argv[2], withInput.input, withInput.mode], ['plan', 'create', '--input', { title: '日本語' }, 0o600])
  assert.equal(existsSync(withInput.argv[3]), false)
  assert.equal((await cli.run({ id: 'alpha', args: ['help'] })).stderr.length, 64 * 1024)
  await assert.rejects(cli.run({ id: '../x', args: ['status'] }), { code: 'LATTICE_PROJECT_INVALID' })
  assert.equal(existsSync(chartsRoot), false, 'BellTeam makes nothing under the charts root')
})

test('cli: host calls go through the contract only (K1 list, K2 sources, K4 chart set, K7 repo)', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lattice-home-')); t.after(() => rm(home, { recursive: true, force: true }))
  const answers = {
    'charts list --json': { schema: 'lattice.charts_list_result.v1', charts: [{ project_id: 'alpha', name: '工程表', created_by: 'bot-a', created_at: 'x', source: 's1' },
      { project_id: 'beta', name: '\u0007', created_by: null, source: null }, { project_id: '../bad', name: 'x', source: 's' }], findings: [] },
    'charts source --project alpha --project nope --json': { charts: { alpha: 's1', nope: null } },
    'charts source --project alpha --json': { charts: { alpha: 's1' } },
    'chart set --name 新しい名前 --json': { project_id: 'alpha', name: '新しい名前', created_by: 'bot-a' },
    'chart repo bind --url u --branch main --json': { status: 'bound' }, 'chart repo sync --json': { status: 'synced', tip: 't' } }
  const spawned = fakeSpawn(child => {
    const key = spawned.calls.at(-1).args.slice(1).join(' ')
    if (answers[key]) child.stdout.emit('data', Buffer.from(JSON.stringify(answers[key]))); else child.stderr.emit('data', Buffer.from('nope'))
    child.emit('close', answers[key] ? 0 : 1)
  })
  const cli = createLatticeCli({ bin: '/x/lattice.mjs', chartsRoot: '/charts', home, spawnImpl: spawned.impl })
  assert.deepEqual(await cli.list(), [{ id: 'alpha', name: '工程表', createdBy: 'bot-a', source: 's1' }, { id: 'beta', name: null, createdBy: null, source: null }])
  assert.deepEqual([...await cli.sources(['alpha', 'nope', '../x'])], [['alpha', 's1'], ['nope', null]])
  assert.deepEqual([await cli.exists('alpha'), await cli.exists('../x')], [true, false])
  await cli.setName('alpha', '新しい名前', 'bot-b')
  const named = spawned.calls.find(call => call.args.includes('set'))
  assert.deepEqual([named.options.env.LATTICE_PROJECT_ID, named.options.env.LATTICE_SEAT_ID, named.options.cwd], ['alpha', 'bot-b', home])
  assert.deepEqual([(await cli.repoBind('bellteam', 'u', 'main')).status, (await cli.repoSync('bellteam')).status], ['bound', 'synced'])
  await assert.rejects(cli.repoSync('nochart').then(() => cli.setName('alpha', 'x', 'y')), { code: 'LATTICE_UNAVAILABLE' })
  assert.equal(spawned.calls.every(call => call.options.env.LATTICE_CHARTS_ROOT === '/charts' && !('cwd' in call.options && call.options.cwd.startsWith('/charts'))), true)
})

test('cli: the filing record lives in BellTeam state; the one-time move takes names and the old record out of Lattice\'s root (a102)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-migrate-')); t.after(() => rm(root, { recursive: true, force: true }))
  const chartsRoot = join(root, 'charts'), stateDir = join(root, 'state'), home = join(root, 'home')
  await mkdir(join(chartsRoot, 'alpha'), { recursive: true }); await mkdir(join(chartsRoot, 'beta'), { recursive: true })
  await writeFile(join(chartsRoot, 'alpha', '.bellteam-chart.json'), JSON.stringify({ name: '工程表', createdBy: 'bot-a' }))
  await writeFile(join(chartsRoot, '.bellteam-owner-decisions.json'), JSON.stringify({ 'alpha / p/t': { decisionId: 'K-ABCD', status: 'open' } }))
  const spawned = fakeSpawn(child => { child.stdout.emit('data', Buffer.from('{"ok":true}')); child.emit('close', 0) })
  const cli = createLatticeCli({ bin: '/x', chartsRoot, stateDir, home, spawnImpl: spawned.impl })
  assert.deepEqual(await cli.migrateLegacy([{ id: 'alpha', name: null, createdBy: null }, { id: 'beta', name: 'B', createdBy: 'bot-c' }]), { names: 1, record: true })
  assert.deepEqual(spawned.calls[0].args.slice(1), ['chart', 'set', '--name', '工程表', '--created-by', 'bot-a', '--json'])
  assert.deepEqual([existsSync(join(chartsRoot, 'alpha', '.bellteam-chart.json')), existsSync(join(chartsRoot, '.bellteam-owner-decisions.json'))], [false, false])
  assert.deepEqual(await cli.readOwnerRecord(), { 'alpha / p/t': { decisionId: 'K-ABCD', status: 'open' } })
  assert.deepEqual(await cli.migrateLegacy([{ id: 'alpha', name: '工程表', createdBy: 'bot-a' }]), { names: 0, record: false }, 'a second run moves nothing')
  // An unnamed chart whose old sidecar holds only the creator: the creator moves, no name is made up.
  await mkdir(join(chartsRoot, 'gamma')); await writeFile(join(chartsRoot, 'gamma', '.bellteam-chart.json'), JSON.stringify({ createdBy: 'bot-g' }))
  assert.deepEqual(await cli.migrateLegacy([{ id: 'gamma', name: null, createdBy: null }]), { names: 1, record: false })
  const creatorOnly = spawned.calls.at(-1)
  assert.deepEqual([creatorOnly.args.slice(1), creatorOnly.options.env.LATTICE_PROJECT_ID], [['chart', 'set', '--created-by', 'bot-g', '--json'], 'gamma'])
  assert.equal(existsSync(join(chartsRoot, 'gamma', '.bellteam-chart.json')), false)
  await cli.writeOwnerRecord({ x: 1 }); assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'owner-decisions.json'), 'utf8')), { x: 1 })
})
test('cli: allowlist and input conflict', async t => {
  const { bin, chartsRoot, home } = await scratch(t)
  const cli = createLatticeCli({ bin, chartsRoot, home })
  for (const command of ['plan', 'todo', 'status', 'session-context', 'help', '--help', '--version']) assert.equal((await cli.run({ id: 'alpha', args: [command] })).exitCode, 0)
  for (const args of [['setup'], ['hooks', 'install'], ['dashboard'], ['run'], ['sensor'], ['bridge'], [], ['PLAN'], ['--input', 'x']]) {
    await assert.rejects(cli.run({ id: 'alpha', args }), error => error.code === 'LATTICE_COMMAND_NOT_SEAT_SURFACE' && error.status === 400 && /plan, todo, status/u.test(error.detail))
  }
  await assert.rejects(cli.run({ id: 'alpha', args: ['plan', 'create', '--input', 'x'], input: {} }), { code: 'LATTICE_INPUT_CONFLICT' })
  assert.equal((await cli.run({ id: 'alpha', args: ['plan', 'create', '--input', 'x'] })).exitCode, 1)
})

function fakeSpawn(behave) {
  const calls = []
  const impl = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [], kill(signal) { this.killed.push(signal) } })
    calls.push({ command, args, options, child })
    setImmediate(() => behave(child))
    return child
  }
  return { impl, calls }
}

// A real chart dir for spawn-only tests: run() refuses a missing or linked chart dir before it spawns.
const chartsWithAlpha = async t => { const root = await mkdtemp(join(tmpdir(), 'lattice-charts-')); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, 'alpha')); return root }

test('cli: a hung process is killed at the timeout and the next call runs', async t => {
  const chartsRoot = await chartsWithAlpha(t)
  const hung = fakeSpawn(child => child.stdout.emit('data', Buffer.from('partial')))
  const home = await mkdtemp(join(tmpdir(), 'lattice-home-')); t.after(() => rm(home, { recursive: true, force: true }))
  const cli = createLatticeCli({ bin: '/x/lattice.mjs', chartsRoot, home, spawnImpl: hung.impl, timeoutMs: 20 })
  assert.deepEqual(await cli.run({ id: 'alpha', args: ['status'] }), { exitCode: null, stdout: 'partial', stderr: 'LATTICE_CLI_TIMEOUT' })
  assert.deepEqual([hung.calls[0].child.killed, hung.calls[0].command, hung.calls[0].args, hung.calls[0].options.cwd], [['SIGKILL'], process.execPath, ['/x/lattice.mjs', 'status'], home])
  const fine = fakeSpawn(child => child.emit('close', 3))
  assert.deepEqual((await createLatticeCli({ bin: '/x', chartsRoot, spawnImpl: fine.impl }).run({ id: 'alpha', args: ['status'] })).exitCode, 3)
})

test('cli: stdout keeps the first 16 MiB, stderr the last 64 KiB, spawn errors are a result', async t => {
  const chartsRoot = await chartsWithAlpha(t)
  const big = fakeSpawn(child => {
    for (let i = 0; i < 24; i++) child.stdout.emit('data', Buffer.alloc(700 * 1024, 'a'))
    child.stderr.emit('data', Buffer.from('x'.repeat(70000))); child.stderr.emit('data', Buffer.from('tail'))
    child.emit('close', 0)
  })
  const result = await createLatticeCli({ bin: '/x', chartsRoot, spawnImpl: big.impl }).run({ id: 'alpha', args: ['status'] })
  assert.deepEqual([result.stdout.length, result.stderr.length, result.stderr.endsWith('tail')], [16 * 1024 * 1024, 64 * 1024, true])
  const broken = fakeSpawn(child => child.emit('error', new Error('ENOENT')))
  assert.deepEqual(await createLatticeCli({ bin: '/x', chartsRoot, spawnImpl: broken.impl }).run({ id: 'alpha', args: ['status'] }), { exitCode: null, stdout: '', stderr: 'LATTICE_CLI_SPAWN_FAILED' })
})

test('cli: the bundled package is resolved at first use, not at creation', async () => {
  const cli = createLatticeCli({ spawnImpl: () => assert.fail('must not spawn') })
  let installed = true
  try { createRequire(import.meta.url).resolve('@quolu/lattice/bin/lattice.mjs') } catch { installed = false }
  if (!installed) await assert.rejects(cli.run({ id: 'alpha', args: ['status'] }), { code: 'LATTICE_UNAVAILABLE', status: 503 })
})

function fakeConnection(method = 'GET') {
  const request = new EventEmitter(), chunks = []
  request.method = method
  const response = { head: null, writeHead(status, headers) { this.head = [status, headers] }, write: chunk => chunks.push(chunk), end(chunk) { if (chunk) chunks.push(chunk); this.ended = true } }
  return { request, response, chunks }
}
const snap = (version, epoch = 'e1') => ({ schema: 'bellteam.lattice-chart.v1', epoch, version, projectId: 'alpha' })
const failure = code => Object.assign(new Error(code), { code })
function fakeFacade(overrides = {}) {
  const facade = { senders: new Set(), charts: async () => ({ schema: 'bellteam.lattice-charts.v1', charts: [] }), chart: async () => snap(1),
    subscribe(id, send) { facade.id = id; facade.senders.add(send); return () => facade.senders.delete(send) }, ...overrides }
  return facade
}
const call = async (api, path, method = 'GET') => {
  const { request, response, chunks } = fakeConnection(method)
  const result = await api(request, response, new URL(path, 'http://x'))
  return { request, response, chunks, result }
}

test('http-api: routes, auth and errors', async () => {
  const facade = fakeFacade({ chart: async id => id === 'missing' ? Promise.reject(failure('LATTICE_CHART_NOT_FOUND')) : id === 'down' ? Promise.reject(failure('LATTICE_UNAVAILABLE')) : snap(1) })
  const api = createLatticeApi({ facade, heartbeatMs: 1e9 })
  for (const path of ['/api/other', '/api/lattice', '/api/lattice/charts/a/b', '/api/lattice/charts/a/events/x']) assert.equal((await call(api, path)).result, false)
  const forbidden = await call(createLatticeApi({ facade, internal: true }), '/api/lattice/charts')
  assert.deepEqual([forbidden.response.head[0], JSON.parse(forbidden.chunks[0])], [403, { error: 'LATTICE_OWNER_REQUIRED' }])
  for (const path of ['/api/lattice/charts', '/api/lattice/charts/alpha', '/api/lattice/charts/alpha/events']) assert.equal((await call(api, path, 'POST')).response.head[0], 405)
  const list = await call(api, '/api/lattice/charts')
  assert.deepEqual([list.response.head[0], JSON.parse(list.chunks[0]).schema], [200, 'bellteam.lattice-charts.v1'])
  assert.deepEqual([JSON.parse((await call(api, '/api/lattice/charts/alpha')).chunks[0]).version], [1])
  for (const [id, status, code] of [['missing', 404, 'LATTICE_CHART_NOT_FOUND'], ['down', 503, 'LATTICE_UNAVAILABLE'], ['Bad_ID', 404, 'LATTICE_CHART_NOT_FOUND']]) {
    for (const suffix of ['', '/events']) {
      const result = await call(api, `/api/lattice/charts/${id}${suffix}`)
      assert.deepEqual([result.response.head[0], JSON.parse(result.chunks[0])], [status, { error: code }])
    }
  }
  assert.equal(facade.senders.size, 0)
  const unavailable = createLatticeApi({ facade: fakeFacade({ charts: async () => { throw failure('LATTICE_UNAVAILABLE') } }) })
  assert.equal((await call(unavailable, '/api/lattice/charts')).response.head[0], 503)
  await assert.rejects(call(createLatticeApi({ facade: fakeFacade({ chart: async () => { throw new Error('boom') } }) }), '/api/lattice/charts/alpha/events'), /boom/u)
})

test('http-api: SSE sends the first snapshot, then only newer versions or a new epoch, with heartbeat and cleanup', async () => {
  let release
  const facade = fakeFacade({ chart: () => new Promise(resolve => { release = () => resolve(snap(5)) }) })
  const api = createLatticeApi({ facade, heartbeatMs: 5 })
  const { request, response, chunks } = fakeConnection()
  const pending = api(request, response, new URL('/api/lattice/charts/alpha/events', 'http://x'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(response.head, null)
  assert.equal(facade.id, 'alpha')
  for (const send of facade.senders) { send(snap(4)); send(snap(5)); send(snap(6)) }
  release()
  await pending
  assert.deepEqual([response.head[0], response.head[1]['content-type']], [200, 'text/event-stream'])
  assert.equal(chunks.filter(chunk => chunk.startsWith('event: snapshot')).length, 2)
  assert.match(chunks[0], /^event: snapshot\ndata: \{.*"version":5.*\}\n\n$/u)
  assert.match(chunks[1], /"version":6/u)
  for (const send of facade.senders) { send(snap(6)); send(snap(2, 'e2')); send(snap(3, 'e2')) }
  assert.deepEqual(chunks.filter(chunk => chunk.startsWith('event:')).map(chunk => JSON.parse(chunk.split('data: ')[1]).version), [5, 6, 2, 3])
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(chunks.includes(': hb\n\n'), true)
  request.emit('close')
  const after = chunks.length
  assert.equal(facade.senders.size, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(chunks.length, after)
})

test('mcp: one tool with a strict schema; the handler runs the chart for the calling Bot', async () => {
  assert.deepEqual(latticeTools.map(tool => tool.name), ['lattice'])
  const { inputSchema, description } = latticeTools[0]
  assert.deepEqual([inputSchema.required, inputSchema.additionalProperties, Object.keys(inputSchema.properties)], [['project', 'args'], false, ['project', 'name', 'args', 'input']])
  for (const word of ['session-context', 'plan', 'todo', 'next_action', '--input', 'bellteam']) assert.ok(description.includes(word), word)
  const calls = []
  const lattice = { run: async params => { calls.push(params); return { exitCode: 0 } } }
  await latticeToolHandlers.lattice({ lattice, from: 'bot-a', args: { project: 'p', args: ['status'] } })
  await latticeToolHandlers.lattice({ lattice, from: 'bot-a', args: { project: 'p', args: ['plan', 'create'], input: { a: 1 } } })
  await latticeToolHandlers.lattice({ lattice, from: 'bot-a', args: { project: 'p', name: '工程', args: [] } })
  assert.deepEqual(calls, [{ from: 'bot-a', projectId: 'p', args: ['status'], input: null }, { from: 'bot-a', projectId: 'p', args: ['plan', 'create'], input: { a: 1 } },
    { from: 'bot-a', projectId: 'p', args: [], input: null, name: '工程' }])
})
