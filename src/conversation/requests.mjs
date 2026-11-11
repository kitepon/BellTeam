import { assertConversationRootAuthority } from './authority.mjs'
import { CONVERSATION_CALLBACK_METHODS, validateConversationCallback } from './callbacks.mjs'

const invalid = () => { throw Object.assign(new Error('CONVERSATION_REQUEST_INVALID'), {
  code: 'CONVERSATION_REQUEST_INVALID', status: 400, outcome: 'not_accepted',
}) }
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = value => typeof value === 'string'
const nonempty = value => text(value) && value.length > 0 && !value.includes('\0')
const identity = value => nonempty(value) && value.length <= 128 && !/\s/u.test(value)
const id = value => text(value) && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)
const roomId = value => id(value) && value.length <= 64
const bool = value => typeof value === 'boolean'
const integer = value => Number.isSafeInteger(value) && value >= 0
const date = value => text(value) && Number.isFinite(Date.parse(value))
const oneOf = (...values) => value => values.includes(value)
const nullable = validate => value => value === null || validate(value)
const array = validate => value => Array.isArray(value) && value.every(validate)
function fields(value, required, optional = {}) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key))
    || Object.entries(required).some(([key, validate]) => !Object.hasOwn(value, key) || !validate(value[key]))
    || Object.entries(optional).some(([key, validate]) => Object.hasOwn(value, key) && !validate(value[key]))) invalid()
  return true
}
const image = value => {
  if (!plain(value)) return false
  return Object.hasOwn(value, 'path') ? fields(value, { path: nonempty })
    : fields(value, { mime: oneOf('image/png', 'image/jpeg', 'image/webp', 'image/gif'), data: text })
}
const changes = value => fields(value, {}, {
  name: text, purpose: text, memberIds: array(id), representativeId: nullable(id), avatar: text,
})
const schedule = value => fields(value, { kind: oneOf('once', 'cron', 'interval_days', 'interval_hours') }, {
  id: nonempty, name: text, prompt: text, command: text, enabled: bool, at: text,
  expression: text, timezone: text, intervalDays: integer, startDate: text, time: text,
  intervalHours: integer, startHour: integer, endHour: integer, minute: integer, targets: nullable(array(id)),
})
const launch = value => fields(value, { session_id: nonempty, launch_id: value => text(value) && /^[a-f0-9]{32}$/u.test(value) })
const post = { message: text, images: array(image) }
// Bound by the parent seat MCP from the resolved fork seat only (fork-inquiry B1/B2).
const askerSeat = value => fields(value, { kind: oneOf('fork'), forkId: identity })

// These are the private normalized payloads; ingress adapters preserve public aliases/defaults.
export function validateConversationRequest(method, params, context) {
  fields(context, { generation: identity, operationId: identity,
    actor: value => { assertConversationRootAuthority(method, value); return true }, continuation: bool })
  return validateConversationInput(method, params, context.actor)
}

// Parent receipts reuse the same pure input/actor validation without an IPC lease.
export function validateConversationInput(method, params, actor) {
  assertConversationRootAuthority(method, actor)
  switch (method) {
    case 'rooms.list': case 'observation.poll': return fields(params, {})
    case 'room.read': case 'room.schedules.list': case 'room.remove':
    case 'history.listRoomMessages': return fields(params, { roomId })
    case 'room.authorize': return fields(params, { roomId, requirement: oneOf('member', 'representative') })
    case 'room.create': return fields(params, { name: text, memberIds: array(id) }, {
      purpose: text, representativeId: nullable(id), avatar: text,
    })
    case 'room.update': return fields(params, { roomId, changes })
    case 'room.invite': case 'room.leave': return fields(params, { roomId, botId: id })
    case 'room.schedules.set': return fields(params, { roomId, schedule })
    case 'room.schedules.remove': return fields(params, { roomId, scheduleId: nonempty })
    case 'room.schedules.claimDue': case 'room.schedules.skipDue': return fields(params, {
      roomId, scheduleId: nonempty, expectedRevision: integer, expectedNextRunAt: date, ranAt: date,
    })
    case 'member.removeFromRooms': return fields(params, { botId: id })
    case 'history.listMessages': case 'history.recent': return fields(params, { botId: id })
    case 'history.recentBatch': return fields(params, { botIds: array(id) })
    case 'history.workInput':
      fields(params, { botId: id, sessionId: identity, launchId: identity, inputRevision: identity,
        deliveryId: identity, context: oneOf('direct', 'room'), contextId: id })
      if (params.context === 'direct' ? params.contextId !== params.botId : !roomId(params.contextId)) invalid()
      return true
    case 'history.deliveryAnchor':
      fields(params, { deliveryId: identity, target: id, context: oneOf('direct', 'room'), contextId: id })
      if (params.context === 'direct' ? params.contextId !== params.target : !roomId(params.contextId)) invalid()
      return true
    case 'history.page':
      fields(params, { kind: oneOf('bots', 'rooms'), id,
        query: value => fields(value, { limit: nullable(text), before: nullable(text), after: nullable(text) }),
        cards: array(array(value => fields(value, { id: text, at: text }))),
      })
      if (params.cards.length !== (params.kind === 'bots' ? 2 : 1) || (params.kind === 'rooms' && !roomId(params.id))) invalid()
      return true
    case 'direct.post': return fields(params, { from: id, target: id, ...post }, { askerSeat })
    case 'fork.ask': return fields(params, { from: id, target: id, message: text }, { askerSeat })
    case 'user.post': case 'user.turn':
      fields(params, { target: id, ...post }, { recordUser: bool })
      if (params.recordUser === false && actor.kind !== 'onboarding') invalid()
      return true
    case 'display.words':
      fields(params, { botId: id, groupId: identity, words: Array.isArray })
      validateConversationCallback('delivery.words', { words: params.words })
      return true
    case 'room.post': return fields(params, { from: id, room: roomId, ...post }, {
      targets: nullable(array(id)), kind: oneOf('message', 'schedule'),
      schedule: nullable(value => fields(value, { id: nonempty, name: text })),
    })
    case 'room.reply': return fields(params, { roomId, messageId: nonempty, ...post }, { targets: nullable(array(id)) })
    case 'room.silent': return fields(params, { roomId, messageId: nonempty })
    case 'assets.save': return fields(params, { owner: id, id, image })
    case 'assets.saveAll': return fields(params, { owner: id, id, images: array(image) })
    case 'delivery.resume': case 'delivery.closeLaunch': return fields(params, { deliveryId: nonempty, target: launch })
    case 'call.receive': return fields(params, {
      event: oneOf('session.message', 'session.reply'), session_id: nonempty, target_id: id,
      source_system: oneOf('grokbot', 'bellteam', 'local'), source_id: nonempty, source_label: nonempty, message: nonempty,
    }, { reply_required: bool, seq: nullable(value => typeof value === 'number' && Number.isFinite(value)) })
    default: invalid()
  }
}

export function validateConversationBotSnapshot(bots) {
  if (!Array.isArray(bots)) invalid()
  const seen = new Set()
  for (const bot of bots) {
    fields(bot, { id, name: nonempty }, { displayName: text, position: text, role: text })
    if (seen.has(bot.id)) invalid()
    seen.add(bot.id)
  }
  return true
}

export function validateConversationControl(method, params, context) {
  fields(context, { generation: identity, operationId: value => value === null })
  switch (method) {
    case 'initialize':
      fields(params, { generation: identity, mode: oneOf('bootstrap', 'restore'), bots: validateConversationBotSnapshot })
      if (params.generation !== context.generation) invalid()
      return true
    case 'routing.changed': return fields(params, { enabled: bool, epoch: integer })
    case 'quiesce': case 'resume': case 'exit': case 'quiesceWriter': case 'exitWriter': return fields(params, {})
    default: invalid()
  }
}

export function validateConversationCallbackContext(method, context) {
  fields(context, { generation: identity, operationId: identity, deliveryId: identity,
    target: identity, callbackKind: value => value === method && CONVERSATION_CALLBACK_METHODS.includes(value) })
  return true
}
