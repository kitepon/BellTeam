import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CurrentWork, ownWork } from '../src/current-work.mjs'
import { readRunningExclusions, exclusionsMeta, RUNNING_EXCLUSIONS_SCHEMA } from '../src/running-exclusions.mjs'
import { createExecutionFacade } from '../src/execution-facade.mjs'

// a41 (execution current-work.md "Own work"): own work reads working; the exclusion list is applied by Aiterm only
// when it echoes the digest; an older engine without ownWork changes nothing.
const launchId = 'a'.repeat(32)
const row = own_work => ({ session_id: 's1', harness: 'grok-cli', launch_id: launchId, turn: { state: 'idle' }, ...(own_work ? { own_work } : {}) })
const read = (work, own_work, digest = 'd1') => {
  const r = work.beginRead([{ botId: 'b1', sessionId: 's1', harness: 'grok-cli', current: () => true }])
  r.digest = digest
  work.endRead(r, { schema: 'aiterm.seat-turns.v1', seats: [row(own_work)] })
}

test('ownWork: digest gate, subagent first, masked descriptor as detail', () => {
  const since = '2026-11-13T01:00:00.000Z'
  assert.equal(ownWork({ processes: 2, exclusions_digest: 'other' }, 'd1'), null, 'list not applied -> processes ignored')
  assert.equal(ownWork({ processes: 2, exclusions_digest: null }, 'd1'), null)
  assert.equal(ownWork({ processes: 0, exclusions_digest: 'd1' }, 'd1'), null)
  assert.equal(ownWork({ processes: null, exclusions_digest: 'd1' }, 'd1'), null, 'null = cannot count = 0')
  assert.deepEqual(ownWork({ processes: 2, exclusions_digest: 'd1', oldest: { exe: 'node', args: ['vite.js', 'dev'], since } }, 'd1'),
    { kind: 'background', detail: 'node vite.js dev', since })
  assert.deepEqual(ownWork({ processes: 1, child_results: 1, exclusions_digest: 'other' }, 'd1'), { kind: 'subagent', detail: null, since: null })
  assert.equal(ownWork(undefined, 'd1'), null, 'older Aiterm: no key')
})

test('CurrentWork.own: idle row with own work, cleared by idle-without and by unknown; turn stays native', () => {
  const work = new CurrentWork()
  read(work, { processes: 2, exclusions_digest: 'd1', oldest: null })
  assert.deepEqual(work.own('b1'), { kind: 'background', detail: null, since: null })
  assert.deepEqual(work.turn('b1'), { state: 'idle', turnId: null }, 'after_turn still sees the AI turn only')
  read(work, { processes: 0, exclusions_digest: 'd1' })
  assert.equal(work.own('b1'), null)
  read(work, { processes: 3, exclusions_digest: 'd1' })
  work.unknown(work.record('b1'))
  assert.equal(work.own('b1'), null)
})

test('running exclusions: absent = empty, invalid = null, meta narrowed to sessions in scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'own-work-')), path = join(dir, 'x.json')
  try {
    assert.deepEqual(await readRunningExclusions(path), [])
    await writeFile(path, '{"schema":"wrong"}')
    assert.equal(await readRunningExclusions(path), null)
    const entries = [{ id: 'e1', kind: 'process', exe: 'node', args: ['vite.js'], scope: ['b2'] },
      { id: 'e2', kind: 'child', harness: 'codex-cli', session: null, scope: 'all' }]
    await writeFile(path, JSON.stringify({ schema: RUNNING_EXCLUSIONS_SCHEMA, entries }))
    assert.deepEqual(await readRunningExclusions(path), entries)
    const targets = [{ botId: 'b1', sessionId: 's1' }, { botId: 'b2', sessionId: 's2' }]
    const meta = exclusionsMeta(entries, targets)
    assert.deepEqual(meta.entries, [{ id: 'e1', kind: 'process', exe: 'node', args: ['vite.js'], sessions: ['s2'] },
      { id: 'e2', kind: 'child', harness: 'codex-cli', session: null, sessions: ['s1', 's2'] }])
    assert.match(meta.digest, /^[0-9a-f]{64}$/)
    assert.equal(exclusionsMeta(entries, targets).digest, meta.digest, 'same list, same digest')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('facade: own work reads working in currentWork and runningState; an older engine is "not supplied"', () => {
  let own = null, older = false
  const idle = { state: 'idle', summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: '2026-11-13T01:00:00.000Z', source: null }
  const controller = { dispatch() {}, close() {}, project: ({ method }) => {
    if (method === 'transport.currentTurn') return { state: 'idle', turnId: null }
    if (method === 'transport.ownWork') { if (older) throw Object.assign(new Error('EXECUTION_REQUEST_INVALID'), { code: 'EXECUTION_REQUEST_INVALID' }); return own }
    return idle
  } }
  const { transport } = createExecutionFacade({ getController: () => controller, client: {}, membersAdmission: {}, requestStop() {}, watchQueue: () => () => {} })
  const bot = { id: 'b1' }
  assert.deepEqual(transport.currentWork(bot), idle)
  assert.equal(transport.runningState('b1'), 'idle')
  own = { kind: 'background', detail: 'sleep 180', since: null }
  assert.deepEqual(transport.currentWork(bot), { ...idle, state: 'working', reason: own })
  assert.equal(transport.runningState('b1'), 'working')
  assert.deepEqual(transport.currentTurn('b1'), { state: 'idle', turnId: null })
  older = true
  assert.deepEqual(transport.currentWork(bot), idle)
  assert.equal(transport.runningState('b1'), 'idle')
})

test('own work keeps its own read clock: a turn completion does not extend an old own observation', () => {
  let clock = 0
  const work = new CurrentWork({ monotonic: () => clock })
  const turnId = 't1', running = { state: 'running', turn_id: turnId, started_at: '2026-11-13T01:00:00.000Z', event_cursor: null, interim_from: null, wait_process: null }
  const r = work.beginRead([{ botId: 'b1', sessionId: 's1', harness: 'grok-cli', current: () => true }])
  r.digest = 'd1'
  work.endRead(r, { schema: 'aiterm.seat-turns.v1', seats: [{ ...row({ processes: 2, exclusions_digest: 'd1' }), turn: running }] })
  assert.equal(work.own('b1'), null, 'working turn: own work is not the reason')
  clock = 14_000
  work.completedTurn({ schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: 's1', launch_id: launchId, turn_id: turnId })
  assert.deepEqual(work.turn('b1'), { state: 'idle', turnId: null })
  assert.notEqual(work.own('b1'), null, 'still within 15 s of its own read')
  clock = 16_000
  assert.equal(work.own('b1'), null, 'the completion refreshed the turn, not the 16 s old own observation')
  read(work, { processes: 2, exclusions_digest: 'd1' })
  assert.notEqual(work.own('b1'), null, 'a fresh read keeps background work that outlives the turn')
})

// a41 PR 3: the card says why a Bot is working; every composed DTO passes the shared schema (integration #1274).
test('facade: reason by the fixed order turn, schedule, own work, and the DTO validates', async () => {
  const { readCurrentWork } = await import('../src/current-work-contract.mjs')
  const base = { summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: '2026-11-13T01:00:00.000Z', source: null }
  let state = 'working', waited = null, own = null
  const controller = { dispatch() {}, close() {}, project: ({ method }) => {
    if (method === 'transport.currentTurn') return { state: state === 'working' ? 'working' : 'idle', turnId: 't', startedAt: '2026-11-13T00:59:00Z' }
    if (method === 'transport.ownWork') return own
    return { ...base, state }
  } }
  const { transport } = createExecutionFacade({ getController: () => controller, client: {}, membersAdmission: {}, requestStop() {}, watchQueue: () => () => {}, commandWait: () => waited })
  const bot = { id: 'b1' }
  // The body reader turns any DTO its schema refuses into unknown; equal means accepted as is.
  const check = expected => { const value = transport.currentWork(bot); assert.deepEqual(value.reason, expected); assert.deepEqual(readCurrentWork(transport, bot), value); return value }
  check({ kind: 'turn', detail: null, since: '2026-11-13T00:59:00.000Z' })
  state = 'idle'; waited = '2026-11-13T00:58:00.000Z'; own = { kind: 'background', detail: 'node vite.js', since: null }
  check({ kind: 'schedule', detail: null, since: null })
  waited = null
  check({ kind: 'background', detail: 'node vite.js', since: null })
  own = null
  const idle = transport.currentWork(bot)
  assert.equal(Object.hasOwn(idle, 'reason'), false, 'an idle Bot carries no reason key')
  assert.deepEqual(readCurrentWork(transport, bot), idle)
})

// a69 (current-work.md "own work: harness tasks"): the harness's own unfinished background tasks count, with no process.
test('ownWork: harness tasks (in-process agent) count without processes; agent -> subagent, other -> background', () => {
  const since = '2026-11-13T14:37:21.000Z'
  assert.deepEqual(ownWork({ processes: 0, exclusions_digest: 'd1', tasks: 1, task: { kind: 'agent', label: 'Implement  LiveTR', since } }, 'd1'),
    { kind: 'subagent', detail: 'Implement LiveTR', since })
  assert.deepEqual(ownWork({ processes: 0, exclusions_digest: 'other', tasks: 1, task: { kind: 'agent', label: 'x', since } }, 'd1'),
    { kind: 'subagent', detail: 'x', since }, 'tasks are not subject to the exclusion list')
  assert.deepEqual(ownWork({ processes: 0, exclusions_digest: 'd1', tasks: 1, task: { kind: 'shell', label: 'npm test', since } }, 'd1'),
    { kind: 'background', detail: 'npm test', since })
  assert.deepEqual(ownWork({ processes: 2, exclusions_digest: 'd1', oldest: { exe: 'sleep', args: ['60'], since }, tasks: 1, task: { kind: 'shell', label: 'sleep 60', since } }, 'd1'),
    { kind: 'background', detail: 'sleep 60', since }, 'processes keep their descriptor')
  assert.equal(ownWork({ processes: 0, exclusions_digest: 'd1', tasks: 0, task: null }, 'd1'), null)
  assert.equal(ownWork({ processes: 0, exclusions_digest: 'd1', tasks: null }, 'd1'), null, 'null = the harness states nothing')
})
