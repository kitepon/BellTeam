export const LATTICE_PROTOCOL_VERSION = 1
export const LATTICE_STATE_COMPATIBILITY = Object.freeze({ state: 'none' })
export const LATTICE_METHODS = Object.freeze(['charts', 'chart', 'refresh', 'run', 'deliver', 'nudge', 'blockers', 'unblock'])
export const LATTICE_EFFECTS = Object.freeze(['members.list', 'messages.send', 'turns.read', 'decisions.file', 'decisions.read'])
// An Approval Box decision id (README L18-L19).
export const LATTICE_DECISION_ID = /^K-[A-Z0-9]{4,16}$/u
export const LATTICE_PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
// A stop's id in the Owner's stop list (README Stops): 24 hex of sha256(projectId, plan, task, blockedAt).
export const LATTICE_STOP_ID = /^[a-f0-9]{24}$/u
// A chart's display name: 1-40 characters of plain text, no control characters, no surrounding spaces.
export const validLatticeName = value => typeof value === 'string' && value === value.trim() && [...value].length >= 1 && [...value].length <= 40 && !/\p{Cc}/u.test(value)
export const latticeError = (code, status = 400) => Object.assign(new Error(code), { code, status, outcome: 'not_accepted' })
export const latticeObject = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
export const validLatticeGeneration = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/u.test(value)

const str = value => typeof value === 'string'
const strOrNull = value => value === null || str(value)
const list = (value, each) => Array.isArray(value) && value.every(each)
const count = value => Number.isInteger(value) && value >= 0
const validId = value => str(value) && LATTICE_PROJECT_ID.test(value)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw latticeError('LATTICE_IPC_INVALID', 503) }
const need = condition => { if (!condition) invalid() }

export function validateLatticeRequest(method, params, context) {
  const check = condition => { if (!condition) throw latticeError('LATTICE_INVALID') }
  const project = id => { if (!validId(id)) throw latticeError('LATTICE_PROJECT_INVALID') }
  check(latticeObject(context, ['generation']) && validLatticeGeneration(context.generation))
  check(LATTICE_METHODS.includes(method))
  if (['charts', 'deliver', 'nudge', 'blockers'].includes(method)) check(latticeObject(params, []))
  else if (method === 'unblock') { check(latticeObject(params, ['projectId', 'stopId']) && str(params.stopId) && LATTICE_STOP_ID.test(params.stopId)); project(params.projectId) }
  else if (method === 'chart') { check(latticeObject(params, ['projectId'])); project(params.projectId) }
  else if (method === 'refresh') {
    check(latticeObject(params, ['projectIds']) && Array.isArray(params.projectIds) && params.projectIds.length >= 1 && params.projectIds.length <= 50
      && new Set(params.projectIds).size === params.projectIds.length)
    params.projectIds.forEach(project)
  } else {
    check(latticeObject(params, ['from', 'projectId', 'args', 'input'], ['name']) && str(params.from) && params.from.length >= 1 && params.from.length <= 128)
    if (Object.hasOwn(params, 'name') && !validLatticeName(params.name)) throw latticeError('LATTICE_NAME_INVALID')
    project(params.projectId)
    check(Array.isArray(params.args) && params.args.length <= 200 && params.args.every(arg => str(arg) && arg.length <= 8192)
      && (params.input === null || plain(params.input)))
  }
}

const sendText = (value, max) => str(value) && value.length >= 1 && value.length <= max
export function validateLatticeEffect(method, params) {
  if (!LATTICE_EFFECTS.includes(method)) throw latticeError('LATTICE_INVALID')
  if (method === 'members.list' ? !latticeObject(params, [])
    : method === 'decisions.file' ? !latticeObject(params, ['title', 'context', 'options', 'requester', 'session_label']) || !sendText(params.title, 120)
      || !sendText(params.context, 20000) || !sendText(params.requester, 60) || !sendText(params.session_label, 200)
      || !Array.isArray(params.options) || params.options.length < 2 || params.options.length > 6
      || !params.options.every(option => latticeObject(option, ['id', 'label']) && sendText(option.id, 40) && sendText(option.label, 60))
    : method === 'decisions.read' ? !latticeObject(params, ['decisionId']) || !str(params.decisionId) || !LATTICE_DECISION_ID.test(params.decisionId)
    : method === 'turns.read' ? !latticeObject(params, ['botIds']) || !Array.isArray(params.botIds) || params.botIds.length < 1 || params.botIds.length > 200
      || new Set(params.botIds).size !== params.botIds.length || !params.botIds.every(id => sendText(id, 128))
    : !latticeObject(params, ['from', 'target', 'message']) || !sendText(params.from, 128) || !sendText(params.target, 128) || !sendText(params.message, 4000))
    throw latticeError('LATTICE_INVALID')
}

export function validateLatticeEffectResult(method, value) {
  if (method === 'members.list') need(latticeObject(value, ['members']) && list(value.members, member =>
    latticeObject(member, ['id', 'name', 'color', 'avatarVersion', 'deleting']) && str(member.id) && str(member.name)
    && str(member.color) && str(member.avatarVersion) && typeof member.deleting === 'boolean'))
  // delivery = the messenger's word (running, queued, steered, delivered, failed, ...) or 'refused' for a permanent refusal.
  else if (method === 'messages.send') need(latticeObject(value, ['delivery', 'deliveryId'], ['code']) && sendText(value.delivery, 64)
    && strOrNull(value.deliveryId) && (value.code === undefined || sendText(value.code, 128)))
  else if (method === 'turns.read') need(latticeObject(value, ['turns']) && plain(value.turns)
    && Object.values(value.turns).every(state => ['working', 'idle', 'unknown'].includes(state)))
  else if (method === 'decisions.file') need(latticeObject(value, ['decisionId', 'existing']) && str(value.decisionId)
    && LATTICE_DECISION_ID.test(value.decisionId) && typeof value.existing === 'boolean')
  else if (method === 'decisions.read') need(latticeObject(value, ['status'], ['answer']) && ['pending', 'held', 'answered', 'cancelled'].includes(value.status)
    && (value.answer === undefined || latticeObject(value.answer, [], ['optionId', 'text']) && (value.answer.optionId === undefined || str(value.answer.optionId))
      && (value.answer.text === undefined || str(value.answer.text))))
  else invalid()
}

const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
export function assertLatticeStateCompatibility(value) {
  if (!latticeObject(value, Object.keys(LATTICE_STATE_COMPATIBILITY))
    || Object.entries(LATTICE_STATE_COMPATIBILITY).some(([key, expected]) => value[key] !== expected))
    throw latticeError('LATTICE_STATE_INCOMPATIBLE', 503)
}

export function validateLatticeControl(method, params) {
  if (!controls.has(method) || (method === 'initialize'
    ? !latticeObject(params, ['generation', 'mode']) || !validLatticeGeneration(params.generation) || !['bootstrap', 'restore'].includes(params.mode)
    : !latticeObject(params, []))) throw latticeError('LATTICE_CONTROL_INVALID')
}

export function validateLatticeControlResult(method, value) {
  if (method === 'initialize') {
    need(latticeObject(value, ['stateCompatibility']))
    assertLatticeStateCompatibility(value.stateCompatibility)
  } else need(method === 'quiesce' ? latticeObject(value, ['quiesced']) && typeof value.quiesced === 'boolean'
    : method === 'resume' ? latticeObject(value, ['resumed']) && value.resumed === true
      : method === 'exit' && latticeObject(value, ['closed']) && value.closed === true)
}

export function validateLatticeReady(value) {
  if (!latticeObject(value, ['versionId', 'protocolVersion', 'stateCompatibility'])
    || value.versionId !== null && (!str(value.versionId) || !/^[a-f0-9]{64}$/u.test(value.versionId))
    || value.protocolVersion !== LATTICE_PROTOCOL_VERSION) throw latticeError('LATTICE_READY_INVALID', 503)
  assertLatticeStateCompatibility(value.stateCompatibility)
}

const DISPLAY_STATES = ['verified', 'unverified', 'last_verified', 'unavailable']
const CARD_STATES = ['pending', 'ready', 'in-progress', 'blocked', 'done', 'retired']
const card = value => latticeObject(value, ['id', 'plan', 'taskId', 'title', 'doneCondition', 'designMemo', 'state', 'lane', 'producer',
  'startedAt', 'changedAt', 'blockedReason', 'depth'], ['phase', 'parent', 'doneAt', 'archived']) && ['id', 'plan', 'taskId', 'title'].every(key => str(value[key]))
  && [value.phase, value.parent, value.doneAt].every(item => item === undefined || strOrNull(item))
  && (value.archived === undefined || typeof value.archived === 'boolean')
  && ['doneCondition', 'designMemo', 'lane', 'producer', 'startedAt', 'changedAt', 'blockedReason'].every(key => strOrNull(value[key]))
  && CARD_STATES.includes(value.state) && count(value.depth)
const edge = value => latticeObject(value, ['from', 'to', 'waiting']) && str(value.from) && str(value.to) && typeof value.waiting === 'boolean'
const wait = value => latticeObject(value, ['waiter', 'waitingCard', 'forCard', 'producer', 'producerState', 'since'])
  && strOrNull(value.waiter) && str(value.waitingCard) && str(value.forCard) && strOrNull(value.producer)
  && CARD_STATES.includes(value.producerState) && strOrNull(value.since)
const phase = value => latticeObject(value, ['id', 'title']) && str(value.id) && strOrNull(value.title)
const member = value => latticeObject(value, ['botId', 'name', 'color', 'avatarVersion']) && Object.values(value).every(str)
const counts = value => latticeObject(value, ['total', 'done', 'working', 'waiting', 'blocked']) && Object.values(value).every(count)
const snapshot = value => latticeObject(value, ['schema', 'epoch', 'version', 'at', 'projectId', 'name', 'createdBy', 'coordinator', 'state', 'verifiedAt', 'degraded',
  'members', 'cards', 'edges', 'waits'], ['phases']) && value.schema === 'bellteam.lattice-chart.v1' && str(value.epoch) && value.epoch.length > 0
  && Number.isInteger(value.version) && value.version >= 1 && str(value.at) && validId(value.projectId) && strOrNull(value.name) && strOrNull(value.createdBy)
  && typeof value.coordinator === 'boolean'
  && DISPLAY_STATES.includes(value.state) && strOrNull(value.verifiedAt) && list(value.degraded, item => ['lattice-read', 'members'].includes(item))
  && list(value.members, member) && list(value.cards, card) && list(value.edges, edge) && list(value.waits, wait)
  && (value.phases === undefined || list(value.phases, phase))
const stop = value => latticeObject(value, ['stopId', 'projectId', 'chartName', 'chartCreatedBy', 'plan', 'taskId', 'cardId', 'title', 'lane', 'reason', 'blockedAt', 'blockedBy'])
  && str(value.stopId) && LATTICE_STOP_ID.test(value.stopId) && validId(value.projectId) && ['plan', 'taskId', 'cardId'].every(key => str(value[key]))
  && ['chartName', 'chartCreatedBy', 'title', 'lane', 'reason', 'blockedAt', 'blockedBy'].every(key => strOrNull(value[key]))
const summary = value => latticeObject(value, ['projectId', 'name', 'coordinator', 'createdBy', 'counts', 'activeMembers', 'updatedAt', 'state'])
  && validId(value.projectId) && strOrNull(value.name) && typeof value.coordinator === 'boolean' && strOrNull(value.createdBy) && counts(value.counts)
  && list(value.activeMembers, str) && strOrNull(value.updatedAt) && DISPLAY_STATES.includes(value.state)

export function validateLatticeResult(method, value) {
  if (method === 'charts') need(latticeObject(value, ['schema', 'at', 'charts']) && value.schema === 'bellteam.lattice-charts.v1'
    && str(value.at) && list(value.charts, summary))
  else if (method === 'chart') need(snapshot(value))
  else if (method === 'refresh') need(latticeObject(value, ['snapshots', 'nextRefreshMs']) && list(value.snapshots, snapshot) && count(value.nextRefreshMs))
  else if (method === 'run') need(latticeObject(value, ['exitCode', 'result', 'stdout', 'stderr'])
    && (value.exitCode === null || Number.isInteger(value.exitCode)) && strOrNull(value.stdout) && str(value.stderr))
  else if (method === 'deliver') need(latticeObject(value, ['delivered', 'failed']) && count(value.delivered) && count(value.failed))
  else if (method === 'blockers') need(latticeObject(value, ['schema', 'at', 'blockers', 'unreadCharts']) && value.schema === 'bellteam.lattice-blockers.v1'
    && str(value.at) && list(value.blockers, stop) && list(value.unreadCharts, validId))
  else if (method === 'unblock') need(latticeObject(value, ['schema', 'projectId', 'stopId', 'outcome'], ['code', 'reason']) && value.schema === 'bellteam.lattice-unblock.v1'
    && validId(value.projectId) && str(value.stopId) && LATTICE_STOP_ID.test(value.stopId) && ['removed', 'already-gone', 'refused'].includes(value.outcome)
    && (value.outcome === 'refused' ? str(value.code) && str(value.reason) : value.code === undefined && value.reason === undefined))
  // filed/routed are optional so a body with this validator also takes an older child (README L13, L18-L19).
  else if (method === 'nudge') need(latticeObject(value, ['charts', 'prompted', 'skipped', 'failed'], ['filed', 'routed'])
    && [value.charts, value.prompted, value.skipped, value.failed, value.filed ?? 0, value.routed ?? 0].every(count))
  else invalid()
}

const knownErrors = new Map([
  ['LATTICE_INVALID', 400], ['LATTICE_CONTROL_INVALID', 400], ['LATTICE_CHART_NOT_FOUND', 404], ['LATTICE_PROJECT_INVALID', 400],
  ['LATTICE_INPUT_CONFLICT', 400], ['LATTICE_NAME_INVALID', 400], ['LATTICE_COMMAND_NOT_SEAT_SURFACE', 400], ['LATTICE_NOT_ACCEPTED', 503], ['LATTICE_UNAVAILABLE', 503],
  ['LATTICE_NOT_QUIESCED', 503], ['LATTICE_EFFECT_FAILED', 503], ['LATTICE_DECISIONS_UNAVAILABLE', 503],
])
export function latticeWireError(error, outcome) {
  const code = knownErrors.has(error?.code) ? error.code : knownErrors.has(error?.message) ? error.message : 'LATTICE_OPERATION_FAILED'
  return { code, status: knownErrors.get(code) ?? 503, outcome }
}
