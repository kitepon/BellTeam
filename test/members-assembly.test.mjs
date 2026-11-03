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
      async configureMembersHarnesses(read, aiterm, callBridge) { cli++; assert.equal(callBridge, currentBridge); assert.deepEqual(await read(), ['bot-test']) },
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
  assert.equal(await hooks.onEffect('memory.ensureScope', { botId: 'bot-test' }, context), null)
  await assert.rejects(hooks.onEffect('arbitrary.exec', {}, context))
  assert.equal(projects, 1); assert.equal(cli, 1)
  hooks.onState({ available: false }); assert.equal(assembly.projection.snapshot().stale, true)
  gate.finish(lease)
  await assert.rejects(hooks.onEffect('project.claim', { botId: 'bot-test' }, context), { status: 503 })
})
