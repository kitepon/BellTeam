export const AUTH_MEDIATION_PROTOCOL_VERSION = 1
export const AUTH_MEDIATION_STATE_COMPATIBILITY = Object.freeze({ state: 'policy-v2' })
export const AUTH_MEDIATION_METHODS = Object.freeze(['resolve', 'admin', 'keyuse', 'http', 'mail', 'gmail', 'run', 'status'])
export const AUTH_MEDIATION_EFFECTS = Object.freeze(['members.roots', 'secret.get', 'secret.put', 'secret.erase', 'seat.run'])
export const authMediationError = (code, status = 400) => Object.assign(new Error(code), { code, status, outcome: 'not_accepted' })
export const authMediationObject = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
export const validAuthMediationGeneration = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/u.test(value)

const str = value => typeof value === 'string'
const text = (value, max) => str(value) && value.length <= max && !value.includes('\0')
const words = (value, max, each) => Array.isArray(value) && value.length <= max && value.every(w => text(w, each))
const path = value => text(value, 4096) && value.startsWith('/')
const botId = value => str(value) && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)
const list = (value, each) => Array.isArray(value) && value.every(each)
const invalid = () => { throw authMediationError('AUTH_MEDIATION_IPC_INVALID', 503) }
const need = condition => { if (!condition) invalid() }

export const OUTCOMES = Object.freeze(['granted', 'denied', 'stopped', 'unknown-caller', 'not-registered', 'error'])
const VIAS = ['mcp', 'container-socket', 'host-socket']

// The mail request: the fields that belong to each action, nothing else. Values that reach a server command line (mailbox, search, keywords) carry no control character.
const MAIL_FIELDS = { send: ['to', 'subject', 'text', 'html', 'from_name', 'reply_to'], read: ['mailbox', 'search', 'order', 'limit', 'fetch', 'uid', 'folders'], sort: ['uid', 'uidvalidity', 'add', 'archive'], check: ['protocol'] }
const noControl = value => text(value, 200) && !/[\x00-\x1f\x7f]/u.test(value)
const MAIL_RULES = {
  send: p => Array.isArray(p.to) && p.to.length >= 1 && p.to.length <= 10 && p.to.every(a => text(a, 254)) && str(p.subject) && p.subject.length <= 256 && str(p.text) && p.text.length <= 32768
    && (p.html === undefined || str(p.html) && p.html.length <= 32768) && (p.from_name === undefined || text(p.from_name, 100)) && (p.reply_to === undefined || text(p.reply_to, 254)),
  read: p => (p.mailbox === undefined || noControl(p.mailbox)) && (p.order === undefined || ['newest', 'oldest'].includes(p.order))
    && (p.limit === undefined || Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= 50) && (p.fetch === undefined || ['none', 'headers', 'text', 'raw'].includes(p.fetch))
    && (p.uid === undefined || Number.isInteger(p.uid) && p.uid >= 1) && (p.folders === undefined || typeof p.folders === 'boolean')
    && (p.search === undefined || authMediationObject(p.search, [], ['unseen', 'since', 'before', 'from', 'subject']) && (p.search.unseen === undefined || typeof p.search.unseen === 'boolean')
      && ['since', 'before', 'from', 'subject'].every(k => p.search[k] === undefined || text(p.search[k], 100))),
  sort: p => Number.isInteger(p.uid) && p.uid >= 1 && Number.isInteger(p.uidvalidity) && p.uidvalidity >= 1 && (p.archive === undefined || typeof p.archive === 'boolean')
    && (p.add === undefined || Array.isArray(p.add) && p.add.length <= 8 && p.add.every(k => str(k) && /^\$?[A-Za-z0-9_]{1,40}$/u.test(k))),
  check: p => ['imap993', 'smtp465', 'smtp587-starttls'].includes(p.protocol),
}
function mailRequestOk(params) {
  const allowed = MAIL_FIELDS[params.action]
  return Boolean(allowed) && authMediationObject(params, ['action', 'name', 'via'], [...allowed, 'cwd', 'unit']) && text(params.name, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(params.name)
    && ['container-socket', 'host-socket', 'caller-socket'].includes(params.via) && (params.via === 'caller-socket' ? params.unit !== undefined : params.cwd !== undefined)
    && (params.cwd === undefined || path(params.cwd)) && (params.unit === undefined || path(params.unit)) && MAIL_RULES[params.action](params)
}

export function validateAuthMediationRequest(method, params, context) {
  const check = condition => { if (!condition) throw authMediationError('AUTH_MEDIATION_INVALID') }
  check(authMediationObject(context, ['generation']) && validAuthMediationGeneration(context.generation) && AUTH_MEDIATION_METHODS.includes(method))
  if (method === 'resolve') check(authMediationObject(params, ['command', 'cwd', 'via'], ['args', 'botId', 'unit', 'timeoutSec'])
    && words(params.command, 64, 1024) && params.command.length > 0 && path(params.cwd) && VIAS.includes(params.via)
    && (params.args === undefined || words(params.args, 256, 8192)) && (params.botId === undefined || botId(params.botId))
    && (params.unit === undefined || path(params.unit)) && (params.timeoutSec === undefined || Number.isInteger(params.timeoutSec) && params.timeoutSec >= 1 && params.timeoutSec <= 3600)
    && (params.via === 'mcp' ? params.botId !== undefined : true))
  else if (method === 'admin') check(authMediationObject(params, ['verb'], ['args', 'botId', 'cwd', 'program']) && (params.botId === undefined) !== (params.cwd === undefined)
    && (params.botId === undefined || botId(params.botId)) && (params.cwd === undefined || path(params.cwd)) && str(params.verb) && /^[a-z][a-z.-]{0,31}$/u.test(params.verb)
    && (params.args === undefined || params.args && typeof params.args === 'object' && !Array.isArray(params.args))
    && (params.program === undefined || authMediationObject(params.program, ['path', 'sha256', 'sealed']) && path(params.program.path) && /^[a-f0-9]{64}$/u.test(params.program.sha256) && typeof params.program.sealed === 'boolean'))
  else if (method === 'keyuse') check(authMediationObject(params, ['action', 'name'], ['data', 'aad', 'flags', 'via', 'cwd', 'unit']) && ['wrap', 'unwrap', 'sign', 'sign-digest', 'ssh-identity', 'ssh-sign'].includes(params.action)
    && text(params.name, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(params.name)
    && (params.data === undefined ? params.action === 'ssh-identity' : text(params.data, 8192) && /^[A-Za-z0-9+/]+={0,2}$/u.test(params.data))
    && (params.flags === undefined || Number.isInteger(params.flags) && params.flags >= 0 && params.flags <= 7)
    && (params.via === undefined || ['container-socket', 'host-socket', 'caller-socket'].includes(params.via))
    && (params.cwd === undefined || path(params.cwd)) && (params.unit === undefined || path(params.unit))
    && ((params.via === undefined || params.via === 'caller-socket') ? params.unit !== undefined : params.cwd !== undefined)
    && (params.aad === undefined || text(params.aad, 256)))
  else if (method === 'mail') check(mailRequestOk(params))
  else if (method === 'gmail') check(authMediationObject(params, ['action', 'name', 'via'], ['q', 'max_results', 'page_token', 'id', 'format', 'add_labels', 'remove_labels', 'cwd', 'unit']) && ['list', 'get', 'modify'].includes(params.action)
    && text(params.name, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(params.name) && ['container-socket', 'host-socket', 'caller-socket'].includes(params.via) && (params.via === 'caller-socket' ? params.unit !== undefined : params.cwd !== undefined)
    && (params.cwd === undefined || path(params.cwd)) && (params.unit === undefined || path(params.unit))
    && (params.q === undefined || text(params.q, 200) && !/[\x00-\x1f\x7f]/u.test(params.q)) && (params.max_results === undefined || Number.isInteger(params.max_results) && params.max_results >= 1 && params.max_results <= 50)
    && (params.page_token === undefined || text(params.page_token, 200)) && (params.id === undefined || text(params.id, 40)) && (params.format === undefined || ['full', 'metadata', 'minimal'].includes(params.format))
    && ['add_labels', 'remove_labels'].every(k => params[k] === undefined || Array.isArray(params[k]) && params[k].length <= 8 && params[k].every(l => text(l, 64)))
    && (params.action === 'list' ? ['id', 'format', 'add_labels', 'remove_labels'].every(k => params[k] === undefined) : params.action === 'get' ? ['q', 'max_results', 'page_token', 'add_labels', 'remove_labels'].every(k => params[k] === undefined) && params.id !== undefined
      : ['q', 'max_results', 'page_token', 'format'].every(k => params[k] === undefined) && params.id !== undefined))
  else if (method === 'run') check(authMediationObject(params, ['name', 'via', 'stream'], ['cwd', 'unit', 'botId']) && text(params.name, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(params.name) && ['container-socket', 'host-socket', 'caller-socket'].includes(params.via)
    && /^\/[^\0]{1,400}\/runs\/[a-f0-9-]{36}\.sock$/u.test(params.stream) && (params.via === 'caller-socket' ? params.unit !== undefined : params.cwd !== undefined) && (params.cwd === undefined || path(params.cwd)) && (params.unit === undefined || path(params.unit)) && (params.botId === undefined || botId(params.botId)))
  else if (method === 'http') check(authMediationObject(params, ['name', 'method', 'path', 'via'], ['headers', 'body', 'timeoutSec', 'cwd', 'unit', 'botId'])
    && text(params.name, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(params.name) && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(params.method)
    && text(params.path, 2048) && params.path.startsWith('/') && ['container-socket', 'host-socket', 'caller-socket'].includes(params.via)
    && (params.via === 'caller-socket' ? params.unit !== undefined : params.cwd !== undefined) && (params.cwd === undefined || path(params.cwd)) && (params.unit === undefined || path(params.unit))
    && (params.botId === undefined || botId(params.botId)) && (params.timeoutSec === undefined || Number.isInteger(params.timeoutSec) && params.timeoutSec >= 1 && params.timeoutSec <= 60)
    && (params.body === undefined || text(params.body, 12583000) && /^[A-Za-z0-9+/]*={0,2}$/u.test(params.body))
    && (params.headers === undefined || params.headers && typeof params.headers === 'object' && !Array.isArray(params.headers) && Object.keys(params.headers).length <= 16
      && Object.entries(params.headers).every(([name, value]) => text(name, 64) && text(value, 1024))))
  else check(authMediationObject(params, []))
}

export function validateAuthMediationEffect(method, params) {
  const check = condition => { if (!condition) throw authMediationError('AUTH_MEDIATION_INVALID') }
  check(AUTH_MEDIATION_EFFECTS.includes(method))
  if (method === 'secret.put') check(authMediationObject(params, ['value']) && text(params.value, 16384) && params.value.length > 0)
  else if (method === 'seat.run') check(authMediationObject(params, ['botId', 'cwd', 'argv', 'env', 'timeoutMs']) && botId(params.botId) && path(params.cwd)
    && words(params.argv, 320, 8192) && params.argv.length > 0 && authMediationObject(params.env, Object.keys(params.env ?? {})) && Object.values(params.env).every(v => text(v, 65536))
    && Number.isInteger(params.timeoutMs) && params.timeoutMs >= 1000 && params.timeoutMs <= 3600000)
  else check(authMediationObject(params, []))
}

export function validateAuthMediationEffectResult(method, value) {
  if (method === 'members.roots') need(authMediationObject(value, ['roots']) && value.roots && typeof value.roots === 'object' && Object.entries(value.roots).every(([id, root]) => botId(id) && path(root)))
  else if (method === 'secret.get') need(authMediationObject(value, ['unavailable']) ? value.unavailable === true : authMediationObject(value, ['value']) && str(value.value))
  else if (method === 'secret.put') need(authMediationObject(value, ['stored']) && value.stored === true)
  else if (method === 'secret.erase') need(authMediationObject(value, ['erased']) && value.erased === true)
  else if (method === 'seat.run') need(authMediationObject(value, ['exitCode', 'stdout', 'stderr', 'truncated', 'timedOut'])
    && (value.exitCode === null || Number.isInteger(value.exitCode)) && str(value.stdout) && str(value.stderr)
    && typeof value.truncated === 'boolean' && typeof value.timedOut === 'boolean')
  else invalid()
}

const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
export function assertAuthMediationStateCompatibility(value) {
  if (!authMediationObject(value, Object.keys(AUTH_MEDIATION_STATE_COMPATIBILITY))
    || Object.entries(AUTH_MEDIATION_STATE_COMPATIBILITY).some(([key, expected]) => value[key] !== expected))
    throw authMediationError('AUTH_MEDIATION_STATE_INCOMPATIBLE', 503)
}

export function validateAuthMediationControl(method, params) {
  if (!controls.has(method) || (method === 'initialize'
    ? !authMediationObject(params, ['generation', 'mode']) || !validAuthMediationGeneration(params.generation) || !['bootstrap', 'restore'].includes(params.mode)
    : !authMediationObject(params, []))) throw authMediationError('AUTH_MEDIATION_CONTROL_INVALID')
}

export function validateAuthMediationControlResult(method, value) {
  if (method === 'initialize') {
    need(authMediationObject(value, ['stateCompatibility']))
    assertAuthMediationStateCompatibility(value.stateCompatibility)
  } else need(method === 'quiesce' ? authMediationObject(value, ['quiesced']) && typeof value.quiesced === 'boolean'
    : method === 'resume' ? authMediationObject(value, ['resumed']) && value.resumed === true
      : method === 'exit' && authMediationObject(value, ['closed']) && value.closed === true)
}

export function validateAuthMediationReady(value) {
  if (!authMediationObject(value, ['versionId', 'protocolVersion', 'stateCompatibility'])
    || value.versionId !== null && (!str(value.versionId) || !/^[a-f0-9]{64}$/u.test(value.versionId))
    || value.protocolVersion !== AUTH_MEDIATION_PROTOCOL_VERSION) throw authMediationError('AUTH_MEDIATION_READY_INVALID', 503)
  assertAuthMediationStateCompatibility(value.stateCompatibility)
}

// Results carry secret values only in `env` of a socket-transport answer (the caller's own environment) and never in run output (redacted before this point).
export function validateAuthMediationResult(method, value) {
  if (method === 'resolve') need(authMediationObject(value, ['outcome'], ['error', 'env', 'cache', 'exit_code', 'stdout', 'stderr', 'truncated'])
    && OUTCOMES.includes(value.outcome) && (value.error === undefined || str(value.error))
    && (value.env === undefined || value.env && typeof value.env === 'object' && Object.values(value.env).every(str))
    && (value.cache === undefined || ['hit', 'miss'].includes(value.cache)) && (value.exit_code === undefined || value.exit_code === null || Number.isInteger(value.exit_code))
    && (value.stdout === undefined || str(value.stdout)) && (value.stderr === undefined || str(value.stderr)) && (value.truncated === undefined || typeof value.truncated === 'boolean'))
  else if (method === 'admin') need(authMediationObject(value, ['outcome'], ['error', 'count', 'policy', 'token', 'lines']) && ['ok', 'denied', 'error'].includes(value.outcome)
    && (value.lines === undefined || list(value.lines, str)))
  else if (method === 'keyuse') need(authMediationObject(value, ['outcome'], ['error', 'data']) && OUTCOMES.includes(value.outcome) && (value.error === undefined || str(value.error))
    && (value.data === undefined || str(value.data) && value.data.length <= 4096))
  else if (method === 'mail') need(authMediationObject(value, ['outcome'], ['error', 'detail', 'message_id', 'folders', 'messages', 'truncated', 'flagged', 'moved', 'tls_verified']) && OUTCOMES.includes(value.outcome) && (value.error === undefined || str(value.error)) && (value.detail === undefined || text(value.detail, 64)) && (value.message_id === undefined || str(value.message_id))
    && (value.folders === undefined || Array.isArray(value.folders) && value.folders.length <= 500) && (value.messages === undefined || Array.isArray(value.messages) && value.messages.length <= 50)
    && (value.truncated === undefined || typeof value.truncated === 'boolean') && JSON.stringify(value).length <= 4 * 1024 * 1024)
  else if (method === 'gmail') need(authMediationObject(value, ['outcome'], ['error', 'detail', 'status', 'body', 'truncated']) && OUTCOMES.includes(value.outcome) && (value.error === undefined || str(value.error)) && (value.detail === undefined || text(value.detail, 64))
    && (value.status === undefined || Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) && (value.body === undefined || str(value.body) && value.body.length <= 1200000) && (value.truncated === undefined || typeof value.truncated === 'boolean'))
  else if (method === 'run') need(authMediationObject(value, ['outcome'], ['error']) && OUTCOMES.includes(value.outcome) && (value.error === undefined || str(value.error)))
  else if (method === 'http') need(authMediationObject(value, ['outcome'], ['error', 'status', 'headers', 'body', 'truncated']) && OUTCOMES.includes(value.outcome) && (value.error === undefined || str(value.error))
    && (value.status === undefined || Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.body === undefined || str(value.body) && value.body.length <= 15400000)
    && (value.headers === undefined || value.headers && typeof value.headers === 'object' && Object.values(value.headers).every(str)))
  else if (method === 'status') need(authMediationObject(value, ['state']) && ['ready', 'no-token'].includes(value.state))
  else invalid()
}

const knownErrors = new Map([
  ['AUTH_MEDIATION_INVALID', 400], ['AUTH_MEDIATION_CONTROL_INVALID', 400],
  ['AUTH_MEDIATION_NOT_ACCEPTED', 503], ['AUTH_MEDIATION_UNAVAILABLE', 503], ['AUTH_MEDIATION_NOT_QUIESCED', 503], ['AUTH_MEDIATION_EFFECT_FAILED', 503],
])
export function authMediationWireError(error, outcome) {
  const code = knownErrors.has(error?.code) ? error.code : knownErrors.has(error?.message) ? error.message : 'AUTH_MEDIATION_OPERATION_FAILED'
  return { code, status: knownErrors.get(code) ?? 503, outcome }
}
