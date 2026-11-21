import { CardTimelines } from '../card-timelines.mjs'
import { usageError } from './process-schema.mjs'
import { backgroundRecordValid, backgroundAgentError } from './background-agent-settings.mjs'
import { credentialDtoValid, credentialScopeValid } from './secret-credentials.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))
// a399 (module-ipc.md): rows with nothing secret-adjacent are read by the fields this side uses; a field a newer writer adds is not refused.
// secret, question, settings and credential rows stay closed: they are served as stored, and the key list is what keeps a stray value out.
const has = (value, required) => object(value) && required.every(key => Object.hasOwn(value, key))
const fields = { routing: ['apiKey'], callBridge: ['url', 'token'], cloudflare: ['teamDomain', 'audience', 'publicUrl'], diagnostics: ['key'], notifications: ['relayUrl'], webPush: ['subject'], onePassword: ['token'], thinkingDisplay: [] }
// a479 (module-ipc.md "Records between halves that ship apart"): the body ships before the usage module, so a list from a child
// that predates thinkingDisplay stays valid. shortcut: drop this when every shipped usage module sends it.
const required = Object.keys(fields).filter(id => id !== 'thinkingDisplay')
export const usageFeatureIdsValid = ids => ids.length >= required.length && new Set(ids).size === ids.length && required.every(id => ids.includes(id)) && ids.every(id => Object.hasOwn(fields, id))
const validGeneration = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && value.length > 0 && value.length <= 200
const secretKeys = new Set(['apiKey', 'token', 'key'])
export function usageSettingValid(item) {
  if (!keys(item, ['id', 'title', 'enabled', 'status', 'fields'], ['error', 'guide', 'connection']) || !Object.hasOwn(fields, item.id)) return false
  const names = fields[item.id]
  return typeof item.title === 'string' && typeof item.enabled === 'boolean' && ['enabled', 'disabled', 'unconfigured'].includes(item.status)
    && (!item.error || keys(item.error, ['code', 'message']) && typeof item.error.code === 'string' && typeof item.error.message === 'string')
    && (!item.connection || keys(item.connection, ['vaults', 'sshKeys']) && Array.isArray(item.connection.vaults)
      && item.connection.vaults.every(name => typeof name === 'string') && Number.isSafeInteger(item.connection.sshKeys) && item.connection.sshKeys >= 0)
    && (!item.guide || keys(item.guide, ['steps', 'link']) && Array.isArray(item.guide.steps) && item.guide.steps.every(step => typeof step === 'string')
      && keys(item.guide.link, ['label', 'url']) && typeof item.guide.link.label === 'string' && /^https:\/\//u.test(item.guide.link.url))
    && Array.isArray(item.fields) && item.fields.length === names.length && item.fields.every((field, index) => keys(field, ['key', 'label', 'secret', 'value', 'configured'], ['required'])
      && (!Object.hasOwn(field, 'required') || typeof field.required === 'boolean') && field.key === names[index] && typeof field.label === 'string' && field.secret === secretKeys.has(field.key) && typeof field.configured === 'boolean'
      && typeof field.value === 'string' && (!field.secret || field.value === ''))
}
export function usageConfigurationValid(id, configuration) {
  return Object.hasOwn(fields, id) && keys(configuration, ['enabled', ...fields[id]]) && typeof configuration.enabled === 'boolean' && fields[id].every(key => typeof configuration[key] === 'string')
}
export function usageProjectionRecordValid(row) {
  if (!object(row) || !Number.isSafeInteger(row.revision) || row.revision < 0) return false
  if (row.type === 'settings') {
    if (!keys(row, ['type', 'revision', 'list', 'configurations', 'epochs'], ['backgroundAgent', 'backgroundAgentError'])
      || Object.hasOwn(row, 'backgroundAgent') && (!backgroundRecordValid(row.backgroundAgent) || Object.hasOwn(row, 'backgroundAgentError'))
      || Object.hasOwn(row, 'backgroundAgentError') && !['BACKGROUND_AGENT_STATE_INVALID', 'BACKGROUND_AGENT_STATE_FAILED'].includes(row.backgroundAgentError)
      || !object(row.configurations) || !object(row.epochs) || !usageFeatureIdsValid(Object.keys(row.configurations)) || !keys(row.epochs, Object.keys(row.configurations))
      || Object.values(row.epochs).some(epoch => !Number.isSafeInteger(epoch) || epoch < 0) || !Array.isArray(row.list) || row.list.length !== Object.keys(row.configurations).length) return false
    const seen = new Set()
    return row.list.every(item => {
      if (!usageSettingValid(item) || seen.has(item.id)) return false
      seen.add(item.id)
      return Object.hasOwn(row.configurations, item.id) && usageConfigurationValid(item.id, row.configurations[item.id])
    })
  }
  if (!keys(row, ['type', 'revision', 'value']) || !object(row.value)) return false
  const item = row.value
  if (row.type === 'credentialRecovery') return has(item, ['recoveryNeeded']) && typeof item.recoveryNeeded === 'boolean'
  if (row.type === 'credential') return keys(item, ['terminalId', 'purpose', 'handle', 'revision', 'available', 'reason', 'requestId'])
    && credentialScopeValid({ terminalId: item.terminalId, purpose: item.purpose }) && (item.requestId === null || typeof item.requestId === 'string')
    && credentialDtoValid({ handle: item.handle, revision: item.revision, available: item.available }) && ['bound', 'unbound', 'revision', 'availability'].includes(item.reason)
  if (row.type === 'secret') return keys(item, ['id', 'botId', 'roomId', 'toolId', 'label', 'message', 'at', 'status'], ['path', 'notification', 'withdrawn', 'inputOptions', 'terminalId', 'purpose', 'oneTime'])
    && ['id', 'toolId', 'label', 'message', 'at'].every(key => typeof item[key] === 'string') && (item.roomId === null || typeof item.roomId === 'string')
    && (typeof item.botId === 'string' && !Object.hasOwn(item, 'terminalId') && !Object.hasOwn(item, 'purpose')
      || item.botId === null && item.roomId === null && item.toolId === 'terminal-key' && ['terminal.ssh', 'terminal.sudo', 'terminal.login'].includes(item.purpose)
      && credentialScopeValid({ terminalId: item.terminalId, purpose: item.purpose }))
    && ['pending', 'submitted', 'cancelled'].includes(item.status) && (!Object.hasOwn(item, 'path') || typeof item.path === 'string')
    && (!Object.hasOwn(item, 'notification') || ['pending', 'sent', 'failed', 'not_needed'].includes(item.notification))
    && (!Object.hasOwn(item, 'withdrawn') || typeof item.withdrawn === 'boolean') && (!Object.hasOwn(item, 'oneTime') || item.oneTime === true)
    && (!Object.hasOwn(item, 'inputOptions') || keys(item.inputOptions, ['preferred', 'onePasswordAvailable'])
      && ['stored', 'onepassword'].includes(item.inputOptions.preferred) && typeof item.inputOptions.onePasswordAvailable === 'boolean')
  if (row.type === 'question') return keys(item, ['id', 'botId', 'question', 'options', 'allowOther', 'at', 'status'], ['answer', 'answeredAt', 'other'])
    && ['id', 'botId', 'question', 'at'].every(key => typeof item[key] === 'string') && typeof item.allowOther === 'boolean' && Array.isArray(item.options) && item.options.every(value => typeof value === 'string')
    && ['open', 'answered'].includes(item.status) && (!Object.hasOwn(item, 'answer') || typeof item.answer === 'string') && (!Object.hasOwn(item, 'answeredAt') || typeof item.answeredAt === 'string')
    && (!Object.hasOwn(item, 'other') || typeof item.other === 'boolean')
  if (row.type === 'event') return has(item, ['all', 'topics', 'botIds', 'roomIds']) && typeof item.all === 'boolean'
    && Array.isArray(item.topics) && item.topics.every(topic => ['requests', 'questions'].includes(topic)) && ['botIds', 'roomIds'].every(key => Array.isArray(item[key]) && item[key].every(value => typeof value === 'string'))
  if (row.type === 'onboarding') return has(item, ['phase', 'harness', 'harnesses', 'guideBotId', 'complete', 'auth']) && typeof item.complete === 'boolean'
    && ['ready', 'authenticate', 'select_harness'].includes(item.phase) && (item.harness === null || typeof item.harness === 'string') && (item.guideBotId === null || typeof item.guideBotId === 'string')
    && Array.isArray(item.harnesses) && (item.auth === null || has(item.auth, ['status', 'url', 'user_code', 'input_required', 'message', 'session_id', 'auth_ui']))
  if (row.type === 'auth') return has(item, ['harnesses']) && Array.isArray(item.harnesses) && item.harnesses.every(harness => has(harness, ['id', 'name', 'members', 'startWarning', 'reloginSupported']))
  if (row.type === 'subscription') return has(item, ['productId', 'environment', 'accessMode', 'setupComplete', 'entitled', 'canUseAI', 'state', 'checkedAt', 'expiresAt', 'validUntil', 'autoRenewing', 'error'])
    && ['setupComplete', 'entitled', 'canUseAI', 'autoRenewing'].every(key => typeof item[key] === 'boolean')
    // a394f: 新しい項目は任意。古いusageの記録も、新しい本体と部品が受け入れる（本体を先に入れ替える）。
    && (!Object.hasOwn(item, 'canPurchase') || typeof item.canPurchase === 'boolean')
    && (!Object.hasOwn(item, 'entitlementState') || ['active', 'none', 'unknown'].includes(item.entitlementState))
    && (!Object.hasOwn(item, 'billingSources') || Array.isArray(item.billingSources) && item.billingSources.every(source => typeof source === 'string'))
  return false
}

// This private ACK projection serves synchronous legacy readers, never writer authority.
export function createUsageProjection({ bots }) {
  let generation = null, staging = null, current = null, revision = -1, bootstrap = null, bootstrapGeneration = null, bootstrapBase = -1
  const seenGenerations = new Set()
  const records = new Set(['settings', 'onboarding', 'auth', 'subscription', 'secret', 'question', 'event', 'credential', 'credentialRecovery'])
  const empty = () => ({ settings: null, onboarding: null, auth: null, subscription: null, secrets: new Map(), questions: new Map(),
    secretTimeline: new CardTimelines(bots, 'secret_request'), questionTimeline: new CardTimelines(bots, 'owner_question') })
  const copy = value => structuredClone(value)
  const apply = (state, row) => {
    if (!row || !records.has(row.type) || !usageProjectionRecordValid(row)) throw usageError('USAGE_PROJECTION_INVALID')
    if (['secret', 'question'].includes(row.type)) {
      const item = row.value
      if (!item || typeof item.id !== 'string' || row.type !== 'secret' && typeof item.botId !== 'string'
        || Object.hasOwn(item, 'value')) throw usageError('USAGE_PROJECTION_INVALID')
      const secret = row.type === 'secret'
      const items = secret ? state.secrets : state.questions
      items.set(item.id, copy(item))
      if (item.botId !== null) (secret ? state.secretTimeline : state.questionTimeline).put(copy(item))
    } else if (row.type === 'settings') {
      if (!Array.isArray(row.list) || !row.configurations || !usageFeatureIdsValid(row.list.map(item => item?.id))
        || row.list.some(item => typeof item.id !== 'string' || !Object.hasOwn(row.configurations, item.id))) throw usageError('USAGE_PROJECTION_INVALID')
      state.settings = copy(row)
    } else if (!['event', 'credential', 'credentialRecovery'].includes(row.type)) {
      if (!row.value || typeof row.value !== 'object') throw usageError('USAGE_PROJECTION_INVALID')
      state[row.type] = copy(row.value)
    }
  }
  const state = () => { if (!current && !bootstrap) throw usageError('USAGE_PROJECTION_UNAVAILABLE'); return current ?? bootstrap }
  return {
    backgroundAgent() {
      const row = state().settings
      if (row?.backgroundAgentError) throw backgroundAgentError(row.backgroundAgentError, 500)
      if (!Object.hasOwn(row ?? {}, 'backgroundAgent')) throw backgroundAgentError('BACKGROUND_AGENT_UNAVAILABLE', 503)
      return copy(row.backgroundAgent)
    },
    hasBackgroundAgent() { const row = state().settings; return Object.hasOwn(row ?? {}, 'backgroundAgent') || Boolean(row?.backgroundAgentError) },
    seed(row, next) {
      if (!validGeneration(next) || generation === next || seenGenerations.has(next)
        || !['settings', 'subscription'].includes(row?.type) || !usageProjectionRecordValid(row)) throw usageError('USAGE_PROJECTION_INVALID')
      // a399: one child lives at a time, so a seed from another generation means the earlier one died before its snapshot;
      // its rows and the revisions it raised go, or the next child's rows would be refused as old.
      if (bootstrapGeneration !== next) {
        if (bootstrap) revision = bootstrapBase; else bootstrapBase = revision
        bootstrap = empty(); bootstrapGeneration = next
      }
      apply(bootstrap, row); revision = Math.max(revision, row.revision)
    },
    begin(next) {
      if (!validGeneration(next) || seenGenerations.has(next)) throw usageError('USAGE_PROJECTION_GENERATION')
      staging = { generation: next, state: empty(), revision: null }
    },
    accept(row, next) {
      if (!usageProjectionRecordValid(row)) throw usageError('USAGE_PROJECTION_INVALID')
      if (staging && staging.generation === next) {
        if (staging.revision !== null && staging.revision !== row.revision) throw usageError('USAGE_PROJECTION_REVISION')
        apply(staging.state, row); staging.revision = row.revision
      } else if (!current && bootstrap && next === bootstrapGeneration) {
        if (row.revision <= revision) throw usageError('USAGE_PROJECTION_REVISION')
        apply(bootstrap, row); revision = row.revision
      } else {
        if (next !== generation || !current || !Number.isSafeInteger(row.revision) || row.revision <= revision) throw usageError('USAGE_PROJECTION_GENERATION')
        apply(current, row); revision = row.revision
      }
    },
    commit(next) {
      if (!staging || staging.generation !== next || !['settings', 'onboarding', 'auth', 'subscription'].every(key => staging.state[key])) throw usageError('USAGE_PROJECTION_INCOMPLETE')
      generation = next; seenGenerations.add(next); current = staging.state; revision = staging.revision; staging = null; bootstrap = null; bootstrapGeneration = null
    },
    discard(next) { if (staging?.generation === next) staging = null },
    configuration(id) {
      const entry = state().settings.configurations[id]
      if (!entry) throw usageError('FEATURE_NOT_FOUND', 404)
      return copy(entry)
    },
    epoch: id => {
      const epoch = state().settings.epochs[id]
      if (epoch === undefined) throw usageError('FEATURE_NOT_FOUND', 404)
      return epoch
    },
    list: () => copy(state().settings.list),
    onboarding: () => copy(state().onboarding), auth: () => copy(state().auth), subscription: () => copy(state().subscription),
    get(kind, id) {
      const item = (kind === 'secret' ? state().secrets : state().questions).get(id)
      if (!item) throw new Error(kind === 'secret' ? 'SECRET_REQUEST_NOT_FOUND' : 'OWNER_QUESTION_NOT_FOUND')
      return copy(item)
    },
    timeline(kind, target) { return copy((kind === 'secret' ? state().secretTimeline : state().questionTimeline).timeline(target)) },
    timelineView(kind, target) { return (kind === 'secret' ? state().secretTimeline : state().questionTimeline).view(target) },
  }
}
