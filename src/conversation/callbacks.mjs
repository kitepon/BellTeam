import { isDeepStrictEqual } from 'node:util'
import { deliveryFailureFields } from '../conversation-writer.mjs'
import { returnedMcpError } from '../returned-mcp-error.mjs'
import { deliveryTracking } from '../delivery-tracking.mjs'

export const CONVERSATION_CALLBACK_METHODS = Object.freeze([
  'delivery.status', 'delivery.words', 'delivery.answer', 'user.complete', 'turn.end',
])
const statuses = new Set(['running', 'delivered', 'failed', 'stopped'])
const errorCodes = new Set(['BOT_STOPPED', 'AI_GLOBAL_PAUSED', 'CONVERSATION_CALLBACK_FAILED'])
const fail = () => { throw Object.assign(new Error('CONVERSATION_CALLBACK_INVALID'), { code: 'CONVERSATION_CALLBACK_INVALID' }) }
const string = value => { if (typeof value !== 'string') fail() }
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail()
}
function nativeLaunch(value) {
  return value?.harness === 'antigravity-cli' && value.session_created === true
    && value.startup?.status === 'blocked' && value.startup.reason === 'vendor_action_required'
    && value.initial_prompt?.status === 'not_requested' && value.initial_prompt.reason === 'not_requested'
    && value.initial_prompt.turn_started === false
    ? { harness: 'antigravity-cli', session_created: true,
      startup: { status: 'blocked', reason: 'vendor_action_required' },
      initial_prompt: { status: 'not_requested', reason: 'not_requested', turn_started: false } } : null
}

export function normalizeConversationCallbackError(error) {
  if (error == null) return null
  return { code: errorCodes.has(error.code) ? error.code : 'CONVERSATION_CALLBACK_FAILED',
    ...(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? { status: error.status } : {}),
    ...(['not_accepted', 'unknown'].includes(error.outcome) ? { outcome: error.outcome } : {}),
    ...deliveryFailureFields(error) }
}

export function conversationCallbackFailureFields(error) {
  if (error == null) return {}
  object(error, ['code'], ['status', 'outcome', 'mcp_error', 'native_launch'])
  if (!errorCodes.has(error.code)) fail()
  if (Object.hasOwn(error, 'status') && (!Number.isInteger(error.status) || error.status < 400 || error.status > 599)) fail()
  if (Object.hasOwn(error, 'outcome') && !['not_accepted', 'unknown'].includes(error.outcome)) fail()
  const mcp = returnedMcpError(error), launch = nativeLaunch(error.native_launch)
  if (Object.hasOwn(error, 'mcp_error') && (!mcp || !isDeepStrictEqual(mcp, error.mcp_error))) fail()
  if (Object.hasOwn(error, 'native_launch') && (!launch || !isDeepStrictEqual(launch, error.native_launch))) fail()
  return { ...(mcp ? { mcp_error: mcp } : {}), ...(launch ? { native_launch: launch } : {}) }
}

export function validateConversationCallback(method, params) {
  if (method === 'delivery.status') {
    object(params, ['delivery'], ['error', 'tracking'])
    if (!statuses.has(params.delivery)) fail()
    conversationCallbackFailureFields(params.error)
    if (params.tracking != null && !isDeepStrictEqual(deliveryTracking(params.delivery, params.tracking), params.tracking)) fail()
  } else if (method === 'delivery.words') {
    object(params, ['words'])
    if (!Array.isArray(params.words)) fail()
    for (const word of params.words) {
      object(word, ['text'], ['kind', 'at']); string(word.text)
      if (Object.hasOwn(word, 'kind')) string(word.kind)
      if (Object.hasOwn(word, 'at')) string(word.at)
    }
  } else if (method === 'delivery.answer') {
    object(params, ['text']); string(params.text)
  } else if (method === 'user.complete') {
    object(params, ['reply'])
    if (typeof params.reply !== 'string') {
      object(params.reply, ['delivery'])
      if (params.reply.delivery !== 'steered') fail()
    }
  } else if (method === 'turn.end') {
    object(params, ['startedAt', 'endedAt'])
    for (const at of [params.startedAt, params.endedAt]) {
      string(at)
      if (!Number.isFinite(Date.parse(at))) fail()
    }
  } else fail()
}

export function normalizeConversationCallback(method, params) {
  const normalized = method === 'delivery.status'
    ? { delivery: params.delivery, error: normalizeConversationCallbackError(params.error),
      tracking: deliveryTracking(params.delivery, params.tracking) }
    : method === 'delivery.words'
      ? { words: params.words.map(word => ({ text: word.text,
        ...(typeof word.kind === 'string' ? { kind: word.kind } : {}),
        ...(typeof word.at === 'string' ? { at: word.at } : {}) })) }
      : method === 'delivery.answer' ? { text: params.text }
        : method === 'user.complete' ? { reply: typeof params.reply === 'string' ? params.reply : { delivery: params.reply?.delivery } }
          : method === 'turn.end' ? { startedAt: params.startedAt, endedAt: params.endedAt } : fail()
  validateConversationCallback(method, normalized)
  return normalized
}

export function validateConversationCallbackResult(method, result) {
  if (method !== 'display.words' && !CONVERSATION_CALLBACK_METHODS.includes(method)) fail()
  object(result, ['applied'])
  if (result.applied !== true) fail()
}
