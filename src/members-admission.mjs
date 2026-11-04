import { randomUUID } from 'node:crypto'
import { MODULE_CONCURRENCY } from './module-ipc.mjs'

const rejected = () => Object.assign(new Error('MEMBERS_NOT_ACCEPTED'), {
  code: 'MEMBERS_NOT_ACCEPTED', status: 503, outcome: 'not_accepted', effect: 'not_started',
})

export const MEMBERS_READ_PIN_METHODS = Object.freeze(['profiles.read', 'profile.read', 'removals.read', 'owner.read', 'rules.read', 'schedules.list'])

// Parent-owned leases survive admission closure, never a generation change.
export class MembersAdmission {
  #generation
  #epoch = 0
  #leases = new Set()
  #readPins = new Set()
  #completions = new Map()
  #ticket = null
  #waiters = new Set()

  constructor(generation = 'builtin') {
    if (typeof generation !== 'string' || !generation) throw rejected()
    this.#generation = generation
  }

  capture() { return Object.freeze({ generation: this.#generation, epoch: this.#epoch }) }

  assertOpen(expected = this.capture()) {
    if (this.#ticket || expected?.generation !== this.#generation || expected?.epoch !== this.#epoch
    ) throw rejected()
  }

  enter(expected = this.capture(), correlation = randomUUID()) {
    this.assertOpen(expected)
    if (this.#leases.size >= MODULE_CONCURRENCY || typeof correlation !== 'string' || !correlation) throw rejected()
    const lease = Object.freeze({ leaseId: randomUUID(), generation: this.#generation, epoch: this.#epoch, correlation })
    this.#leases.add(lease)
    this.#completions.set(lease, { finishRequested: false, pending: new Set() })
    return lease
  }

  assertLease(lease, { generation = lease?.generation, correlation = lease?.correlation } = {}) {
    if (!this.#leases.has(lease) || lease.generation !== this.#generation
      || generation !== lease.generation || correlation !== lease.correlation) throw rejected()
    return lease
  }

  finish(lease) {
    this.assertLease(lease)
    this.#completions.get(lease).finishRequested = true
    this.#releaseFinished(lease)
  }

  trackCompletion(lease, completion) {
    this.assertLease(lease)
    this.#trackCompletion(lease, completion)
  }

  #trackCompletion(lease, completion) {
    if (!(completion instanceof Promise)) throw rejected()
    const state = this.#completions.get(lease)
    if (state.pending.has(completion)) return
    state.pending.add(completion)
    const done = () => { state.pending.delete(completion); this.#releaseFinished(lease) }
    completion.then(done, done)
  }

  #releaseFinished(lease) {
    const state = this.#completions.get(lease)
    if (!state?.finishRequested || state.pending.size) return
    this.#completions.delete(lease)
    this.#leases.delete(lease)
    this.#readPins.delete(lease)
    if (!this.#leases.size && !this.#readPins.size) {
      for (const done of this.#waiters) done()
      this.#waiters.clear()
    }
  }

  enterReadPin(method, expected = this.capture(), correlation = randomUUID()) {
    this.assertOpen(expected)
    if (!MEMBERS_READ_PIN_METHODS.includes(method) || typeof correlation !== 'string' || !correlation) throw rejected()
    const pin = Object.freeze({ leaseId: randomUUID(), generation: this.#generation, epoch: this.#epoch, correlation, method })
    this.#readPins.add(pin)
    this.#completions.set(pin, { finishRequested: false, pending: new Set() })
    return pin
  }

  assertReadPin(pin, { method = pin?.method, generation = pin?.generation, correlation = pin?.correlation } = {}) {
    if (!this.#readPins.has(pin) || pin.generation !== this.#generation || method !== pin.method
      || generation !== pin.generation || correlation !== pin.correlation) throw rejected()
    return pin
  }

  finishReadPin(pin) {
    this.assertReadPin(pin)
    this.#completions.get(pin).finishRequested = true
    this.#releaseFinished(pin)
  }

  trackReadCompletion(pin, completion) {
    this.assertReadPin(pin)
    this.#trackCompletion(pin, completion)
  }

  withReadPin(method, operation, { pin, expected, correlation } = {}) {
    const owned = !pin
    const current = pin ? this.assertReadPin(pin, { method }) : this.enterReadPin(method, expected, correlation)
    let result
    try { result = operation(current) }
    catch (error) { if (owned) this.finishReadPin(current); throw error }
    return Promise.resolve(result).finally(() => { if (owned) this.finishReadPin(current) })
  }

  withLease(operation, { lease, expected } = {}) {
    const owned = !lease
    const current = lease ? this.assertLease(lease) : this.enter(expected)
    let result
    try { result = operation(current) }
    catch (error) { if (owned) this.finish(current); throw error }
    return Promise.resolve(result).finally(() => { if (owned) this.finish(current) })
  }

  close() {
    if (this.#ticket) return this.#ticket
    this.#epoch++
    this.#ticket = Object.freeze({ generation: this.#generation, epoch: this.#epoch })
    return this.#ticket
  }

  #assertTicket(ticket) {
    if (!this.#ticket || ticket !== this.#ticket) throw rejected()
  }

  drain(ticket) {
    this.#assertTicket(ticket)
    if (!this.#leases.size && !this.#readPins.size) return Promise.resolve()
    return new Promise(resolve => this.#waiters.add(resolve))
  }

  adopt(ticket, generation) {
    this.#assertTicket(ticket)
    if (this.#leases.size || this.#readPins.size || typeof generation !== 'string' || !generation || generation === this.#generation) throw rejected()
    this.#generation = generation
  }

  resume(ticket) {
    this.#assertTicket(ticket)
    this.#ticket = null
  }
}
