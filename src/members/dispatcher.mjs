import { AsyncLocalStorage } from 'node:async_hooks'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { BotRegistry } from '../bot-registry.mjs'
import { OwnerProfile } from '../owner-profile.mjs'
import { UserRules } from '../user-rules.mjs'
import { renderBotInstructions, renderGlobalInstructions } from './instructions.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from './state-compatibility.mjs'
import { validateMembersRequest, validateMembersCallback, validateMembersControl, validateMembersContext,
  validateMembersResult, validateMembersEffect, validateMembersEffectResult, validateMembersProjection } from './protocol.mjs'

const failure = code => Object.assign(new Error(code), { code, outcome: 'not_accepted', status: 503 })
const withoutImages = profile => {
  const { avatar, avatarLarge, avatarSource, avatarLargeSource, ...rest } = profile
  return { ...rest, hasAvatar: Boolean(avatar), hasAvatarLarge: Boolean(avatarLarge) }
}

export function createMembersDispatcher({ root, effect, projection, diagnostic = async () => {} }) {
  const contexts = new AsyncLocalStorage()
  let generation, initialized = false, initializationStarted = false, accepting = false, quiesced = false, exiting = false, epoch = 0, revision = 0
  const active = new Set()
  let projecting = Promise.resolve()
  const call = async (method, params) => {
    const context = contexts.getStore()
    validateMembersEffect(method, params, context)
    const value = await effect(method, params, context)
    validateMembersEffectResult(method, value)
    return value
  }
  const projectFiles = {
    ensureRoot: () => call('project.ensureRoot', {}),
    claim: project => call('project.claim', { botId: projectId(project) }),
    initialize: project => call('project.initialize', { botId: projectId(project) }),
    remove: project => call('project.remove', { botId: projectId(project) }),
    async writeInstructions(profile) {
      const previous = await call('project.readPreviousSession', { botId: profile.id })
      await call('project.writeInstructions', { botId: profile.id, body: renderBotInstructions(profile, previous.trim()) })
    },
    prepareStartupContext: (profile, memory) => call('project.prepareStartupContext', { botId: profile.id,
      previousSession: `${memory.trim()}\n`, body: renderBotInstructions(profile, memory.trim()) }),
    appendInstructions: (profile, text) => call('project.appendInstructions', { botId: profile.id, text }),
  }
  function projectId(project) {
    const id = project.slice(project.lastIndexOf('/') + 1)
    if (project !== join(root, 'bots', id)) throw failure('MEMBERS_PROJECT_INVALID')
    return id
  }
  const bots = new BotRegistry({ seedPath: join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'config/bots.json'),
    botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots'), projectFiles,
    models: { forHarness: harness => call('models.read', { harness }) },
    onChange: registry => call('cli.configure', { botIds: [...registry.keys()] }),
    assetRemoval: {
      prepareBotAssetRemoval: botId => call('assets.prepareBotAssetRemoval', { botId }),
      cancelBotAssetRemoval: (botId, lease, state) => call('assets.cancelBotAssetRemoval', { botId, lease, state }),
    },
  })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  let ownerSaving = Promise.resolve(), globalWriting = Promise.resolve()
  const saveOwner = operation => {
    const task = ownerSaving.then(operation)
    ownerSaving = task.catch(() => {})
    return task
  }
  function refreshGlobalInstructions() {
    const task = globalWriting.catch(() => {}).then(writeGlobal)
    globalWriting = task
    return task
  }
  async function writeGlobal() {
    const common = await readFile(new URL('../../config/common-agents.md', import.meta.url), 'utf8')
    await call('global.writeInstructions', { body: renderGlobalInstructions(await ownerProfile.restore(), await userRules.restore(), common) })
  }
  const track = operation => {
    const task = Promise.resolve().then(operation)
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const snapshot = context => {
    const next = projecting.catch(() => {}).then(async () => {
      await bots.refresh()
      const current = ++revision
      const send = async record => { validateMembersProjection(record, context); await projection(record, context) }
      await send({ type: 'snapshot-start', revision: current })
      for (const profile of await bots.listForClient()) await send({ type: 'profile', revision: current, bot: withoutImages(profile) })
      await send({ type: 'snapshot-end', revision: current })
    })
    projecting = next
    return next
  }
  const assertContext = context => {
    validateMembersContext(context)
    if (!initialized || exiting || context.generation !== generation) throw failure('MEMBERS_UNAVAILABLE')
  }
  const validateRequest = (method, params, context) => {
    validateMembersRequest(method, params, context)
    assertContext(context)
    if (!accepting) throw failure('MEMBERS_UNAVAILABLE')
  }
  const validateCallback = (method, params, context) => {
    validateMembersCallback(method, params, context)
    assertContext(context)
    // Parent channel validates that this is an existing live lease, including during drain.
  }
  async function execute(method, params) {
    switch (method) {
      case 'profiles.cli': await bots.refresh(); return { botIds: [...bots.keys()] }
      case 'profiles.read': await bots.refresh(); return { profiles: (await bots.listForClient()).map(withoutImages) }
      case 'profile.read': {
        await bots.refresh()
        const bot = bots.get(params.botId)
        if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
        return { bot }
      }
      case 'profile.preview': return { bot: await bots.previewUpdate(params.botId, params.changes) }
      case 'profile.remove': return bots.remove(params.botId)
      case 'profile.update': return { bot: await bots.update(params.botId, params.changes) }
      case 'profile.create': {
        const bot = await bots.create(params.input)
        await call('memory.ensureScope', { botId: bot.id })
        return { bot }
      }
      case 'profile.startup': await bots.prepareStartupContext(params.botId, params.shortTermMemory); return { prepared: true }
      case 'profile.session': return { bot: await bots.updateSession(params.botId, params.session) }
      case 'profile.fastMode': return { bot: await bots.updateFastMode(params.botId, params.fastMode) }
      case 'removals.read': return bots.readRemovalStates()
      case 'owner.read': return { owner: await ownerProfile.restore() }
      case 'owner.update': {
        const owner = await saveOwner(() => ownerProfile.update(params.changes))
        await refreshGlobalInstructions()
        return { owner }
      }
      case 'rules.read': return { text: await userRules.restore() }
      case 'rules.update': {
        const text = await saveOwner(() => userRules.update(params.text))
        await refreshGlobalInstructions()
        return { text }
      }
      case 'schedules.list': return { schedules: params.ownerKind === 'bot' ? await bots.listSchedules(params.ownerId)
        : await call('room.schedules.list', { roomId: params.ownerId }) }
      case 'schedules.set': return { schedule: params.ownerKind === 'bot' ? await bots.setSchedule(params.ownerId, params.input)
        : await call('room.schedules.set', { roomId: params.ownerId, input: params.input }) }
      case 'schedules.remove': {
        if (params.ownerKind === 'bot') await bots.removeSchedule(params.ownerId, params.scheduleId)
        else await call('room.schedules.remove', { roomId: params.ownerId, scheduleId: params.scheduleId })
        return { removed: params.scheduleId }
      }
      case 'schedules.claimDue': case 'schedules.skipDue': {
        const { ownerKind, ownerId, ...input } = params
        if (ownerKind === 'room') return call(method === 'schedules.claimDue' ? 'room.schedules.claimDue' : 'room.schedules.skipDue', { roomId: ownerId, ...input })
        return method === 'schedules.claimDue' ? bots.claimDue({ botId: ownerId, ...input }) : bots.skipDue({ botId: ownerId, ...input })
      }
      default: throw failure('MEMBERS_INPUT_INVALID')
    }
  }
  const run = (callback, method, params, context) => {
    // Already accepted by the channel: a concurrent quiesce must not discard it.
    ;(callback ? validateMembersCallback : validateMembersRequest)(method, params, context)
    assertContext(context)
    return track(() => contexts.run(context, async () => {
      const result = await execute(method, params)
      validateMembersResult(method, result)
      if (!['profiles.cli', 'profiles.read', 'profile.read', 'profile.preview', 'removals.read', 'owner.read', 'rules.read', 'schedules.list'].includes(method)) await snapshot(context)
      return result
    }))
  }
  const drain = async () => { do { await Promise.allSettled([...active]); await projecting.catch(() => {}) } while (active.size) }
  const control = async (method, params, context) => {
    validateMembersControl(method, params)
    if (method === 'initialize') {
      validateMembersContext(context, { initialize: true })
      if (initializationStarted || exiting || context.leaseId !== null || context.generation !== params.generation) throw failure('MEMBERS_CONTROL_INVALID')
      initializationStarted = true
      generation = params.generation
      return track(async () => {
        await bots.restore(); await ownerProfile.restore(); await userRules.restore()
        await snapshot(context)
        initialized = true
        return { stateCompatibility: MEMBERS_STATE_COMPATIBILITY }
      })
    }
    if (!initialized || exiting) throw failure('MEMBERS_CONTROL_INVALID')
    if (method === 'resume') { epoch++; accepting = true; quiesced = false; return { resumed: true } }
    if (method === 'quiesce') {
      accepting = false
      const current = ++epoch
      await drain()
      if (current === epoch && !accepting) {
        await bots.restore(); await ownerProfile.restore(); await userRules.restore()
      }
      quiesced = current === epoch && !accepting
      return { quiesced }
    }
    if (!quiesced) throw failure('MEMBERS_NOT_QUIESCED')
    exiting = true
    return { closed: true }
  }
  const disconnect = async () => { accepting = false; exiting = true; epoch++; await drain() }
  return { validateRequest, dispatch: (method, params, context) => run(false, method, params, context),
    validateCallback, dispatchCallback: (method, params, context) => run(true, method, params, context), control, disconnect }
}
