import { validateMembersResult } from './members/protocol.mjs'

// Request/callback are the same live controller's closed public channel methods.
export function createMembersFacade({ request, callback, admission, projection }) {
  const invoke = (method, params, context = {}) => admission.withLease(async membersLease => {
    const result = await request(method, params, { membersLease, capturedAuthorization: context.capturedAuthorization })
    validateMembersResult(method, result)
    return result
  }, { lease: context.membersLease })
  const save = async (method, params, context) => {
    const membersLease = admission.assertLease(context?.membersLease)
    const result = await callback(method, params, { membersLease })
    validateMembersResult(method, result)
    return result.bot
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
    create: async (input, context) => (await invoke('profile.create', { input }, context)).bot,
    previewUpdate: async (botId, changes, context) => (await invoke('profile.preview', { botId, changes }, context)).bot,
    update: async (botId, changes, context) => (await invoke('profile.update', { botId, changes }, context)).bot,
    prepareStartupContext: async (botId, shortTermMemory, context) => { await invoke('profile.startup', { botId, shortTermMemory }, context) },
    updateSession: (botId, session, context) => save('profile.session', { botId, session }, context),
    updateFastMode: (botId, fastMode, context) => save('profile.fastMode', { botId, fastMode }, context),
    listSchedules: async (botId, context) => (await invoke('schedules.list', { ownerKind: 'bot', ownerId: botId }, context)).schedules,
    setSchedule: async (botId, input, context) => (await invoke('schedules.set', { ownerKind: 'bot', ownerId: botId, input }, context)).schedule,
    removeSchedule: async (botId, scheduleId, context) => (await invoke('schedules.remove', { ownerKind: 'bot', ownerId: botId, scheduleId }, context)).removed,
    claimDue: ({ botId, ...input }, context) => invoke('schedules.claimDue', { ownerKind: 'bot', ownerId: botId, ...input }, context),
    skipDue: ({ botId, ...input }, context) => invoke('schedules.skipDue', { ownerKind: 'bot', ownerId: botId, ...input }, context),
  }
  return { bots,
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
