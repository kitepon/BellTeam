import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { BellTeamMemory } from '../src/memory-service.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { createApplicationServices } from '../src/application-services.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

test('product services replace bootstrap writers, preserve the shared gate/assets, and close the child', async t => {
  const root = await mkdtemp(join(tmpdir(), 'members-product-'))
  let services
  t.after(async () => {
    try { if (services) { await services.transport.close(); await services.members.controller.close(); await services.notifications.close() } }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const seedPath = join(root, 'seed.json'); await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots') })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root }), settings = new FeatureSettings({ root, environment: {} })
  for (const value of [bots, ownerProfile, userRules, settings]) await value.initialize()
  let globalWrites = 0, closed = 0
  const originalRulesUpdate = userRules.update.bind(userRules)
  userRules.update = async () => { throw new Error('OLD_RULES_WRITER_USED') }
  ownerProfile.update = async () => { throw new Error('OLD_OWNER_WRITER_USED') }
  const seatRuntime = {
    memory: registry => new BellTeamMemory({ registry, root }), characterSheets: () => ({}), throughlineChanged: () => async () => false,
    async membersProject(method, params) { assert.equal(method, 'global.writeInstructions'); assert.ok(params.body.includes('new synthetic rule')); globalWrites++; return null },
  }
  let sequence = 0
  const createMembersProcess = options => {
    const leases = new Map(), generation = 'test-child'
    const dispatcher = createMembersDispatcher({ root, projection: options.onProjection,
      effect: (method, params, context) => options.onEffect(method, params, { ...context, ...leases.get(context.rootId) }),
    })
    const call = async (method, params, context, callback) => {
      const binding = context.membersReadPin ?? context.membersLease
      if (context.membersReadPin) options.membersAdmission.assertReadPin(binding, { method })
      else options.membersAdmission.assertLease(binding)
      const rootId = String(++sequence); leases.set(rootId, { membersLease: context.membersLease, membersReadPin: context.membersReadPin })
      const wire = { generation, rootId, leaseId: binding.leaseId,
        ownerWrite: options.authorizeOwner(method, context.capturedAuthorization), continuation: binding.epoch !== options.membersAdmission.capture().epoch }
      try { return await dispatcher[callback ? 'dispatchCallback' : 'dispatch'](method, params, wire) }
      finally { leases.delete(rootId) }
    }
    return {
      async start() {
        const ticket = options.membersAdmission.close(); options.membersAdmission.adopt(ticket, generation); options.onGeneration(generation)
        await dispatcher.control('initialize', { generation }, { generation, rootId: 'initialize', leaseId: null, ownerWrite: false, continuation: false })
        await dispatcher.control('resume', {}); options.membersAdmission.resume(ticket)
      },
      request: (method, params, context) => call(method, params, context, false), callback: (method, params, context) => call(method, params, context, true),
      async close() { const ticket = options.membersAdmission.close(); await options.membersAdmission.drain(ticket); await dispatcher.control('quiesce', {}); await dispatcher.control('exit', {}); closed++ },
    }
  }
  services = await createApplicationServices({ root, bots, ownerProfile, userRules, settings, seatRuntime,
    aiterm: { command: 'synthetic', args: [] }, client: { async close() {} },
    createMembersProcess, createNotificationsProcess: createSyntheticNotificationsProcess, refreshGlobalInstructions: async () => { throw new Error('OLD_GLOBAL_WRITER_USED') }, olrwManagement: null,
  })
  assert.notEqual(services.bots, bots); assert.notEqual(services.userRules, userRules)
  assert.equal(services.scheduler.membersAdmission, services.transport.membersAdmission)
  assert.equal(services.messenger.assets, services.assets)
  assert.equal((await services.bots.refresh()).length, 0)
  const request = { method: 'PUT' }, context = services.membersAuthorization.captureHttp(request, '/api/user-rules')
  assert.equal(await services.userRules.update('new synthetic rule', context), 'new synthetic rule\n')
  services.membersAuthorization.releaseHttp(request)
  await services.refreshGlobalInstructions(); assert.equal(globalWrites, 1)
  await assert.rejects(services.userRules.update('forged', { capturedAuthorization: {} }), { code: 'MEMBERS_INPUT_INVALID' })
  assert.equal(await new UserRules({ root }).get(), 'new synthetic rule\n')
  assert.equal(typeof originalRulesUpdate, 'function'); assert.equal(closed, 0)
})
