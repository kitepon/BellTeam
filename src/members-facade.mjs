import { validateMembersResult } from './members/protocol.mjs'
import { MEMBERS_READ_PIN_METHODS } from './members-admission.mjs'

// Request/callback are the same live controller's closed public channel methods.
export function createMembersFacade({ request, callback, admission, projection }) {
  const withContext = (method, context, operation) => context.membersReadPin || !context.membersLease && MEMBERS_READ_PIN_METHODS.includes(method)
    ? admission.withReadPin(method, membersReadPin => operation({ membersReadPin,
      capturedAuthorization: context.capturedAuthorization, membersEffect: context.membersEffect }), { pin: context.membersReadPin })
    : admission.withLease(membersLease => operation({ membersLease,
      capturedAuthorization: context.capturedAuthorization, membersEffect: context.membersEffect }), { lease: context.membersLease })
  const invoke = (method, params, context = {}) => withContext(method, context, async options => {
    const result = await request(method, params, options)
    validateMembersResult(method, result)
    return result
  })
  const invokeCallback = async (method, params, context) => {
    const membersLease = admission.assertLease(context?.membersLease)
    const result = await callback(method, params, { membersLease, membersEffect: context.membersEffect })
    validateMembersResult(method, result)
    return result
  }
  const readProfiles = async (context = {}) => withContext('profiles.read', context, async options => {
    const receipt = await invoke('profiles.read', {}, options)
    const view = projection.snapshot()
    const generation = (options.membersReadPin ?? options.membersLease).generation
    if (!view.available || view.generation !== generation || !Number.isSafeInteger(view.revision) || view.revision < receipt.revision)
      throw Object.assign(new Error('MEMBERS_PROJECTION_UNCONFIRMED'), { code: 'MEMBERS_PROJECTION_UNCONFIRMED', status: 503, outcome: 'unknown' })
    return view.profiles
  })
  const readMember = async (botId, context) => (await invoke('profile.read', { botId }, context)).bot
  const readListedMember = async (botId, context) => (await invoke('profile.read', { botId, includeDeleting: true }, context)).bot
  const collectProfiles = async (profilesContext, memberContext) => {
    const profiles = await readProfiles(profilesContext)
    const result = []
    for (const profile of profiles) {
      try { result.push(await readListedMember(profile.id, memberContext)) }
      catch (error) { if (error.code !== 'BOT_NOT_FOUND' || error.status !== 404) throw error }
    }
    return result
  }
  const listForClient = (context = {}) => {
    if (context.omitAvatars !== false) return readProfiles(context).then(profiles =>
      profiles.every(bot => ['avatarVersion', 'avatarLargeVersion', 'avatarSourceVersion', 'avatarLargeSourceVersion'].every(field => Object.hasOwn(bot, field)))
        ? profiles : listForClient({ ...context, omitAvatars: false }))
    if (context.membersLease) return admission.withLease(membersLease => {
      const options = { ...context, membersLease }
      return collectProfiles(options, options)
    }, { lease: context.membersLease })
    return admission.withReadPin('profiles.read', profilesPin => admission.withReadPin('profile.read', memberPin =>
      collectProfiles({ ...context, membersReadPin: profilesPin }, { ...context, membersReadPin: memberPin }),
    { expected: { generation: profilesPin.generation, epoch: profilesPin.epoch } }), { pin: context.membersReadPin })
  }
  const bots = {
    // These are display projection reads, never fresh authorization.
    get: id => { const bot = projection.get(id); return bot?.deleting ? undefined : bot },
    clientListingState: id => { const bot = projection.get(id); return bot ? bot.deleting ? 'pending' : 'active' : 'absent' },
    has: id => Boolean(bots.get(id)),
    keys: () => [...bots.values()].map(bot => bot.id).values(),
    values: () => [...projection.values()].filter(bot => !bot.deleting).values(),
    entries: () => [...bots.values()].map(bot => [bot.id, bot]).values(),
    [Symbol.iterator]: () => bots.entries(),
    refresh: readProfiles,
    listForClient, readMember, readListedMember,
    readRemovalStates: context => invoke('removals.read', {}, context),
    hasPendingRemoval: async (botId, context) => (await invoke('removals.read', {}, context)).removals.some(value => value.botId === botId),
    remove: (botId, context) => invoke('profile.remove', { botId }, context),
    create: async (input, context = {}) => (await invoke('profile.create', { input, ...(context.id === undefined ? {} : { id: context.id }) }, context)).bot,
    previewUpdate: async (botId, changes, context) => (await invoke('profile.preview', { botId, changes }, context)).bot,
    update: async (botId, changes, context) => (await invoke('profile.update', { botId, changes }, context)).bot,
    prepareStartupContext: async (botId, shortTermMemory, context) => { await invoke('profile.startup', { botId, shortTermMemory }, context) },
    // Remote seat C1/C6 (modules/members/remote-seat.md); execution calls this instead of prepareStartupContext.
    launchContext: async (botId, { sessionName, shortTermMemory }, context) => (await invoke('profile.launchContext', { botId, sessionName, shortTermMemory }, context)).launchContext,
    docs: {
      list: async (botId, context) => (await invoke('docs.list', { botId }, context)).files,
      read: (botId, path, context) => invoke('docs.read', { botId, path }, context),
      write: (botId, path, content, context) => invoke('docs.write', { botId, path, content }, context),
    },
    updateSession: async (botId, session, context) => (await invokeCallback('profile.session', { botId, session }, context)).bot,
    updateFastMode: async (botId, fastMode, context) => (await invokeCallback('profile.fastMode', { botId, fastMode }, context)).bot,
    listSchedules: async (botId, context) => (await invoke('schedules.list', { ownerKind: 'bot', ownerId: botId }, context)).schedules,
    setSchedule: async (botId, input, context) => (await invoke('schedules.set', { ownerKind: 'bot', ownerId: botId, input }, context)).schedule,
    removeSchedule: async (botId, scheduleId, context) => (await invoke('schedules.remove', { ownerKind: 'bot', ownerId: botId, scheduleId }, context)).removed,
    claimAfterTurn: (input, context) => invoke('schedules.claimAfterTurn', input, context),
    claimDue: ({ botId, ...input }, context) => invoke('schedules.claimDue', { ownerKind: 'bot', ownerId: botId, ...input }, context),
    skipDue: ({ botId, ...input }, context) => invoke('schedules.skipDue', { ownerKind: 'bot', ownerId: botId, ...input }, context),
  }
  return { bots,
    readCurrentBotIds: async context => (await invokeCallback('profiles.cli', {}, context)).botIds,
    ownerProfile: {
      get: async context => (await invoke('owner.read', {}, context)).owner,
      update: async (changes, context) => (await invoke('owner.update', { changes }, context)).owner,
    },
    userRules: {
      get: async context => (await invoke('rules.read', {}, context)).text,
      update: async (text, context) => (await invoke('rules.update', { text }, context)).text,
    },
  }
}
