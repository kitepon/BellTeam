import { avatarVersion } from '../avatar-value.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { BotRegistry, remoteBindingRevision } from '../bot-registry.mjs'
import { OwnerProfile } from '../owner-profile.mjs'
import { UserRules } from '../user-rules.mjs'
import { renderBotInstructions, renderGlobalInstructions, renderRemoteAccessNote } from './instructions.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from './state-compatibility.mjs'
import { normalizeMembersError } from './errors.mjs'
import { validateMembersRequest, validateMembersCallback, validateMembersControl, validateMembersContext,
  validateMembersResult, validateMembersEffect, validateMembersEffectResult, validateMembersProjection } from './protocol.mjs'

const failure = code => Object.assign(new Error(code), { code, outcome: 'not_accepted', status: 503 })
const withoutImages = profile => {
  const { avatar, avatarLarge, avatarSource, avatarLargeSource, ...rest } = profile
  return { ...rest, hasAvatar: Boolean(avatar), hasAvatarLarge: Boolean(avatarLarge),
    avatarVersion: avatarVersion(avatar), avatarLargeVersion: avatarVersion(avatarLarge || avatar),
    avatarSourceVersion: avatarVersion(avatarSource), avatarLargeSourceVersion: avatarVersion(avatarLargeSource) }
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
  // S5 effects are newer than some bodies (remote-seat.md): after our own params check passes, a parent that rejects the
  // method (MEMBERS_INPUT_INVALID) or has no handler (MEMBERS_EFFECT_UNSUPPORTED) offers no terminals, so answer `absent`.
  const offered = async (method, params, absent) => {
    validateMembersEffect(method, params, contexts.getStore())
    try { return await call(method, params) } catch (error) {
      if (['MEMBERS_INPUT_INVALID', 'MEMBERS_EFFECT_UNSUPPORTED'].includes(error?.code)) return absent
      throw error
    }
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
    currentTurn: botId => call('schedules.currentTurn', { botId }),
    models: { forHarness: harness => call('models.read', { harness }) },
    terminals: { read: terminalId => offered('terminals.read', { terminalId }, undefined), folder: request => offered('terminals.folder', request, null) },
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
  function refreshGlobalInstructions(operation = writeGlobal) {
    const task = globalWriting.catch(() => {}).then(operation)
    globalWriting = task
    return task
  }
  // A new generation may carry a new common template; parent's ready probe (owner.read) is its first leased request.
  // Each owner.read queues its own attempt in its own context: a read-pinned attempt the parent refuses must not satisfy the leased probe.
  let generationRendered = false, renderReported = false
  const renderForGeneration = () => refreshGlobalInstructions(async () => {
    if (generationRendered) return
    await writeGlobal()
    generationRendered = true
  }).catch(async error => {
    const code = error?.code
    if (renderReported || code === 'MEMBERS_EFFECT_UNSUPPORTED') return
    renderReported = true
    try { await diagnostic({ code: 'MEMBERS_GLOBAL_INSTRUCTIONS_FAILED', module: 'members', diagnostic_log: /^[A-Z_0-9]{1,100}$/.test(code ?? '') ? code : 'UNKNOWN' }) } catch { /* Keep members available. */ }
  })
  async function globalBody() {
    const common = await readFile(new URL('../../config/common-agents.md', import.meta.url), 'utf8')
    return renderGlobalInstructions(await ownerProfile.restore(), await userRules.restore(), common)
  }
  async function writeGlobal() { await call('global.writeInstructions', { body: await globalBody() }) }
  // Remote seat C1/C6: the in-memory equivalent of home AGENTS.md + project AGENTS.md; writes nothing.
  async function launchContext({ botId, shortTermMemory }) {
    const profile = await currentBot(botId)
    if (!profile.terminalId) throw Object.assign(new Error('BOT_REMOTE_BINDING_MISSING'), { code: 'BOT_REMOTE_BINDING_MISSING', status: 409 })
    const member = await call('project.composeInstructions', { botId, body: renderBotInstructions(profile, shortTermMemory.trim()) })
    return { text: `${await globalBody()}\n\n${member}\n${renderRemoteAccessNote(profile)}`, revision: remoteBindingRevision(profile) }
  }
  async function currentBot(botId) {
    await bots.refresh()
    const bot = bots.get(botId)
    if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
    return bot
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
      return current
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
    if (!accepting && !context.continuation) throw failure('MEMBERS_UNAVAILABLE')
  }
  const validateCallback = (method, params, context) => {
    validateMembersCallback(method, params, context)
    assertContext(context)
    // Parent channel validates that this is an existing live lease, including during drain.
  }
  async function execute(method, params) {
    switch (method) {
      case 'profiles.cli': await bots.refresh(); return { botIds: [...bots.keys()] }
      case 'profiles.read': return { revision: await snapshot(contexts.getStore()) }
      case 'profile.read': {
        await bots.refresh()
        const bot = bots.get(params.botId) ?? (params.includeDeleting ? (await bots.listForClient()).find(bot => bot.id === params.botId) : undefined)
        if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
        return { bot }
      }
      case 'profile.preview': return { bot: await bots.previewUpdate(params.botId, params.changes) }
      case 'profile.remove': return bots.remove(params.botId)
      case 'profile.update': { const saved = {}; const bot = await bots.update(params.botId, params.changes, saved); return { bot, ...saved } }
      case 'profile.create': {
        const saved = {}
        const bot = await bots.create(params.input, params.id === undefined ? { saved } : { id: params.id, saved })
        return { bot, ...saved }
      }
      case 'profile.launchContext': return { launchContext: await launchContext(params) }
      case 'docs.list': await currentBot(params.botId); return { files: await call('project.docs.list', { botId: params.botId }) }
      case 'docs.read': await currentBot(params.botId); return call('project.docs.read', params)
      case 'docs.write': await currentBot(params.botId); return call('project.docs.write', params)
      case 'profile.startup': await bots.prepareStartupContext(params.botId, params.shortTermMemory); return { prepared: true }
      case 'profile.session': return { bot: await bots.updateSession(params.botId, params.session) }
      case 'profile.fastMode': return { bot: await bots.updateFastMode(params.botId, params.fastMode) }
      case 'removals.read': return bots.readRemovalStates()
      case 'owner.read': await renderForGeneration(); return { owner: await ownerProfile.restore() }
      case 'owner.update': {
        const owner = await saveOwner(() => ownerProfile.update(params.changes))
        await refreshGlobalInstructions()
        return { owner }
      }
      case 'rules.read': return { text: await userRules.restore() }
      case 'rules.update': {
        const { text } = await saveOwner(() => userRules.change(params.text, { actor: { kind: 'owner' } }))
        await refreshGlobalInstructions()
        return { text }
      }
      // The Owner's approval is checked by the parent profiles-mcp before this request; before pins the approved diff (instructions.md).
      case 'rules.botUpdate': {
        const { text, before } = await saveOwner(() => userRules.change(params.text, { actor: { kind: 'bot', botId: params.botId }, instruction: params.instruction, expectedBefore: params.before }))
        await refreshGlobalInstructions()
        return { text, before }
      }
      case 'rules.history': return { changes: await userRules.history() }
      case 'schedules.claimAfterTurn': return bots.claimAfterTurn(params)
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
      const changesProjection = !['profiles.cli', 'profiles.read', 'profile.read', 'profile.preview', 'removals.read', 'owner.read', 'rules.read', 'rules.history', 'schedules.list', 'profile.launchContext', 'docs.list', 'docs.read', 'docs.write'].includes(method)
      try {
        const result = await execute(method, params)
        validateMembersResult(method, result)
        if (changesProjection) await snapshot(context)
        return result
      } catch (error) {
        if (changesProjection) { try { await snapshot(context) } catch { /* Preserve the original partial failure. */ } }
        throw normalizeMembersError(error)
      }
    }))
  }
  const drain = async () => { do { await Promise.allSettled([...active]); await projecting.catch(() => {}) } while (active.size) }
  const control = async (method, params, context) => {
    validateMembersControl(method, params)
    if (method === 'initialize') {
      validateMembersContext(context, { initialize: true })
      if (initializationStarted || exiting || context.leaseId !== null || context.continuation || context.generation !== params.generation) throw failure('MEMBERS_CONTROL_INVALID')
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
    validateCallback, dispatchCallback: (method, params, context) => run(true, method, params, context),
    control: async (...args) => { try { return await control(...args) } catch (error) { throw normalizeMembersError(error) } }, disconnect }
}
