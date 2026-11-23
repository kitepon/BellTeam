// Approval Box extension (Delta, R5): wire protocol between the body parent and the module child. Shape of lattice-protocol.mjs.
// Roots (parent -> child) are the calls of contract/approvals-contract.md; effects (child -> parent) exist only inside a root call.
export const APPROVAL_BOX_EXTENSION_PROTOCOL_VERSION = 1
export const APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY = Object.freeze({ state: 'none' })
export const APPROVAL_BOX_EXTENSION_METHODS = Object.freeze(['byTask', 'byDecision', 'connection', 'connect', 'cancelConnect', 'disconnect', 'refresh'])
export const APPROVAL_BOX_EXTENSION_EFFECTS = Object.freeze(['lattice.ownerTask', 'lattice.link', 'lattice.chart', 'lattice.charts', 'members.list',
  'session.get', 'session.put', 'session.erase', 'daemon.decisions.list', 'daemon.decisions.read'])
export const APPROVALS_DECISION_ID = /^K-[A-Z0-9]{4,16}$/u
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export const approvalsError = (code, status = 400) => Object.assign(new Error(code), { code, status, outcome: 'not_accepted' })
export const approvalsObject = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
export const validApprovalsGeneration = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/u.test(value)

const str = value => typeof value === 'string'
const strOrNull = value => value === null || str(value)
const count = value => Number.isInteger(value) && value >= 0
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw approvalsError('APPROVALS_IPC_INVALID', 503) }
const need = condition => { if (!condition) invalid() }
const decisionId = value => str(value) && APPROVALS_DECISION_ID.test(value)
const STATUSES = ['pending', 'held', 'answered', 'cancelled']

// A read root changes nothing (the dispatcher lets reads run beside the one write at a time). refresh is the engine tick: it writes charts, so it is a write.
export const approvalsRootReads = method => ['byTask', 'byDecision', 'connection'].includes(method)

export function validateApprovalsRequest(method, params, context) {
  const check = condition => { if (!condition) throw approvalsError('APPROVALS_INVALID') }
  check(approvalsObject(context, ['generation']) && validApprovalsGeneration(context.generation))
  check(APPROVAL_BOX_EXTENSION_METHODS.includes(method))
  if (['connection', 'connect', 'cancelConnect', 'disconnect'].includes(method)) check(approvalsObject(params, []))
  else if (method === 'byDecision') check(approvalsObject(params, ['id']) && decisionId(params.id))
  else if (method === 'byTask') check(approvalsObject(params, ['project', 'plan', 'task']) && str(params.project) && PROJECT_ID.test(params.project) && str(params.plan) && REF.test(params.plan) && str(params.task) && REF.test(params.task))
  else check(approvalsObject(params, ['since']) && count(params.since)) // refresh
}

const sendText = (value, max) => str(value) && value.length >= 1 && value.length <= max
export function validateApprovalsEffect(method, params) {
  if (!APPROVAL_BOX_EXTENSION_EFFECTS.includes(method)) throw approvalsError('APPROVALS_INVALID')
  const bad = method === 'lattice.ownerTask' ? !approvalsObject(params, ['projectId', 'args', 'input']) || !PROJECT_ID.test(params.projectId) || !Array.isArray(params.args) || params.args.length > 200
      || !params.args.every(arg => str(arg) && arg.length <= 8192) || !(params.input === null || plain(params.input))
    : method === 'lattice.link' ? !approvalsObject(params, ['projectId', 'plan', 'taskId']) || !PROJECT_ID.test(params.projectId) || !REF.test(params.plan) || !REF.test(params.taskId)
    : method === 'lattice.chart' ? !approvalsObject(params, ['projectId']) || !PROJECT_ID.test(params.projectId)
    : method === 'session.put' ? !approvalsObject(params, ['value']) || !sendText(params.value, 8192)
    : method === 'daemon.decisions.read' ? !approvalsObject(params, ['id']) || !decisionId(params.id)
    : !approvalsObject(params, []) // lattice.charts, members.list, session.get, session.erase, daemon.decisions.list
  if (bad) throw approvalsError('APPROVALS_INVALID')
}

export function validateApprovalsEffectResult(method, value) {
  if (method === 'lattice.ownerTask') need(approvalsObject(value, ['exitCode', 'result', 'stdout', 'stderr']) && (value.exitCode === null || Number.isInteger(value.exitCode)) && strOrNull(value.stdout) && str(value.stderr))
  else if (method === 'lattice.link') need(approvalsObject(value, ['schema', 'projectId', 'plan', 'taskId', 'linked']) && value.schema === 'bellteam.lattice-link.v1' && value.linked === true)
  else if (method === 'lattice.chart') need(approvalsObject(value, ['cards', 'edges']) && Array.isArray(value.cards) && value.cards.every(card => plain(card) && str(card.id) && str(card.plan) && str(card.taskId) && str(card.state) && strOrNull(card.lane) && str(card.title))
    && Array.isArray(value.edges) && value.edges.every(edge => plain(edge) && str(edge.from) && str(edge.to)))
  else if (method === 'lattice.charts') need(Array.isArray(value) && value.every(chart => approvalsObject(chart, ['projectId', 'name', 'createdBy', 'coordinator']) && PROJECT_ID.test(chart.projectId) && strOrNull(chart.name) && strOrNull(chart.createdBy) && typeof chart.coordinator === 'boolean'))
  else if (method === 'members.list') need(Array.isArray(value) && value.every(member => approvalsObject(member, ['id', 'name']) && str(member.id) && str(member.name)))
  else if (method === 'session.get') need(value === null || approvalsObject(value, ['value']) && str(value.value))
  else if (method === 'session.put' || method === 'session.erase') need(approvalsObject(value, ['ok']) && value.ok === true)
  // a490g: what the link engine reads from the hosted daemon. No context and no attachments cross: the chart needs ids, status, title, options and the answer only.
  else if (method === 'daemon.decisions.list') need(Array.isArray(value) && value.length <= 500 && value.every(item => approvalsObject(item, ['id']) && decisionId(item.id)))
  else if (method === 'daemon.decisions.read') need(value === null || approvalsObject(value, ['id', 'title', 'status', 'version', 'urgency', 'options', 'sessionLabel', 'requester', 'answer', 'cancelReason', 'createdAt', 'updatedAt'], ['recommendation', 'deadline'])
    && decisionId(value.id) && str(value.title) && STATUSES.includes(value.status) && Number.isInteger(value.version) && str(value.urgency) && str(value.sessionLabel) && strOrNull(value.requester) && strOrNull(value.cancelReason)
    && Array.isArray(value.options) && value.options.every(option => approvalsObject(option, ['id', 'label']) && str(option.id) && str(option.label))
    && (value.answer === null || approvalsObject(value.answer, ['optionId', 'text', 'answeredAt']) && strOrNull(value.answer.optionId) && strOrNull(value.answer.text) && strOrNull(value.answer.answeredAt)))
  else invalid()
}

const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
export function assertApprovalsStateCompatibility(value) {
  if (!approvalsObject(value, Object.keys(APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY)) || Object.entries(APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY).some(([key, expected]) => value[key] !== expected))
    throw approvalsError('APPROVALS_STATE_INCOMPATIBLE', 503)
}
export function validateApprovalsControl(method, params) {
  if (!controls.has(method) || (method === 'initialize' ? !approvalsObject(params, ['generation', 'mode']) || !validApprovalsGeneration(params.generation) || !['bootstrap', 'restore'].includes(params.mode)
    : !approvalsObject(params, []))) throw approvalsError('APPROVALS_CONTROL_INVALID')
}
export function validateApprovalsControlResult(method, value) {
  if (method === 'initialize') { need(approvalsObject(value, ['stateCompatibility'])); assertApprovalsStateCompatibility(value.stateCompatibility) }
  else need(method === 'quiesce' ? approvalsObject(value, ['quiesced']) && typeof value.quiesced === 'boolean'
    : method === 'resume' ? approvalsObject(value, ['resumed']) && value.resumed === true : method === 'exit' && approvalsObject(value, ['closed']) && value.closed === true)
}
export function validateApprovalsReady(value) {
  if (!approvalsObject(value, ['versionId', 'protocolVersion', 'stateCompatibility']) || value.versionId !== null && (!str(value.versionId) || !/^[a-f0-9]{64}$/u.test(value.versionId))
    || value.protocolVersion !== APPROVAL_BOX_EXTENSION_PROTOCOL_VERSION) throw approvalsError('APPROVALS_READY_INVALID', 503)
  assertApprovalsStateCompatibility(value.stateCompatibility)
}

// Result shapes the parent checks before it hands a value to the HTTP handler.
const connection = value => approvalsObject(value, ['state', 'entitled', 'entitlement'], ['connectedAt', 'expiresAt']) && ['connected', 'waiting', 'denied', 'not_connected', 'expired'].includes(value.state)
  && typeof value.entitled === 'boolean' && plain(value.entitlement) && str(value.entitlement.state)

export function validateApprovalsResult(method, value) {
  if (method === 'byDecision') need(value === null || approvalsObject(value, ['project', 'plan', 'task', 'state', 'attached']) && str(value.project) && PROJECT_ID.test(value.project) && str(value.plan) && REF.test(value.plan)
    && str(value.task) && REF.test(value.task) && ['linked', 'answered', 'closed', 'diverged'].includes(value.state) && typeof value.attached === 'boolean')
  else if (method === 'byTask') need(value === null || approvalsObject(value, ['decisionId', 'status', 'title']) && decisionId(value.decisionId) && STATUSES.includes(value.status) && str(value.title))
  else if (method === 'connection' || method === 'cancelConnect' || method === 'disconnect') need(connection(value))
  else if (method === 'connect') need(approvalsObject(value, ['authorizationUrl', 'expiresAt']) && str(value.authorizationUrl) && /^https:\/\//u.test(value.authorizationUrl) && str(value.expiresAt))
  else if (method === 'refresh') need(approvalsObject(value, ['seq', 'events', 'summary']) && count(value.seq) && Array.isArray(value.events)
    && value.events.every(event => approvalsObject(event, ['type', 'id', 'version']) && ['decision.created', 'decision.updated', 'decision.deleted'].includes(event.type) && decisionId(event.id) && count(event.version))
    && value.summary === null) // no summary any more (a490h2): the apps count from their device session
  else invalid()
}

const knownErrors = new Map([
  ['APPROVALS_INVALID', 400], ['APPROVALS_CONTROL_INVALID', 400], ['APPROVALS_VALIDATION_FAILED', 400], ['APPROVALS_NOT_FOUND', 404], ['APPROVALS_NOT_ACCEPTED', 503],
  ['APPROVALS_UNAVAILABLE', 503], ['APPROVALS_NOT_QUIESCED', 503], ['APPROVALS_EFFECT_FAILED', 503], ['APPROVALS_NOT_ENTITLED', 403], ['APPROVALS_NOT_CONNECTED', 409],
  ['APPROVALS_SUBSCRIPTION_EXPIRED', 402], ['APPROVALS_RATE_LIMITED', 429],
])
export function approvalsWireError(error, outcome) {
  const code = knownErrors.has(error?.code) ? error.code : knownErrors.has(error?.message) ? error.message : 'APPROVALS_OPERATION_FAILED'
  return { code, status: knownErrors.get(code) ?? 503, outcome }
}
