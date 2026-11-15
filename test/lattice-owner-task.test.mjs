import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerTaskCheck } from '../src/lattice/owner-task.mjs'
import { ownerDecisions } from '../src/lattice/owner-decisions.mjs'
import { laneResolver } from '../src/lattice/projection.mjs'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { createLatticeCore } from '../src/lattice/core.mjs'
import { validateLatticeRequest, validateLatticeResult, latticeWireError } from '../src/lattice-protocol.mjs'

const refused = (args, input = null, linked = () => false) => assert.throws(() => ownerTaskCheck(args, input, linked), { code: 'LATTICE_OWNER_TASK_REFUSED', status: 403 })
const ok = (args, input = null, linked = () => false) => assert.doesNotThrow(() => ownerTaskCheck(args, input, linked))
const dec = 'dec-k-abc123'

test('owner task check: only decision tasks, and cards that were linked; no file flags, no other verbs', () => {
  const plan = { plan_key: 'approval-box', tasks: [{ task_id: dec, lane: 'owner' }] }
  ok(['plan', 'create', '--json'], plan)
  refused(['plan', 'create', '--json'], { ...plan, plan_key: 'other' })
  refused(['plan', 'create', '--json'], { plan_key: 'approval-box', tasks: [{ task_id: 't1', lane: 'owner' }] })
  refused(['plan', 'create', '--json'], { plan_key: 'approval-box', tasks: [{ task_id: dec, lane: 'bot-a' }] })
  ok(['todo', 'add', '--plan', 'approval-box', '--task', dec, '--title', 'x', '--lane', 'owner', '--after', 'dec-k-prev'])
  refused(['todo', 'add', '--plan', 'approval-box', '--task', dec, '--title', 'x'], null)
  refused(['todo', 'add', '--plan', 'approval-box', '--task', dec, '--lane', 'bot-a'])
  refused(['todo', 'add', '--plan', 'p1', '--task', 't9', '--lane', 'owner'])
  for (const verb of ['start', 'done', 'retire', 'note', 'retract']) ok(['todo', verb, '--plan', 'approval-box', '--task', dec])
  ok(['todo', 'done', '--plan', 'approval-box', '--task', dec, '--message', 'answered'])
  refused(['todo', 'start', '--plan', 'p1', '--task', 't1'])
  ok(['todo', 'start', '--plan', 'p1', '--task', 't1'], null, (plan, task) => `${plan}/${task}` === 'p1/t1')
  refused(['todo', 'start', '--plan', 'p1', '--task', 't2'], null, (plan, task) => `${plan}/${task}` === 'p1/t1')
  for (const verb of ['block', 'unblock', 'reopen']) refused(['todo', verb, '--plan', 'approval-box', '--task', dec])
  refused(['todo', 'done', '--plan', 'approval-box', '--task', dec, '--evidence', '/etc/passwd'])
  refused(['todo', 'done', '--plan', 'approval-box', '--task', dec, '--test-result', '/x'])
  refused(['todo', 'done', '--plan', 'approval-box', '--task', dec, '--some-future-file-flag', '/x'])
  refused(['todo', 'note', '--plan', 'approval-box', '--task', dec, '--message', 'x', 'stray'])
  refused(['todo', 'start', '--plan', 'approval-box', '--task', dec, '--rebind'])
  ok(['todo', 'start', '--plan', 'approval-box', '--task', dec, '--parallel-frontier', '--override-reason', 'why'])
  refused(['todo', 'retire', '--plan', 'approval-box', '--task', dec, '--message', 'x'])
  refused(['todo', 'note', '--plan', 'approval-box', '--task', dec, '--input=/etc/passwd'])
  refused(['todo', 'start', '--plan', 'approval-box', '--plan', 'p1', '--task', dec])
  refused(['todo', 'start', '--plan=p1', '--task', 't1'], null, () => true)
  refused(['todo', 'start', '--task', dec])
  refused(['plan', 'revise', '--plan', 'p1'])
  refused(['status'])
  const connect = (...rest) => ['todo', 'dependency', 'connect', '--reason', 'why', ...rest]
  ok(connect('--from-plan', 'approval-box', '--from-task', dec, '--to-plan', 'p1', '--to-task', 's1'))
  ok(connect('--from-plan', 'p1', '--from-task', 's1', '--to-plan', 'approval-box', '--to-task', dec))
  refused(connect('--from-plan', 'p1', '--from-task', 's1', '--to-plan', 'p1', '--to-task', 's2'))
  refused(connect('--from-project', 'other', '--from-plan', 'approval-box', '--from-task', dec, '--to-plan', 'p1', '--to-task', 's1'))
})

test('owner task protocol: link and ownerTask requests and results, the refusal code crosses the wire', () => {
  const context = { generation: 'g1' }
  validateLatticeRequest('link', { projectId: 'alpha', plan: 'approval-box', taskId: dec }, context)
  validateLatticeRequest('ownerTask', { projectId: 'alpha', args: ['todo', 'start'], input: null }, context)
  assert.throws(() => validateLatticeRequest('ownerTask', { from: 'owner', projectId: 'alpha', args: [], input: null }, context), { code: 'LATTICE_INVALID' })
  assert.throws(() => validateLatticeRequest('link', { projectId: 'alpha', plan: 'a/b', taskId: 't' }, context), { code: 'LATTICE_INVALID' })
  assert.throws(() => validateLatticeRequest('link', { projectId: 'Bad', plan: 'p', taskId: 't' }, context), { code: 'LATTICE_PROJECT_INVALID' })
  validateLatticeResult('link', { schema: 'bellteam.lattice-link.v1', projectId: 'alpha', plan: 'p', taskId: 't', linked: true })
  assert.throws(() => validateLatticeResult('link', { schema: 'bellteam.lattice-link.v1', projectId: 'alpha', plan: 'p', taskId: 't', linked: false }), { code: 'LATTICE_IPC_INVALID' })
  validateLatticeResult('ownerTask', { exitCode: 0, result: null, stdout: null, stderr: '' })
  assert.deepEqual(latticeWireError({ code: 'LATTICE_OWNER_TASK_REFUSED' }, 'not_accepted'), { code: 'LATTICE_OWNER_TASK_REFUSED', status: 403, outcome: 'not_accepted' })
})

test('owner hand-over a145/R3: a linked card is neither handed over nor reminded, and an asked one stops being reminded once linked', async () => {
  const members = [{ id: 'bot-c', name: 'Cee', deleting: false }]
  const old = new Date(Date.now() - 2 * 3600e3).toISOString()
  const cards = ['t1', 't2'].map(taskId => ({ plan: 'p1', taskId, title: taskId, state: 'ready', lane: 'owner' }))
  const sent = []
  const effect = async method => method === 'messages.send' ? (sent.push(1), { delivery: 'running' }) : { turns: {} }
  const stored = { 'alpha/p1/t1': { projectId: 'alpha', plan: 'p1', taskId: 't1', status: 'linked', linkedAt: old } }
  const records = { read: async () => structuredClone(stored), write: async () => assert.fail('nothing to write') }
  await ownerDecisions([{ projectId: 'alpha', name: 'A', createdBy: 'bot-c', cards: cards.slice(0, 1) }], { laneOf: laneResolver(members), names: new Map(), bots: new Set(['bot-c']), records, effect, log: () => {} })
  assert.equal(sent.length, 0, 'linked: not handed over, not reminded')
})

const bin = new URL('../distribution/lattice/node_modules/@quolu/lattice/bin/lattice.mjs', import.meta.url).pathname
test('real Lattice: the Owner actor drives decision tasks only; link registers an Owner-lane card and refuses others', { skip: !existsSync(bin) && 'distribution/lattice not installed' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-owner-task-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = createLatticeCli({ bin, chartsRoot: join(root, 'charts'), home: join(root, 'home'), stateDir: join(root, 'state') })
  const core = createLatticeCore({ cli, log: () => {} })
  const effect = async method => method === 'members.list' ? { members: ['bot-a'].map(id => ({ id, name: id, color: 'c', avatarVersion: 'v', deleting: false })) } : { turns: {} }
  const seat = (args, input = null) => core.run({ from: 'bot-a', projectId: 'alpha', args, input }, effect)
  const owner = (args, input = null) => core.ownerTask({ projectId: 'alpha', args, input }, effect)
  const planInput = { schema: 'lattice.plan_create_input.v5', plan_key: 'p1', phases: [{ phase_id: 'a', title: 'A' }], hard_dependencies: [],
    tasks: [{ task_id: 't1', title: 'owner one', phase_id: 'a', design_memo: 'm', lane: 'owner' }, { task_id: 's1', title: 'successor', phase_id: 'a', design_memo: 'm', lane: 'bot-a' }] }
  assert.equal((await seat(['plan', 'create', '--json'], planInput)).exitCode, 0)
  // link: a decision task needs no card; an existing card must be lane owner.
  assert.equal((await core.link({ projectId: 'alpha', plan: 'approval-box', taskId: dec }, effect)).linked, true)
  await assert.rejects(core.link({ projectId: 'alpha', plan: 'p1', taskId: 's1' }, effect), { code: 'LATTICE_OWNER_TASK_REFUSED' })
  await assert.rejects(core.link({ projectId: 'alpha', plan: 'p1', taskId: 'nope' }, effect), { code: 'LATTICE_OWNER_TASK_REFUSED' })
  assert.equal((await core.link({ projectId: 'alpha', plan: 'p1', taskId: 't1' }, effect)).linked, true)
  assert.equal((await core.link({ projectId: 'alpha', plan: 'p1', taskId: 't1' }, effect)).linked, true, 'idempotent')
  // The Owner actor: the decision plan, a decision task, the edge to the waiting task, then the answer.
  const made = await owner(['plan', 'create', '--json'], { schema: 'lattice.plan_create_input.v5', plan_key: 'approval-box', phases: [{ phase_id: 'decisions', title: 'Decisions' }], hard_dependencies: [],
    tasks: [{ task_id: 'dec-k-first', title: 'first', phase_id: 'decisions', design_memo: 'm', lane: 'owner' }] })
  assert.equal(made.exitCode, 0, made.stderr)
  const added = await owner(['todo', 'add', '--plan', 'approval-box', '--task', dec, '--title', 'decide', '--phase', 'decisions', '--lane', 'owner', '--after', 'dec-k-first', '--design-memo', 'the decision', '--reason', 'filed'])
  assert.equal(added.exitCode, 0, added.stderr)
  assert.equal(added.result.actor.agent, 'owner', 'the chart records the Owner as the actor')
  const edge = await owner(['todo', 'dependency', 'connect', '--from-plan', 'approval-box', '--from-task', dec, '--to-plan', 'p1', '--to-task', 's1', '--reason', 'waits for the answer'])
  assert.equal(edge.exitCode, 0, edge.stderr)
  assert.equal((await owner(['todo', 'start', '--plan', 'approval-box', '--task', 'dec-k-first'])).exitCode, 0)
  assert.equal((await owner(['todo', 'start', '--plan', 'approval-box', '--task', dec])).exitCode, 1, 'its predecessor is not done: Lattice refuses, the port passes the refusal on')
  assert.equal((await owner(['todo', 'done', '--plan', 'approval-box', '--task', 'dec-k-first', '--message', 'answered'])).exitCode, 0)
  assert.equal((await owner(['todo', 'start', '--plan', 'approval-box', '--task', dec])).exitCode, 0)
  assert.equal((await owner(['todo', 'start', '--plan', 'p1', '--task', 't1'])).exitCode, 0, 'a linked card')
  await assert.rejects(owner(['todo', 'start', '--plan', 'p1', '--task', 's1']), { code: 'LATTICE_OWNER_TASK_REFUSED' })
  const chart = await core.chart({ projectId: 'alpha' }, effect)
  assert.ok(chart.edges.some(item => item.from === `approval-box/${dec}` && item.to === 'p1/s1' && item.waiting), 'edges carry <plan>/<task> ids')
  assert.deepEqual(chart.cards.find(card => card.id === `approval-box/${dec}`)?.lane, 'owner')
})
