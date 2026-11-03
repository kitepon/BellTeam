import { validateMembersRequest, validateMembersCallback, validateMembersEffect,
  validateMembersResult, validateMembersEffectResult, validateMembersProjection } from './members/protocol.mjs'
import { MEMBERS_STATE_COMPATIBILITY, assertMembersStateCompatibility } from './members/state-compatibility.mjs'
import { MEMBERS_READ_PIN_METHODS } from './members-admission.mjs'
export { verifyMembersLocks } from './members-locks.mjs'
export { waitNotificationsChildClose as waitMembersChildClose } from './notifications-ipc.mjs'
export const MEMBERS_PAYLOAD_LIMIT = 16 * 1024 * 1024
export const MEMBERS_ENVELOPE_LIMIT = 64 * 1024
export const MEMBERS_BUFFER_LIMIT = 64 * 1024 * 1024
const lanes = new Set(['root', 'effect', 'callback', 'projection', 'diagnostic', 'control'])
const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
const business = kind => ['root', 'effect', 'callback', 'projection'].includes(kind)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',')
const idValid = value => Number.isSafeInteger(value) && value > 0
const codeValid = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value)
const generationValid = value => typeof value === 'string' && value.length > 0 && value.length <= 200
const contextValid = (value, initial = false) => keys(value, 'generation,leaseId,rootId,ownerWrite,continuation')
  && generationValid(value.generation) && typeof value.rootId === 'string'
  && /^[1-9][0-9]{0,15}$/.test(value.rootId) && Number.isSafeInteger(Number(value.rootId)) && typeof value.ownerWrite === 'boolean'
  && typeof value.continuation === 'boolean'
  && (typeof value.leaseId === 'string' && value.leaseId.length > 0 && value.leaseId.length <= 200
    || initial && value.leaseId === null && value.ownerWrite === false)
const sameContext = (left, right) => contextValid(left, true) && contextValid(right, true)
  && ['generation', 'leaseId', 'rootId', 'ownerWrite', 'continuation'].every(key => left[key] === right[key])
export const membersError = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })
const invalid = () => membersError('MEMBERS_IPC_INVALID')
const safeError = (error, outcome) => ({ code: codeValid(error?.code) ? error.code : 'MEMBERS_OPERATION_FAILED',
  outcome, status: [400, 403, 404, 409, 503].includes(error?.status) ? error.status : 503 })
const validError = value => keys(value, 'code,outcome,status') && codeValid(value.code)
  && ['unknown', 'not_accepted'].includes(value.outcome) && [400, 403, 404, 409, 503].includes(value.status)
const size = value => { try { return Buffer.byteLength(JSON.stringify(value)) } catch { return Infinity } }
const controlResultValid = (method, value) => method === 'initialize' ? keys(value, 'stateCompatibility')
  : method === 'quiesce' ? keys(value, 'quiesced') && typeof value.quiesced === 'boolean'
    : method === 'resume' ? keys(value, 'resumed') && value.resumed === true
      : keys(value, 'closed') && value.closed === true
const check = (value, code = 'MEMBERS_IPC_INVALID') => { if (!value) throw membersError(code, 'not_accepted') }

// These credits cover unsent frames and received frames waiting to enter a dispatcher.
function endpointChannel(endpoint, { validateResult, onRequest, onDisconnect, afterResponse = async () => {} }) {
  let sequence = 0, incoming = 0, dead = false, queued = 0, controlQueued = 0
  const pending = new Map(), running = new Set()
  const counts = { root: 0, effect: 0, callback: 0, projection: 0, diagnostic: 0, control: 0 }
  const reserve = (kind, bytes) => {
    const large = business(kind)
    check(Number.isFinite(bytes) && bytes <= (large ? MEMBERS_PAYLOAD_LIMIT + MEMBERS_ENVELOPE_LIMIT : MEMBERS_ENVELOPE_LIMIT), 'MEMBERS_IPC_MESSAGE_LIMIT')
    check((large ? queued : controlQueued) + bytes <= (large ? MEMBERS_BUFFER_LIMIT : 1024 * 1024), 'MEMBERS_IPC_CAPACITY')
    if (large) queued += bytes; else controlQueued += bytes
    let held = true
    return () => { if (!held) return; held = false; if (large) queued -= bytes; else controlQueued -= bytes }
  }
  const send = message => new Promise((resolve, reject) => {
    let release
    try {
      check(!dead && endpoint.connected, 'MEMBERS_IPC_DISCONNECTED')
      release = reserve(message.kind ?? 'control', size(message))
      endpoint.send(message, error => { release(); error ? reject(membersError('MEMBERS_IPC_SEND_FAILED')) : resolve() })
    } catch (error) { release?.(); reject(error) }
  })
  const errorReply = (message, error, outcome) => send({ type: 'result', kind: message.kind, id: message.id,
    ok: false, error: safeError(error, outcome) }).catch(() => {})
  const fail = () => {
    if (dead) return
    dead = true
    for (const task of pending.values()) task.reject(membersError('MEMBERS_IPC_DISCONNECTED'))
    onDisconnect?.()
  }
  const protocolFailure = () => { fail(); if (endpoint.connected) endpoint.disconnect() }
  const call = (kind, method, params, context, { timeout = 60000, beforeSend } = {}) => {
    let complete, incomplete, resolve, reject
    const completion = new Promise((yes, no) => { complete = yes; incomplete = no }); completion.catch(() => {})
    const result = new Promise((yes, no) => { resolve = yes; reject = no })
    Object.defineProperty(result, 'completion', { value: completion })
    const limit = business(kind) ? kind === 'projection' ? 1 : 8 : 16
    let id, task
    try {
      check(lanes.has(kind) && !dead && endpoint.connected, 'MEMBERS_IPC_DISCONNECTED')
      check(object(params) && size(params) <= (business(kind) ? MEMBERS_PAYLOAD_LIMIT : MEMBERS_ENVELOPE_LIMIT), 'MEMBERS_IPC_MESSAGE_LIMIT')
      check(counts[kind] < limit, 'MEMBERS_IPC_CAPACITY')
      check(sequence < Number.MAX_SAFE_INTEGER, 'MEMBERS_IPC_SEQUENCE')
      id = ++sequence
      if (typeof context === 'function') context = context(id)
      const message = { type: 'call', kind, id, method, params, ...(context ? { context } : {}) }
      check(size(message) - size(params) <= MEMBERS_ENVELOPE_LIMIT, 'MEMBERS_IPC_MESSAGE_LIMIT')
      // Reserve before exposing acceptance: a rejected frame has never been attempted.
      const release = reserve(kind, size(message)); release()
      task = { kind, method, context, accepted: false, resolve, reject, complete, incomplete }
      counts[kind]++; pending.set(id, task)
      task.ack = setTimeout(() => reject(membersError('MEMBERS_IPC_ACK_TIMEOUT')), 5000)
      task.deadline = setTimeout(() => reject(membersError('MEMBERS_IPC_TIMEOUT')), timeout)
      beforeSend?.(completion, context)
      void send(message).catch(error => reject(membersError(error.code)))
    } catch (error) {
      if (task) { clearTimeout(task.ack); clearTimeout(task.deadline); pending.delete(id); counts[kind]-- }
      reject(error); incomplete(error)
    }
    return result
  }
  endpoint.on('message', message => {
    try {
      check(object(message) && lanes.has(message.kind))
      check(size(message) <= (business(message.kind) ? MEMBERS_PAYLOAD_LIMIT + MEMBERS_ENVELOPE_LIMIT : MEMBERS_ENVELOPE_LIMIT))
      if (message.type === 'accepted' || message.type === 'result') {
        const task = pending.get(message.id)
        check(task && task.kind === message.kind)
        if (message.type === 'accepted') {
          check(keys(message, 'type,kind,id') && !task.accepted)
          task.accepted = true; clearTimeout(task.ack); return
        }
        check(typeof message.ok === 'boolean' && keys(message, message.ok ? 'type,kind,id,ok,value' : 'type,kind,id,ok,error'))
        check(message.ok ? task.accepted : validError(message.error)
          && !(task.accepted && message.error.outcome === 'not_accepted'))
        if (message.ok) {
          check(size(message.value) <= (business(task.kind) ? MEMBERS_PAYLOAD_LIMIT : MEMBERS_ENVELOPE_LIMIT))
          check(validateResult(task.kind, task.method, message.value) !== false)
        }
        clearTimeout(task.ack); clearTimeout(task.deadline); pending.delete(message.id); counts[task.kind]--
        if (message.ok) { task.resolve(message.value); task.complete(message.value) }
        else {
          const error = Object.assign(new Error(message.error.code), message.error)
          task.reject(error); task.incomplete(error)
        }
        return
      }
      check(message.type === 'call' && idValid(message.id) && message.id > incoming)
      check(keys(message, business(message.kind) && message.kind !== 'projection' ? 'type,kind,id,method,params,context'
        : message.kind === 'projection' ? 'type,kind,id,method,params,context' : 'type,kind,id,method,params'))
      incoming = message.id
      check(object(message.params) && size(message.params) <= (business(message.kind) ? MEMBERS_PAYLOAD_LIMIT : MEMBERS_ENVELOPE_LIMIT))
      let release
      try { release = reserve(message.kind, size(message)) }
      catch (error) { void errorReply(message, error, 'not_accepted'); return }
      let operation
      try { operation = onRequest(message) }
      catch (error) { release(); void errorReply(message, error, 'not_accepted'); return }
      const task = (async () => {
        try {
          await send({ type: 'accepted', kind: message.kind, id: message.id })
          let value
          try { value = operation(); release(); value = await value }
          catch (error) { release(); await errorReply(message, error, 'unknown'); return }
          check(size(value ?? null) <= (business(message.kind) ? MEMBERS_PAYLOAD_LIMIT : MEMBERS_ENVELOPE_LIMIT), 'MEMBERS_IPC_MESSAGE_LIMIT')
          await send({ type: 'result', kind: message.kind, id: message.id, ok: true, value: value ?? null })
          await afterResponse(message, value)
        } finally { release(); operation.finish?.() }
      })()
      running.add(task)
      void task.catch(error => errorReply(message, error, 'unknown')).finally(() => running.delete(task))
    } catch { protocolFailure() }
  })
  endpoint.on('disconnect', fail)
  endpoint.on('error', fail)
  return { call, pending, counts, running, send, fail,
    // Only the OS/stdio barrier may terminate completions after IPC loss.
    reaped: () => {
      fail()
      for (const task of pending.values()) {
        clearTimeout(task.ack); clearTimeout(task.deadline)
        task.incomplete(membersError('MEMBERS_CHILD_EXITED'))
      }
      pending.clear()
    },
    close: () => { fail(); if (endpoint.connected) endpoint.disconnect() },
    snapshot: () => ({ ...counts, queuedBytes: queued, controlBytes: controlQueued }),
  }
}

export function createMembersParentChannel(child, { generation, admission, validateRequest = validateMembersRequest, validateCallback = validateMembersCallback,
  validateEffect = validateMembersEffect, validateResult = (_kind, method, value) => validateMembersResult(method, value),
  validateProjection = validateMembersProjection, onEffect = async () => { throw membersError('MEMBERS_EFFECT_UNAVAILABLE') },
  onProjection = async () => {}, onDiagnostic = async () => {},
  authorizeOwner = () => false, assertStateCompatibility = assertMembersStateCompatibility }) {
  check(generationValid(generation))
  const received = { effect: 0, projection: 0, diagnostic: 0 }
  const effects = new Map()
  const callbackCredits = () => effects.size + [...channel.pending.values()].filter(task => task.kind === 'callback' && !effects.has(task.effect)).length
  let readyResolve, readyReject, readySeen = false
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject }); ready.catch(() => {})
  let channel
  const live = context => {
    check(contextValid(context) && context.generation === generation)
    const task = channel.pending.get(Number(context.rootId))
    check(task && ['root', 'callback'].includes(task.kind) && sameContext(task.context, context))
    if (task.readPin) return { task, readPin: admission.assertReadPin(task.readPin, { generation, method: task.method }) }
    return { task, lease: admission.assertLease(task.lease, { generation, correlation: task.lease.correlation }) }
  }
  channel = endpointChannel(child, {
    validateResult: (kind, method, value) => {
      if (kind !== 'control') return validateResult(kind, method, value)
      if (method === 'initialize') assertStateCompatibility(value?.stateCompatibility)
      return controlResultValid(method, value)
    },
    onDisconnect: () => readyReject(membersError('MEMBERS_IPC_DISCONNECTED')),
    onRequest: message => {
      if (message.kind === 'control' && message.method === 'ready') {
        check(!readySeen && keys(message.params, 'versionId,protocolVersion,stateCompatibility')
          && message.params.protocolVersion === 1 && (message.params.versionId === null || /^[a-f0-9]{64}$/.test(message.params.versionId)))
        assertStateCompatibility(message.params.stateCompatibility)
        readySeen = true
        return () => { readyResolve(message.params); return { acknowledged: true } }
      }
      if (message.kind === 'projection') {
        check(received.projection < 1)
        const initial = contextValid(message.context, true) && message.context.leaseId === null
          && message.context.generation === generation && channel.pending.get(Number(message.context.rootId))?.kind === 'control'
          && channel.pending.get(Number(message.context.rootId))?.method === 'initialize'
        if (!initial) {
          const source = live(message.context)
          check(!source.readPin || source.task.method === 'profiles.read', 'MEMBERS_NOT_ACCEPTED')
        }
        check(validateProjection(message.params, message.context) !== false)
      } else if (message.kind === 'effect') {
        const { lease, readPin, task } = live(message.context)
        check(!readPin || task.method === 'schedules.list' && task.readParams.ownerKind === 'room'
          && message.method === 'room.schedules.list' && message.params.roomId === task.readParams.ownerId, 'MEMBERS_NOT_ACCEPTED')
        check(channel.pending.get(Number(message.context.rootId))?.kind === 'root', 'MEMBERS_CALLBACK_RECURSION')
        check(received.effect < 8 && callbackCredits() < 8, 'MEMBERS_IPC_CAPACITY')
        check(validateEffect(message.method, message.params, message.context) !== false)
        const effect = Object.freeze({ id: message.id, ...(readPin ? { membersReadPin: readPin } : { membersLease: lease }), context: message.context })
        effects.set(effect, true)
        const context = Object.freeze({ ...message.context, ...(readPin ? { membersReadPin: readPin } : { membersLease: lease }), membersEffect: effect })
        received.effect++
        let complete
        const completion = new Promise(resolve => { complete = resolve })
        if (readPin) admission.trackReadCompletion(readPin, completion)
        else admission.trackCompletion(lease, completion)
        const run = () => onEffect(message.method, message.params, context)
        run.finish = () => { effects.delete(effect); received.effect--; complete() }
        return run
      } else if (message.kind === 'diagnostic') {
        check(received.diagnostic < 16 && keys(message.params, 'code,module,diagnostic_log')
          && message.params.module === 'members' && codeValid(message.params.code) && codeValid(message.params.diagnostic_log))
      } else throw invalid()
      received[message.kind]++
      const run = async () => {
        if (message.kind === 'projection') await onProjection(message.params, message.context)
        else await onDiagnostic(message.params)
        return { acknowledged: true }
      }
      run.finish = () => { received[message.kind]-- }
      return run
    },
  })
  const request = (kind, method, params, { membersLease, membersReadPin, capturedAuthorization, membersEffect } = {}) => {
    let lease, readPin
    try {
      check(!membersReadPin || kind === 'root' && !membersLease && !membersEffect && MEMBERS_READ_PIN_METHODS.includes(method), 'MEMBERS_NOT_ACCEPTED')
      if (membersReadPin) readPin = admission.assertReadPin(membersReadPin, { generation, method })
      else lease = admission.assertLease(membersLease, { generation })
      const binding = readPin ?? lease
      const ownerWrite = !readPin && authorizeOwner(method, capturedAuthorization) === true
      const validate = kind === 'root' ? validateRequest : validateCallback
      if (kind === 'callback' && !membersEffect) membersEffect = [...effects.keys()].find(effect => effect.membersLease === lease
        && ![...channel.pending.values()].some(task => task.effect === effect))
      if (membersEffect) check(effects.has(membersEffect) && membersEffect.membersLease === lease
        && ![...channel.pending.values()].some(task => task.effect === membersEffect), 'MEMBERS_IPC_CAPACITY')
      else if (kind === 'callback') check(callbackCredits() < 8, 'MEMBERS_IPC_CAPACITY')
      const attempt = channel.call(kind, method, params,
        id => {
          const context = Object.freeze({ generation, leaseId: binding.leaseId, rootId: String(id), ownerWrite, continuation: binding.epoch !== admission.capture().epoch })
          check(validate(method, params, context) !== false)
          return context
        }, {
          beforeSend: (completion, context) => {
            channel.pending.get(Number(context.rootId)).lease = lease
            channel.pending.get(Number(context.rootId)).readPin = readPin
            if (readPin) channel.pending.get(Number(context.rootId)).readParams = structuredClone(params)
            channel.pending.get(Number(context.rootId)).effect = membersEffect
            if (readPin) admission.trackReadCompletion(readPin, completion)
            else admission.trackCompletion(lease, completion)
          },
        })
      return attempt
    } catch (error) {
      const rejected = Promise.reject(error); rejected.catch(() => {})
      Object.defineProperty(rejected, 'completion', { value: rejected })
      return rejected
    }
  }
  return { ready, request: (method, params, options) => request('root', method, params, options),
    callback: (method, params, options) => request('callback', method, params, options),
    control: (method, params = {}, timeout = 5000) => {
      check(controls.has(method))
      return channel.call('control', method, params, null, { timeout })
    }, reaped: channel.reaped, dispose: channel.fail, snapshot: channel.snapshot,
  }
}

export function createMembersChildChannel({ validateRequest, dispatch, validateCallback, dispatchCallback,
  validateEffect = validateMembersEffect, validateResult = (_kind, method, value) => validateMembersEffectResult(method, value),
  validateProjection = validateMembersProjection, control, disconnect, afterControl = async () => {},
  stateCompatibility = MEMBERS_STATE_COMPATIBILITY }) {
  let generation = null, accepting = false, quiesced = false, epoch = 0, orphaned = false, sentReady = false
  const active = new Set(), contexts = new Set(), contextKinds = new Map(), received = { root: 0, callback: 0 }
  let channel
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const orphan = () => {
    if (orphaned) return
    orphaned = true; accepting = false; epoch++
    const timer = setTimeout(() => { process.stderr.write('MEMBERS_PARENT_LOST_UNKNOWN\n'); process.exit(1) }, 60000)
    // No parent remains to return an effect result. Its outcome is unknown, never retried.
    channel.reaped()
    void drain().then(disconnect).catch(() => { process.exitCode = 1 }).finally(() => { clearTimeout(timer); channel.close() })
  }
  channel = endpointChannel(process, {
    validateResult: (kind, method, value) => ['projection', 'diagnostic', 'control'].includes(kind)
      ? keys(value, 'acknowledged') && value.acknowledged === true : validateResult(kind, method, value),
    onDisconnect: orphan,
    afterResponse: (message, value) => message.kind === 'control' ? afterControl(message.method, value) : undefined,
    onRequest: message => {
      if (message.kind === 'control') {
        check(controls.has(message.method))
        if (message.method === 'initialize') {
          check(generation === null && keys(message.params, 'generation')
            && generationValid(message.params.generation))
          generation = message.params.generation
        } else check(keys(message.params, '') || object(message.params) && Object.keys(message.params).length === 0)
        const current = message.method === 'resume' ? ++epoch : epoch
        if (message.method === 'quiesce') accepting = false
        const context = Object.freeze({ generation, leaseId: null, rootId: String(message.id), ownerWrite: false, continuation: false })
        return async () => {
          if (message.method === 'quiesce') { await drain(); check(current === epoch, 'MEMBERS_QUIESCE_CANCELLED') }
          if (message.method === 'exit') check(quiesced && active.size === 0, 'MEMBERS_NOT_QUIESCED')
          contexts.add(context)
          try {
            const result = await control(message.method, message.params, context)
            if (message.method === 'resume') { accepting = true; quiesced = false }
            if (message.method === 'quiesce' && current === epoch) quiesced = true
            return result
          } finally { contexts.delete(context) }
        }
      }
      check(['root', 'callback'].includes(message.kind) && contextValid(message.context)
        && message.context.generation === generation && message.context.rootId === String(message.id))
      check(received[message.kind] < 8 && (message.kind === 'callback' || accepting || message.context.continuation), 'MEMBERS_NOT_ACCEPTING')
      const validate = message.kind === 'callback' ? validateCallback : validateRequest
      check(validate(message.method, message.params, message.context) !== false)
      const context = Object.freeze({ ...message.context })
      contexts.add(context); contextKinds.set(context, message.kind); received[message.kind]++
      let complete
      const completion = new Promise(resolve => { complete = resolve }); active.add(completion)
      const run = () => (message.kind === 'callback' ? dispatchCallback : dispatch)(message.method, message.params, context)
      run.finish = () => { contexts.delete(context); contextKinds.delete(context); received[message.kind]--; active.delete(completion); complete() }
      return run
    },
  })
  const dependent = (kind, method, params, context) => {
    check(contexts.has(context) && context.generation === generation && (kind !== 'effect' || context.leaseId !== null))
    if (kind === 'effect') {
      // Dedicated persistence callbacks do not recursively issue external effects.
      check(contextKinds.get(context) === 'root', 'MEMBERS_CALLBACK_RECURSION')
      check(validateEffect(method, params, context) !== false)
    }
    else check(validateProjection(params, context) !== false)
    const attempt = channel.call(kind, method, params, context)
    active.add(attempt.completion)
    void attempt.completion.finally(() => active.delete(attempt.completion)).catch(() => {})
    return attempt
  }
  return {
    effect: (method, params, context) => dependent('effect', method, params, context),
    projection: (record, context) => dependent('projection', 'projection', record, context),
    diagnostic: report => channel.call('diagnostic', 'diagnostic', report, null, { timeout: 5000 }),
    ready: () => {
      check(!sentReady && generation !== null, 'MEMBERS_READY_DUPLICATE'); sentReady = true
      return channel.call('control', 'ready', { versionId: process.argv[2] === 'builtin' ? null : process.argv[2],
        protocolVersion: 1, stateCompatibility }, null, { timeout: 5000 })
    }, close: channel.close, snapshot: channel.snapshot,
  }
}
