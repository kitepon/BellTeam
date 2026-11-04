const reading = ['rooms.list', 'room.read', 'room.authorize', 'room.schedules.list',
  'history.page', 'history.recent', 'history.recentBatch', 'history.export', 'history.listMessages', 'history.listRoomMessages']
const rooms = ['room.create', 'room.update', 'room.remove', 'room.invite', 'room.leave', 'room.schedules.set', 'room.schedules.remove']
const posting = ['user.post', 'direct.post', 'room.post', 'room.reply', 'room.silent', 'assets.save', 'assets.saveAll']

// Admission/authentication is parent-owned; these are method ceilings, not credentials.
export const CONVERSATION_ACTOR_METHODS = Object.freeze({
  owner: Object.freeze([...reading, ...rooms, ...posting, 'user.turn', 'delivery.resume', 'delivery.closeLaunch', 'member.removeFromRooms']),
  bot: Object.freeze([...reading, ...rooms, ...posting, 'member.removeFromRooms']),
  scheduler: Object.freeze(['rooms.list', 'room.read', 'room.schedules.list', 'room.schedules.claimDue', 'room.schedules.skipDue', 'direct.post', 'room.post']),
  bridge: Object.freeze(['call.receive']),
  onboarding: Object.freeze(['user.post', 'user.turn']),
  usage: Object.freeze(['user.post']),
  observer: Object.freeze(['observation.poll', 'display.words']),
})
export const CONVERSATION_PARENT_METHODS = Object.freeze(['assets.open', 'history.export'])
export const CONVERSATION_ROOT_METHODS = Object.freeze([...new Set(Object.values(CONVERSATION_ACTOR_METHODS).flat())]
  .filter(method => method !== 'display.words' && !CONVERSATION_PARENT_METHODS.includes(method)))

const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)
const invalid = () => { throw Object.assign(new Error('CONVERSATION_ACTOR_INVALID'), { code: 'CONVERSATION_ACTOR_INVALID', status: 403, outcome: 'not_accepted' }) }

export function validateConversationActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || !Object.hasOwn(CONVERSATION_ACTOR_METHODS, actor.kind)) invalid()
  const bot = ['bot', 'onboarding', 'usage'].includes(actor.kind)
  const keys = ['kind', ...(bot ? ['botId'] : []), ...(actor.kind === 'usage' ? ['source'] : [])]
  if (Object.keys(actor).length !== keys.length || Object.keys(actor).some(key => !keys.includes(key))
    || bot && !id(actor.botId) || actor.kind === 'usage' && !['secret', 'question'].includes(actor.source)) invalid()
}

export function assertConversationRootAuthority(method, actor) {
  validateConversationActor(actor)
  if (!CONVERSATION_ACTOR_METHODS[actor.kind].includes(method))
    throw Object.assign(new Error('CONVERSATION_METHOD_FORBIDDEN'), { code: 'CONVERSATION_METHOD_FORBIDDEN', status: 403, outcome: 'not_accepted' })
}
