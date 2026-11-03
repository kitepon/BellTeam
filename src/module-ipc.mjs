export const MODULE_PAYLOAD_LIMIT = 16 * 1024 * 1024
export const MODULE_ENVELOPE_LIMIT = 64 * 1024
export const MODULE_BUFFER_LIMIT = 64 * 1024 * 1024
const MEMBERS_PAYLOAD_LIMIT = MODULE_PAYLOAD_LIMIT, MEMBERS_ENVELOPE_LIMIT = MODULE_ENVELOPE_LIMIT, MEMBERS_BUFFER_LIMIT = MODULE_BUFFER_LIMIT
const lanes = new Set(['root', 'effect', 'callback', 'projection', 'diagnostic', 'control'])
const business = kind => ['root', 'effect', 'callback', 'projection'].includes(kind)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',')
const idValid = value => Number.isSafeInteger(value) && value > 0
const codeValid = value => typeof value === 'string' && /^[A-Z_0-9]{1,100}$/.test(value)
const safeError = (error, outcome) => ({ code: codeValid(error?.code) ? error.code : 'MODULE_OPERATION_FAILED',
  outcome, status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503 })
const validError = value => keys(value, 'code,outcome,status') && codeValid(value.code)
  && ['unknown', 'not_accepted'].includes(value.outcome) && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599
const size = value => { try { return Buffer.byteLength(JSON.stringify(value)) } catch { return Infinity } }

// These credits cover unsent frames and received frames waiting to enter a dispatcher.
export function createModuleEndpoint(endpoint, { validateResult, onRequest, onDisconnect, afterResponse = async () => {},
  afterResult, streamed = false, errorPrefix = 'MODULE', statusCodes }) {
  const membersError = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code.replace(/^MEMBERS/u, errorPrefix)), { code: code.replace(/^MEMBERS/u, errorPrefix), outcome, status })
  const check = (value, code = 'MEMBERS_IPC_INVALID') => { if (!value) throw membersError(code, 'not_accepted') }
  let sequence = 0, incoming = 0, dead = false, queued = 0, controlQueued = 0
  const pending = new Map(), running = new Set()
  const safeWireError = (error, outcome) => { const value = safeError(error, outcome); if (value.code === 'MODULE_OPERATION_FAILED') value.code = `${errorPrefix}_OPERATION_FAILED`; if (statusCodes && !statusCodes.includes(value.status)) value.status = 503; return value }
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
    ok: false, error: safeWireError(error, outcome) }).catch(() => {})
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
      task = { id, kind, method, context, accepted: false, resolve, reject, complete, incomplete }
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
    if (streamed && ['open', 'data', 'credit', 'end', 'closed', 'abort', 'rejected', 'control'].includes(message?.type)) return
    try {
      check(object(message) && lanes.has(message.kind))
      check(size(message) <= (business(message.kind) ? MEMBERS_PAYLOAD_LIMIT + MEMBERS_ENVELOPE_LIMIT : MEMBERS_ENVELOPE_LIMIT))
      if (message.type === 'accepted' || message.type === 'result') {
        const task = pending.get(message.id)
        check(task && task.kind === message.kind && !task.resultSeen)
        if (message.type === 'accepted') {
          check(keys(message, 'type,kind,id') && !task.accepted)
          task.accepted = true; clearTimeout(task.ack); return
        }
        check(typeof message.ok === 'boolean' && keys(message, message.ok ? 'type,kind,id,ok,value' : 'type,kind,id,ok,error'))
        check(message.ok ? task.accepted : validError(message.error) && (!statusCodes || statusCodes.includes(message.error.status))
          && !(task.accepted && message.error.outcome === 'not_accepted'))
        if (message.ok) {
          check(size(message.value) <= (business(task.kind) ? MEMBERS_PAYLOAD_LIMIT : MEMBERS_ENVELOPE_LIMIT))
          check(validateResult(task.kind, task.method, message.value) !== false)
        }
        clearTimeout(task.ack); clearTimeout(task.deadline)
        task.resultSeen = true
        const finish = error => {
          if (!pending.delete(message.id)) return
          counts[task.kind]--
          if (error) task.incomplete(error); else task.complete(message.value)
        }
        if (message.ok) {
          const body = afterResult?.(task, message.value)
          task.resolve(message.value)
          if (body === undefined) finish()
          else Promise.resolve(body).then(() => { if (!dead) finish() }, () => { protocolFailure() })
        } else {
          const error = Object.assign(new Error(message.error.code), message.error)
          task.reject(error); finish(error)
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

