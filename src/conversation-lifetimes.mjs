import { randomUUID } from 'node:crypto'

export const CONVERSATION_CALLBACK_KINDS = Object.freeze(['delivery.status', 'delivery.words', 'delivery.answer', 'user.complete', 'turn.end'])
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value)
const rejected = () => Object.assign(new Error('CONVERSATION_NOT_ACCEPTED'), { code: 'CONVERSATION_NOT_ACCEPTED', status: 503, outcome: 'not_accepted', effect: 'not_started' })
const protocolError = () => Object.assign(new Error('CONVERSATION_PROTOCOL_UNCONFIRMED'), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED', status: 503, outcome: 'outcome_unknown', effect: 'possible' })

// IPC owns the eight root slots. These references follow real work after those slots are released.
export class ConversationLifetimes {
  #generation; #epoch = 0; #ticket = null; #records = new WeakMap(); #active = new Set(); #operations = new Map(); #waiters = new Set(); #failed = false
  constructor(generation = 'builtin', { onProtocolFailure = () => {} } = {}) {
    if (!id(generation)) throw rejected()
    this.#generation = generation; this.onProtocolFailure = onProtocolFailure
  }
  capture() { return Object.freeze({ generation: this.#generation, epoch: this.#epoch }) }
  assertOpen(expected = this.capture()) {
    if (this.#ticket || this.#failed || expected?.generation !== this.#generation || expected?.epoch !== this.#epoch) throw rejected()
  }
  enter(expected = this.capture(), correlation = randomUUID()) {
    this.assertOpen(expected)
    if (!id(correlation) || this.#operations.has(correlation)) throw rejected()
    const record = this.#make('operation', correlation)
    record.usedDeliveries = new Set(); this.#operations.set(correlation, record)
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
    if (!record?.live || lease.generation !== this.#generation) throw rejected()
    return record
  }
  assertLease(lease, { generation = lease?.generation, correlation = lease?.correlation } = {}) {
    this.#record(lease)
    if (generation !== lease.generation || correlation !== lease.correlation) throw rejected()
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
    if (!record.live || !record.finishRequested || record.pending.size) return
    record.live = false; this.#active.delete(record)
    if (record.kind === 'operation') this.#operations.delete(record.lease.correlation)
    else record.dispatch = null
    record.resolve(); this.#notifyDrained()
  }
  withLease(operation, { lease, expected, correlation } = {}) {
    const owned = !lease, current = lease ? this.assertLease(lease) : this.enter(expected, correlation)
    let result
    try { result = operation(current) } catch (error) { if (owned) this.finish(current); throw error }
    return Promise.resolve(result).finally(() => { if (owned) this.finish(current) })
  }
  registerDelivery(lease, { deliveryId, target, dispatch, kinds }) {
    const operation = this.#record(lease)
    const key = JSON.stringify([deliveryId, target])
    if (operation.kind !== 'operation' || !id(deliveryId) || !id(target) || typeof dispatch !== 'function'
      || !Array.isArray(kinds) || new Set(kinds).size !== kinds.length || kinds.some(kind => !CONVERSATION_CALLBACK_KINDS.includes(kind))
      || operation.usedDeliveries.has(key)) throw this.#protocol()
    operation.usedDeliveries.add(key)
    const record = this.#make('delivery', lease.correlation)
    Object.assign(record, { operation, binding: Object.freeze({ generation: lease.generation, operationId: lease.correlation, deliveryId, target }),
      dispatch, kinds: new Set(kinds), report: false, reportUsed: false, backgroundStarted: false, reportWindow: false })
    this.trackCompletion(lease, record.done)
    return record.lease
  }
  assertDelivery(lease, { deliveryId, target } = {}) {
    let record
    try { record = this.#record(lease) } catch { throw this.#protocol() }
    if (record.kind !== 'delivery' || record.failed || deliveryId !== undefined && record.binding.deliveryId !== deliveryId
      || target !== undefined && record.binding.target !== target) throw this.#protocol()
    return lease
  }
  binding(lease, callbackKind) {
    this.assertDelivery(lease)
    const record = this.#records.get(lease)
    if (record.failed || !record.kinds.has(callbackKind)) throw this.#protocol()
    return Object.freeze({ ...record.binding, callbackKind })
  }
  assertCallback(lease, claimed) {
    const expected = this.binding(lease, claimed?.callbackKind)
    if (!claimed || Object.keys(claimed).length !== 5 || !Object.entries(expected).every(([key, value]) => claimed[key] === value)) throw this.#protocol()
    return lease
  }
  claimNative(lease, { deliveryId, target, kind }) {
    this.assertDelivery(lease, { deliveryId, target })
    const record = this.#records.get(lease)
    if (record.nativeClaimed || !['turn', 'notify', 'report'].includes(kind) || record.report !== (kind === 'report')
      || kind === 'turn' && (record.kinds.has('delivery.answer') || record.kinds.has('turn.end'))
      || kind === 'notify' && record.kinds.has('user.complete')) throw this.#protocol()
    record.nativeClaimed = true
  }
  supports(lease, kind) { this.assertDelivery(lease); return this.#records.get(lease).kinds.has(kind) }
  isReport(lease) { this.assertDelivery(lease); return this.#records.get(lease).report }
  #run(lease, operation) {
    this.assertLease(lease)
    let resolve, reject
    const completion = new Promise((yes, no) => { resolve = yes; reject = no })
    this.trackCompletion(lease, completion)
    try { Promise.resolve(operation()).then(resolve, reject) } catch (error) { reject(error) }
    return completion
  }
  invoke(lease, kind, params) {
    const binding = this.binding(lease, kind), record = this.#records.get(lease)
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw this.#protocol()
    if (kind === 'turn.end') {
      if (record.report || record.backgroundStarted) throw this.#protocol()
      record.backgroundStarted = true; record.reportWindow = true
    }
    return this.#run(lease, async () => {
      try {
        const result = await record.dispatch(kind, params, binding)
        if (!result || Array.isArray(result) || Object.keys(result).length !== 1 || result.applied !== true) throw protocolError()
        return result
      }
      catch (error) { record.failed = true; this.#protocol(); throw error }
      finally { if (kind === 'turn.end') record.reportWindow = false }
    })
  }
  runBackground(lease, operation) {
    this.assertDelivery(lease)
    const record = this.#records.get(lease)
    if (record.report || record.backgroundStarted || typeof operation !== 'function') throw this.#protocol()
    record.backgroundStarted = true; record.reportWindow = true
    return this.#run(lease, async () => { try { return await operation() } catch (error) { this.#protocol(); throw error } finally { record.reportWindow = false } })
  }
  deriveReport(lease, { deliveryId, reason, dispatch, kinds = ['delivery.status', 'delivery.words', 'delivery.answer'] }) {
    this.assertDelivery(lease)
    const source = this.#records.get(lease)
    if (source.report || source.reportUsed || !source.reportWindow || !['missing', 'content'].includes(reason)
      || !Array.isArray(kinds) || kinds.some(kind => ['user.complete', 'turn.end'].includes(kind))) throw this.#protocol()
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
  #protocol() {
    const first = !this.#failed
    this.#failed = true
    const error = protocolError()
    if (first) { try { this.onProtocolFailure({ code: error.code, generation: this.#generation }) } catch {} }
    for (const waiter of this.#waiters) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.#waiters.clear()
    return error
  }
  close() {
    if (!this.#ticket) { this.#epoch++; this.#ticket = Object.freeze({ generation: this.#generation, epoch: this.#epoch }) }
    return this.#ticket
  }
  #assertTicket(ticket) { if (!this.#ticket || ticket !== this.#ticket) throw rejected() }
  #notifyDrained() {
    if (this.#active.size || this.#failed) return
    for (const waiter of this.#waiters) { clearTimeout(waiter.timer); waiter.resolve({ status: 'drained' }) }
    this.#waiters.clear()
  }
  drain(ticket, { timeoutMs = 60_000 } = {}) {
    this.#assertTicket(ticket)
    if (this.#failed) return Promise.reject(protocolError())
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw rejected()
    if (!this.#active.size) return Promise.resolve({ status: 'drained' })
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => { this.#waiters.delete(waiter); resolve({ status: 'busy' }) }, timeoutMs)
      this.#waiters.add(waiter)
    })
  }
  adopt(ticket, generation) {
    this.#assertTicket(ticket)
    if (this.#failed || this.#active.size || !id(generation) || generation === this.#generation) throw rejected()
    this.#generation = generation
  }
  resume(ticket) { this.#assertTicket(ticket); if (this.#failed) throw protocolError(); this.#ticket = null }
  snapshot() { return { generation: this.#generation, closed: Boolean(this.#ticket), active: this.#active.size, unconfirmed: this.#failed } }
}
