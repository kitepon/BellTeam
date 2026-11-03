import { validateConversationActor } from './authority.mjs'
import { CONVERSATION_CALLBACK_METHODS } from './callbacks.mjs'
import { validateConversationBotSnapshot, validateConversationCallbackContext } from './requests.mjs'

export const CONVERSATION_EFFECT_METHODS = Object.freeze([
  'members.profiles.read', 'usage.routing.read', 'usage.notify.direct', 'usage.notify.room',
  'assets.beginSave', 'assets.endSave', 'runtime.image.read', 'runtime.room.context',
  'runtime.observer.changed', 'runtime.observer.read', 'execution.notify', 'execution.turn',
  'execution.background.begin', 'execution.background.end', 'execution.observation.source', 'execution.report',
])
const invalid = () => { throw Object.assign(new Error('CONVERSATION_EFFECT_INVALID'), { code: 'CONVERSATION_EFFECT_INVALID' }) }
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = value => typeof value === 'string'
const nonempty = value => text(value) && value.length > 0 && !value.includes('\0')
const identity = value => nonempty(value) && value.length <= 128 && !/\s/u.test(value)
const id = value => text(value) && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)
const bool = value => typeof value === 'boolean'
const integer = value => Number.isSafeInteger(value) && value >= 0
const finite = value => typeof value === 'number' && Number.isFinite(value)
const oneOf = (...values) => value => values.includes(value)
const nullable = validate => value => value === null || validate(value)
const array = validate => value => Array.isArray(value) && value.every(validate)
function fields(value, required, optional = {}) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key))
    || Object.entries(required).some(([key, validate]) => !Object.hasOwn(value, key) || !validate(value[key]))
    || Object.entries(optional).some(([key, validate]) => Object.hasOwn(value, key) && !validate(value[key]))) invalid()
  return true
}
const image = value => plain(value) && (Object.hasOwn(value, 'path') ? fields(value, { path: nonempty })
  : fields(value, { mime: oneOf('image/png', 'image/jpeg', 'image/webp', 'image/gif'), data: text }))
const label = value => fields(value, { id, name: text })
const queue = value => fields(value, { context: oneOf('direct', 'room', 'report'), contextId: id,
  groupId: identity, from: nonempty, fromName: text, target: id, message: text }, {
  call: value => fields(value, { sessionId: nonempty, event: oneOf('session.message', 'session.reply'), seq: nullable(finite) }),
})

function context(value) {
  if (Object.hasOwn(value ?? {}, 'callbackKind')) return validateConversationCallbackContext(value.callbackKind, value)
  return fields(value, { generation: identity, operationId: identity, continuation: bool,
    actor: actor => { validateConversationActor(actor); return true } })
}

export function validateConversationEffect(method, params, capturedContext) {
  context(capturedContext)
  switch (method) {
    case 'members.profiles.read': case 'usage.routing.read': case 'runtime.observer.changed': return fields(params, {})
    case 'usage.notify.direct': return fields(params, { deliveryId: identity, from: nonempty, target: id })
    case 'usage.notify.room': return fields(params, { id: identity, sender: label, room: label })
    case 'assets.beginSave': return fields(params, { owner: id })
    case 'assets.endSave': return fields(params, { leaseId: identity })
    case 'runtime.image.read': return fields(params, { image, leaseId: identity })
    case 'runtime.room.context': return fields(params, { roomId: id, messageId: identity, speaker: text, text })
    case 'runtime.observer.read': return fields(params, { botId: id }, {
      afterCursor: nullable(text), throughCursor: nullable(text), pageToken: nullable(text),
    })
    case 'execution.observation.source':
      if (capturedContext.actor?.kind !== 'observer') invalid()
      return fields(params, { target: id })
    case 'execution.background.begin':
      if (capturedContext.callbackKind === 'turn.end') invalid()
      return fields(params, { deliveryId: identity, target: id })
    case 'execution.background.end': return fields(params, { backgroundId: identity })
    case 'execution.notify': case 'execution.turn': case 'execution.report': {
      const report = method === 'execution.report'
      fields(params, { deliveryId: identity, target: id, message: text, queue,
        kinds: array(value => CONVERSATION_CALLBACK_METHODS.includes(value)),
        ...(report ? { sourceDeliveryId: identity, reason: oneOf('missing', 'content') } : { images: array(image) }),
      })
      if (params.queue.groupId !== params.deliveryId || params.queue.target !== params.target
        || new Set(params.kinds).size !== params.kinds.length) invalid()
      if (report) {
        if (params.queue.context !== 'report' || params.queue.from !== 'bellteam'
          || params.queue.contextId !== params.target || params.kinds.some(kind => ['turn.end', 'user.complete'].includes(kind))) invalid()
      } else if (params.queue.context === 'report' || (method === 'execution.turn'
        ? !params.kinds.includes('user.complete') || params.kinds.some(kind => ['delivery.answer', 'turn.end'].includes(kind))
        : params.kinds.includes('user.complete'))) invalid()
      return true
    }
    default: invalid()
  }
}

const observerStatus = oneOf('snapshot', 'delta', 'thread_switched', 'host_switched',
  'resync_required', 'projection_pending', 'ambiguous_parent', 'error')
const observerTurn = value => fields(value, {}, { source_sha256: text, turn_start: oneOf('prompt', 'self', 'unknown'),
  user: text, assistant: text, completed_at: nullable(finite) })
function observerResult(value) {
  return fields(value, { status: observerStatus }, { throughCursor: nullable(text),
    page: value => fields(value, { complete: bool }, { nextToken: nullable(text) }),
    turns: array(observerTurn), code: nonempty })
}

// Keep only fields consumed by the existing v2 reader, without body truncation or cursor rewriting.
export function normalizeConversationObserverResult(value) {
  if (value?.schema !== 'throughline.observer_read.v2') invalid()
  const pick = (input, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]))
  const result = { status: value.status,
    ...pick(value, ['throughCursor', 'code']),
    ...(Object.hasOwn(value, 'page') ? { page: pick(value.page, ['complete', 'nextToken']) } : {}),
    ...(Object.hasOwn(value, 'turns') ? { turns: value.turns.map(turn => pick(turn,
      ['source_sha256', 'turn_start', 'user', 'assistant', 'completed_at'])) } : {}),
  }
  observerResult(result)
  return result
}

export function validateConversationEffectResult(method, result, params) {
  switch (method) {
    case 'members.profiles.read': return fields(result, { bots: validateConversationBotSnapshot })
    case 'usage.routing.read':
      fields(result, { enabled: bool, epoch: integer, apiKey: nullable(nonempty) })
      if (!result.enabled && result.apiKey !== null) invalid()
      return true
    case 'usage.notify.direct': case 'usage.notify.room': return fields(result, { accepted: value => value === true })
    case 'assets.beginSave': return fields(result, { leaseId: identity })
    case 'assets.endSave': case 'execution.background.end': return fields(result, { requested: value => value === true })
    case 'runtime.image.read': return fields(result, { data: text })
    case 'runtime.room.context': return fields(result, { turns: array(value => fields(value, { speaker: text, text })) })
    case 'runtime.observer.changed': return fields(result, { changed: bool })
    case 'runtime.observer.read': return observerResult(result)
    case 'execution.notify': case 'execution.turn': case 'execution.report': return fields(result, { delivery: oneOf('running', 'steered') })
    case 'execution.background.begin': return fields(result, { backgroundId: identity })
    case 'execution.observation.source':
      fields(result, { deliveryId: identity, target: id })
      if (result.target !== params?.target) invalid()
      return true
    default: invalid()
  }
}
