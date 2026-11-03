export { verifyNotificationsLocks } from './notifications-locks.mjs'
import { validateWebPushParams, webPushStatusValid } from './usage/web-push-schema.mjs'
export const NOTIFICATIONS_MESSAGE_LIMIT = 64 * 1024
export const NOTIFICATIONS_REQUEST_LIMIT = 64
const methods = new Set(['status', 'configure', 'register', 'unregister', 'publish'])
const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',')
const identifier = id => Number.isSafeInteger(id) && id > 0
const safeCode = code => typeof code === 'string' && /^[A-Z_0-9]{1,100}$/.test(code)
export const notificationError = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })
const validError = error => keys(error, 'code,outcome,status') && safeCode(error.code)
  && ['unknown', 'not_accepted'].includes(error.outcome) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
const statusValid = value => object(value) && keys(value, value.error === undefined ? 'configured,environments' : 'configured,environments,error')
  && typeof value.configured === 'boolean' && Array.isArray(value.environments)
  && value.environments.every(item => ['development', 'production'].includes(item))
  && (value.error === undefined || keys(value.error, 'code,message') && safeCode(value.error.code)
    && value.error.message === '通知の設定・送信を確認できませんでした。設定と診断情報を確認してください。')
const pair = value => keys(value, 'apns,webPush')
const applyErrorValid = value => pair(value) && [value.apns, value.webPush].every(error => error === null || safeCode(error))
const initializedValid = value => keys(value, 'status,applyError') && pair(value.status)
  && statusValid(value.status.apns) && webPushStatusValid(value.status.webPush) && applyErrorValid(value.applyError)
const resultValid = (method, params, value, control) => control
  ? method === 'initialize' ? initializedValid(value)
    : method === 'quiesce' ? keys(value, 'quiesced') && typeof value.quiesced === 'boolean'
      : method === 'resume' ? keys(value, 'resumed') && value.resumed === true
        : keys(value, 'closed') && value.closed === true
  : method === 'publish' ? keys(value, 'accepted') && value.accepted === true
    : params.provider === 'apns' && ['status', 'configure'].includes(method) ? statusValid(value)
      : params.provider === 'webPush' && (method === 'configure' || method === 'status' && !Object.hasOwn(params, 'endpoint'))
        ? webPushStatusValid(value)
        : keys(value, 'registered') && (method === 'status' ? typeof value.registered === 'boolean' : value.registered === (method === 'register'))
const validateParams = (method, params, control) => {
  if (control) {
    if (method !== 'initialize') { if (!keys(params, '')) throw notificationError('PUSH_IPC_ARGUMENTS', 'not_accepted'); return }
    if (!keys(params, 'configuration') || !pair(params.configuration)
      || !keys(params.configuration.apns, 'enabled,relayUrl') || typeof params.configuration.apns.enabled !== 'boolean'
      || typeof params.configuration.apns.relayUrl !== 'string' || params.configuration.apns.relayUrl.includes('\0')
      || !keys(params.configuration.webPush, 'enabled,subject'))
      throw notificationError('PUSH_IPC_ARGUMENTS', 'not_accepted')
    validateWebPushParams('configure', { provider: 'webPush', ...params.configuration.webPush })
    return
  }
  if (method === 'publish') return
  if (!['apns', 'webPush'].includes(params.provider)) throw notificationError('PUSH_IPC_ARGUMENTS', 'not_accepted')
  if (params.provider === 'webPush') validateWebPushParams(method, params)
}
const bounded = value => { try { return Buffer.byteLength(JSON.stringify(value)) <= NOTIFICATIONS_MESSAGE_LIMIT } catch { return false } }
const diagnosticValid = value => keys(value, 'code,module,diagnostic_log') && value.module === 'notifications'
  && ['SERVER_PUSH_SEND_FAILED', 'SERVER_PUSH_UNAVAILABLE'].includes(value.code) && safeCode(value.diagnostic_log)
const send = (endpoint, message) => new Promise((resolve, reject) => {
  if (!bounded(message)) return reject(notificationError('PUSH_IPC_MESSAGE_TOO_LARGE', 'not_accepted'))
  if (!endpoint.connected) return reject(notificationError('PUSH_IPC_DISCONNECTED', 'not_accepted'))
  try { endpoint.send(message, error => error ? reject(notificationError('PUSH_IPC_SEND_FAILED')) : resolve()) }
  catch { reject(notificationError('PUSH_IPC_SEND_FAILED')) }
})

// A parent-initiated IPC disconnect can omit ChildProcess close on Node 26.
// Reap still requires OS exit, disconnected IPC and every owned pipe's close.
export function waitNotificationsChildClose(child) {
  return new Promise(resolve => {
    let exited = child.exitCode !== null || child.signalCode !== null
    let result = { code: child.exitCode, signal: child.signalCode }
    const streams = [child.stdin, child.stdout, child.stderr].filter(Boolean)
    const finish = () => {
      if (exited && !child.connected && streams.every(stream => stream.closed)) resolve(result)
    }
    child.once('exit', (code, signal) => { exited = true; result = { code, signal }; finish() })
    child.once('close', (code, signal) => resolve({ code, signal }))
    child.on('disconnect', finish)
    for (const stream of streams) stream.once('close', finish)
    finish()
  })
}

export function createNotificationsParentChannel(child, { onDiagnostic = async () => {} } = {}) {
  let sequence = 0, dead = false, business = 0, readyValue = null, readyResolve, readyReject
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  ready.catch(() => {})
  const fail = () => {
    if (dead) return
    dead = true
    readyReject(notificationError('PUSH_IPC_DISCONNECTED'))
    for (const task of pending.values()) task.reject(notificationError('PUSH_IPC_DISCONNECTED'))
  }
  child.on('disconnect', fail)
  child.on('close', fail)
  child.on('error', fail)
  const invalid = () => { fail(); if (child.connected) child.disconnect() }
  child.on('message', message => {
    if (!bounded(message) || !object(message)) return invalid()
    if (message.type === 'ready') {
      if (readyValue || !keys(message, 'type,versionId,protocolVersion,stateSchema,status,applyError')
        || message.protocolVersion !== 2 || message.stateSchema !== 2
        || message.versionId !== null && !/^[a-f0-9]{64}$/.test(message.versionId)
        || !initializedValid({ status: message.status, applyError: message.applyError })) return invalid()
      readyValue = message
      readyResolve(message)
      return
    }
    if (message.type === 'diagnostic') {
      if (!keys(message, 'type,id,report') || !identifier(message.id) || !diagnosticValid(message.report)) return invalid()
      // Keep this sink alive while quiesce/close waits for the child's report ACK.
      let timer
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 5000) })
      void Promise.race([Promise.resolve().then(() => onDiagnostic(message.report)), deadline])
        .then(() => send(child, { type: 'diagnostic-result', id: message.id, ok: true }),
          () => send(child, { type: 'diagnostic-result', id: message.id, ok: false }))
        .catch(() => {}).finally(() => clearTimeout(timer))
      return
    }
    const task = pending.get(message.id)
    // Timed out requests may return later; they are never issued again.
    if (!task && identifier(message.id) && message.id <= sequence) return
    if (!task) return invalid()
    if (message.type === 'accepted') {
      if (task.control || task.accepted || !keys(message, 'type,id')) return invalid()
      task.accepted = true
      return
    }
    if (message.type !== (task.control ? 'control-result' : 'result') || typeof message.ok !== 'boolean'
      || !keys(message, message.ok ? 'type,id,ok,value' : 'type,id,ok,error')
      || !message.ok && !validError(message.error) || !task.control && message.ok && !task.accepted
      || !task.control && !message.ok && message.error.outcome === 'not_accepted' && task.accepted) return invalid()
    if (message.ok && !resultValid(task.method, task.params, message.value, task.control)) return invalid()
    if (message.ok) task.resolve(message.value)
    else task.reject(notificationError(message.error.code, message.error.outcome, message.error.status))
  })
  const call = (method, params, control, timeout) => {
    if (dead || !child.connected) return Promise.reject(notificationError('PUSH_UNAVAILABLE', 'not_accepted'))
    if (!object(params) || !(control ? controls : methods).has(method)) return Promise.reject(notificationError('PUSH_IPC_ARGUMENTS', 'not_accepted'))
    try { validateParams(method, params, control); params = structuredClone(params) }
    catch (error) { return Promise.reject(error) }
    if (!control && business >= NOTIFICATIONS_REQUEST_LIMIT) return Promise.reject(notificationError('PUSH_IPC_BUSY', 'not_accepted'))
    if (sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(notificationError('PUSH_IPC_SEQUENCE', 'not_accepted'))
    const id = ++sequence, message = { type: control ? 'control' : 'request', id, method, params }
    if (!bounded(message)) return Promise.reject(notificationError('PUSH_IPC_MESSAGE_TOO_LARGE', 'not_accepted'))
    if (!control) business++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(reject, notificationError('PUSH_IPC_TIMEOUT')), timeout)
      const finish = (callback, value) => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        if (!control) business--
        callback(value)
      }
      pending.set(id, { method, params, control, accepted: false, resolve: value => finish(resolve, value), reject: error => finish(reject, error) })
      // After this attempt, send callback success/failure alone cannot prove non-acceptance.
      void send(child, message).catch(error => pending.get(id)?.reject(notificationError(error.code)))
    })
  }
  return { ready, request: (method, params) => call(method, params, false, method === 'configure' ? 90000 : 30000),
    control: (method, params = {}, timeout = 5000) => call(method, params, true, timeout), dispose: fail }
}

export function createNotificationsChildChannel({ validateRequest, dispatch, control, disconnect, afterControl = async () => {} }) {
  let sequence = 0, diagnosticSequence = 0, accepting = false, quiesced = false, epoch = 0, closed = false, sentReady = false
  const active = new Set(), diagnostics = new Map()
  const close = () => {
    if (closed) return
    closed = true; accepting = false
    for (const task of diagnostics.values()) task.reject(notificationError('PUSH_DIAGNOSTIC_FAILED'))
    if (process.connected) process.disconnect()
  }
  const orphan = () => {
    accepting = false; epoch++
    if (closed) return
    const timer = setTimeout(() => { process.stderr.write('PUSH_PARENT_LOST_UNKNOWN\n'); process.exit(1) }, 60000)
    void Promise.allSettled([...active]).then(() => disconnect()).catch(() => { process.exitCode = 1 }).finally(() => {
      clearTimeout(timer); close()
    })
  }
  process.once('disconnect', orphan)
  const replyError = (type, id, error, outcome) => send(process, { type, id, ok: false,
    error: { code: safeCode(error?.code) ? error.code : 'PUSH_OPERATION_FAILED', outcome,
      status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503 } }).catch(() => {})
  const protocolFailure = () => { accepting = false; if (process.connected) process.disconnect(); else orphan() }
  const onMessage = message => {
    if (!bounded(message) || !object(message)) return protocolFailure()
    if (message.type === 'diagnostic-result') {
      if (!keys(message, 'type,id,ok') || !identifier(message.id) || typeof message.ok !== 'boolean') return protocolFailure()
      const task = diagnostics.get(message.id)
      if (task) message.ok ? task.resolve() : task.reject(notificationError('PUSH_DIAGNOSTIC_FAILED'))
      return
    }
    if (!keys(message, 'type,id,method,params') || !identifier(message.id) || message.id <= sequence || !object(message.params)) return protocolFailure()
    sequence = message.id
    if (message.type === 'request') {
      try {
        if (!methods.has(message.method) || !accepting || active.size >= 64) throw notificationError('PUSH_NOT_ACCEPTING', 'not_accepted')
        validateParams(message.method, message.params, false)
        validateRequest(message.method, message.params)
      } catch (error) { void replyError('result', message.id, error, 'not_accepted'); return }
      // Reserve synchronously so quiesce includes requests waiting for their accepted send callback.
      const task = (async () => {
        await send(process, { type: 'accepted', id: message.id })
        let value
        try { value = await dispatch(message.method, message.params) }
        catch (error) { await replyError('result', message.id, error, 'unknown'); return }
        await send(process, { type: 'result', id: message.id, ok: true, value })
      })()
      active.add(task)
      void task.catch(() => {}).finally(() => active.delete(task))
      return
    }
    if (message.type !== 'control' || !controls.has(message.method)) return protocolFailure()
    try { validateParams(message.method, message.params, true) } catch { return protocolFailure() }
    const generation = message.method === 'resume' ? ++epoch : epoch
    let waiting = []
    if (message.method === 'quiesce') { accepting = false; waiting = [...active] }
    void (async () => {
      await Promise.allSettled(waiting)
      if (message.method === 'quiesce' && generation !== epoch) throw notificationError('PUSH_QUIESCE_CANCELLED')
      if (message.method === 'exit' && !quiesced) throw notificationError('PUSH_NOT_QUIESCED')
      const value = await control(message.method, message.params)
      if (message.method === 'resume') { accepting = true; quiesced = false }
      if (message.method === 'quiesce' && generation === epoch) quiesced = true
      await send(process, { type: 'control-result', id: message.id, ok: true, value: value ?? null })
      await afterControl(message.method, value)
    })().catch(error => replyError('control-result', message.id, error, 'unknown'))
  }
  process.on('message', onMessage)
  return { close,
    ready: async ({ status, applyError }) => {
      if (sentReady) throw notificationError('PUSH_READY_DUPLICATE')
      if (!initializedValid({ status, applyError })) throw notificationError('PUSH_READY_INVALID')
      sentReady = true
      const versionId = process.argv[2] === 'builtin' ? null : process.argv[2]
      await send(process, { type: 'ready', versionId, protocolVersion: 2, stateSchema: 2, status, applyError })
    },
    diagnostic: report => {
      if (!diagnosticValid(report) || closed) return Promise.reject(notificationError('PUSH_DIAGNOSTIC_FAILED', 'not_accepted'))
      const id = ++diagnosticSequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(reject, notificationError('PUSH_DIAGNOSTIC_FAILED')), 5000)
        const finish = (callback, value) => { if (!diagnostics.delete(id)) return; clearTimeout(timer); callback(value) }
        diagnostics.set(id, { resolve: () => finish(resolve), reject: error => finish(reject, error) })
        void send(process, { type: 'diagnostic', id, report }).catch(() => diagnostics.get(id)?.reject(notificationError('PUSH_DIAGNOSTIC_FAILED')))
      })
    } }
}
