import { usageMethods } from './process-schema.mjs'
import { usageProjectionRecordValid, usageSettingValid, usageConfigurationValid } from './projection.mjs'
import { backgroundRecordValid } from './background-agent-settings.mjs'
import { credentialDtoValid } from './secret-credentials.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key))
const record = (type, value) => usageProjectionRecordValid({ type, value, revision: 0 })
const auth = value => value === null || exact(value, ['status', 'url', 'user_code', 'input_required', 'message', 'session_id', 'auth_ui'])
  && ['waiting', 'authenticated', 'blocked', 'failed'].includes(value.status) && typeof value.input_required === 'boolean'
const timeline = (kind, value) => Array.isArray(value) && value.every(row => exact(row, ['id', 'kind', 'direction', 'at', 'message', 'sender', kind])
  && row.kind === kind && row.direction === 'incoming' && typeof row.message === 'string'
  && exact(row.sender, ['id', 'name']) && typeof row.sender.name === 'string' && record(kind === 'secret_request' ? 'secret' : 'question', row[kind]))

// The channel validates a reply before it becomes a successful public business result.
export function usageResultValid(method, value, params = {}) {
  if (!Object.hasOwn(usageMethods, method)) return false
  if (method === 'settings.backgroundAgent') return backgroundRecordValid(value)
  if (method === 'settings.updateBackgroundAgent') return backgroundRecordValid(value) && value.selection !== null
    && ['harness', 'model', 'reasoningEffort'].every(key => value.selection[key] === params[key])
  if (method === 'settings.list') return Array.isArray(value) && value.length === 7 && new Set(value.map(item => item?.id)).size === 7 && value.every(usageSettingValid)
  if (method === 'settings.configuration') return usageConfigurationValid(params.id, value)
  if (method === 'settings.update') return usageSettingValid(value) && value.id === params.id
  if (['settings.setError', 'onboarding.prepareStartup', 'secrets.notifyOwnerGuide'].includes(method)) return value === null
  if (method === 'secrets.refresh') return exact(value, ['recoveryNeeded']) && typeof value.recoveryNeeded === 'boolean'
  if (method === 'secrets.revokeTerminalRequests') return value === null
  if (method === 'secrets.requestTerminalKey') return exact(value, ['secretRequest']) && record('secret', value.secretRequest) && value.secretRequest.botId === null
  if (method === 'secrets.current') return value === null || exact(value, ['handle', 'revision', 'available', 'requestId'])
    && credentialDtoValid({ handle: value.handle, revision: value.revision, available: value.available }) && typeof value.requestId === 'string'
  if (method.startsWith('onboarding.')) return record('onboarding', value)
  if (method === 'auth.list') return record('auth', value)
  if (method.startsWith('auth.')) {
    const slot = params.slot ?? '1st'
    const legacy = exact(value, ['harness', 'auth']) && slot === '1st'
    const scoped = params.harness === 'claude' && exact(value, ['harness', 'slot', 'account_label', 'auth'])
      && value.slot === slot && (value.account_label === null || typeof value.account_label === 'string')
    return (legacy || scoped) && value.harness === params.harness && auth(value.auth)
  }
  if (['secrets.resolve', 'secrets.resolveRequest'].includes(method)) return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 16384 && !value.includes('\0')
  if (['secrets.bind', 'secrets.credential', 'secrets.replace', 'secrets.unbind'].includes(method)) return credentialDtoValid(value) && (!params.handle || value.handle === params.handle)
  if (method === 'secrets.onePasswordItems') return Array.isArray(value) && value.every(row => exact(row, ['title', 'vault', 'reference'])
    && typeof row.title === 'string' && typeof row.vault === 'string' && typeof row.reference === 'string' && row.reference.startsWith('op://'))
  if (method === 'secrets.timeline') return timeline('secret_request', value)
  if (method.startsWith('secrets.')) return record('secret', value) && (!params.id || value.id === params.id)
  if (method === 'questions.timeline') return timeline('owner_question', value)
  if (method.startsWith('questions.')) return record('question', value) && (!params.id || value.id === params.id)
  if (method === 'subscriptions.runSetupTest') return exact(value, ['subscription', 'reply']) && record('subscription', value.subscription) && typeof value.reply === 'string' && value.reply.trim().length > 0
  return method.startsWith('subscriptions.') && record('subscription', value)
}
