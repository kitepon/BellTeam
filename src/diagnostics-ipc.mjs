import { createModuleEndpoint } from './module-ipc.mjs'
import { createModuleStreams, encodeModuleJson, readModuleJson } from './module-streams.mjs'
import { DIAGNOSTICS_STATE_COMPATIBILITY, DIAGNOSTICS_PROTOCOL_VERSION, diagnosticsObject,
  validDiagnosticsGeneration, validateDiagnosticsRequest, validateDiagnosticsControl,
  validateDiagnosticsControlResult, validateDiagnosticsReady, validateDiagnosticsRow, diagnosticsWireError } from './diagnostics-protocol.mjs'

const failure = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })
const check = value => { if (!value) throw failure('DIAGNOSTICS_IPC_INVALID') }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => {})
  return { promise, resolve, reject }
}
const streamedResult = value => diagnosticsObject(value, ['streamed']) && value.streamed === true
const acknowledged = value => diagnosticsObject(value, ['acknowledged']) && value.acknowledged === true

export function createDiagnosticsParentChannel(child, { generation }) {
  check(validDiagnosticsGeneration(generation))
  const ready = deferred(), lists = new Map()
  let readySeen = false, channel, streams
  const fail = () => {
    const error = failure('DIAGNOSTICS_IPC_DISCONNECTED')
    ready.reject(error)
    for (const list of lists.values()) list.reject(error)
  }
  channel = createModuleEndpoint(child, {
    errorPrefix: 'DIAGNOSTICS', streamed: true,
    validateResult: (kind, method, value) => {
      if (kind === 'control') { validateDiagnosticsControlResult(method, value); return true }
      check(kind === 'root')
      return method === 'list' ? streamedResult(value) : validateDiagnosticsRow(value)
    },
    afterResult: (task, value) => {
      if (task.kind === 'root' && task.method === 'list') {
        check(streamedResult(value) && task.listResult)
        return task.listResult
      }
    },
    onDisconnect: fail,
    onRequest: message => {
      check(message.kind === 'control' && message.method === 'ready' && !readySeen)
      validateDiagnosticsReady(message.params)
      readySeen = true
      return () => { ready.resolve(message.params); return { acknowledged: true } }
    },
  })
  streams = createModuleStreams(child, { rpcFrames: true,
    onOpen: frame => frame.lane === 'history' && lists.has(frame.operation)
      && channel.pending.get(frame.operation)?.method === 'list' && !lists.get(frame.operation).opened,
    onStream: async (frame, chunks) => {
      const list = lists.get(frame.operation)
      check(list && !list.opened); list.opened = true
      try {
        const rows = await readModuleJson(chunks, Infinity)
        check(Array.isArray(rows))
        for (const row of rows) validateDiagnosticsRow(row)
        list.resolve(rows)
      } catch (error) { list.reject(error); throw error }
    },
    onFailure: () => { channel.fail(); fail(); if (child.connected) child.disconnect() },
  })
  const request = (method, params) => {
    let operation, list, attempt
    try {
      validateDiagnosticsRequest(method, params, { generation })
      attempt = channel.call('root', method, params, id => {
        operation = id
        if (method === 'list') { list = deferred(); lists.set(id, list) }
        return { generation }
      }, { beforeSend: () => { if (list) channel.pending.get(operation).listResult = list.promise } })
    } catch (error) {
      const rejected = Promise.reject(error); rejected.catch(() => {})
      Object.defineProperty(rejected, 'completion', { value: rejected })
      return rejected
    }
    if (!list) return attempt
    // Only the real completion or reaped barrier releases a timed-out request's stream binding.
    void attempt.completion.finally(() => { lists.delete(operation); list.reject(failure('DIAGNOSTICS_RESULT_CLOSED')) }).catch(() => {})
    const result = attempt.then(() => list.promise)
    Object.defineProperty(result, 'completion', { value: attempt.completion })
    return result
  }
  return { ready: ready.promise, request,
    control: (method, params = {}, timeout = 5000) => {
      validateDiagnosticsControl(method, params)
      if (method === 'initialize') check(params.generation === generation)
      return channel.call('control', method, params, null, { timeout })
    },
    reaped: () => { channel.reaped(); streams.close(); fail() },
    dispose: () => { channel.fail(); streams.close(); fail() },
    snapshot: () => ({ ...channel.snapshot(), streams: streams.snapshot() }),
  }
}

export function createDiagnosticsChildChannel({ dispatcher, event = process, versionId = process.argv[2] === 'builtin' ? null : process.argv[2] }) {
  let generation = null, accepting = false, quiesced = false, epoch = 0, orphaned = false, readySent = false, channel, streams
  const active = new Set()
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const close = () => { streams.close(); channel.close() }
  const orphan = () => {
    if (orphaned) return
    orphaned = true; accepting = false; epoch++
    streams.close()
    const timer = setTimeout(() => { if (event === process) process.exit(1) }, 60000)
    void dispatcher.disconnect().then(drain).catch(() => { if (event === process) process.exitCode = 1 })
      .finally(() => { clearTimeout(timer); channel.close() })
  }
  channel = createModuleEndpoint(event, {
    errorPrefix: 'DIAGNOSTICS', streamed: true,
    validateResult: (kind, method, value) => kind === 'control' && method === 'ready' && acknowledged(value),
    onDisconnect: orphan,
    afterResponse: async message => {
      if (message.kind !== 'control') return
      if (message.method === 'initialize') await ready()
      if (message.method === 'exit') close()
    },
    onRequest: message => {
      if (message.kind === 'control') {
        validateDiagnosticsControl(message.method, message.params)
        if (message.method === 'initialize') {
          check(generation === null); generation = message.params.generation
        }
        const current = message.method === 'resume' ? ++epoch : epoch
        if (message.method === 'quiesce') accepting = false
        return async () => {
          if (message.method === 'quiesce') {
            await drain()
            if (current !== epoch) return { quiesced: false }
          }
          if (message.method === 'exit') check(quiesced && active.size === 0)
          const value = await dispatcher.control(message.method, message.params)
          if (message.method === 'resume') { accepting = true; quiesced = false }
          if (message.method === 'quiesce' && current === epoch) quiesced = value.quiesced === true
          return value
        }
      }
      check(message.kind === 'root' && message.context?.generation === generation)
      if (!accepting || active.size >= 8) throw failure('DIAGNOSTICS_NOT_ACCEPTED', 'not_accepted')
      dispatcher.validateRequest(message.method, message.params, message.context)
      quiesced = false
      const done = deferred(); active.add(done.promise)
      const run = async () => {
        try {
          const value = await dispatcher.dispatch(message.method, message.params, message.context)
          if (message.method !== 'list') { validateDiagnosticsRow(value); return value }
          // history has no additional aggregate cap; the existing row/count contract owns list size.
          try { await streams.write(encodeModuleJson(value), { lane: 'history', operation: message.id }) }
          finally { await value.return?.() }
          return { streamed: true }
        } catch (error) { throw Object.assign(new Error('DIAGNOSTICS_OPERATION_FAILED'), diagnosticsWireError(error, 'unknown')) }
      }
      run.finish = () => { active.delete(done.promise); done.resolve() }
      return run
    },
  })
  streams = createModuleStreams(event, { rpcFrames: true,
    onOpen: () => false,
    onFailure: () => { channel.fail(); if (event.connected) event.disconnect() },
  })
  const ready = () => {
    check(!readySent && generation !== null); readySent = true
    return channel.call('control', 'ready', { versionId, protocolVersion: DIAGNOSTICS_PROTOCOL_VERSION,
      stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY }, null, { timeout: 5000 })
  }
  return { ready, close, snapshot: () => ({ ...channel.snapshot(), streams: streams.snapshot() }) }
}
