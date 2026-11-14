import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerDecisions, OPTIONS } from '../src/lattice/owner-decisions.mjs'
import { laneResolver } from '../src/lattice/projection.mjs'
import { createLatticeCli } from '../src/lattice/cli.mjs'
import { validateLatticeEffect, validateLatticeEffectResult, validateLatticeResult } from '../src/lattice-protocol.mjs'

const members = [{ id: 'bot-c', name: 'Cee', deleting: false }, { id: 'bot-a', name: 'Aye', deleting: false }]
const card = (taskId, state, lane = 'owner') => ({ plan: 'p1', taskId, title: `Task ${taskId}`, state, lane, doneCondition: 'approved', designMemo: 'why' })

const fail = code => Object.assign(new Error('x'), { code })
function rig({ charts, decisions = {}, fileFails = false, readFails = null, cancelFails = null, sendDelivery = 'running', record = {}, failWrite = () => false }) {
  const calls = [], logs = [], writes = []
  let stored = structuredClone(record), next = 1
  const effect = async (method, params) => {
    calls.push([method, params])
    if (method === 'decisions.file') {
      const code = typeof fileFails === 'function' ? fileFails(params) : fileFails && 'LATTICE_DECISIONS_UNAVAILABLE'
      if (code) throw fail(code)
      return { decisionId: `K-AB${next++}CD`, existing: false }
    }
    if (method === 'decisions.read' && readFails) throw fail(readFails)
    if (method === 'decisions.read') return decisions[params.decisionId] ?? { status: 'pending' }
    if (method === 'messages.send') return { delivery: sendDelivery, deliveryId: 'd' }
    if (method === 'decisions.cancel' && cancelFails) throw fail(cancelFails)
    if (method === 'decisions.cancel') return { status: 'cancelled' }
    throw new Error(method)
  }
  const records = { read: async () => structuredClone(stored), write: async value => { if (failWrite(value)) throw fail('EIO'); stored = structuredClone(value); writes.push(stored) } }
  return { calls, logs, writes, stored: () => stored,
    go: () => ownerDecisions(charts, { laneOf: laneResolver(members), names: new Map(members.map(m => [m.id, m.name])), bots: new Set(members.map(m => m.id)), records, effect, log: line => logs.push(line) }) }
}

test('owner hand-over: an in-progress or startable Owner-lane task goes once to the chart creator Bot, which files the plain-Japanese request; Lattice files none (Owner 2026-11-14)', async () => {
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready'), card('t2', 'in-progress', '指揮官'), card('t3', 'pending'),
    card('t4', 'blocked'), card('t5', 'done'), card('t6', 'ready', 'bot-a')] }, { projectId: 'beta', name: null, createdBy: null, cards: [card('t7', 'ready')] }]
  const x = rig({ charts })
  assert.deepEqual(await x.go(), { filed: 2, routed: 0 })
  assert.equal(x.calls.filter(([method]) => method.startsWith('decisions.')).length, 0, 'no script-made Approval Box card')
  const sends = x.calls.map(([, params]) => params)
  assert.deepEqual(sends.map(params => [params.from, params.target]), [['scheduler', 'bot-c'], ['scheduler', 'bot-c']])
  for (const text of ['p1/t1 「Task t1」', 'exactly ONE Approval Box request', 'already filed one, file nothing', 'request_decision', 'plain Japanese',
    'each option says what happens after it', 'lattice todo done --plan p1 --task t1', 'cancel_decision']) assert.ok(sends[0].message.includes(text), text)
  for (const params of sends) validateLatticeEffect('messages.send', params)
  assert.deepEqual(Object.fromEntries(Object.entries(x.stored()).map(([key, item]) => [key, item.status])), { 'alpha/p1/t1': 'asked', 'alpha/p1/t2': 'asked' })
  assert.deepEqual(x.logs, ['lattice-owner-ask beta no-creator'])
  // Next tick: nothing again (Owner: 決裁箱連発すんなよ).
  const again = rig({ charts, record: x.stored() })
  assert.deepEqual(await again.go(), { filed: 0, routed: 0 })
  assert.deepEqual(again.calls, [])
  const refused = rig({ charts: charts.slice(0, 1), sendDelivery: 'refused' })
  assert.deepEqual(await refused.go(), { filed: 0, routed: 0 })
  assert.deepEqual(refused.stored(), {}, 'nothing recorded; the next tick hands it over')
  assert.deepEqual(refused.logs, ['lattice-owner-ask alpha/p1/t1 not accepted', 'lattice-owner-ask alpha/p1/t2 not accepted'])
})

test('owner hand-over: an already pending Lattice-filed card is withdrawn with a Japanese reason and handed to the creator in the same tick; one decision, one card', async () => {
  const open = (projectId, taskId, id) => ({ projectId, plan: 'p1', taskId, title: `Task ${taskId}`, decisionId: id, status: 'open', filedAt: 'x' })
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready'), card('t2', 'in-progress'), card('t3', 'pending')] },
    { projectId: 'beta', name: null, createdBy: 'bot-gone', cards: [card('t4', 'ready')] }]
  const record = { 'alpha/p1/t1': open('alpha', 't1', 'K-AAAA01'), 'alpha/p1/t2': open('alpha', 't2', 'K-AAAA02'), 'alpha/p1/t3': open('alpha', 't3', 'K-AAAA03'),
    'beta/p1/t4': open('beta', 't4', 'K-AAAA04') }
  const x = rig({ charts, record, decisions: { 'K-AAAA02': { status: 'held' } } })
  assert.deepEqual(await x.go(), { filed: 2, routed: 0 })
  const cancels = x.calls.filter(([method]) => method === 'decisions.cancel').map(([, params]) => params)
  assert.deepEqual(cancels.map(params => params.decisionId), ['K-AAAA01', 'K-AAAA02'])
  assert.ok(cancels[0].reason.includes('伝わりにくい') && cancels[0].reason.includes('Ceeが'))
  for (const params of cancels) validateLatticeEffect('decisions.cancel', params)
  assert.deepEqual(x.calls.filter(([method]) => method === 'messages.send').map(([, params]) => params.target), ['bot-c', 'bot-c'])
  assert.deepEqual(Object.fromEntries(Object.entries(x.stored()).map(([key, item]) => [key, item.status])),
    { 'alpha/p1/t1': 'asked', 'alpha/p1/t2': 'asked', 'alpha/p1/t3': 'open', 'beta/p1/t4': 'open' }, 'a task that cannot move, or no creator to ask, keeps its card')
  const down = rig({ charts, record: { 'alpha/p1/t1': open('alpha', 't1', 'K-AAAA01') }, cancelFails: 'LATTICE_DECISIONS_UNAVAILABLE' })
  await down.go()
  assert.deepEqual(down.calls.map(([method]) => method), ['decisions.read', 'decisions.cancel'], 'unavailable ends the tick')
  assert.equal(down.stored()['alpha/p1/t1'].status, 'reask', 'not handed over while its old card may still be up')
})

test('owner hand-over: a re-ask survives a cancel that took effect but lost its reply, or a lost write after it; the creator is handed the task once (Epinel #1430)', async () => {
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready')] }]
  const legacy = { 'alpha/p1/t1': { projectId: 'alpha', plan: 'p1', taskId: 't1', title: 'Task t1', decisionId: 'K-AAAA01', status: 'open', filedAt: 'x' } }
  const status = record => Object.fromEntries(Object.entries(record).map(([key, item]) => [key, item.status]))
  const handed = x => x.calls.filter(([method]) => method === 'messages.send').length
  // Tick 1: the cancel reaches Approval Box but its reply is lost.
  const decisions = {}
  const lost = rig({ charts, record: legacy, decisions, cancelFails: 'LATTICE_DECISIONS_UNAVAILABLE' })
  assert.deepEqual(await lost.go(), { filed: 0, routed: 0 })
  assert.deepEqual([status(lost.stored()), handed(lost)], [{ 'alpha/p1/t1': 'reask' }, 0], 'the intent is durable before the cancel')
  decisions['K-AAAA01'] = { status: 'cancelled' }
  // Tick 2: reads cancelled -> handed over once, not closed forever.
  const next = rig({ charts, record: lost.stored(), decisions })
  assert.deepEqual(await next.go(), { filed: 1, routed: 0 })
  assert.deepEqual([status(next.stored()), handed(next)], [{ 'alpha/p1/t1': 'asked' }, 1])
  const after = rig({ charts, record: next.stored(), decisions })
  await after.go()
  assert.deepEqual(after.calls, [], 'once')
  // A cancel that succeeds but whose delete write fails resumes the same way; a re-ask still pending retries the cancel.
  const unwritten = rig({ charts, record: legacy, decisions: {}, failWrite: value => !('alpha/p1/t1' in value) })
  await assert.rejects(unwritten.go(), { code: 'EIO' })
  assert.deepEqual([status(unwritten.stored()), unwritten.calls.map(([method]) => method)], [{ 'alpha/p1/t1': 'reask' }, ['decisions.read', 'decisions.cancel']])
  const resumed = rig({ charts, record: unwritten.stored(), decisions })
  assert.deepEqual(await resumed.go(), { filed: 1, routed: 0 })
  const retried = rig({ charts, record: unwritten.stored() })
  await retried.go()
  assert.deepEqual(retried.calls.map(([method]) => method), ['decisions.read', 'decisions.cancel', 'messages.send'], 'still pending: the cancel is retried, then handed over')
})

test('owner filing: the answer goes to the chart creator once; cancelled closes; no creator waits; a refused send retries', async () => {
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready')] }, { projectId: 'beta', name: null, createdBy: 'bot-gone', cards: [] }]
  const record = {
    'alpha/p1/t1': { projectId: 'alpha', plan: 'p1', taskId: 't1', title: 'Task t1', decisionId: 'K-AAAA01', status: 'open', filedAt: 'x' },
    'alpha/p1/t9': { projectId: 'alpha', plan: 'p1', taskId: 't9', title: 'Task t9', decisionId: 'K-AAAA09', status: 'open', filedAt: 'x' },
    'beta/p1/t2': { projectId: 'beta', plan: 'p1', taskId: 't2', title: 'Task t2', decisionId: 'K-AAAA02', status: 'open', filedAt: 'x' },
  }
  const x = rig({ charts, record, decisions: { 'K-AAAA01': { status: 'answered', answer: { optionId: 'done', text: 'ok' } }, 'K-AAAA09': { status: 'cancelled' },
    'K-AAAA02': { status: 'answered', answer: { optionId: 'not-yet' } } } })
  assert.deepEqual(await x.go(), { filed: 0, routed: 1 })
  const sends = x.calls.filter(([method]) => method === 'messages.send').map(([, params]) => params)
  assert.deepEqual(sends.map(params => [params.from, params.target]), [['scheduler', 'bot-c']])
  assert.ok(sends[0].message.includes('Answer: 済んだ / ok') && sends[0].message.includes('lattice todo done --plan p1 --task t1')
    && sends[0].message.indexOf('lattice todo start --plan p1 --task t1') < sends[0].message.indexOf('lattice todo done --plan p1 --task t1')
    && sends[0].message.includes('lattice todo start --plan p1 --task t1'))
  assert.deepEqual(Object.fromEntries(Object.entries(x.stored()).map(([key, item]) => [key, item.status])), { 'alpha/p1/t1': 'routed', 'alpha/p1/t9': 'closed', 'beta/p1/t2': 'open' })
  assert.deepEqual(x.logs, ['lattice-owner-route beta no-creator'])

  const refused = rig({ charts, record: { 'alpha/p1/t1': record['alpha/p1/t1'] }, decisions: { 'K-AAAA01': { status: 'answered', answer: { optionId: 'done' } } }, sendDelivery: 'refused' })
  assert.deepEqual(await refused.go(), { filed: 0, routed: 0 })
  assert.equal(refused.stored()['alpha/p1/t1'].status, 'open', 'a refused send retries next tick')
})

test('owner record file: missing reads {}, written 0600 by rename, a malformed file is moved aside', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-owner-'))
  const cli = createLatticeCli({ bin: '/nonexistent', chartsRoot: join(root, 'charts'), stateDir: root })
  assert.deepEqual(await cli.readOwnerRecord(), {})
  await cli.writeOwnerRecord({ 'a/p/t': { status: 'open' } })
  assert.deepEqual(await cli.readOwnerRecord(), { 'a/p/t': { status: 'open' } })
  assert.deepEqual(await readdir(root), ['owner-decisions.json'], 'BellTeam state dir, never the charts root (a102)')
  await writeFile(join(root, 'owner-decisions.json'), '[broken')
  assert.deepEqual(await cli.readOwnerRecord(), {})
  const aside = (await readdir(root)).find(name => name.startsWith('owner-decisions.json.invalid-'))
  assert.equal(await readFile(join(root, aside), 'utf8'), '[broken', 'kept aside, not deleted')
})

test('protocol: decisions effects and the nudge result with or without filed/routed', () => {
  validateLatticeEffect('decisions.read', { decisionId: 'K-3JM9PS' })
  assert.throws(() => validateLatticeEffect('decisions.read', { decisionId: 'k-1' }), { code: 'LATTICE_INVALID' })
  assert.throws(() => validateLatticeEffect('decisions.file', { title: 't', context: 'c', options: [OPTIONS[0]], requester: 'r', session_label: 'w' }), { code: 'LATTICE_INVALID' })
  validateLatticeEffectResult('decisions.file', { decisionId: 'K-3JM9PS', existing: true })
  validateLatticeEffectResult('decisions.read', { status: 'answered', answer: { optionId: 'done', text: 'ok' } })
  assert.throws(() => validateLatticeEffectResult('decisions.read', { status: 'gone' }), { code: 'LATTICE_IPC_INVALID' })
  validateLatticeResult('nudge', { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  validateLatticeResult('nudge', { charts: 1, prompted: 0, skipped: 0, failed: 0, filed: 1, routed: 0 })
})

test('owner filing: an unavailable read of a legacy request ends the tick before any hand-over', async () => {
  const two = () => [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready'), card('t2', 'ready')] }]
  const unread = rig({ charts: two(), readFails: 'LATTICE_DECISIONS_UNAVAILABLE',
    record: { 'alpha/p1/t9': { projectId: 'alpha', plan: 'p1', taskId: 't9', title: 'x', decisionId: 'K-AAAA09', status: 'open', filedAt: 't' } } })
  assert.deepEqual(await unread.go(), { filed: 0, routed: 0 })
  assert.deepEqual(unread.calls.map(([method]) => method), ['decisions.read'], 'no hand-over after an unavailable read')
})

test('owner filing: an Owner task retired or done on its chart cancels its still-open request; unseen cards and answers are left alone (Chime 2026-11-13)', async () => {
  const open = (taskId, id) => ({ projectId: 'alpha', plan: 'p1', taskId, title: `Task ${taskId}`, decisionId: id, status: 'open', filedAt: 'x' })
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'retired'), card('t2', 'done'), card('t3', 'ready'), card('t4', 'retired')] }]
  const record = { 'alpha/p1/t1': open('t1', 'K-AAAA01'), 'alpha/p1/t2': open('t2', 'K-AAAA02'), 'alpha/p1/t3': open('t3', 'K-AAAA03'),
    'alpha/p1/t4': open('t4', 'K-AAAA04'), 'alpha/p1/t9': open('t9', 'K-AAAA09') }
  const x = rig({ charts, record, decisions: { 'K-AAAA02': { status: 'held' }, 'K-AAAA04': { status: 'answered', answer: { optionId: 'done' } } } })
  assert.deepEqual(await x.go(), { filed: 1, routed: 1 })
  const cancels = x.calls.filter(([method]) => method === 'decisions.cancel').map(([, params]) => params)
  assert.deepEqual(cancels.map(params => params.decisionId), ['K-AAAA01', 'K-AAAA02', 'K-AAAA03'])
  assert.ok(cancels[0].reason.includes('取り下げられた') && cancels[1].reason.includes('済になった'))
  for (const params of cancels) validateLatticeEffect('decisions.cancel', params)
  validateLatticeEffectResult('decisions.cancel', { status: 'cancelled' })
  assert.deepEqual(Object.fromEntries(Object.entries(x.stored()).map(([key, item]) => [key, item.status])),
    { 'alpha/p1/t1': 'closed', 'alpha/p1/t2': 'closed', 'alpha/p1/t3': 'asked', 'alpha/p1/t4': 'routed', 'alpha/p1/t9': 'open' }, 'ready is handed over, an answer still routes, an unseen card is not an end')

  // A refused cancel (or an older body) skips that record only; unavailable ends the tick.
  const refused = rig({ charts, record: { 'alpha/p1/t1': open('t1', 'K-AAAA01'), 'alpha/p1/t2': open('t2', 'K-AAAA02') }, cancelFails: 'LATTICE_EFFECT_FAILED' })
  await refused.go()
  assert.deepEqual(refused.calls.filter(([method]) => method === 'decisions.cancel').length, 2)
  assert.deepEqual([refused.stored()['alpha/p1/t1'].status, refused.stored()['alpha/p1/t2'].status], ['open', 'open'], 'filing goes on after a refused cancel')
  const down = rig({ charts, record: { 'alpha/p1/t1': open('t1', 'K-AAAA01'), 'alpha/p1/t2': open('t2', 'K-AAAA02') }, cancelFails: 'LATTICE_DECISIONS_UNAVAILABLE' })
  await down.go()
  assert.deepEqual(down.calls.map(([method]) => method), ['decisions.read', 'decisions.cancel'])
})
