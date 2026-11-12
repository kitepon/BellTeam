import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { stopsOf, stopIdOf, unblockOutcome } from '../src/lattice/blockers.mjs'
import { createLatticeApi } from '../src/lattice/http-api.mjs'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { createLatticeCore } from '../src/lattice/core.mjs'
import { validateLatticeRequest, validateLatticeResult } from '../src/lattice-protocol.mjs'

const entry = (task, at = '2026-11-12T00:00:00.000Z') => ({ plan_key: 'p1', task_id: task, title: `T ${task}`, lane: 'bot-a', reason: 'CI red', blocked_at: at,
  blocked_by: { agent: 'bot-a', host: 'h', session: 's' }, unblock_action: `lattice todo unblock --plan p1 --task ${task}` })

test('stops: rows carry a stable id that changes when the task is blocked again', () => {
  const [row] = stopsOf('alpha', { blockers: [entry('t1'), { plan_key: 1 }] }, { name: 'A', createdBy: 'bot-c' })
  assert.deepEqual({ ...row, stopId: undefined }, { stopId: undefined, projectId: 'alpha', chartName: 'A', chartCreatedBy: 'bot-c', plan: 'p1', taskId: 't1', cardId: 'p1/t1',
    title: 'T t1', lane: 'bot-a', reason: 'CI red', blockedAt: '2026-11-12T00:00:00.000Z', blockedBy: 'bot-a' })
  assert.match(row.stopId, /^[a-f0-9]{24}$/u)
  assert.equal(stopIdOf('alpha', entry('t1')), row.stopId)
  assert.notEqual(stopIdOf('alpha', entry('t1', '2026-11-12T01:00:00.000Z')), row.stopId)
  assert.notEqual(stopIdOf('beta', entry('t1')), row.stopId)
  assert.deepEqual(stopsOf('x', { project_id: null, blockers: [] }), [])
})

test('unblock outcomes: removed, already-gone (unchanged, task/plan gone), refused with reason', () => {
  assert.deepEqual(unblockOutcome({ exitCode: 0, out: { kind: 'unblock' } }), { outcome: 'removed' })
  assert.deepEqual(unblockOutcome({ exitCode: 0, out: { unchanged: true } }), { outcome: 'already-gone' })
  for (const code of ['TASK_NOT_FOUND', 'PLAN_NOT_FOUND']) assert.deepEqual(unblockOutcome({ exitCode: 1, err: { code } }), { outcome: 'already-gone' })
  assert.deepEqual(unblockOutcome({ exitCode: 1, err: { code: 'STORE_BUSY', detail: { next_action: 'retry' } } }), { outcome: 'refused', code: 'STORE_BUSY', reason: 'retry' })
  assert.deepEqual(unblockOutcome({ exitCode: null }), { outcome: 'refused', code: 'LATTICE_CLI_FAILED', reason: 'LATTICE_CLI_FAILED' })
})

test('protocol: blockers and unblock', () => {
  const context = { generation: 'g' }
  validateLatticeRequest('blockers', {}, context)
  validateLatticeRequest('unblock', { projectId: 'alpha', stopId: 'a'.repeat(24) }, context)
  for (const params of [{ projectId: 'alpha', stopId: 'x' }, { projectId: 'alpha' }, { projectId: 'alpha', stopId: 'a'.repeat(24), plan: 'p' }])
    assert.throws(() => validateLatticeRequest('unblock', params, context), { code: 'LATTICE_INVALID' })
  const [row] = stopsOf('alpha', { blockers: [entry('t1')] })
  validateLatticeResult('blockers', { schema: 'bellteam.lattice-blockers.v1', at: 'now', blockers: [row], unreadCharts: ['beta'] })
  const ok = { schema: 'bellteam.lattice-unblock.v1', projectId: 'alpha', stopId: row.stopId }
  validateLatticeResult('unblock', { ...ok, outcome: 'removed' })
  validateLatticeResult('unblock', { ...ok, outcome: 'refused', code: 'X', reason: 'r' })
  assert.throws(() => validateLatticeResult('unblock', { ...ok, outcome: 'refused' }), { code: 'LATTICE_IPC_INVALID' })
  assert.throws(() => validateLatticeResult('unblock', { ...ok, outcome: 'removed', code: 'X' }), { code: 'LATTICE_IPC_INVALID' })
})

function connection(method, body, contentType = 'application/json') {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  Object.assign(request, { method, headers: contentType ? { 'content-type': contentType } : {} })
  const chunks = [], response = { head: null, writeHead(status, headers) { this.head = [status, headers] }, write: chunk => chunks.push(chunk), end(chunk) { if (chunk) chunks.push(chunk) } }
  return { request, response, chunks }
}
const send = async (api, path, method = 'GET', body, contentType) => {
  const { request, response, chunks } = connection(method, body, contentType)
  const result = await api(request, response, new URL(path, 'http://x'))
  return { result, status: response.head?.[0], body: chunks[0] === undefined ? undefined : JSON.parse(chunks[0]) }
}
const stop = 'b'.repeat(24)

test('http-api stops: Owner only, JSON only, exact body, distinct outcomes, old child is 503', async () => {
  const calls = []
  const facade = { blockers: async () => ({ schema: 'bellteam.lattice-blockers.v1', at: 'now', blockers: [], unreadCharts: [] }),
    unblock: async params => { calls.push(params); return { schema: 'bellteam.lattice-unblock.v1', ...params, ...(params.projectId === 'refuse' ? { outcome: 'refused', code: 'X', reason: 'why' } : { outcome: params.projectId === 'gone' ? 'already-gone' : 'removed' }) } } }
  const api = createLatticeApi({ facade, heartbeatMs: 1e9 })
  const internal = createLatticeApi({ facade, internal: true })
  assert.deepEqual(await send(internal, '/api/lattice/blockers'), { result: undefined, status: 403, body: { error: 'LATTICE_OWNER_REQUIRED' } })
  assert.equal((await send(internal, '/api/lattice/charts/alpha/unblock', 'POST', JSON.stringify({ stopId: stop }))).status, 403)
  assert.equal((await send(api, '/api/lattice/blockers', 'POST')).status, 405)
  assert.equal((await send(api, '/api/lattice/charts/alpha/unblock', 'GET')).status, 405)
  assert.deepEqual((await send(api, '/api/lattice/blockers')).body.schema, 'bellteam.lattice-blockers.v1')
  assert.equal((await send(api, '/api/lattice/charts/alpha/unblock', 'POST', `stopId=${stop}`, 'application/x-www-form-urlencoded')).status, 415)
  assert.equal((await send(api, '/api/lattice/charts/Bad/unblock', 'POST', JSON.stringify({ stopId: stop }))).status, 400)
  for (const body of ['{', '[]', JSON.stringify({ stopId: 'x' }), JSON.stringify({ stopId: stop, plan: 'p' }), JSON.stringify({ stopId: stop, pad: 'x'.repeat(2000) })])
    assert.deepEqual((await send(api, '/api/lattice/charts/alpha/unblock', 'POST', body)).body, { error: 'LATTICE_INVALID' })
  assert.deepEqual(calls, [])
  assert.deepEqual(await send(api, '/api/lattice/charts/alpha/unblock', 'POST', JSON.stringify({ stopId: stop }), 'application/json; charset=utf-8'),
    { result: undefined, status: 200, body: { schema: 'bellteam.lattice-unblock.v1', projectId: 'alpha', stopId: stop, outcome: 'removed' } })
  assert.equal((await send(api, '/api/lattice/charts/gone/unblock', 'POST', JSON.stringify({ stopId: stop }))).body.outcome, 'already-gone')
  assert.deepEqual(await send(api, '/api/lattice/charts/refuse/unblock', 'POST', JSON.stringify({ stopId: stop })),
    { result: undefined, status: 409, body: { error: 'LATTICE_UNBLOCK_REFUSED', outcome: 'refused', code: 'X', reason: 'why' } })
  const old = createLatticeApi({ facade: { blockers: async () => { throw Object.assign(new Error('x'), { code: 'LATTICE_INVALID' }) }, unblock: async () => { throw Object.assign(new Error('x'), { code: 'LATTICE_INVALID' }) } } })
  assert.deepEqual((await send(old, '/api/lattice/blockers')).body, { error: 'LATTICE_UNAVAILABLE' })
  assert.equal((await send(old, '/api/lattice/charts/alpha/unblock', 'POST', JSON.stringify({ stopId: stop }))).status, 503)
})

const bin = new URL('../distribution/lattice/node_modules/@quolu/lattice/bin/lattice.mjs', import.meta.url).pathname
test('real Lattice: list across charts, Owner unblock recorded as owner, re-send is already-gone, nothing sent as owner', { skip: !existsSync(bin) && 'distribution/lattice not installed' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-stops-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = createLatticeCli({ bin, chartsRoot: join(root, 'charts'), home: join(root, 'home') })
  const core = createLatticeCore({ cli, log: () => {} })
  const sent = []
  const effect = async (method, params) => method === 'members.list' ? { members: ['bot-a', 'bot-b'].map(id => ({ id, name: id, color: 'c', avatarVersion: 'v', deleting: false })) }
    : (sent.push(params), { delivery: 'queued', deliveryId: 'd' })
  const plan = { schema: 'lattice.plan_create_input.v5', plan_key: 'p1', phases: [{ phase_id: 'a', title: 'A' }],
    tasks: [{ task_id: 't1', title: 'One', phase_id: 'a', design_memo: 'm', lane: 'bot-a' }, { task_id: 't2', title: 'Two', phase_id: 'a', design_memo: 'm', lane: 'bot-b' }],
    hard_dependencies: [{ from: { task_id: 't1' }, to: { task_id: 't2' } }] }
  const run = (projectId, args, input = null) => core.run({ from: 'bot-a', projectId, args, input }, effect)
  assert.equal((await run('alpha', ['plan', 'create', '--json'], plan)).exitCode, 0)
  await run('alpha', ['todo', 'start', '--plan', 'p1', '--task', 't1'])
  await run('alpha', ['todo', 'block', '--plan', 'p1', '--task', 't1', '--reason', 'waiting for CI'])
  await mkdir(join(root, 'charts', 'empty'), { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: join(root, 'charts', 'empty') })
  const list = await core.blockers()
  assert.deepEqual(list.blockers.map(row => [row.projectId, row.cardId, row.reason, row.blockedBy]), [['alpha', 'p1/t1', 'waiting for CI', 'bot-a']])
  assert.deepEqual(list.unreadCharts, [])
  const { stopId } = list.blockers[0]
  assert.equal((await core.unblock({ projectId: 'alpha', stopId }, effect)).outcome, 'removed')
  assert.deepEqual((await core.blockers()).blockers, [])
  assert.equal((await core.unblock({ projectId: 'alpha', stopId }, effect)).outcome, 'already-gone', 're-send is harmless')
  assert.equal((await core.unblock({ projectId: 'nochart', stopId }, effect)).outcome, 'already-gone')
  const history = await run('alpha', ['todo', 'show', '--plan', 'p1', '--task', 't1', '--json'])
  assert.equal(history.result.state.status, 'in-progress')
  const journal = (await readFile(join(root, 'charts', 'alpha', '.lattice', 'todo', 'plans', 'p1', 'v1', 'journal', 'active.jsonl'), 'utf8')).trim().split('\n')
  assert.ok(journal.some(line => /"unblock"/u.test(line) && /"agent":"owner"/u.test(line)), 'the unblock is recorded under owner')
  // done t1 releases t2 (lane bot-b) through the normal path; nothing was sent from 'owner'
  assert.ok(sent.every(item => item.from !== 'owner'))
})
