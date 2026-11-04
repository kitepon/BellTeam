import { randomUUID } from 'node:crypto'

export const CONVERSATION_CALLBACK_KINDS = Object.freeze(['delivery.status', 'delivery.words', 'delivery.answer', 'user.complete', 'turn.end'])
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value)
const rejected = () => Object.assign(new Error('CONVERSATION_NOT_ACCEPTED'), { code: 'CONVERSATION_NOT_ACCEPTED', status: 503, outcome: 'not_accepted', effect: 'not_started' })
const protocolError = () => Object.assign(new Error('CONVERSATION_PROTOCOL_UNCONFIRMED'), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED', status: 503, outcome: 'outcome_unknown', effect: 'possible' })

// IPC owns the eight root slots. These references follow real work after those slots are released.
export class ConversationLifetimes {
  #observation = { writerRevision: 0, closedBy: null, closedAt: null, closedWriterRevision: null,
    failureSource: null, failureAt: null, failureWriterRevision: null, transition: null, transitionAt: null, revision: 0 }
  #generation; #epoch = 0; #ticket = null; #records = new WeakMap(); #active = new Set(); #operations = new Map(); #waiters = new Set(); #failed = false; #retiredFailed = new Set(); #generations = new Set(); #closeWaiters = new Set(); #nativeUnknown = new Set()
  constructor(generation = 'builtin', { onProtocolFailure = () => {} } = {}) {
    if (!id(generation)) throw rejected()
    this.#generation = generation; this.#generations.add(generation); this.onProtocolFailure = onProtocolFailure
  }
  capture() { return Object.freeze({ generation: this.#generation, epoch: this.#epoch }) }
  assertOpen(expected = this.capture()) {
    if (this.#ticket || this.#failed || expected?.generation !== this.#generation || expected?.epoch !== this.#epoch) throw rejected()
  }
  enter(expected = this.capture(), correlation = randomUUID()) {
    this.assertOpen(expected)
    if (!id(correlation) || this.#operations.has(correlation)) throw rejected()
    const record = this.#make('operation', correlation)
    record.usedDeliveries = new Map(); this.#operations.set(correlation, record)
    return record.lease
  }
  tryEnter(expected = this.capture(), correlation = randomUUID()) {
    if (this.#ticket || this.#failed) return null
    return this.enter(expected, correlation)
  }
  #make(kind, correlation) {
    const lease = Object.freeze({ leaseId: randomUUID(), generation: this.#generation, epoch: this.#epoch, correlation })
    let done
    const record = { lease, kind, live: true, finishRequested: false, pending: new Set(), done: new Promise(resolve => { done = resolve }), resolve: () => done() }
    this.#records.set(lease, record); this.#active.add(record)
    return record
  }
  #record(lease) {
    const record = this.#records.get(lease)
    if (!record?.live) throw rejected()
    return record
  }
  assertLease(lease, { generation = lease?.generation, correlation = lease?.correlation } = {}) {
    this.#record(lease)
    if (generation !== lease.generation || correlation !== lease.correlation) throw rejected()
    return lease
  }
  assertCurrentLease(lease, expected) {
    this.assertLease(lease, expected)
    if (lease.generation !== this.#generation) throw this.#protocol(lease, 'assert_current_lease')
    return lease
  }
  finish(lease) {
    const record = this.#record(lease)
    record.finishRequested = true; this.#release(record)
  }
  trackCompletion(lease, completion) {
    const record = this.#record(lease)
    if (!(completion instanceof Promise)) throw rejected()
    if (record.pending.has(completion)) return
    record.pending.add(completion)
    const done = () => { record.pending.delete(completion); this.#release(record) }
    completion.then(done, done)
  }
  #release(record) {
    if (!record.live || !record.finishRequested || record.pending.size || record.nativeUnconfirmed) return
    record.live = false; this.#active.delete(record)
    if (record.kind === 'operation') this.#operations.delete(record.lease.correlation)
    else record.dispatch = null
    record.resolve(); this.#notifyDrained()
  }
  withLease(operation, { lease, expected, correlation } = {}) {
    const owned = !lease, current = lease ? this.assertCurrentLease(lease) : this.enter(expected, correlation)
    let result
    try { result = operation(current) } catch (error) { if (owned) this.finish(current); throw error }
    return Promise.resolve(result).finally(() => { if (owned) this.finish(current) })
  }
  registerDelivery(lease, { deliveryId, target, dispatch, kinds }) {
    this.assertCurrentLease(lease)
    const operation = this.#record(lease)
    const key = JSON.stringify([deliveryId, target])
    if (operation.kind !== 'operation' || !id(deliveryId) || !id(target) || typeof dispatch !== 'function'
      || !Array.isArray(kinds) || new Set(kinds).size !== kinds.length || kinds.some(kind => !CONVERSATION_CALLBACK_KINDS.includes(kind))
      || operation.usedDeliveries.has(key)) throw this.#protocol(lease, 'register_delivery')
    const record = this.#make('delivery', lease.correlation)
    Object.assign(record, { operation, binding: Object.freeze({ generation: lease.generation, operationId: lease.correlation, deliveryId, target }),
      dispatch, kinds: new Set(kinds), report: false, reportUsed: false, backgroundStarted: false, reportWindow: false })
    operation.usedDeliveries.set(key, record.lease)
    this.trackCompletion(lease, record.done)
    return record.lease
  }
  deliveryFor(lease, { deliveryId, target }) {
    let operation
    try { operation = this.#record(lease) } catch { throw this.#protocol(lease, 'delivery_for') }
    const delivery = operation.kind === 'operation' && operation.usedDeliveries.get(JSON.stringify([deliveryId, target]))
    if (!delivery) throw this.#protocol(lease, 'delivery_for')
    return this.assertDelivery(delivery, { deliveryId, target })
  }
  assertDelivery(lease, { deliveryId, target } = {}) {
    let record
    try { record = this.#record(lease) } catch { throw this.#protocol(lease, 'assert_delivery') }
    if (record.kind !== 'delivery' || record.failed || deliveryId !== undefined && record.binding.deliveryId !== deliveryId
      || target !== undefined && record.binding.target !== target) throw this.#protocol(lease, 'assert_delivery')
    return lease
  }
  finishUnclaimedDelivery(lease) {
    const record = this.#records.get(lease)
    if (!record || record.kind !== 'delivery') throw rejected()
    if (!record.live || record.nativeClaimed || record.finishRequested) return false
    record.finishRequested = true; this.#release(record)
    return true
  }
  operationCompletion(lease) {
    const record = this.#record(lease)
    if (record.kind !== 'operation') throw rejected()
    return record.done
  }
  deliveryCompletion(lease) {
    const record = this.#record(lease)
    if (record.kind !== 'delivery') throw rejected()
    return record.done
  }
  trackNativeContinuation(lease, receipt, completion) {
    const record = this.#record(lease)
    if (record.kind !== 'delivery' || !record.nativeClaimed || record.nativeContinuation || !(completion instanceof Promise)
      || !['agent_dispatch', 'agent_steer'].includes(receipt?.mode)
      || !Number.isInteger(receipt.event_cursor) || !receipt.wait_process) throw this.#protocol(lease, 'track_native_continuation')
    const native = record.nativeContinuation = { receipt, completion, pending: true }
    completion.then(() => { native.pending = false }, error => {
      native.pending = false
      if (error?.turnCompleted !== true) {
        record.nativeUnconfirmed = true; this.#nativeUnknown.add(record)
      }
    })
    this.trackCompletion(lease, completion)
  }
  getNativeContinuation(lease, expectedBinding) {
    const record = this.#records.get(lease)
    if (this.#failed || !record?.live || record.kind !== 'delivery' || record.failed
      || lease.generation !== this.#generation || !record.nativeClaimed || !record.nativeContinuation?.pending
      || !expectedBinding || Object.keys(expectedBinding).length !== 4
      || !Object.entries(record.binding).every(([key, value]) => Object.hasOwn(expectedBinding, key) && expectedBinding[key] === value)) return null
    return record.nativeContinuation.completion
  }
  binding(lease, callbackKind) {
    this.assertDelivery(lease)
    if (lease.generation !== this.#generation) throw this.#protocol(lease, 'binding')
    const record = this.#records.get(lease)
    if (record.failed || !record.kinds.has(callbackKind)) throw this.#protocol(lease, 'binding')
    return Object.freeze({ ...record.binding, callbackKind })
  }
  assertCallback(lease, claimed) {
    const expected = this.binding(lease, claimed?.callbackKind)
    if (!claimed || Object.keys(claimed).length !== 5 || !Object.entries(expected).every(([key, value]) => claimed[key] === value)) throw this.#protocol(lease, 'assert_callback')
    return lease
  }
  claimNative(lease, { deliveryId, target, kind }) {
    this.assertCurrentLease(lease)
    this.assertDelivery(lease, { deliveryId, target })
    const record = this.#records.get(lease)
    if (record.nativeClaimed || !['turn', 'notify', 'report'].includes(kind) || record.report !== (kind === 'report')
      || kind === 'turn' && (record.kinds.has('delivery.answer') || record.kinds.has('turn.end'))
      || kind === 'notify' && record.kinds.has('user.complete')) throw this.#protocol(lease, 'claim_native')
    record.nativeClaimed = true
  }
  supports(lease, kind) { this.assertDelivery(lease); return this.#records.get(lease).kinds.has(kind) }
  isReport(lease) { this.assertDelivery(lease); return this.#records.get(lease).report }
  #run(lease, operation) {
    this.assertCurrentLease(lease)
    let resolve, reject
    const completion = new Promise((yes, no) => { resolve = yes; reject = no })
    this.trackCompletion(lease, completion)
    try { Promise.resolve(operation()).then(resolve, reject) } catch (error) { reject(error) }
    return completion
  }
  invoke(lease, kind, params) {
    const binding = this.binding(lease, kind), record = this.#records.get(lease)
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw this.#protocol(lease, 'invoke')
    if (kind === 'turn.end') {
      if (record.report || record.backgroundStarted) throw this.#protocol(lease, 'invoke')
      record.backgroundStarted = true; record.reportWindow = true
    }
    return this.#run(lease, async () => {
      try {
        const dispatched = record.dispatch(kind, params, binding)
        const result = await (dispatched?.completion ?? dispatched)
        if (!result || Array.isArray(result) || Object.keys(result).length !== 1 || result.applied !== true) throw protocolError()
        return result
      }
      catch (error) { record.failed = true; this.#protocol(lease, 'invoke'); throw error }
      finally { if (kind === 'turn.end') record.reportWindow = false }
    })
  }
  runBackground(lease, operation) {
    this.assertCurrentLease(lease)
    this.assertDelivery(lease)
    const record = this.#records.get(lease)
    if (record.report || record.backgroundStarted || typeof operation !== 'function') throw this.#protocol(lease, 'run_background')
    record.backgroundStarted = true; record.reportWindow = true
    return this.#run(lease, async () => { try { return await operation() } catch (error) { this.#protocol(lease, 'run_background'); throw error } finally { record.reportWindow = false } })
  }
  deriveReport(lease, { deliveryId, reason, dispatch, kinds = ['delivery.status', 'delivery.words', 'delivery.answer'] }) {
    this.assertCurrentLease(lease)
    this.assertDelivery(lease)
    const source = this.#records.get(lease)
    if (source.report || source.reportUsed || !source.reportWindow || !['missing', 'content'].includes(reason)
      || !Array.isArray(kinds) || kinds.some(kind => ['user.complete', 'turn.end'].includes(kind))) throw this.#protocol(lease, 'derive_report')
    // A refused native preparation still consumes the one report right; never reissue it.
    source.reportUsed = true
    const child = this.registerDelivery(source.operation.lease, { deliveryId, target: source.binding.target, dispatch, kinds })
    Object.assign(this.#records.get(child), { report: true, reason, sourceDeliveryId: source.binding.deliveryId })
    return child
  }
  callbacks(lease) {
    this.assertDelivery(lease)
    const result = {}
    for (const [name, kind, callback] of [
      ['onStatus', 'delivery.status', (delivery, error, tracking) => this.invoke(lease, 'delivery.status', { delivery, error, tracking })],
      ['onInterim', 'delivery.words', words => this.invoke(lease, 'delivery.words', { words })],
      ['onAnswer', 'delivery.answer', text => this.invoke(lease, 'delivery.answer', { text })],
      ['onTurnEnd', 'turn.end', ({ startedAt, endedAt }) => this.invoke(lease, 'turn.end', { startedAt, endedAt })],
      ['userComplete', 'user.complete', reply => this.invoke(lease, 'user.complete', { reply })],
    ]) if (this.supports(lease, kind)) result[name] = callback
    return result
  }
  #protocol(lease, source) {
    const record = this.#records.get(lease)
    // A known retired capability cannot fail the current generation; wire IDs alone confer no exemption.
    if (record && record.lease.generation !== this.#generation) {
      this.#retiredFailed.add(record.lease.generation)
      return protocolError()
    }
    const first = !this.#failed
    this.#failed = true
    if (first) {
      this.#transition('protocol')
      Object.assign(this.#observation, { failureSource: source, failureAt: this.#observation.transitionAt,
        failureWriterRevision: this.#observation.writerRevision })
    }
    const error = protocolError()
    if (first) { try { this.onProtocolFailure({ code: error.code, generation: this.#generation }) } catch {} }
    for (const waiter of this.#waiters) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.#waiters.clear()
    return error
  }
  #transition(kind) {
    this.#observation.transition = kind; this.#observation.transitionAt = Date.now(); this.#observation.revision++
  }
  close(source = 'unknown') {
    if (!this.#ticket) {
      this.#epoch++; this.#ticket = Object.freeze({ generation: this.#generation, epoch: this.#epoch })
      this.#transition('close')
      Object.assign(this.#observation, { closedBy: CONVERSATION_ADMISSION_CLOSE_SOURCES.includes(source) ? source : 'unknown',
        closedAt: this.#observation.transitionAt, closedWriterRevision: this.#observation.writerRevision })
    }
    return this.#ticket
  }
  #assertTicket(ticket) { if (!this.#ticket || ticket !== this.#ticket) throw rejected() }
  #unconfirmed() { return this.#failed || this.#retiredFailed.size > 0 || this.#nativeUnknown.size > 0 }
  #notifyDrained() {
    if (this.#active.size) return
    for (const waiter of this.#closeWaiters) {
      clearTimeout(waiter.timer)
      if (this.#unconfirmed()) waiter.reject(protocolError())
      else waiter.resolve({ status: 'drained' })
    }
    this.#closeWaiters.clear()
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      if (this.#unconfirmed()) waiter.reject(protocolError())
      else waiter.resolve({ status: 'drained' })
    }
    this.#waiters.clear()
  }
  drain(ticket, { timeoutMs = 60_000 } = {}) {
    this.#assertTicket(ticket)
    if (this.#unconfirmed()) return Promise.reject(protocolError())
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw rejected()
    if (!this.#active.size) return Promise.resolve({ status: 'drained' })
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => { this.#waiters.delete(waiter); resolve({ status: 'busy' }) }, timeoutMs)
      this.#waiters.add(waiter)
    })
  }
  drainForClose(ticket, { timeoutMs = 60_000 } = {}) {
    this.#assertTicket(ticket)
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw rejected()
    if (!this.#active.size) return this.#unconfirmed() ? Promise.reject(protocolError()) : Promise.resolve({ status: 'drained' })
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => { this.#closeWaiters.delete(waiter); resolve({ status: 'busy' }) }, timeoutMs)
      this.#closeWaiters.add(waiter)
    })
  }
  recoverFailedGeneration(ticket, previousGeneration, generation) {
    this.#assertTicket(ticket)
    if (previousGeneration !== this.#generation || !id(generation) || this.#generations.has(generation)) throw rejected()
    if (this.#failed) this.#retiredFailed.add(previousGeneration)
    this.#generations.add(generation); this.#generation = generation; this.#failed = false
    this.#observation.writerRevision++; this.#transition('recover_failed_generation')
  }
  adopt(ticket, generation) {
    this.#assertTicket(ticket)
    if (this.#unconfirmed() || this.#active.size || !id(generation) || generation === this.#generation) throw rejected()
    this.#generations.add(generation); this.#generation = generation
    this.#observation.writerRevision++; this.#transition('adopt')
  }
  recover(ticket, previousGeneration, generation) {
    this.#assertTicket(ticket)
    if (previousGeneration !== this.#generation || ticket.generation !== previousGeneration || this.#active.size || this.#retiredFailed.size
      || !id(generation) || generation === previousGeneration) throw rejected()
    this.#generations.add(generation); this.#generation = generation; this.#failed = false
    this.#observation.writerRevision++; this.#transition('recover')
  }
  resume(ticket) { this.#assertTicket(ticket); if (this.#failed) throw protocolError(); this.#ticket = null; this.#transition('resume') }
  inspectAdmission() {
    return { schema: 'bellteam.conversation-admission.v1', ticket: Boolean(this.#ticket), failed: this.#failed,
      active: this.#active.size, unconfirmed: this.#unconfirmed(), ...this.#observation }
  }
  snapshot() { return { generation: this.#generation, closed: Boolean(this.#ticket), active: this.#active.size, unconfirmed: this.#unconfirmed() } }
}

export const CONVERSATION_ADMISSION_CLOSE_SOURCES = Object.freeze([
  'unknown', 'module_start', 'module_replace', 'module_close', 'module_child_exit', 'module_recovery', 'module_protocol_failure',
])
const failureSources = ['assert_current_lease', 'register_delivery', 'delivery_for', 'assert_delivery',
  'track_native_continuation', 'binding', 'assert_callback', 'claim_native', 'invoke', 'run_background', 'derive_report']
const transitions = ['close', 'protocol', 'adopt', 'recover', 'recover_failed_generation', 'resume']
const keys = ['schema', 'ticket', 'failed', 'active', 'unconfirmed', 'writerRevision', 'closedBy', 'closedAt',
  'closedWriterRevision', 'failureSource', 'failureAt', 'failureWriterRevision', 'transition', 'transitionAt', 'revision'].sort().join(',')
const integer = value => Number.isSafeInteger(value) && value >= 0

export function validateConversationAdmissionDiagnostic(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys
    || value.schema !== 'bellteam.conversation-admission.v1'
    || ['ticket', 'failed', 'unconfirmed'].some(key => typeof value[key] !== 'boolean')
    || ['active', 'writerRevision', 'revision'].some(key => !integer(value[key]))
    || ['closedAt', 'closedWriterRevision', 'failureAt', 'failureWriterRevision', 'transitionAt'].some(key => value[key] !== null && !integer(value[key]))
    || value.closedBy !== null && !CONVERSATION_ADMISSION_CLOSE_SOURCES.includes(value.closedBy)
    || value.failureSource !== null && !failureSources.includes(value.failureSource)
    || value.transition !== null && !transitions.includes(value.transition))
    throw Object.assign(new Error('CONVERSATION_ADMISSION_DIAGNOSTIC_INVALID'), { code: 'CONVERSATION_ADMISSION_DIAGNOSTIC_INVALID' })
  return { ...value }
}
