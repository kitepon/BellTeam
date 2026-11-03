import { assertConversationStateCompatibility } from './state-compatibility.mjs'

const invalid = () => { throw Object.assign(new Error('CONVERSATION_RESULT_INVALID'), { code: 'CONVERSATION_RESULT_INVALID' }) }
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = value => typeof value === 'string'
const nonempty = value => text(value) && value.length > 0
const id = value => text(value) && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const oneOf = (...values) => value => values.includes(value)
const nullable = validate => value => value === null || validate(value)
const array = validate => value => Array.isArray(value) && value.every(validate)
function fields(value, required, optional = {}) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key))
    || Object.entries(required).some(([key, validate]) => !Object.hasOwn(value, key) || !validate(value[key]))
    || Object.entries(optional).some(([key, validate]) => Object.hasOwn(value, key) && !validate(value[key]))) invalid()
  return true
}
const room = value => fields(value, { id, name: text, purpose: text, representativeId: nullable(id), memberIds: array(id), avatar: text })
// Existing schedule documents may carry future optional data; result wrappers remain closed.
const schedule = value => plain(value) && nonempty(value.id) && ['once', 'cron', 'interval_days', 'interval_hours'].includes(value.kind)
const asset = value => fields(value, { owner: id, file: value => text(value) && /^[a-z0-9][a-z0-9-]{0,127}\.(png|jpg|webp|gif)$/u.test(value),
  mime: oneOf('image/png', 'image/jpeg', 'image/webp', 'image/gif') })
const delivery = oneOf('running', 'steered', 'delivered')
const failedTargets = array(value => fields(value, { id, error: text }))

export function validateConversationResult(method, value) {
  switch (method) {
    case 'rooms.list': return fields(value, { rooms: array(room) })
    case 'room.read': case 'room.authorize': case 'room.create': case 'room.update':
    case 'room.invite': case 'room.leave': return fields(value, { room })
    case 'room.remove': case 'member.removeFromRooms': case 'room.schedules.remove': return fields(value, { removed: nonempty })
    case 'room.schedules.list': return fields(value, { schedules: array(schedule) })
    case 'room.schedules.set': return fields(value, { schedule })
    case 'room.schedules.claimDue': case 'room.schedules.skipDue': if (!nullable(schedule)(value)) invalid(); return true
    case 'history.listMessages': case 'history.listRoomMessages':
      if (typeof value?.[Symbol.asyncIterator] !== 'function') invalid()
      return true
    case 'direct.post': case 'user.post': case 'delivery.resume': return fields(value, {
      delivery, delivery_id: nonempty, from: nonempty, target: id,
    })
    case 'user.turn': return fields(value, { delivery: oneOf('delivered', 'steered'), delivery_id: nonempty,
      from: nonempty, target: id }, { reply_id: nonempty, reply: nullable(text) })
    case 'delivery.closeLaunch': return fields(value, { closureId: nonempty, delivery_id: nonempty, from: nonempty, target: id })
    case 'room.post': return fields(value, { id: nonempty, room: id, targets: array(id),
      delivery: oneOf('posted', 'posted_with_failed_deliveries', 'already_posted', 'running', 'steered') }, { failedTargets })
    case 'room.reply': return fields(value, { id: nonempty,
      delivery: oneOf('posted', 'posted_with_failed_deliveries', 'already_posted', 'running', 'steered') }, { failedTargets })
    case 'room.silent': return fields(value, { delivery: oneOf('suppressed') })
    case 'assets.save': if (!asset(value)) invalid(); return true
    case 'assets.saveAll': if (!array(asset)(value)) invalid(); return true
    case 'call.receive': return fields(value, { delivery, delivery_id: nonempty, target: id })
    case 'observation.poll': case 'display.words': return fields(value, { applied: value => value === true })
    default: invalid()
  }
}

export function validateConversationControlResult(method, value) {
  switch (method) {
    case 'initialize': return fields(value, { stateCompatibility: value => { assertConversationStateCompatibility(value); return true } })
    case 'quiesce': return fields(value, { quiesced: value => value === true })
    case 'resume': return fields(value, { resumed: value => value === true })
    case 'exit': return fields(value, { closed: value => value === true })
    case 'routing.changed': return fields(value, { applied: value => value === true, epoch: integer })
    default: invalid()
  }
}
