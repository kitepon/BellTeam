import { validateMembersResult } from './members/protocol.mjs'

// Request/callback are the same live controller's closed public channel methods.
export function createMembersFacade({ request, callback, admission, projection }) {
  const invoke = (method, params, context = {}) => admission.withLease(async membersLease => {
    const result = await request(method, params, { membersLease, capturedAuthorization: context.capturedAuthorization, membersEffect: context.membersEffect })
    validateMembersResult(method, result)
    return result
  }, { lease: context.membersLease })
  const invokeCallback = async (method, params, context) => {
    const membersLease = admission.assertLease(context?.membersLease)
    const result = await callback(method, params, { membersLease, membersEffect: context.membersEffect })
    validateMembersResult(method, result)
    return result
  }
  const readMember = async (botId, context) => (await invoke('profile.read', { botId }, context)).bot
  const bots = {
    // These are display projection reads, never fresh authorization.
    get: id => projection.get(id), has: id => projection.has(id),
    keys: () => projection.keys(), values: () => projection.values(),
    refresh: async context => (await invoke('profiles.read', {}, context)).profiles,
    listForClient: async context => (await invoke('profiles.read', {}, context)).profiles,
    readMember,
    readRemovalStates: context => invoke('removals.read', {}, context),
    hasPendingRemoval: async (botId, context) => (await invoke('removals.read', {}, context)).removals.some(value => value.botId === botId),
    remove: (botId, context) => invoke('profile.remove', { botId }, context),
    create: async (input, context = {}) => (await invoke('profile.create', { input, ...(context.id === undefined ? {} : { id: context.id }) }, context)).bot,
    previewUpdate: async (botId, changes, context) => (await invoke('profile.preview', { botId, changes }, context)).bot,
    update: async (botId, changes, context) => (await invoke('profile.update', { botId, changes }, context)).bot,
    prepareStartupContext: async (botId, shortTermMemory, context) => { await invoke('profile.startup', { botId, shortTermMemory }, context) },
    updateSession: async (botId, session, context) => (await invokeCallback('profile.session', { botId, session }, context)).bot,
    updateFastMode: async (botId, fastMode, context) => (await invokeCallback('profile.fastMode', { botId, fastMode }, context)).bot,
    listSchedules: async (botId, context) => (await invoke('schedules.list', { ownerKind: 'bot', ownerId: botId }, context)).schedules,
    setSchedule: async (botId, input, context) => (await invoke('schedules.set', { ownerKind: 'bot', ownerId: botId, input }, context)).schedule,
    removeSchedule: async (botId, scheduleId, context) => (await invoke('schedules.remove', { ownerKind: 'bot', ownerId: botId, scheduleId }, context)).removed,
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
