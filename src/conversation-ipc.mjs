import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createConversationPeer, conversationChannelError as error, channelCheck as check, exactChannelKeys as exact } from './conversation-channel.mjs'
import { createConversationBackgroundParent, createConversationBackgroundChild } from './conversation-background-ipc.mjs'
import { createConversationDeliveryReleaseParent, createConversationDeliveryReleaseChild } from './conversation-delivery-release.mjs'
import { validateConversationRequest, validateConversationControl, validateConversationCallbackContext } from './conversation/requests.mjs'
import { validateConversationResult, validateConversationControlResult } from './conversation/results.mjs'
import { validateConversationEffect, validateConversationEffectResult } from './conversation/effects.mjs'
import { validateConversationCallback, validateConversationCallbackResult, normalizeConversationCallback } from './conversation/callbacks.mjs'
import { CONVERSATION_STATE_COMPATIBILITY, assertConversationStateCompatibility } from './conversation/state-compatibility.mjs'
export { verifyConversationLocks } from './conversation-locks.mjs'
export { waitNotificationsChildClose as waitConversationChildClose } from './notifications-ipc.mjs'

const deferred = () => { const d = Promise.withResolvers(); d.promise.catch(() => {}); return d }
const bindingKey = value => JSON.stringify([value.generation, value.operationId, value.deliveryId, value.target])
const validEvent = value => {
  check(exact(value, 'type,topics,all,botIds,roomIds') && value.type === 'changed' && typeof value.all === 'boolean'
    && Array.isArray(value.topics) && value.topics.every(topic => ['timeline', 'rooms', 'schedules'].includes(topic)))
  for (const key of ['botIds', 'roomIds']) check(Array.isArray(value[key]) && value[key].every(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(id)))
}
const validDiagnostic = value => {
  const corruption = value?.code === 'MESSAGE_LOG_INVALID'
  check(exact(value, corruption ? 'code,line,offset,length,reason' : 'code')
    && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value.code))
  if (corruption) check(Number.isSafeInteger(value.line) && value.line >= 1
    && Number.isSafeInteger(value.offset) && value.offset >= 0 && Number.isSafeInteger(value.length) && value.length >= 0
    && ['nul', 'syntax', 'schema'].includes(value.reason))
}

export function createConversationParentChannel(child, { generation, admission, authorizeActor,
  onEffect, onEvent = async () => {}, onDiagnostic = async () => {} }) {
  const records = new Map(), deliveries = new Map(), backgrounds = new Map()
  const ready = deferred()
  let peer, readySeen = false, initialized = false, initializationStarted = false
  const hold = (record, completion) => {
    record.refs++
    const done = () => { if (--record.refs === 0) records.delete(record.id) }
    completion.then(done, done)
  }
  const live = (id, wire) => {
    const record = records.get(id)
    check(record && isDeepStrictEqual(record.context, wire) && wire.generation === generation)
    admission.assertLease(record.lease, { generation })
    const root = record.root ?? record
    check(isDeepStrictEqual(authorizeActor(root.method, root.options.capturedAuthority), root.context.actor))
    return record
  }
  const enriched = (record, delivery) => {
    if (!delivery && record.effectContext) return record.effectContext
    const value = Object.freeze({ ...record.context,
    rootMethod: (record.root ?? record).method, conversationLease: record.lease,
    actualCompletion: record.actualCompletion, executionSource: record.options.executionSource,
    ...(delivery ? { conversationDelivery: delivery } : {}),
    operationContext: record.options.operationContext, admissionCheck: record.options.admissionCheck })
    if (!delivery) record.effectContext = value
    return value
  }
  const background = createConversationBackgroundParent({ generation, assertContext: context => {
    check([...records.values()].some(record => isDeepStrictEqual(record.context, context)))
  }, send: frame => peer.control(frame), onFailure: () => peer.fail() })
  const release = createConversationDeliveryReleaseParent({ generation, admission, send: frame => peer.control(frame), onFailure: () => peer.fail() })
  const register = (record, params, source = null) => {
    let delivery
    const options = { deliveryId: params.deliveryId, target: params.target, kinds: params.kinds,
      dispatch: (kind, value) => callback(kind, normalizeConversationCallback(kind, value), { conversationDelivery: delivery }) }
    delivery = source ? admission.deriveReport(source, { ...options, reason: params.reason }) : admission.registerDelivery(record.lease, options)
    const binding = { generation, operationId: record.lease.correlation, deliveryId: params.deliveryId, target: params.target }
    const info = { record, delivery, binding, source }
    deliveries.set(delivery, info)
    const done = release.register(record.lease, delivery, params)
    hold(record, done)
    done.then(() => deliveries.delete(delivery), () => {})
    return delivery
  }
  const executeEffect = async (record, method, params) => {
    validateConversationEffect(method, params, record.context)
    const rootMethod = (record.root ?? record).method
    const allowed = {
      'execution.notify': ['direct.post', 'room.post', 'room.reply', 'delivery.resume', 'call.receive'],
      'execution.turn': ['user.post', 'user.turn'],
      'execution.reconcile': ['delivery.resume'], 'execution.closeLaunch': ['delivery.closeLaunch'],
      'runtime.room.context': ['room.post', 'room.reply'],
      'execution.background.begin': ['user.post', 'user.turn', 'observation.poll'],
    }
    if (allowed[method]) check(allowed[method].includes(rootMethod))
    if (method.startsWith('runtime.observer.') || method.startsWith('execution.shown.') || method === 'execution.observation.source')
      check(rootMethod === 'observation.poll' && record.context.actor?.kind === 'observer')
    if (method === 'runtime.observer.read' || method.startsWith('execution.shown.')) check(record.allowedBots?.has(params.botId))
    if (method === 'runtime.observer.check') check(params.projects.every(item => record.allowedBots?.has(item.id)))
    if (method === 'execution.observation.source') check(record.allowedBots?.has(params.target))
    if (method === 'usage.routing.read') check(record.context.callbackKind === 'turn.end'
      || ['room.post', 'room.reply', 'user.post', 'user.turn', 'observation.poll'].includes(rootMethod))
    let value
    if (method === 'execution.background.begin') {
      const source = admission.deliveryFor(record.lease, params)
      const observed = record.observerSources?.get(bindingKey({ generation, operationId: record.lease.correlation, ...params }))
      const sourceRecord = deliveries.get(source)?.record
      const savedTurn = record.context.callbackKind === 'user.complete' && sourceRecord === record.root
        && record.context.deliveryId === params.deliveryId && record.context.target === params.target
      check(sourceRecord === record || savedTurn || observed?.source === source)
      const actual = deferred(), ack = deferred(), backgroundId = randomUUID()
      const work = admission.runBackground(source, () => actual.promise)
      work.catch(() => {})
      admission.trackCompletion(record.lease, ack.promise); hold(record, ack.promise)
      const state = { record, ack, source }
      backgrounds.set(backgroundId, state)
      background.register(backgroundId, record.context, { complete: cause => { if (cause) actual.reject(cause); else actual.resolve() },
        waitEffects: async () => { while (record.effects.size) await Promise.allSettled([...record.effects]) } })
      if (observed && !observed.finished) { observed.finished = true; admission.finish(source) }
      value = { backgroundId }
    } else if (method === 'execution.background.end') {
      const state = backgrounds.get(params.backgroundId)
      check(state?.record === record)
      background.endRequested(params.backgroundId, record.context); value = { requested: true }
    } else if (['execution.notify', 'execution.turn', 'execution.report'].includes(method)) {
      const source = method === 'execution.report' ? admission.deliveryFor(record.lease, { deliveryId: params.sourceDeliveryId, target: params.target }) : null
      if (source) {
        const sourceRecord = deliveries.get(source)?.record
        const inline = record.context.callbackKind === 'turn.end' && sourceRecord === record.root
          && record.context.deliveryId === params.sourceDeliveryId && record.context.target === params.target
        check(inline || [...backgrounds.values()].some(state => state.record === record && state.source === source))
      }
      const delivery = register(record, params, source)
      // A local preparation refusal proves transport was never called; its registered delivery still needs the release ACK.
      try { record.options.admissionCheck?.() } catch (cause) { admission.finish(delivery); throw cause }
      try { value = await onEffect(method, params, enriched(record, delivery)) }
      catch (cause) { admission.finishUnclaimedDelivery(delivery); throw cause }
    } else {
      value = await onEffect(method, params, enriched(record))
      validateConversationEffectResult(method, value, params)
      if (method === 'runtime.observer.snapshot') check(value.projects.every(item => record.allowedBots?.has(item.botId)))
      if (method === 'execution.observation.source') {
        check(record.method === 'observation.poll' && record.context.actor?.kind === 'observer' && record.allowedBots?.has(params.target))
        validateConversationEffectResult(method, value, params)
        const source = admission.registerDelivery(record.lease, { deliveryId: value.deliveryId, target: value.target, kinds: [], dispatch: () => { throw error('CONVERSATION_OBSERVER_CALLBACK_INVALID') } })
        record.observerSources ??= new Map()
        record.observerSources.set(bindingKey({ generation, operationId: record.lease.correlation, ...value }), { source, finished: false })
      }
      if (method === 'members.profiles.read') record.allowedBots = new Set(value.bots.map(bot => bot.id))
    }
    validateConversationEffectResult(method, value, params)
    return value
  }
  peer = createConversationPeer(child, { side: 'parent',
    validateResult: (kind, method, value) => kind === 'control' ? (() => { validateConversationControlResult(method, value); if (method === 'initialize') initialized = true })()
      : kind === 'callback' ? validateConversationCallbackResult(method, value)
        : validateConversationResult(kind === 'accepted' ? 'user.post' : method, value),
    onDisconnect: cause => ready.reject(cause),
    onControl: async frame => {
      if (frame?.type === 'delivery-release-ack') return release.receive(frame)
      check(frame?.type === 'background-complete')
      const state = backgrounds.get(frame.backgroundId); check(state)
      try { await background.receive(frame); state.ack.resolve(); backgrounds.delete(frame.backgroundId) }
      catch (cause) { state.ack.reject(cause); throw cause }
    },
    accept: entry => {
      if (entry.kind === 'control' && entry.method === 'ready') return params => {
        check(initialized && !readySeen && entry.context === null && entry.source === null && exact(params, 'versionId,protocolVersion,stateCompatibility') && params.protocolVersion === 1
          && (params.versionId === null || /^[a-f0-9]{64}$/u.test(params.versionId)))
        assertConversationStateCompatibility(params.stateCompatibility); readySeen = true; ready.resolve(params); return { acknowledged: true }
      }
      if (entry.kind === 'diagnostic') return async params => { validDiagnostic(params); await onDiagnostic(params); return { acknowledged: true } }
      check(['effect', 'event'].includes(entry.kind))
      const record = live(entry.source, entry.context), done = deferred()
      record.effects.add(done.promise); hold(record, done.promise); admission.trackCompletion(record.lease, done.promise)
      peer.progress(record.id)
      const run = async params => {
        live(entry.source, entry.context)
        if (entry.kind === 'event') { validEvent(params); await onEvent(params, enriched(record)); return { acknowledged: true } }
        return executeEffect(record, entry.method, params)
      }
      run.finish = () => { record.effects.delete(done.promise); done.resolve() }
      return run
    },
  })
  const attach = (method, options, context, completion, id, root = null) => {
    const record = { id, method, options, context, actualCompletion: completion, lease: options.conversationLease, root, refs: 0, effects: new Set() }
    records.set(id, record); hold(record, completion); admission.trackCompletion(record.lease, completion)
    completion.finally(() => {
      for (const source of record.observerSources?.values() ?? []) if (!source.finished) { source.finished = true; admission.finish(source.source) }
    }).catch(() => {})
  }
  function request(method, params, options = {}, kind = 'root') {
    let lease, actor, requestId
    try { lease = admission.assertLease(options.conversationLease, { generation }); actor = authorizeActor(method, options.capturedAuthority)
      check((method === 'display.words') === (kind === 'callback'))
      validateConversationRequest(method, params, { generation, operationId: lease.correlation, actor, continuation: lease.epoch !== admission.capture().epoch }) }
    catch (cause) {
      const rejected = Promise.reject(cause); rejected.catch(() => {}); rejected.completion = rejected
      if (method === 'user.turn') rejected.accepted = rejected
      return rejected
    }
    const nativeTarget = kind === 'root' && method === 'user.turn' ? params.target : null
    return peer.call(kind, method, params, {
      context: Object.freeze({ generation, operationId: lease.correlation, actor: Object.freeze({ ...actor }), continuation: lease.epoch !== admission.capture().epoch }),
      onChunk: options.onChunk,
      getNativeContinuation: () => {
        if (kind !== 'root' || method !== 'user.turn') return null
        const record = records.get(requestId)
        if (!record) return null
        live(requestId, record.context)
        for (const info of deliveries.values()) {
          if (info.record !== record || info.source !== null || info.binding.target !== nativeTarget) continue
          const continuation = admission.getNativeContinuation?.(info.delivery, info.binding)
          if (continuation instanceof Promise) return continuation
        }
        return null
      },
      beforeSend: (completion, context, id) => { requestId = id; attach(method, options, context, completion, id) },
    })
  }
  function callback(method, params, options = {}) {
    if (method === 'display.words') return request(method, params, options, 'callback')
    const { conversationDelivery } = options
    const info = deliveries.get(conversationDelivery); check(info)
    const context = admission.binding(conversationDelivery, method)
    admission.assertCallback(conversationDelivery, context); validateConversationCallback(method, params)
    const root = info.record.root ?? info.record
    return peer.call('callback', method, params, { context, source: info.record.id,
      beforeSend: (completion, context, id) => { attach(method, info.record.options, context, completion, id, root); admission.trackCompletion(conversationDelivery, completion) },
    })
  }
  return { ready: ready.promise, request, callback, drainIncoming: peer.drainIncoming,
    control(method, params = {}, timeout = method === 'quiesce' ? 0 : 5000) {
      validateConversationControl(method, params, { generation, operationId: null })
      if (method === 'initialize') { check(!initializationStarted); initializationStarted = true }
      return peer.call('control', method, params, { context: { generation, operationId: null }, timeout })
    },
    async reaped() { await background.reaped(); release.reaped(); peer.reaped() },
    snapshot: () => ({ ...peer.snapshot(), contexts: records.size, deliveries: deliveries.size, backgrounds: backgrounds.size }),
  }
}

export function createConversationChildChannel({ dispatcher, endpoint = process, versionId = process.argv[2] === 'builtin' ? null : process.argv[2], afterControl }) {
  let generation = null, accepting = false, quiesced = false, epoch = 0, peer, background, release
  const contexts = new Map(), deliveries = new Map(), backgroundContexts = new Map(), waiters = new Set()
  const hold = record => { record.refs++; return () => { if (--record.refs === 0) { contexts.delete(record.context); for (const wake of waiters) wake(); waiters.clear() } } }
  const captured = context => { const record = contexts.get(context); check(record && context.generation === generation); return record }
  const callbacks = () => [...peer.pending.values()].map(task => task.completion.promise)
  peer = createConversationPeer(endpoint, { side: 'child',
    validateResult: (kind, method, value, task) => {
      if (kind === 'accepted') return validateConversationResult('user.post', value)
      if (kind === 'effect') return validateConversationEffectResult(method, value, task.params)
      check(exact(value, 'acknowledged') && value.acknowledged === true)
    },
    onDisconnect: () => { accepting = false; background?.reaped(); void dispatcher.disconnect().catch(() => {}) },
    onControl: async frame => {
      if (frame?.type === 'background-ack') {
        background.receive(frame); const done = backgroundContexts.get(frame.backgroundId); check(done); done(); backgroundContexts.delete(frame.backgroundId); return
      }
      check(frame?.type === 'delivery-release')
      await release(frame)
      const info = deliveries.get(bindingKey(frame.binding)); check(info); info.finish(); deliveries.delete(bindingKey(frame.binding))
    },
    afterResponse: async (entry, value) => {
      if (entry.kind !== 'control') return
      if (entry.method === 'initialize') await ready()
      if (afterControl) await afterControl(entry.method, value)
      else if (entry.method === 'exit') peer.close()
    },
    accept: entry => {
      if (entry.kind === 'control') {
        check(['initialize', 'quiesce', 'resume', 'exit', 'routing.changed'].includes(entry.method))
        if (entry.method === 'quiesce') accepting = false
        const current = entry.method === 'resume' ? ++epoch : epoch
        return async params => {
          validateConversationControl(entry.method, params, entry.context)
          if (entry.method === 'initialize') {
            check(generation === null); generation = params.generation
            background = createConversationBackgroundChild({ generation, assertContext: captured, send: frame => peer.control(frame), onFailure: () => peer.fail() })
            release = createConversationDeliveryReleaseChild({ generation, releaseDelivery: binding => dispatcher.releaseDelivery(binding), send: frame => peer.control(frame) })
          } else check(entry.context.generation === generation)
          const value = await dispatcher.control(entry.method, params, entry.context)
          if (entry.method === 'resume') { accepting = true; quiesced = false }
          if (entry.method === 'quiesce') {
            await background.drain(); await Promise.all(callbacks())
            while (contexts.size) await new Promise(resolve => waiters.add(resolve))
            check(current === epoch); quiesced = true
          }
          if (entry.method === 'exit') check(quiesced && contexts.size === 0)
          return value
        }
      }
      check(['root', 'callback'].includes(entry.kind) && entry.context?.generation === generation)
      const context = Object.freeze(structuredClone(entry.context))
      if (entry.kind === 'callback' && entry.method === 'display.words') {
        check(entry.source === null && context.actor?.kind === 'observer')
      } else if (entry.kind === 'callback') {
        validateConversationCallbackContext(entry.method, context)
        const source = deliveries.get(bindingKey(context)); check(source && source.record.id === entry.source)
      } else check(entry.method !== 'display.words' && (accepting || context.continuation === true))
      const record = { id: entry.id, context, refs: 0 }
      contexts.set(context, record)
      const finish = hold(record)
      const run = params => {
        if (entry.kind === 'root') { dispatcher.validateRequest(entry.method, params, context); return dispatcher.dispatch(entry.method, params, context) }
        dispatcher.validateCallback(entry.method, params, context); return dispatcher.dispatchCallback(entry.method, params, context)
      }
      run.finish = finish
      return run
    },
  })
  function dependent(kind, method, params, context) {
    const record = captured(context)
    if (kind === 'effect') validateConversationEffect(method, params, context)
    else validEvent(params)
    if (kind === 'effect' && ['execution.notify', 'execution.turn', 'execution.report'].includes(method)) {
      const binding = { generation, operationId: context.operationId, deliveryId: params.deliveryId, target: params.target }, key = bindingKey(binding)
      check(!deliveries.has(key)); deliveries.set(key, { record, finish: hold(record) })
    }
    const attempt = peer.call(kind, method, params, { context, source: record.id,
      beforeSend: completion => { const finish = hold(record); completion.then(finish, finish) } })
    if (kind === 'effect') return attempt.then(value => {
      validateConversationEffectResult(method, value, params)
      if (method === 'execution.background.begin') { background.issued(value.backgroundId, context); backgroundContexts.set(value.backgroundId, hold(record)) }
      if (method === 'execution.background.end') background.endAcknowledged(params.backgroundId, context)
      return value
    })
    attempt.catch(() => {})
    return attempt.completion
  }
  let sentReady = false
  function ready() {
    check(!sentReady && generation !== null && (versionId === null || /^[a-f0-9]{64}$/u.test(versionId)))
    sentReady = true
    return peer.call('control', 'ready', { versionId, protocolVersion: 1, stateCompatibility: CONVERSATION_STATE_COMPATIBILITY }, { timeout: 5000 })
  }
  return { effect: (method, params, context) => dependent('effect', method, params, context),
    event: (record, context) => dependent('event', 'changed', record, context),
    trackBackground: (...args) => background.trackBackground(...args),
    diagnostic: report => { validDiagnostic(report); return peer.call('diagnostic', 'diagnostic', report, { timeout: 5000 }) },
    ready, close: peer.close,
    snapshot: () => ({ ...peer.snapshot(), contexts: contexts.size, deliveries: deliveries.size, backgrounds: background?.snapshot().pending ?? 0 }),
  }
}
