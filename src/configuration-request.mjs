import { createHash } from 'node:crypto'

// Persisted common intent contract; compatible producer releases still need structural capability checks.
export const CONFIGURATION_VERSION = '0.63.11'
export const CONFIGURATION_INTENT_VERSIONS = ['0.63.5', '0.63.6', '0.63.7', '0.63.8', '0.63.9', '0.63.10', '0.63.11']
export const CONFIGURATION_SCHEMA = 'aiterm.agent-configure-request-result.v1'
const failureRequests = new WeakMap()
export function captureConfigurationRequest(error, request) {
  if (!error || !['object', 'function'].includes(typeof error)) return
  const previous = failureRequests.get(error)
  if (failureRequests.has(error) && (!previous || Object.keys(previous.binding).some(key => previous.binding[key] !== request.binding[key]))) {
    failureRequests.set(error, null)
    return
  }
  failureRequests.set(error, structuredClone(request))
}
export const configurationRequestFailure = error => failureRequests.has(error) ? structuredClone(failureRequests.get(error)) : null
const notIssued = new WeakSet()
const intentNotWritten = new WeakSet()
export const configurationIntentWasNotWritten = error => intentNotWritten.has(error)
export function markConfigurationIntentNotWritten(error) { intentNotWritten.add(error); return error }
export const configurationWasNotIssued = error => notIssued.has(error)
export function markConfigurationNotIssued(error) { notIssued.add(error); return error }
export function configurationError(code, effect = 'not_issued') {
  const error = Object.assign(new Error(code), { code, effect, status: effect === 'not_issued' ? 503 : 502 })
  return error
}
export const configurationUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
export const configurationBot = value => typeof value === 'string' && /^bot-[a-z0-9-]{1,100}$/u.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const session = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)

export function configurationSettings(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['model', 'reasoning_effort', 'fast'].includes(key)))
    throw configurationError('CONFIGURATION_SETTINGS_INVALID')
  const text = value => {
    if (value == null) return null
    if (typeof value !== 'string' || value.trim().length > 512) throw configurationError('CONFIGURATION_SETTINGS_INVALID')
    return value.trim() || null
  }
  if (input.fast != null && typeof input.fast !== 'boolean') throw configurationError('CONFIGURATION_SETTINGS_INVALID')
  return { model: text(input.model), reasoning_effort: text(input.reasoning_effort), fast: input.fast ?? null }
}

export const configurationDigest = input => createHash('sha256').update(JSON.stringify(configurationSettings(input)), 'utf8').digest('hex')
export function configurationBinding(value) {
  if (!exact(value, 'id,session_id,launch_id,digest') || !configurationUUID(value.id) || !session(value.session_id)
    || typeof value.launch_id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.launch_id)
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)) throw configurationError('CONFIGURATION_BINDING_INVALID')
  return { ...value }
}

export function configurationReceipt(value, expected) {
  const invalid = () => { throw configurationError('CONFIGURATION_RESULT_UNCONFIRMED', 'possible') }
  if (!exact(value, 'schema,binding,request_state,outcome,later_effect,terminal_at,result,current,observed_at')
    || value.schema !== CONFIGURATION_SCHEMA) invalid()
  let binding
  try { binding = configurationBinding(value.binding) } catch { invalid() }
  if (Object.keys(binding).some(key => binding[key] !== expected[key])
    || !['terminal', 'pending_or_unknown', 'not_recorded', 'unavailable'].includes(value.request_state)
    || !['applied', 'not_applied', 'outcome_unknown'].includes(value.outcome)
    || !['excluded', 'unconfirmed'].includes(value.later_effect)
    || !exact(value.current, 'availability') || value.current.availability !== 'unsupported' || !date(value.observed_at)) invalid()
  if (value.request_state === 'terminal') {
    if (!date(value.terminal_at)) invalid()
  } else if (value.terminal_at !== null || value.outcome !== 'outcome_unknown' || value.result !== null || value.later_effect !== 'unconfirmed') invalid()
  if (value.later_effect === 'excluded' && value.request_state !== 'terminal') invalid()
  if (value.result !== null) {
    const result = value.result
    const harnesses = { claude: 'claude-code', codex: 'codex-cli', grok: 'grok-cli', cursor: 'cursor-cli', antigravity: 'antigravity-cli' }
    if (!exact(result, 'schema,session_id,provider,harness,model,reasoning_effort,fast')
      || result.schema !== 'aiterm.agent-configure-result.v1' || result.session_id !== binding.session_id
      || !Object.hasOwn(harnesses, result.provider) || harnesses[result.provider] !== result.harness
      || ![result.model, result.reasoning_effort].every(entry => entry === null || typeof entry === 'string')
      || !(result.fast === null || typeof result.fast === 'boolean') || value.outcome !== 'applied') invalid()
  } else if (value.outcome === 'applied') invalid()
  return structuredClone(value)
}

export function configurationConnection(client, sdk, transport) {
  const server = sdk?.getServerVersion()
  if (!sdk || client.client !== sdk || client.transport !== transport || client.connecting || !transport
    || sdk.transport !== transport || !Number.isSafeInteger(transport.pid) || transport.pid <= 0
    || server?.name !== 'aiterm')
    throw markConfigurationNotIssued(configurationError('CONFIGURATION_CONNECTION_UNCONFIRMED'))
}

export async function configurationCapability(client) {
  await client.connect()
  const sdk = client.client, transport = client.transport
  configurationConnection(client, sdk, transport)
  let cursor, found
  const cursors = new Set()
  for (let page = 0; page < 16; page++) {
    const result = await sdk.listTools(cursor ? { cursor } : {})
    configurationConnection(client, sdk, transport)
    if (!Array.isArray(result.tools)) throw configurationError('CONFIGURATION_CAPABILITY_UNCONFIRMED')
    for (const tool of result.tools) if (tool.name === 'agent_configure') {
      if (found) throw configurationError('CONFIGURATION_CAPABILITY_UNCONFIRMED')
      found = tool
    }
    if (!result.nextCursor) { cursor = null; break }
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw configurationError('CONFIGURATION_CAPABILITY_UNCONFIRMED')
    cursor = result.nextCursor; cursors.add(cursor)
  }
  const properties = found?.inputSchema?.properties, request = properties?.request
  const schema = found?.outputSchema?.properties?.schema
  if (cursor || !properties?.action?.enum?.includes('apply') || !properties.action.enum.includes('reconcile')
    || request?.type !== 'object' || !['id', 'launch_id', 'digest'].every(key => request.required?.includes(key) && request.properties?.[key]?.type === 'string')
    || !(schema?.const === CONFIGURATION_SCHEMA || schema?.enum?.includes(CONFIGURATION_SCHEMA)))
    throw configurationError('CONFIGURATION_CAPABILITY_UNCONFIRMED')
  return { sdk, transport }
}
