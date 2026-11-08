export const WORK_GRAPH_PROTOCOL_VERSION = 1
export const WORK_GRAPH_STATE_COMPATIBILITY = Object.freeze({ state: 'none' })
export const WORK_GRAPH_METHODS = Object.freeze(['refresh', 'snapshot'])
export const WORK_GRAPH_EFFECTS = Object.freeze(['members.list', 'turns.read', 'queue.read', 'room.messages'])
export const workGraphError = (code, status = 400) => Object.assign(new Error(code), { code, status, outcome: 'not_accepted' })
export const workGraphObject = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
export const validWorkGraphGeneration = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/u.test(value)

const str = value => typeof value === 'string'
const strOrNull = value => value === null || str(value)
const list = (value, each) => Array.isArray(value) && value.every(each)
const invalid = () => { throw workGraphError('WORK_GRAPH_IPC_INVALID', 503) }
const need = condition => { if (!condition) invalid() }

export function validateWorkGraphRequest(method, params, context) {
  const check = condition => { if (!condition) throw workGraphError('WORK_GRAPH_INVALID') }
  check(workGraphObject(context, ['generation']) && validWorkGraphGeneration(context.generation))
  check(WORK_GRAPH_METHODS.includes(method) && workGraphObject(params, []))
}

export function validateWorkGraphEffect(method, params) {
  const check = condition => { if (!condition) throw workGraphError('WORK_GRAPH_INVALID') }
  check(WORK_GRAPH_EFFECTS.includes(method))
  if (method === 'turns.read') check(workGraphObject(params, ['botIds']) && Array.isArray(params.botIds)
    && params.botIds.length >= 1 && params.botIds.length <= 200 && params.botIds.every(id => str(id) && id.length > 0 && id.length <= 128))
  else if (method === 'room.messages') check(workGraphObject(params, ['roomId']) && str(params.roomId) && params.roomId.length > 0 && params.roomId.length <= 256)
  else check(workGraphObject(params, []))
}

const queueItem = item => workGraphObject(item, ['status', 'context', 'contextId', 'groupId', 'from', 'target', 'requestSummary', 'image', 'steered', 'startedAt'])
  && str(item.status) && str(item.context) && strOrNull(item.contextId) && strOrNull(item.groupId) && strOrNull(item.from) && strOrNull(item.target)
  && strOrNull(item.requestSummary) && typeof item.image === 'boolean' && typeof item.steered === 'boolean'
  && (item.startedAt === null || str(item.startedAt) || typeof item.startedAt === 'number')
const turn = value => workGraphObject(value, ['state', 'turnId'], ['startedAt', 'summary', 'summaryStatus']) && ['working', 'idle', 'unknown'].includes(value.state)
  && strOrNull(value.turnId) && (value.startedAt === undefined || strOrNull(value.startedAt))
  && (value.summary === undefined || strOrNull(value.summary) && (value.summary === null || value.summary.length <= 200))
  && (value.summaryStatus === undefined || ['current', 'missing', 'stale'].includes(value.summaryStatus))

export function validateWorkGraphEffectResult(method, value) {
  if (method === 'members.list') need(workGraphObject(value, ['members']) && list(value.members, member =>
    workGraphObject(member, ['id', 'name', 'color', 'avatarVersion', 'deleting']) && str(member.id) && str(member.name)
    && str(member.color) && str(member.avatarVersion) && typeof member.deleting === 'boolean'))
  else if (method === 'turns.read') need(workGraphObject(value, ['unsupported']) ? value.unsupported === true
    : workGraphObject(value, ['turns']) && value.turns && typeof value.turns === 'object' && !Array.isArray(value.turns) && Object.values(value.turns).every(turn))
  else if (method === 'queue.read') need(workGraphObject(value, ['items']) && list(value.items, queueItem))
  else if (method === 'room.messages') need(workGraphObject(value, ['items']) && list(value.items, message =>
    workGraphObject(message, ['id', 'routing']) && str(message.id) && (message.routing === null
      || workGraphObject(message.routing, ['responders', 'status']) && list(message.routing.responders, str) && str(message.routing.status))))
  else invalid()
}

const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
export function assertWorkGraphStateCompatibility(value) {
  if (!workGraphObject(value, Object.keys(WORK_GRAPH_STATE_COMPATIBILITY))
    || Object.entries(WORK_GRAPH_STATE_COMPATIBILITY).some(([key, expected]) => value[key] !== expected))
    throw workGraphError('WORK_GRAPH_STATE_INCOMPATIBLE', 503)
}

export function validateWorkGraphControl(method, params) {
  if (!controls.has(method) || (method === 'initialize'
    ? !workGraphObject(params, ['generation', 'mode']) || !validWorkGraphGeneration(params.generation) || !['bootstrap', 'restore'].includes(params.mode)
    : !workGraphObject(params, []))) throw workGraphError('WORK_GRAPH_CONTROL_INVALID')
}

export function validateWorkGraphControlResult(method, value) {
  if (method === 'initialize') {
    need(workGraphObject(value, ['stateCompatibility']))
    assertWorkGraphStateCompatibility(value.stateCompatibility)
  } else need(method === 'quiesce' ? workGraphObject(value, ['quiesced']) && typeof value.quiesced === 'boolean'
    : method === 'resume' ? workGraphObject(value, ['resumed']) && value.resumed === true
      : method === 'exit' && workGraphObject(value, ['closed']) && value.closed === true)
}

export function validateWorkGraphReady(value) {
  if (!workGraphObject(value, ['versionId', 'protocolVersion', 'stateCompatibility'])
    || value.versionId !== null && (!str(value.versionId) || !/^[a-f0-9]{64}$/u.test(value.versionId))
    || value.protocolVersion !== WORK_GRAPH_PROTOCOL_VERSION) throw workGraphError('WORK_GRAPH_READY_INVALID', 503)
  assertWorkGraphStateCompatibility(value.stateCompatibility)
}

const node = value => workGraphObject(value, ['botId', 'name', 'color', 'avatarVersion', 'state', 'activeSince'])
  && str(value.botId) && str(value.name) && str(value.color) && str(value.avatarVersion) && ['working', 'linked'].includes(value.state) && str(value.activeSince)
const edge = value => workGraphObject(value, ['id', 'requestId', 'from', 'to', 'context', 'roomId', 'label', 'state', 'startedAt'])
  && str(value.id) && str(value.requestId) && str(value.from) && str(value.to) && ['direct', 'room'].includes(value.context)
  && strOrNull(value.roomId) && str(value.label) && ['running', 'steered'].includes(value.state) && str(value.startedAt)
const change = value => value && (value.type === 'member-enter' || value.type === 'member-update' ? workGraphObject(value, ['type', 'node']) && node(value.node)
  : value.type === 'edge-start' || value.type === 'edge-update' ? workGraphObject(value, ['type', 'edge']) && edge(value.edge)
    : value.type === 'edge-end' ? workGraphObject(value, ['type', 'edgeId']) && str(value.edgeId)
      : value.type === 'member-leave' && workGraphObject(value, ['type', 'botId']) && str(value.botId))
const head = value => str(value.epoch) && value.epoch.length > 0 && Number.isInteger(value.version) && value.version >= 0 && str(value.at) && list(value.degraded, str)

export function validateWorkGraphResult(method, value) {
  if (method === 'refresh') need(workGraphObject(value, ['batch', 'nextRefreshMs'])
    && (value.nextRefreshMs === null || Number.isInteger(value.nextRefreshMs) && value.nextRefreshMs >= 0)
    && (value.batch === null || workGraphObject(value.batch, ['epoch', 'version', 'at', 'degraded', 'changes']) && head(value.batch)
      && value.batch.version >= 1 && list(value.batch.changes, change)))
  else if (method === 'snapshot') need(workGraphObject(value, ['schema', 'epoch', 'version', 'at', 'degraded', 'nodes', 'edges'])
    && value.schema === 'bellteam.work-graph.v1' && head(value) && list(value.nodes, node) && list(value.edges, edge))
  else invalid()
}

const knownErrors = new Map([
  ['WORK_GRAPH_INVALID', 400], ['WORK_GRAPH_CONTROL_INVALID', 400],
  ['WORK_GRAPH_NOT_ACCEPTED', 503], ['WORK_GRAPH_UNAVAILABLE', 503], ['WORK_GRAPH_NOT_QUIESCED', 503], ['WORK_GRAPH_EFFECT_FAILED', 503],
])
export function workGraphWireError(error, outcome) {
  const code = knownErrors.has(error?.code) ? error.code : knownErrors.has(error?.message) ? error.message : 'WORK_GRAPH_OPERATION_FAILED'
  return { code, status: knownErrors.get(code) ?? 503, outcome }
}
