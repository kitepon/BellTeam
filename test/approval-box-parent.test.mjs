import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalBoxExtensionEffects, APPROVAL_BOX_SESSION_SCOPE } from '../src/approval-box-parent-effects.mjs'
import { createApprovalsFacade } from '../src/approval-box-parent-facade.mjs'
import { createApprovalBoxExtensionProcess } from '../src/approval-box-parent-process.mjs'
import { validateApprovalsEffectResult } from '../src/approval-box-extension-protocol.mjs'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('effects: refusal is told apart, session uses the fixed scope, put/erase absent means unavailable', async () => {
  const seen = []
  const credentials = { current: async scope => (seen.push(scope), { available: true, handle: 'h' }),
    withResolved: async (handle, scope, consume) => (seen.push(scope), consume('{"token":"t"}')), put: async (scope, value) => seen.push([scope, value]), erase: async scope => seen.push(scope) }
  const lattice = { ownerTask: async () => { throw Object.assign(new Error('x'), { code: 'LATTICE_OWNER_TASK_REFUSED' }) }, link: async () => ({}), chart: async () => ({ cards: [], edges: [] }), charts: async () => [] }
  const effects = createApprovalBoxExtensionEffects({ lattice, bots: { listForClient: async () => [{ id: 'b', name: 'B', color: 'x' }] }, credentials })
  await assert.rejects(effects('lattice.ownerTask', { projectId: 'p', args: [] }), { code: 'APPROVALS_EFFECT_REFUSED' })
  assert.deepEqual(await effects('members.list', {}), [{ id: 'b', name: 'B' }])
  assert.deepEqual(await effects('session.get', {}), { value: '{"token":"t"}' })
  assert.deepEqual(seen[0], APPROVAL_BOX_SESSION_SCOPE)
  assert.deepEqual(await effects('session.put', { value: 'v' }), { ok: true })
  assert.deepEqual(await effects('session.erase', {}), { ok: true })
  for (const [method, value] of [['session.get', { value: 'v' }], ['session.put', { ok: true }], ['members.list', [{ id: 'b', name: 'B' }]]]) validateApprovalsEffectResult(method, value)
  const bare = createApprovalBoxExtensionEffects({ lattice, bots: {}, credentials: { current: async () => null } })
  assert.equal(await bare('session.get', {}), null)
  await assert.rejects(bare('session.put', { value: 'v' }), { code: 'APPROVAL_BOX_EXTENSION_SESSION_UNAVAILABLE' })
  await assert.rejects(bare('nope', {}), { code: 'APPROVAL_BOX_EXTENSION_EFFECT_INVALID' })
})

test('effects: the real facade shapes of lattice.chart / lattice.charts are narrowed to what the child protocol accepts', async () => {
  const card = { id: 'p/t', plan: 'p', taskId: 't', state: 'pending', lane: 'approval-box', title: 'x', producer: 'owner', designMemo: '', startedAt: null }
  const lattice = { chart: async () => ({ schema: 'bellteam.lattice-chart.v1', epoch: 1, projectId: 'bellteam', name: 'n', cards: [card], edges: [{ from: 'p/a', to: 'p/t', waiting: true }], members: [], waits: [], phases: [], externals: [] }),
    charts: async () => ({ schema: 'bellteam.lattice-charts.v1', at: 'now', charts: [{ projectId: 'bellteam', name: 'n', coordinator: true, createdBy: undefined, counts: {}, activeMembers: [], updatedAt: 'now', state: 'active' }] }) }
  const effects = createApprovalBoxExtensionEffects({ lattice, bots: {}, credentials: { current: async () => null } })
  validateApprovalsEffectResult('lattice.chart', await effects('lattice.chart', { projectId: 'bellteam' }))
  const charts = await effects('lattice.charts', {})
  validateApprovalsEffectResult('lattice.charts', charts)
  assert.deepEqual(charts, [{ projectId: 'bellteam', name: 'n', createdBy: null, coordinator: true }])
})

test('facade: loop fans events out, keeps child codes, hides other failures', async () => {
  const timers = []
  const calls = []
  const controller = { request: async (method, params) => {
    calls.push([method, params])
    if (method === 'refresh') return { seq: 3, events: [{ type: 'decision.created', id: 'K-ABCD', version: 1 }], summary: { pending: 1 } }
    if (method === 'get') throw Object.assign(new Error('x'), { code: 'APPROVALS_NOT_FOUND' })
    throw new Error('boom')
  } }
  const facade = createApprovalsFacade({ controller, setTimer: fn => (timers.push(fn), { unref() {} }), clearTimer() {} })
  const got = []
  facade.subscribe(message => got.push(message))
  await timers.at(-1)()
  assert.deepEqual(calls[0], ['refresh', { since: 0 }])
  assert.deepEqual(got.map(item => item.event), ['decision.created', 'summary'])
  await assert.rejects(facade.get({ id: 'K-ABCD' }), { code: 'APPROVALS_NOT_FOUND', status: 404 })
  await assert.rejects(facade.list({ status: ['pending'] }), { code: 'APPROVALS_UNAVAILABLE', status: 503 })
  await timers.at(-1)()
  assert.deepEqual(calls.findLast(call => call[0] === 'refresh')[1], { since: 3 })
  facade.close()
})

test('process: builds for the new component', () => {
  assert.equal(typeof createApprovalBoxExtensionProcess({ root: '/tmp/x', onEffect: async () => null, spawnProcess() {} }).start, 'function')
})

// The session effects over the real usageAssembly.credentials, with the real usage services behind the process port (R7, a199b).
async function realSession(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-abx-session-'))
  const bots = new Map(), rooms = new Map(); rooms.refresh = async () => {}
  const onePassword = { available: false, async refresh() {}, close() {}, watch: () => () => {}, setToken() {}, async resolve() { throw new Error('unused') }, async listSshKeys() { return [] }, async listPasswords() { return [] } }
  const services = createUsageServices({ root, bots, rooms, onePassword, effect: async () => {}, onProjection() {} })
  await services.initializeSettings(); await services.initialize()
  let assembly
  assembly = createUsageAssembly({ root, getServices: () => ({ bots }), onEffect() {}, createProcess: value => ({
    request(method, params, context) { const result = services.request(method, params, value.authorizeActor(method, context.capturedAuthorization)); Object.defineProperty(result, 'completion', { value: result }); return result }, close() {} }) })
  t.after(async () => { assembly.close(); await services.quiesce(); services.close(); await rm(root, { recursive: true, force: true }) })
  const effects = createApprovalBoxExtensionEffects({ lattice: {}, bots: {}, credentials: assembly.credentials })
  return { root, effects, credentials: assembly.credentials }
}

test('effects over the real usage credentials: put then get returns the value, erase then get returns null', async t => {
  const { effects } = await realSession(t)
  assert.equal(await effects('session.get', {}), null)
  const value = JSON.stringify({ token: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z' })
  assert.deepEqual(await effects('session.put', { value }), { ok: true })
  assert.deepEqual(await effects('session.get', {}), { value })
  assert.deepEqual(await effects('session.erase', {}), { ok: true })
  assert.equal(await effects('session.get', {}), null)
})

test('effects over the real usage credentials: a lost value file erases the stale handle and reads as not connected', async t => {
  const { root, effects, credentials } = await realSession(t)
  await effects('session.put', { value: 'v1' })
  const dir = join(root, 'state/secret-module-values')
  const { readdir, rm: remove } = await import('node:fs/promises')
  for (const name of await readdir(dir)) await remove(join(dir, name))
  assert.equal(await effects('session.get', {}), null)
  assert.equal(await credentials.current(APPROVAL_BOX_SESSION_SCOPE), null)
})

test('effects: the hosted daemon is read through fixed, narrowed methods; not running or not paired reads as nothing, never an error', async () => {
  const lattice = {}
  const record = { decision_id: 'K-AAAA', title: 't', status: 'answered', version: 2, urgency: 'normal', context: 'SECRET CONTEXT', options: [{ id: 'o1', label: 'L', extra: 1 }], session_label: 's', requester: 'r', answer: { option_id: 'o1', answered_at: 'a' },
    request_attachments: [{ id: 'x' }], created_at: 'c', updated_at: 'u' }
  const route = async (method, path) => path === '/decisions' ? { items: [{ decision_id: 'K-AAAA' }, { decision_id: 'bad' }] } : path === '/decisions/K-AAAA' ? record : Promise.reject(Object.assign(new Error('x'), { status: 404, code: 'not_found' }))
  const effects = createApprovalBoxExtensionEffects({ lattice, bots: {}, daemon: { route } })
  assert.deepEqual(await effects('daemon.decisions.list', {}), [{ id: 'K-AAAA' }])
  const read = await effects('daemon.decisions.read', { id: 'K-AAAA' })
  validateApprovalsEffectResult('daemon.decisions.read', read)
  assert.equal(read.context, 'SECRET CONTEXT') // the view needs the body text (a490k); attachments and history still do not cross
  assert.ok(!JSON.stringify(read).includes('"x"'), 'no attachments cross')
  assert.ok(!JSON.stringify(await effects('daemon.decisions.list', {})).includes('SECRET'), 'the list carries ids only')
  assert.deepEqual(read.answer, { optionId: 'o1', text: null, answeredAt: 'a' })
  assert.equal(await effects('daemon.decisions.read', { id: 'K-ZZZZ' }), null)
  const down = createApprovalBoxExtensionEffects({ lattice, bots: {}, daemon: { route: async () => { throw Object.assign(new Error('x'), { status: 503, code: 'not_paired' }) } } })
  assert.deepEqual(await down('daemon.decisions.list', {}), [])
  assert.equal(await down('daemon.decisions.read', { id: 'K-AAAA' }), null)
  const none = createApprovalBoxExtensionEffects({ lattice, bots: {} })
  assert.deepEqual(await none('daemon.decisions.list', {}), [])
})

test('effects: seat.message goes through the messenger as the scheduler; a gone Bot is a permanent refusal, anything else fails the call; no messenger is unavailable', async () => {
  const seen = []
  const messenger = { sendmessage: async input => { seen.push(input); if (input.target === 'bot-gone') throw new Error('BOT_NOT_FOUND: bot-gone'); if (input.target === 'bot-down') throw new Error('transport down'); return { delivery: 'steered', delivery_id: 'd-9' } } }
  const actors = []
  const effects = createApprovalBoxExtensionEffects({ lattice: {}, bots: {}, messenger, runAs: (actor, send) => { actors.push(actor); return send() } })
  const ok = await effects('seat.message', { target: 'bot-a', message: 'hi' })
  assert.deepEqual(ok, { delivery: 'steered', deliveryId: 'd-9' }); validateApprovalsEffectResult('seat.message', ok)
  assert.deepEqual(seen[0], { from: 'scheduler', target: 'bot-a', message: 'hi' }); assert.deepEqual(actors[0], { kind: 'scheduler' })
  assert.deepEqual(await effects('seat.message', { target: 'bot-gone', message: 'hi' }), { delivery: 'refused', deliveryId: null, code: 'BOT_NOT_FOUND' })
  await assert.rejects(() => effects('seat.message', { target: 'bot-down', message: 'hi' }), { message: 'transport down' })
  await assert.rejects(() => createApprovalBoxExtensionEffects({ lattice: {}, bots: {} })('seat.message', { target: 'bot-a', message: 'hi' }), { code: 'APPROVAL_BOX_EXTENSION_SESSION_UNAVAILABLE' })
})
