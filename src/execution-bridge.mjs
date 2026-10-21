// Adapter for Aiterm execution wire v1; not mounted on the live transport yet.
// Aiterm owns relation storage, generation checks, fences and retirement.
import { isDeepStrictEqual as same } from 'node:util'
import { requestSessionInterruption } from './session-interruption.mjs'

export const EXECUTION_META = 'aiterm/execution'
export const BINDING_META = 'aiterm/execution_binding'
export const ERROR_META = 'aiterm/execution_error'
export const SOURCE_META = 'aiterm/execution_source'
const codes = new Set(['INVALID', 'NOT_FOUND', 'CONFLICT', 'STOPPING', 'STALE_GENERATION', 'UNCONFIRMED', 'BUSY', 'STATE_UNAVAILABLE', 'UNSUPPORTED'].map(value => `EXECUTION_${value}`))
const session = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
const launch = value => value && session(value.session_id) && typeof value.launch_id === 'string' && /^[0-9a-f]{32}$/u.test(value.launch_id)
const boundary = value => value && Number.isInteger(value.event_cursor) && value.event_cursor >= 0
  && (value.operation_id === null || typeof value.operation_id === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.operation_id))
  && (value.turn_id === null || typeof value.turn_id === 'string' && value.turn_id.length > 0)
  && (value.steer_id === null || typeof value.steer_id === 'string' && /^[0-9a-f]{16}$/u.test(value.steer_id))
const point = value => value && launch(value.launch) && (value.boundary === null || boundary(value.boundary))
const sourceResult = value => value && ['verified', 'unknown', 'stale'].includes(value.status)
  && ['matched', 'launch_unavailable', 'launch_changed', 'caller_unbound'].includes(value.reason)
  && ['matched', 'missing', 'mismatch'].includes(value.boundary_status) && (value.point === null || point(value.point))
  && (value.status !== 'verified' || point(value.point))

export function returnedExecutionError(value) {
  return value?.schema === 'aiterm.execution-error.v1' && codes.has(value.code)
    && ['not_started', 'possible'].includes(value.effect) && ['none', 'status_only'].includes(value.follow_up)
    ? { schema: value.schema, code: value.code, effect: value.effect, follow_up: value.follow_up } : null
}
const failure = (code = 'EXECUTION_UNCONFIRMED', effect = 'possible', cause) =>
  Object.assign(new Error(code, { cause }), { code, effect, follow_up: 'status_only' })

async function call(client, name, args, options) {
  try {
    const result = await client.call(name, args, options)
    if (result?.isError) {
      const receipt = returnedExecutionError(result._meta?.[ERROR_META])
      throw receipt ? Object.assign(failure(receipt.code, receipt.effect), receipt) : failure()
    }
    return result
  } catch (cause) {
    const receipt = returnedExecutionError(cause.executionError)
    if (receipt) throw Object.assign(failure(receipt.code, receipt.effect, cause), receipt)
    if (codes.has(cause.code) && ['not_started', 'possible'].includes(cause.effect)) throw cause
    throw failure('EXECUTION_UNCONFIRMED', 'possible', cause)
  }
}
function readRecord(result, request, reservation = null) {
  const record = result?.structuredContent
  if (record?.schema !== 'aiterm.execution-record.v1' || !same(record.reservation?.request, request)
    || (reservation && !same(record.reservation, reservation)) || !same(record.relation?.request, request)
    || !['open', 'completed', 'interrupted', 'unknown'].includes(record.relation.completion)
    || !['open', 'closed', 'unknown'].includes(record.relation.target_fence)
    || !['tracking', 'retired'].includes(record.relation.lifecycle) || !sourceResult(record.source)
    || (record.relation.target !== null && !point(record.relation.target))
    || (record.relation.lifecycle === 'retired' && record.relation.phase !== 'unsent'
      && (record.relation.target_fence !== 'closed' || !['completed', 'interrupted'].includes(record.relation.completion)))) throw failure()
  return record
}

export function deliveryExecutionRef(deliveryId, targetSession) {
  if (typeof deliveryId !== 'string' || !deliveryId.length || !session(targetSession)) throw failure('EXECUTION_INVALID', 'not_started')
  return { kind: 'delivery', delivery_id: deliveryId, target_session_id: targetSession }
}
export function roomExecutionRef(messageId, targetSession) {
  deliveryExecutionRef(messageId, targetSession)
  return { kind: 'room', message_id: messageId, target_session_id: targetSession }
}
export function callExecutionRef({ sessionId, event, seq, deliveryId }, targetSession) {
  if (typeof sessionId === 'string' && sessionId && ['session.message', 'session.reply'].includes(event)
    && Number.isSafeInteger(seq) && seq >= 0 && session(targetSession))
    return { kind: 'call', call_session_id: sessionId, event, seq, target_session_id: targetSession }
  return deliveryExecutionRef(deliveryId, targetSession)
}

export class ExecutionBridge {
  constructor(client) { this.client = client }
  async interrupt(roots) {
    return requestSessionInterruption(args => call(this.client, 'agent_stop', args), roots)
  }
  async reserve({ request, sourceSession = null, source = { launch: null, boundary: null }, targetSession, expectedLaunch = null }, { sourceContext = null, ...options } = {}) {
    // Host-only context comes from the captured ingress, separately from the
    // public register claim. Missing context must never fall back to that claim.
    if (sourceContext !== null && !point(sourceContext)) throw failure('EXECUTION_INVALID', 'not_started')
    const meta = { ...options.meta, [SOURCE_META]: {
      schema: 'aiterm.execution-source.v1', source: structuredClone(sourceContext),
    } }
    const reservation = structuredClone({ schema: 'aiterm.execution-reservation.v1', request, source,
      target: { session_id: targetSession, expected_launch_id: expectedLaunch } })
    const handle = new ExecutionRequest(this.client, reservation)
    handle.record = readRecord(await call(this.client, 'agent_execution', {
      action: 'register', source_session_id: sourceSession, reservation,
    }, { ...options, meta }), reservation.request, reservation)
    handle.registered = true
    return handle
  }
  async status(request) {
    return readRecord(await call(this.client, 'agent_execution', { action: 'status', request }), request)
  }
  async roots(sessionId) {
    if (!session(sessionId)) throw failure('EXECUTION_INVALID', 'not_started')
    const data = (await call(this.client, 'agent_execution_roots', { session_id: sessionId }))?.structuredContent
    if (data?.schema !== 'aiterm.execution-roots.v1' || data.session_id !== sessionId
      || !['present', 'absent', 'unknown'].includes(data.observation)
      || (data.current !== null && (!launch(data.current) || data.current.session_id !== sessionId))
      || !Array.isArray(data.roots) || !data.roots.every(root => launch(root) && root.session_id === sessionId)
      || !['complete', 'incomplete'].includes(data.relation_coverage) || !Array.isArray(data.unresolved)
      || (data.relation_coverage === 'complete' && (data.unresolved.length || data.observation === 'unknown'
        || data.observation === 'present' && (!data.current || !data.roots.some(root => same(root, data.current)))))) throw failure()
    // Empty roots are a read result, never an implicit successful stop.
    return data
  }
  async stop(roots) {
    // Historical close-based v1 transport; not eligible for owner stop UI.
    // Production wiring stays blocked until this caller is replaced by v2.
    if (!Array.isArray(roots) || !roots.length || !roots.every(launch)) throw failure('EXECUTION_INVALID', 'not_started')
    const expected = structuredClone(roots)
    const result = await call(this.client, 'agent_stop', { schema: 'aiterm.cascade-stop-request.v1', roots: expected })
    if (result?._meta?.[ERROR_META]) throw failure()
    const data = result?.structuredContent
    if (data?.schema !== 'aiterm.cascade-stop-result.v1' || !same(data.roots, expected)
      || !['stopped', 'partial', 'unconfirmed'].includes(data.status)
      || !['complete', 'incomplete'].includes(data.relation_coverage) || !Array.isArray(data.unresolved)
      || !Array.isArray(data.targets) || !data.targets.every(item => item && launch(item.launch)
        && ['closed', 'already_closed', 'unknown', 'unsupported', 'replaced'].includes(item.outcome))) throw failure()
    if (data.status === 'stopped' && (data.relation_coverage !== 'complete' || data.unresolved.length
      || data.targets.some(item => !['closed', 'already_closed'].includes(item.outcome))
      || expected.some(root => !data.targets.some(item => same(item.launch, root))))) throw failure()
    return data
  }
}

class ExecutionRequest {
  constructor(client, reservation) {
    this.client = client
    this.reservation = reservation
    this.record = null
    this.binding = null
    this.trackingError = null
    this.registered = false
    this.issued = new Set()
    this.unknownStages = new Set()
  }
  async invoke(name, args, options = {}) {
    if (!this.registered || !['agent_launch', 'pty_send'].includes(name)) throw failure('EXECUTION_INVALID', 'not_started')
    if ((name === 'pty_send' ? args.session_id : args.session_name) !== this.reservation.target.session_id)
      throw failure('EXECUTION_INVALID', 'not_started')
    if (this.unknownStages.size) throw failure()
    const stage = name === 'agent_launch' ? 'launch' : 'send'
    if (this.issued.has(stage)) throw failure('EXECUTION_CONFLICT', 'not_started')
    this.issued.add(stage)
    const promptedLaunch = stage === 'launch' && typeof args.prompt === 'string' && args.prompt.length > 0
    if (promptedLaunch) this.issued.add('send')
    let result
    try {
      result = await call(this.client, name, args, { ...options,
        meta: { ...options.meta, [EXECUTION_META]: { schema: 'aiterm.execution-ref.v1', request: this.reservation.request } },
      })
    } catch (error) {
      this.trackingError = error.code
      if (error.effect === 'possible') this.unknownStages.add(stage)
      throw error
    }
    this.acceptBinding(result)
    if (!this.binding?.target || this.binding.phase === 'submitted_unknown') this.unknownStages.add(stage)
    if (stage === 'launch' && this.binding?.target?.boundary) this.issued.add('send')
    return result
  }
  acceptBinding(result, record = null) {
    const binding = result?._meta?.[BINDING_META], reported = result?._meta?.[ERROR_META], target = binding?.target
    const valid = binding?.schema === 'aiterm.execution-binding.v1' && same(binding.request, this.reservation.request)
      && sourceResult(binding.source)
      && (binding.source.status !== 'verified' || same(binding.source.point.launch, this.reservation.source.launch))
      && ['reserved', 'invoked', 'submitted_unknown', 'unsent'].includes(binding.phase)
      && (!record || same(record.relation.target, target) && record.relation.phase === binding.phase)
      && (target === null || point(target) && target.launch.session_id === this.reservation.target.session_id
        && (this.reservation.target.expected_launch_id === null || target.launch.launch_id === this.reservation.target.expected_launch_id))
    // Keep the action receipt, including steer/interim meta, when binding is missing or uncertain.
    this.binding = valid && !reported ? structuredClone(binding) : null
    this.trackingError = !valid || reported || !target || binding.source.status !== 'verified' || binding.phase === 'submitted_unknown'
      ? returnedExecutionError(reported)?.code ?? 'EXECUTION_UNCONFIRMED' : null
  }
  async status() {
    const result = await call(this.client, 'agent_execution', { action: 'status', request: this.reservation.request })
    this.record = readRecord(result, this.reservation.request, this.reservation)
    this.acceptBinding(result, this.record)
    if (this.binding) for (const stage of this.unknownStages)
      if (['accepted', 'not_sent'].includes(this.record.operations?.[stage])) this.unknownStages.delete(stage)
    return this.record
  }
  async finish(evidence) {
    if (!this.registered) throw failure('EXECUTION_INVALID', 'not_started')
    if (!['completion', 'interrupted', 'not_sent'].includes(evidence?.kind)) throw failure('EXECUTION_INVALID', 'not_started')
    if (evidence?.kind === 'completion' && (!this.binding?.target?.boundary || !same(evidence.target, this.binding.target))) throw failure()
    if (evidence?.kind === 'interrupted' && (!this.binding?.target || !same(evidence.target, this.binding.target.launch))) throw failure()
    this.record = readRecord(await call(this.client, 'agent_execution', {
      action: 'finish', request: this.reservation.request, evidence,
    }), this.reservation.request, this.reservation)
    // Local done is not a closed target fence or retired branch. Return Aiterm's record unchanged.
    return this.record
  }
}
