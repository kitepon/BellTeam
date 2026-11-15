import assert from 'node:assert/strict'
import test from 'node:test'
import { createMembersAssembly } from '../src/members-assembly.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersOwnerAuthorization } from '../src/members-owner-authorization.mjs'

test('assembly uses one gate/controller and dispatches only fixed effects with original capabilities', async () => {
  const gate = new MembersAdmission(), authority = createMembersOwnerAuthorization()
  let hooks, currentBridge = { token: 'private-a' }, callbackContext, projects = 0, cli = 0
  const assembly = createMembersAssembly({ root: '/synthetic', membersAdmission: gate, membersAuthorization: authority,
    diagnostics: { record() {} }, aiterm: {}, settings: { configuration: () => currentBridge }, models: { forHarness: async () => ({ efforts: [], models: [] }) },
    dependencies: () => ({ memory: { async ensureScope() { return { private: true } } } }),
    seatRuntime: {
      async membersProject(method, params) { projects++; assert.equal(method, 'project.claim'); assert.deepEqual(params, { botId: 'bot-test' }); return null },
      async configureMembersHarnesses(read, aiterm, callBridge) { cli++; assert.equal(callBridge(), currentBridge); assert.deepEqual(await read(), ['bot-test']) },
    }, createProcess(options) {
      hooks = options; assert.equal(options.membersAdmission, gate)
      return { async start() {
        const ticket = gate.close(); gate.adopt(ticket, 'current'); options.onGeneration('current')
        const context = { generation: 'current', leaseId: null, rootId: 'initialize', ownerWrite: false, continuation: false }
        for (const record of [{ type: 'snapshot-start', revision: 0 }, { type: 'profile', revision: 0, bot: { id: 'bot-test', name: 'test', harness: 'codex', session: '' } }, { type: 'snapshot-end', revision: 0 }]) await options.onProjection(record, context)
        gate.resume(ticket)
      }, async callback(method, params, context) { callbackContext = context; assert.equal(method, 'profiles.cli'); return { botIds: ['bot-test'] } } }
    } })
  await assembly.controller.start()
  assert.equal(assembly.bots.size, 1); assert.equal(assembly.bots.projectPath('bot-test'), '/synthetic/bots/bot-test')
  assert.throws(() => assembly.bots.projectPath('../other'))
  const lease = gate.enter(), effect = Object.freeze({})
  const context = { generation: 'current', leaseId: lease.leaseId, rootId: 'root', ownerWrite: false, continuation: false, membersLease: lease, membersEffect: effect }
  await hooks.onEffect('project.claim', { botId: 'bot-test' }, context)
  currentBridge = { token: 'private-b' }
  await hooks.onEffect('cli.configure', { botIds: ['stale'] }, context)
  assert.equal(callbackContext.membersLease, lease); assert.equal(callbackContext.membersEffect, effect)
  await assert.rejects(hooks.onEffect('memory.ensureScope', { botId: 'bot-test' }, context), { code: 'MEMBERS_INPUT_INVALID' })
  await assert.rejects(hooks.onEffect('arbitrary.exec', {}, context))
  assert.equal(projects, 1); assert.equal(cli, 1)
  hooks.onState({ available: false }); assert.equal(assembly.projection.snapshot().stale, true)
  gate.finish(lease)
  await assert.rejects(hooks.onEffect('project.claim', { botId: 'bot-test' }, context), { status: 503 })
})

// a153 (BugHub ef83d4ee 11/15 06:15Z): GET /api/rooms got 503 MEMBERS_PROJECTION_INVALID when the exchange's quiesce began while the old
// child was still sending a snapshot: state(quiescing) cleared the pending snapshot and the next record was refused.
test('a153: a planned quiesce keeps the snapshot the old child is still sending; a real loss still clears it', async () => {
  const gate = new MembersAdmission()
  let hooks, ticket
  const assembly = createMembersAssembly({ root: '/synthetic', membersAdmission: gate, membersAuthorization: createMembersOwnerAuthorization(),
    diagnostics: { record() {} }, aiterm: {}, settings: { configuration: () => ({}) }, models: { forHarness: async () => ({ efforts: [], models: [] }) },
    dependencies: () => ({}), createProcess(options) { hooks = options; return { async start() { ticket = gate.close(); gate.adopt(ticket, 'g'); options.onGeneration('g'); gate.resume(ticket) } } } })
  await assembly.controller.start()
  const context = { generation: 'g', leaseId: null, rootId: 'initialize', ownerWrite: false, continuation: false }
  const bot = { id: 'bot-test', name: 'test', harness: 'codex', session: '' }
  await hooks.onProjection({ type: 'snapshot-start', revision: 1 }, context)
  await hooks.onProjection({ type: 'profile', revision: 1, bot }, context)
  hooks.onState({ available: false, phase: 'quiescing' })
  await hooks.onProjection({ type: 'snapshot-end', revision: 1 }, context) // before: MEMBERS_PROJECTION_INVALID
  assert.equal(assembly.projection.snapshot().available, true)
  hooks.onState({ available: false, phase: 'unavailable' })
  assert.equal(assembly.projection.snapshot().available, false)
})

// a164 (lattice README L21): the parent adds the Lattice 接続 right after a save that carries `connect`; members never calls Lattice.
test('a164: set_schedule with connect adds the 接続 for a new schedule or a changed connect only; a failed add removes a created schedule', async () => {
  const calls = []
  let added = { ok: true }, scheduler = null
  const row = (id, connect) => ({ id, name: 'ci', kind: 'cron', expression: '* * * * *', command: 'x', lastRunAt: null, nextRunAt: null, revision: 1, connect })
  const connect = { project: 'bellteam', plan: 'plan-a', task: 'task-b' }
  const assembly = createMembersAssembly({ root: '/synthetic', membersAdmission: new MembersAdmission(), membersAuthorization: createMembersOwnerAuthorization(),
    diagnostics: { record() {} }, aiterm: {}, settings: { configuration: () => ({}) }, models: { forHarness: async () => ({ efforts: [], models: [] }) },
    dependencies: () => ({ scheduler }),
    createProcess: () => ({ async request(method, params) {
      calls.push(method)
      if (method === 'schedules.list') return { schedules: [row('sch-old', connect)] }
      if (method === 'schedules.set') return { schedule: row(params.input.id ?? 'sch-new', params.input.connect ?? connect) }
      return { removed: params.scheduleId }
    } }) })
  const lattice = []
  // Startup window: no scheduler yet -> refused before the save.
  await assert.rejects(assembly.bots.setSchedule('bot-test', { kind: 'cron', command: 'x', connect }), { code: 'SCHEDULE_CONNECT_FAILED' })
  assert.deepEqual(calls, [])
  scheduler = { runLattice: async (from, project, args) => { lattice.push([from, project, args]); return added } }
  const saved = await assembly.bots.setSchedule('bot-test', { kind: 'cron', command: 'x', connect })
  assert.equal(saved.id, 'sch-new')
  assert.deepEqual(lattice.at(-1), ['bot-test', 'bellteam', ['todo', 'connect', 'condition', 'add', '--plan', 'plan-a', '--task', 'task-b', '--to', 'schedule:sch-new', '--reason', 'ci']])
  lattice.length = 0; calls.length = 0
  await assembly.bots.setSchedule('bot-test', { id: 'sch-old', enabled: false }) // the scheduler's own disable: no connect in the input
  await assembly.bots.setSchedule('bot-test', { id: 'sch-old', kind: 'cron', command: 'x', connect }) // an editor echoing the same connect back: Lattice would reopen a settled 接続
  assert.deepEqual(lattice, [])
  calls.length = 0; added = { ok: false, reason: 'CONNECTION_INVALID' }
  await assert.rejects(assembly.bots.setSchedule('bot-test', { kind: 'cron', command: 'x', connect }), { code: 'SCHEDULE_CONNECT_FAILED' })
  assert.deepEqual(calls, ['schedules.set', 'schedules.remove'])
  calls.length = 0; lattice.length = 0
  await assert.rejects(assembly.bots.setSchedule('bot-test', { id: 'sch-old', kind: 'cron', command: 'x', connect: { ...connect, task: 'other' } }), { code: 'SCHEDULE_CONNECT_FAILED' })
  assert.equal(lattice.length, 1) // a changed connect on an update adds; its failure keeps the stored schedule
  assert.deepEqual(calls, ['schedules.list', 'schedules.set'])
})

test('a164: the effect schedules.connectionRemoved calls the parent scheduler once and answers nothing', async () => {
  const gate = new MembersAdmission(), released = []
  let hooks
  const assembly = createMembersAssembly({ root: '/synthetic', membersAdmission: gate, membersAuthorization: createMembersOwnerAuthorization(),
    diagnostics: { record() {} }, aiterm: {}, settings: { configuration: () => ({}) }, models: { forHarness: async () => ({ efforts: [], models: [] }) },
    dependencies: () => ({ scheduler: { releaseConnection: async (botId, schedule) => { released.push([botId, schedule.id]) } } }),
    createProcess(options) { hooks = options; return { async start() { const ticket = gate.close(); gate.adopt(ticket, 'current'); options.onGeneration('current'); gate.resume(ticket) } } } })
  await assembly.controller.start()
  const lease = gate.enter()
  const context = { generation: 'current', leaseId: lease.leaseId, rootId: 'root', ownerWrite: false, continuation: false, membersLease: lease, membersEffect: Object.freeze({}) }
  const schedule = { id: 'sch-1', name: 'ci', command: 'x', connect: { project: 'bellteam', plan: 'plan-a', task: 'task-b' } }
  assert.equal(await hooks.onEffect('schedules.connectionRemoved', { botId: 'bot-test', schedule }, context), undefined)
  assert.deepEqual(released, [['bot-test', 'sch-1']])
  await assert.rejects(hooks.onEffect('schedules.connectionRemoved', { botId: 'bot-test', schedule: { ...schedule, connect: { project: 'x' } } }, context), { code: 'MEMBERS_INPUT_INVALID' })
  gate.finish(lease)
})
