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
function rig({ charts, decisions = {}, fileFails = false, readFails = null, cancelFails = null, sendDelivery = 'running', record = {} }) {
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
  const records = { read: async () => structuredClone(stored), write: async value => { stored = structuredClone(value); writes.push(stored) } }
  return { calls, logs, writes, stored: () => stored,
    go: () => ownerDecisions(charts, { laneOf: laneResolver(members), names: new Map(members.map(m => [m.id, m.name])), bots: new Set(members.map(m => m.id)), records, effect, log: line => logs.push(line) }) }
}

test('owner filing: an in-progress or startable Owner-lane task is filed once by script, named after the chart creator, and recorded before the next', async () => {
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready'), card('t2', 'in-progress', '指揮官'), card('t3', 'pending'),
    card('t4', 'blocked'), card('t5', 'done'), card('t6', 'ready', 'bot-a')] }]
  const x = rig({ charts })
  assert.deepEqual(await x.go(), { filed: 2, routed: 0 })
  const files = x.calls.filter(([method]) => method === 'decisions.file').map(([, params]) => params)
  assert.deepEqual(files.map(params => [params.title, params.requester, params.session_label]), [['Alpha: Task t1', 'Cee', 'alpha / p1/t1'], ['Alpha: Task t2', 'Cee', 'alpha / p1/t2']])
  assert.deepEqual(files[0].options, OPTIONS)
  assert.ok(files[0].context.includes('終わりの条件: approved') && files[0].context.includes('Cee が工程表に記録します'))
  for (const params of files) validateLatticeEffect('decisions.file', params)
  assert.equal(x.writes.length, 2, 'one write per filing')
  assert.deepEqual(Object.keys(x.stored()), ['alpha/p1/t1', 'alpha/p1/t2'])
  // Next tick: open records are read, nothing is filed again (Owner: 決裁箱連発すんなよ).
  const again = rig({ charts, record: x.stored() })
  assert.deepEqual(await again.go(), { filed: 0, routed: 0 })
  assert.deepEqual(again.calls.map(([method]) => method), ['decisions.read', 'decisions.read'])
})

test('owner filing: the answer goes to the chart creator once; cancelled closes; no creator waits; a failed file records nothing', async () => {
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

  const down = rig({ charts: [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready')] }], fileFails: true })
  assert.deepEqual(await down.go(), { filed: 0, routed: 0 })
  assert.deepEqual(down.stored(), {}, 'nothing recorded; the next tick files')
  assert.deepEqual(down.logs, ['lattice-owner-file alpha/p1/t1 LATTICE_DECISIONS_UNAVAILABLE'])

  const refused = rig({ charts, record: { 'alpha/p1/t1': record['alpha/p1/t1'] }, decisions: { 'K-AAAA01': { status: 'answered', answer: { optionId: 'done' } } }, sendDelivery: 'refused' })
  assert.deepEqual(await refused.go(), { filed: 0, routed: 0 })
  assert.equal(refused.stored()['alpha/p1/t1'].status, 'open', 'a refused send retries next tick')
})

test('owner record file: missing reads {}, written 0600 by rename, a malformed file is moved aside', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-owner-'))
  const cli = createLatticeCli({ bin: '/nonexistent', chartsRoot: root })
  assert.deepEqual(await cli.readOwnerRecord(), {})
  await cli.writeOwnerRecord({ 'a/p/t': { status: 'open' } })
  assert.deepEqual(await cli.readOwnerRecord(), { 'a/p/t': { status: 'open' } })
  assert.deepEqual(await readdir(root), ['.bellteam-owner-decisions.json'])
  await writeFile(join(root, '.bellteam-owner-decisions.json'), '[broken')
  assert.deepEqual(await cli.readOwnerRecord(), {})
  const aside = (await readdir(root)).find(name => name.startsWith('.bellteam-owner-decisions.json.invalid-'))
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

test('owner filing: unavailable ends the tick at the first failure; a refusal skips only that card', async () => {
  const two = () => [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'ready'), card('t2', 'ready')] }]
  const down = rig({ charts: two(), fileFails: () => 'LATTICE_DECISIONS_UNAVAILABLE' })
  assert.deepEqual(await down.go(), { filed: 0, routed: 0 })
  assert.equal(down.calls.filter(([method]) => method === 'decisions.file').length, 1, 'a hung Approval Box costs one request per tick')
  const old = rig({ charts: two(), fileFails: () => 'LATTICE_INVALID' })
  await old.go()
  assert.equal(old.calls.length, 1, 'an old body ends the tick too')
  const refused = rig({ charts: two(), fileFails: params => params.session_label.endsWith('/t1') && 'LATTICE_DECISIONS_REFUSED' })
  assert.deepEqual(await refused.go(), { filed: 1, routed: 0 })
  assert.deepEqual(Object.keys(refused.stored()), ['alpha/p1/t2'])
  assert.deepEqual(refused.logs, ['lattice-owner-file alpha/p1/t1 LATTICE_DECISIONS_REFUSED'])
  const unread = rig({ charts: two(), readFails: 'LATTICE_DECISIONS_UNAVAILABLE',
    record: { 'alpha/p1/t9': { projectId: 'alpha', plan: 'p1', taskId: 't9', title: 'x', decisionId: 'K-AAAA09', status: 'open', filedAt: 't' } } })
  assert.deepEqual(await unread.go(), { filed: 0, routed: 0 })
  assert.deepEqual(unread.calls.map(([method]) => method), ['decisions.read'], 'no filing after an unavailable read')
})

test('owner filing: an Owner task retired or done on its chart cancels its still-open request; unseen cards and answers are left alone (Chime 2026-11-13)', async () => {
  const open = (taskId, id) => ({ projectId: 'alpha', plan: 'p1', taskId, title: `Task ${taskId}`, decisionId: id, status: 'open', filedAt: 'x' })
  const charts = [{ projectId: 'alpha', name: 'Alpha', createdBy: 'bot-c', cards: [card('t1', 'retired'), card('t2', 'done'), card('t3', 'ready'), card('t4', 'retired')] }]
  const record = { 'alpha/p1/t1': open('t1', 'K-AAAA01'), 'alpha/p1/t2': open('t2', 'K-AAAA02'), 'alpha/p1/t3': open('t3', 'K-AAAA03'),
    'alpha/p1/t4': open('t4', 'K-AAAA04'), 'alpha/p1/t9': open('t9', 'K-AAAA09') }
  const x = rig({ charts, record, decisions: { 'K-AAAA02': { status: 'held' }, 'K-AAAA04': { status: 'answered', answer: { optionId: 'done' } } } })
  assert.deepEqual(await x.go(), { filed: 0, routed: 1 })
  const cancels = x.calls.filter(([method]) => method === 'decisions.cancel').map(([, params]) => params)
  assert.deepEqual(cancels.map(params => params.decisionId), ['K-AAAA01', 'K-AAAA02'])
  assert.ok(cancels[0].reason.includes('取り下げられた') && cancels[1].reason.includes('済になった'))
  for (const params of cancels) validateLatticeEffect('decisions.cancel', params)
  validateLatticeEffectResult('decisions.cancel', { status: 'cancelled' })
  assert.deepEqual(Object.fromEntries(Object.entries(x.stored()).map(([key, item]) => [key, item.status])),
    { 'alpha/p1/t1': 'closed', 'alpha/p1/t2': 'closed', 'alpha/p1/t3': 'open', 'alpha/p1/t4': 'routed', 'alpha/p1/t9': 'open' }, 'ready stays, an answer still routes, an unseen card is not an end')

  // A refused cancel (or an older body) skips that record only; unavailable ends the tick.
  const refused = rig({ charts, record: { 'alpha/p1/t1': open('t1', 'K-AAAA01'), 'alpha/p1/t2': open('t2', 'K-AAAA02') }, cancelFails: 'LATTICE_EFFECT_FAILED' })
  await refused.go()
  assert.deepEqual(refused.calls.filter(([method]) => method === 'decisions.cancel').length, 2)
  assert.deepEqual([refused.stored()['alpha/p1/t1'].status, refused.stored()['alpha/p1/t2'].status], ['open', 'open'], 'filing goes on after a refused cancel')
  const down = rig({ charts, record: { 'alpha/p1/t1': open('t1', 'K-AAAA01'), 'alpha/p1/t2': open('t2', 'K-AAAA02') }, cancelFails: 'LATTICE_DECISIONS_UNAVAILABLE' })
  await down.go()
  assert.deepEqual(down.calls.map(([method]) => method), ['decisions.read', 'decisions.cancel'])
})
