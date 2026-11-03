import { randomUUID } from 'node:crypto'

const rejected = () => Object.assign(new Error('MEMBERS_NOT_ACCEPTED'), {
  code: 'MEMBERS_NOT_ACCEPTED', status: 503, outcome: 'not_accepted', effect: 'not_started',
})

// Parent-owned leases survive admission closure, never a generation change.
export class MembersAdmission {
  #generation
  #epoch = 0
  #leases = new Set()
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
    if (this.#leases.size >= 8 || typeof correlation !== 'string' || !correlation) throw rejected()
    const lease = Object.freeze({ leaseId: randomUUID(), generation: this.#generation, epoch: this.#epoch, correlation })
    this.#leases.add(lease)
    return lease
  }

  assertLease(lease, { generation = lease?.generation, correlation = lease?.correlation } = {}) {
    if (!this.#leases.has(lease) || lease.generation !== this.#generation
      || generation !== lease.generation || correlation !== lease.correlation) throw rejected()
    return lease
  }

  finish(lease) {
    this.assertLease(lease)
    this.#leases.delete(lease)
    if (!this.#leases.size) {
      for (const done of this.#waiters) done()
      this.#waiters.clear()
    }
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
    if (!this.#leases.size) return Promise.resolve()
    return new Promise(resolve => this.#waiters.add(resolve))
  }

  adopt(ticket, generation) {
    this.#assertTicket(ticket)
    if (this.#leases.size || typeof generation !== 'string' || !generation || generation === this.#generation) throw rejected()
    this.#generation = generation
  }

  resume(ticket) {
    this.#assertTicket(ticket)
    this.#ticket = null
  }
}
