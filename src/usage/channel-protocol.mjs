import { isAbsolute } from 'node:path'
import { HARNESS, GUIDE_BOT_ID } from '../onboarding.mjs'
import { usageError, validateUsageActor } from './process-schema.mjs'
import { usageProjectionRecordValid } from './projection.mjs'
import { backgroundHarnesses, backgroundRecordValid, backgroundModelsValid } from './background-agent-settings.mjs'

export const object = value => value && typeof value === 'object' && !Array.isArray(value)
export const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
export const check = (value, code = 'USAGE_IPC_INVALID') => { if (!value) throw usageError(code) }
export const contextValid = value => exact(value, 'generation,rootId,kind,method,mode,actor,continuation')
  && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 200
  && typeof value.rootId === 'string' && /^[1-9][0-9]{0,15}$/.test(value.rootId) && Number.isSafeInteger(Number(value.rootId))
  && ['root', 'callback', 'control'].includes(value.kind) && typeof value.method === 'string'
  && (value.mode === null || ['settings', 'subscriptions', 'services', 'restore'].includes(value.mode))
  && validateUsageActor(value.actor) && typeof value.continuation === 'boolean'
export const sameContext = (left, right) => contextValid(left) && contextValid(right)
  && ['generation', 'rootId', 'kind', 'method', 'mode', 'continuation'].every(key => left[key] === right[key])
  && left.actor.kind === right.actor.kind && left.actor.botId === right.actor.botId
export const ackValid = value => exact(value, 'acknowledged') && value.acknowledged === true
export const marker = value => exact(value, 'streamed,collection,count') && value.streamed === true && typeof value.collection === 'boolean'
  && Number.isSafeInteger(value.count) && value.count >= 0 && (value.collection || value.count === 1)
export const publicationValid = value => exact(value, 'phase,row') && ['seed', 'snapshot', 'update'].includes(value.phase) && usageProjectionRecordValid(value.row)
const metadata = value => exact(value, 'id,name,harness') && typeof value.id === 'string' && typeof value.name === 'string' && (value.harness === null || Object.hasOwn(HARNESS, value.harness))
const text = value => typeof value === 'string'
const named = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))
const authActions = {
  'auth.status': ['status', 'cancel'], 'auth.start': ['start', 'cancel'], 'auth.input': ['respond', 'cancel'], 'auth.cancel': ['cancel'],
  'onboarding.status': ['status'], 'onboarding.select': ['start', 'cancel'], 'onboarding.input': ['respond'], 'onboarding.start': ['status', 'cancel'],
}
const allowed = {
  'backgroundAgent.models': ['settings.updateBackgroundAgent'], 'backgroundAgent.changed': ['settings.updateBackgroundAgent'],
  'settings.changed': ['settings.update'], 'onboarding.ensureGuide': ['onboarding.select'],
  'onboarding.prepareStartup': ['onboarding.prepareStartup'], 'onboarding.startConversation': ['onboarding.start'],
  'secret.created': ['secrets.create'], 'question.created': ['questions.create'],
  'secret.completed': ['secrets.submit', 'secrets.cancel'], 'question.answered': ['questions.answer'],
  'subscription.setupTest': ['subscriptions.runSetupTest'], 'rooms.read': ['secrets.create'],
}
export function usageEffectValid(method, params, context, rootParams = {}) {
  if (!contextValid(context)) return false
  if (method === 'members.read') return exact(params, '') && (context.kind === 'control' && context.method === 'initialize' && ['services', 'restore'].includes(context.mode)
    || context.kind === 'root' && ['secrets.create', 'questions.create', 'onboarding.prepareStartup'].includes(context.method))
  if (context.kind !== 'root') return false
  if (method === 'auth.prepareAccount') return exact(params, 'harness,slot') && params.harness === 'claude'
    && ['1st', '2nd'].includes(params.slot) && params.harness === rootParams.harness && params.slot === (rootParams.slot ?? '1st')
    && ['auth.start', 'auth.status', 'auth.input', 'auth.cancel'].includes(context.method)
  if (method === 'auth.listAccounts') return exact(params, '')
    && ['auth.start', 'auth.status', 'auth.input'].includes(context.method) && rootParams.harness === 'claude'
  if (method === 'auth.call') return named(params, ['harness', 'action'], ['session_id', 'relogin', 'expected_binding', 'expected_prompt_digest', 'response', 'configuration_root', 'login', 'token_file'])
    && Object.hasOwn(params, 'login') === Object.hasOwn(params, 'token_file')
    && (!Object.hasOwn(params, 'login') || params.login === 'oauth_token' && rootParams.harness === 'claude' && rootParams.slot === '2nd'
      && params.harness === HARNESS.claude && typeof params.token_file === 'string' && isAbsolute(params.token_file) && !params.token_file.includes('\0'))
    && Object.values(HARNESS).includes(params.harness) && authActions[context.method]?.includes(params.action)
    && (!params.session_id || text(params.session_id)) && (!Object.hasOwn(params, 'relogin') || typeof params.relogin === 'boolean')
    && (!Object.hasOwn(params, 'configuration_root') || rootParams.harness === 'claude' && params.harness === HARNESS.claude
      && typeof params.configuration_root === 'string' && isAbsolute(params.configuration_root) && !params.configuration_root.includes('\0'))
    && (params.action !== 'respond' || object(params.expected_binding) && text(params.expected_prompt_digest) && object(params.response))
  if (!allowed[method]?.includes(context.method)) return false
  if (method === 'backgroundAgent.models') return exact(params, 'harness') && backgroundHarnesses.includes(params.harness) && params.harness === rootParams.harness
  if (method === 'backgroundAgent.changed') return exact(params, 'configuration') && backgroundRecordValid(params.configuration)
    && params.configuration.selection !== null && ['harness', 'model', 'reasoningEffort'].every(key => params.configuration.selection[key] === rootParams[key])
  if (method === 'settings.changed') return exact(params, 'id,configuration,epoch') && params.id === rootParams.id && object(params.configuration) && Number.isSafeInteger(params.epoch) && params.epoch >= 0
  if (method === 'onboarding.ensureGuide') return exact(params, 'harness') && Object.hasOwn(HARNESS, params.harness) && params.harness === rootParams.harness
  if (method === 'onboarding.prepareStartup') return exact(params, 'botId,text') && params.botId === rootParams.botId && text(params.text)
  if (method === 'onboarding.startConversation') return exact(params, 'botId,message') && params.botId === GUIDE_BOT_ID && text(params.message)
  if (method === 'rooms.read') return exact(params, '')
  if (method === 'subscription.setupTest') return exact(params, 'botId') && params.botId === rootParams.botId
  if (method === 'secret.created' || method === 'question.created') return exact(params, 'item') && params.item?.botId === context.actor.botId
    && usageProjectionRecordValid({ type: method === 'secret.created' ? 'secret' : 'question', value: params.item, revision: 0 })
  return exact(params, 'botId,message') && text(params.botId) && text(params.message)
}
export function usageEffectResultValid(method, value) {
  if (method === 'backgroundAgent.models') return backgroundModelsValid(value)
  if (method === 'members.read') return Array.isArray(value) && value.every(metadata)
  if (method === 'onboarding.ensureGuide') return metadata(value) && value.id === GUIDE_BOT_ID
  if (method === 'rooms.read') return Array.isArray(value) && value.every(room => exact(room, 'id,memberIds') && text(room.id) && Array.isArray(room.memberIds) && room.memberIds.every(text))
  if (method === 'auth.prepareAccount') return exact(value, 'configurationRoot') && typeof value.configurationRoot === 'string'
    && isAbsolute(value.configurationRoot) && !value.configurationRoot.includes('\0')
  if (method === 'auth.listAccounts') return exact(value, 'harnesses') && Array.isArray(value.harnesses) && value.harnesses.length <= 1
    && value.harnesses.every(row => exact(row, 'harness,slots') && row.harness === 'claude' && Array.isArray(row.slots) && row.slots.length <= 2
      && row.slots.every(slot => exact(slot, 'slot,loggedIn,label') && ['1st', '2nd'].includes(slot.slot)
        && (slot.loggedIn === null || typeof slot.loggedIn === 'boolean') && (slot.label === null || typeof slot.label === 'string'))
      && new Set(row.slots.map(slot => slot.slot)).size === row.slots.length)
  if (method === 'auth.call') return named(value, ['structuredContent'], ['isError']) && object(value.structuredContent) && (!Object.hasOwn(value, 'isError') || typeof value.isError === 'boolean')
  if (method === 'subscription.setupTest') return text(value) && value.trim().length > 0
  return Object.hasOwn(allowed, method) && value === null
}
