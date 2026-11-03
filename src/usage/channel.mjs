import { createModuleEndpoint, MODULE_PAYLOAD_LIMIT } from '../module-ipc.mjs'
import { createModuleStreams, encodeModuleJson, readModuleJson } from '../module-streams.mjs'
import { validateUsageRequest, usageError } from './process-schema.mjs'
import { usageResultValid } from './process-results.mjs'
import { usageHandoffValid } from './services.mjs'
import { assertUsageStateCompatibility, USAGE_STATE_COMPATIBILITY } from './state-compatibility.mjs'
import { exact, check, contextValid, sameContext, ackValid, marker, publicationValid, usageEffectValid, usageEffectResultValid } from './channel-protocol.mjs'

const controls = new Set(['initialize', 'quiesce', 'resume', 'export', 'exit'])
const system = Object.freeze({ kind: 'system', botId: null })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => {}); return { promise, resolve, reject } }
const makeContext = (generation, id, kind, method, actor, mode = null, continuation = false) => Object.freeze({ generation, rootId: String(id), kind, method, mode, actor: Object.freeze({ ...actor }), continuation })
const controlResult = (method, value) => {
  if (method === 'initialize') { if (!exact(value, 'stateCompatibility')) return false; assertUsageStateCompatibility(value.stateCompatibility); return true }
  if (method === 'export') return marker(value)
  return method === 'quiesce' ? exact(value, 'quiesced') && typeof value.quiesced === 'boolean'
    : method === 'resume' ? exact(value, 'resumed') && value.resumed === true : exact(value, 'closed') && value.closed === true
}
const completeAttempt = (attempt, operation) => {
  const result = attempt.then(async value => { await attempt.completion; return operation.streamed ? operation.value : value }).catch(error => {
    if (error.code === 'AUTH_RESPONSE_NOT_ISSUED') error.effect = 'not_issued'
    else if (['AUTH_RESPONSE_UNCONFIRMED', 'HARNESS_AUTH_RESPONSE_UNCONFIRMED', 'SETUP_AUTH_RESPONSE_UNCONFIRMED'].includes(error.code)) error.effect = 'unknown'
    throw error
  })
  Object.defineProperty(result, 'completion', { value: attempt.completion }); result.catch(() => {})
  return result
}
const rejected = error => { const result = Promise.reject(error); result.catch(() => {}); Object.defineProperty(result, 'completion', { value: result }); return result }

export function createUsageParentChannel(child, { generation, admission, authorizeActor, onEffect = async () => { throw usageError('USAGE_EFFECT_UNAVAILABLE') },
  onProjection = async () => {}, onSnapshotStart = async () => {}, onSnapshotEnd = async () => {}, onSnapshotAbort = () => {}, onDiagnostic = async () => {} }) {
  check(typeof generation === 'string' && generation.length > 0 && generation.length <= 200)
  const operations = new Map(), effects = new Map(), received = { projection: 0, diagnostic: 0 }
  let channel, streams, readySeen = false, readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject }); ready.catch(() => {})
  const failed = () => {
    readyReject(usageError('USAGE_IPC_DISCONNECTED'))
    for (const operation of operations.values()) if (operation.snapshotStarted && !operation.snapshotCommitted && !operation.snapshotAborted) {
      operation.snapshotAborted = true
      try { onSnapshotAbort(operation.context) } catch {}
    }
    channel?.fail()
  }
  const live = context => {
    check(contextValid(context) && context.generation === generation)
    const operation = operations.get(Number(context.rootId))
    check(operation && sameContext(operation.context, context) && channel.pending.has(Number(context.rootId)))
    if (context.kind !== 'control') admission.assertLease(operation.lease, { generation })
    return operation
  }
  const publish = async (publication, operation) => {
    check(publicationValid(publication))
    if (publication.phase === 'snapshot') {
      check(operation.kind === 'control' && operation.method === 'initialize' && ['services', 'restore'].includes(operation.params.mode))
      if (!operation.snapshotStarted) { operation.snapshotStarted = true; await onSnapshotStart(operation.context) }
    } else if (publication.phase === 'seed') check(operation.kind === 'control' && operation.method === 'initialize' && ['settings', 'subscriptions', 'restore'].includes(operation.params.mode))
    else check(operation.kind === 'root' || operation.kind === 'callback')
    await onProjection(publication.row, Object.freeze({ ...operation.context, phase: publication.phase }))
  }
  streams = createModuleStreams(child, { rpcFrames: true, onFailure: failed,
    onOpen: info => {
      const operation = operations.get(info.operation)
      return Boolean(operation && channel.pending.has(info.operation) && (info.lane === 'history' && operation.kind === 'control' && operation.method === 'initialize' && ['services', 'restore'].includes(operation.params.mode)
          || info.lane === 'result' && (operation.kind === 'root' || operation.kind === 'control' && operation.method === 'export')
          || info.lane === 'callback' && operation.kind === 'callback'))
    },
    onStream: async (info, chunks) => {
      const operation = operations.get(info.operation); check(operation && channel.pending.has(info.operation))
      const value = await readModuleJson(chunks, MODULE_PAYLOAD_LIMIT)
      if (info.lane === 'history') await publish(value, operation)
      else {
        check(exact(value, 'index,value') && value.index === operation.rows.length)
        operation.rows.push(value.value)
      }
    },
  })
  channel = createModuleEndpoint(child, { streamed: true, errorPrefix: 'USAGE', onDisconnect: failed,
    validateResult: (kind, method, value) => kind === 'control' ? controlResult(method, value) : marker(value),
    afterResult: async (task, wire) => {
      const operation = operations.get(task.id); check(operation)
      if (marker(wire)) {
        check(operation.rows.length === wire.count)
        operation.value = wire.collection ? operation.rows : operation.rows[0]; operation.streamed = true
        check(operation.kind === 'control' ? exact(operation.value, 'handoff') && usageHandoffValid(operation.value.handoff)
          : usageResultValid(operation.method, operation.value, operation.params))
      }
      if (operation.snapshotStarted) { await onSnapshotEnd(operation.context); check(!operation.snapshotAborted, 'USAGE_SNAPSHOT_ABORTED'); operation.snapshotCommitted = true }
    },
    onRequest: message => {
      if (message.kind === 'control' && message.method === 'ready') {
        check(!readySeen && exact(message.params, 'versionId,protocolVersion,stateCompatibility') && message.params.protocolVersion === 1
          && (message.params.versionId === null || /^[a-f0-9]{64}$/.test(message.params.versionId)))
        assertUsageStateCompatibility(message.params.stateCompatibility); readySeen = true
        return () => { readyResolve(message.params); return { acknowledged: true } }
      }
      if (message.kind === 'diagnostic') {
        check(received.diagnostic < 16, 'USAGE_IPC_CAPACITY')
        check(exact(message.params, 'code') && /^[A-Z_0-9]{1,100}$/.test(message.params.code))
        received.diagnostic++
        const run = async () => { await onDiagnostic({ module: 'usage', code: message.params.code }); return { acknowledged: true } }
        run.finish = () => { received.diagnostic-- }; return run
      }
      const operation = live(message.context)
      if (message.kind === 'projection') {
        check(received.projection < 1 && publicationValid(message.params), 'USAGE_IPC_CAPACITY'); received.projection++
        const run = async () => { await publish(message.params, operation); return { acknowledged: true } }
        run.finish = () => { received.projection-- }; return run
      }
      check(message.kind === 'effect' && effects.size < 8 && operation.context.kind !== 'callback', 'USAGE_CALLBACK_RECURSION')
      check(usageEffectValid(message.method, message.params, operation.context, operation.params))
      const capability = Object.freeze({}), item = { operation, id: message.id }
      effects.set(capability, item)
      let complete; const completion = new Promise(resolve => { complete = resolve })
      if (operation.lease) admission.trackCompletion(operation.lease, completion)
      const run = async () => {
        const value = await onEffect(message.method, message.params, Object.freeze({ ...operation.context, usageLease: operation.lease, usageEffect: capability }))
        check(usageEffectResultValid(message.method, value ?? null)); return value ?? null
      }
      run.finish = () => { effects.delete(capability); complete() }; return run
    },
  })
  const call = (kind, method, params, options = {}) => {
    let operation
    try {
      let actor = system, lease = null, continuation = false
      if (kind !== 'control') {
        lease = admission.assertLease(options.usageLease, { generation })
        actor = authorizeActor(method, options.capturedAuthorization)
        validateUsageRequest(method, params, actor)
        continuation = lease.epoch !== admission.capture().epoch
        if (kind === 'callback') {
          check(method === 'settings.setError' && actor.kind === 'system' && effects.has(options.usageEffect), 'USAGE_CALLBACK_UNAVAILABLE')
          const parent = effects.get(options.usageEffect)
          check(parent.operation.lease === lease && parent.operation.context.kind === 'root')
          check(![...operations.values()].some(value => value.effect === options.usageEffect), 'USAGE_IPC_CAPACITY')
        }
      } else check(controls.has(method))
      operation = { kind, method, params: structuredClone(params), lease, effect: options.usageEffect, rows: [] }
      const body = kind === 'control' && method === 'initialize'
      const wire = body ? { generation, mode: params.mode, streamed: true } : params
      const attempt = channel.call(kind, method, wire, id => {
        operation.id = id; operation.context = makeContext(generation, id, kind, method, actor, kind === 'control' && method === 'initialize' ? params.mode : null, continuation)
        operations.set(id, operation); return kind === 'control' ? null : operation.context
      }, { timeout: options.timeout ?? (method === 'initialize' ? 45000 : 60000), beforeSend: completion => {
        if (lease) admission.trackCompletion(lease, completion)
        if (body) queueMicrotask(() => {
          void streams.write(encodeModuleJson(operation.params), { lane: 'root', operation: operation.id }).catch(failed)
        })
      } })
      void attempt.completion.finally(() => operations.delete(operation.id)).catch(() => {})
      return completeAttempt(attempt, operation)
    } catch (error) { return rejected(error) }
  }
  return {
    ready, request: (method, params, options) => call('root', method, params, options),
    callback: (method, params, options) => call('callback', method, params, options),
    control: (method, params = {}, timeout = 5000) => call('control', method, params, { timeout }),
    reaped() { channel.reaped(); streams.close() }, dispose() { channel.fail(); streams.close() },
    snapshot: () => ({ ...channel.snapshot(), streams: streams.snapshot(), effects: effects.size }),
  }
}

export function createUsageChildChannel({ endpoint = process, versionId = process.argv[2] === 'builtin' ? null : process.argv[2],
  validateRequest, dispatch, validateCallback, dispatchCallback, control, disconnect, afterControl = async () => {} }) {
  check(versionId === null || typeof versionId === 'string' && /^[a-f0-9]{64}$/.test(versionId))
  const contexts = new Map(), active = new Set(), received = { root: 0, callback: 0 }
  let generation = null, mode = 'new', readySent = false, orphaned = false, closing = false, initializationActive = null, channel, streams
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const lost = () => {
    if (orphaned || closing) return
    orphaned = true; mode = 'orphaned'; for (const item of contexts.values()) item.body?.reject(usageError('USAGE_PARENT_LOST_UNKNOWN')); channel?.reaped()
    void drain().then(disconnect).catch(() => {}).finally(() => { streams.close(); channel.close() })
  }
  const dependent = (kind, method, params, context) => {
    const item = contexts.get(context); check(item && context.generation === generation)
    if (kind === 'effect') check(usageEffectValid(method, params, context, item.params))
    else check(publicationValid(params))
    if (kind === 'projection' && params.phase === 'snapshot') return streams.write(encodeModuleJson(params), { lane: 'history', operation: Number(context.rootId) })
    const attempt = channel.call(kind, method, params, context)
    active.add(attempt.completion); void attempt.completion.finally(() => active.delete(attempt.completion)).catch(() => {})
    return attempt
  }
  streams = createModuleStreams(endpoint, { rpcFrames: true, onFailure: lost,
    onOpen: info => info.lane === 'root' && [...contexts.entries()].some(([context, item]) => Number(context.rootId) === info.operation && item.body),
    onStream: async (info, chunks) => {
      const pair = [...contexts.entries()].find(([context, item]) => Number(context.rootId) === info.operation && item.body)
      check(pair); const [context, item] = pair; check(!item.bodySeen); item.bodySeen = true
      const value = await readModuleJson(chunks, MODULE_PAYLOAD_LIMIT)
      check(value.generation === context.generation && value.mode === context.mode); item.body.resolve(value)
    },
  })
  let resultTail = Promise.resolve()
  const sendResult = async (value, operation, kind = 'root') => {
    const previous = resultTail, slot = deferred()
    if (kind !== 'callback') resultTail = slot.promise
    if (kind !== 'callback') await previous
    try {
    const collection = Array.isArray(value), rows = collection ? value : [value]
    for (let index = 0; index < rows.length; index++) await streams.write(encodeModuleJson({ index, value: rows[index] }), { lane: kind === 'callback' ? 'callback' : 'result', operation })
    return { streamed: true, collection, count: rows.length }
    } finally { slot.resolve() }
  }
  channel = createModuleEndpoint(endpoint, { streamed: true, errorPrefix: 'USAGE', onDisconnect: lost,
    validateResult: (kind, method, value) => ['projection', 'diagnostic', 'control'].includes(kind) ? ackValid(value) : usageEffectResultValid(method, value),
    afterResponse: async (message, value) => {
      if (message.kind !== 'control') return
      if (message.method === 'initialize' && !readySent) {
        readySent = true
        await channel.call('control', 'ready', { versionId, protocolVersion: 1, stateCompatibility: USAGE_STATE_COMPATIBILITY }, null)
      }
      await afterControl(message.method, value)
      if (message.method === 'exit') { closing = true; streams.close(); channel.close() }
    },
    onRequest: message => {
      if (message.kind === 'control') {
        check(controls.has(message.method))
        const initializing = message.method === 'initialize'
        if (initializing) {
          check(!initializationActive, 'USAGE_INITIALIZATION_ORDER')
          check(exact(message.params, 'generation,mode,streamed') && message.params.streamed === true && ['settings', 'subscriptions', 'services', 'restore'].includes(message.params.mode))
          if (generation === null) { check(['settings', 'restore'].includes(message.params.mode)); generation = message.params.generation }
          check(message.params.generation === generation)
        } else check(exact(message.params, ''))
        const context = makeContext(generation, message.id, 'control', message.method, system, initializing ? message.params.mode : null)
        if (initializing) initializationActive = context
        const item = { params: message.params, body: initializing ? deferred() : null }; contexts.set(context, item)
        if (message.method === 'quiesce') mode = 'draining'
        const run = async () => {
          const params = item.body ? await item.body.promise : message.params
          item.params = params
          const value = await control(message.method, params, context)
          if (message.method === 'initialize') { mode = ['services', 'restore'].includes(params.mode) ? 'services' : params.mode; if (initializationActive === context) initializationActive = null }
          if (message.method === 'resume') mode = 'services'
          if (message.method === 'quiesce' && value.quiesced) { await drain(); mode = 'drained' }
          if (message.method === 'export') return sendResult(value, message.id)
          return value
        }
        run.finish = () => { contexts.delete(context); if (initializationActive === context) initializationActive = null }; return run
      }
      check(['root', 'callback'].includes(message.kind) && contextValid(message.context) && message.context.generation === generation
        && message.context.rootId === String(message.id) && message.context.kind === message.kind && message.context.method === message.method)
      check(received[message.kind] < 8 && !orphaned && mode !== 'closed', 'USAGE_IPC_CAPACITY')
      const early = message.kind === 'root' && message.context.actor.kind === 'system' && ['settings.list', 'settings.configuration', 'settings.setError'].includes(message.method)
      check(message.kind === 'callback' || mode === 'services' || early && ['settings', 'subscriptions'].includes(mode), 'USAGE_UNAVAILABLE')
      const context = Object.freeze({ ...message.context, actor: Object.freeze({ ...message.context.actor }) })
      check((message.kind === 'root' ? validateRequest : validateCallback)(message.method, message.params, context) !== false)
      contexts.set(context, { params: message.params }); received[message.kind]++
      let complete; const completion = new Promise(resolve => { complete = resolve }); active.add(completion)
      const run = async () => {
        const value = await (message.kind === 'root' ? dispatch : dispatchCallback)(message.method, message.params, context)
        check(usageResultValid(message.method, value, message.params)); return sendResult(value, message.id, message.kind)
      }
      run.finish = () => { contexts.delete(context); received[message.kind]--; active.delete(completion); complete() }; return run
    },
  })
  return {
    effect: (method, params, context) => dependent('effect', method, params, context),
    projection: (record, context) => dependent('projection', 'projection', record, context),
    diagnostic: code => { check(/^[A-Z_0-9]{1,100}$/.test(code)); return channel.call('diagnostic', 'diagnostic', { code }, null) },
    close() { closing = true; streams.close(); channel.close() }, reaped: channel.reaped,
    snapshot: () => ({ ...channel.snapshot(), streams: streams.snapshot(), active: active.size }),
  }
}
