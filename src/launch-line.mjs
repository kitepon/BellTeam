// a505b (docs/architecture/modules/execution/memory-budget.md): cold seat launches wait FIFO while the container's memory is full.
import { HOLD, SEAT_BYTES } from './memory-pressure.mjs'

export class LaunchLine {
  // pressure(): {anon, max, ratio} | null. A wait never fails a delivery: it ends when memory frees or after maxWaitMs.
  constructor({ pressure, hold = HOLD, seatBytes = SEAT_BYTES, pollMs = 5000, maxWaitMs = 45_000, settleMs = 30_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { pressure, hold, seatBytes, pollMs, maxWaitMs, settleMs, now, sleep })
    this.entries = new Map()
    this.tail = Promise.resolve()
    this.admitted = []
  }

  has(botId) { return this.entries.has(botId) }

  // A seat already in the line shares its entry: a later delivery for it (a sweep prompt) takes no second place.
  enter(botId) {
    const existing = this.entries.get(botId)
    if (existing) return existing
    const deadline = this.now() + this.maxWaitMs
    const turn = this.tail.then(() => this.#wait(deadline))
    this.tail = turn.catch(() => {})
    const entry = turn.finally(() => this.entries.delete(botId))
    this.entries.set(botId, entry)
    return entry
  }

  async #wait(deadline) {
    for (;;) {
      const sample = await this.pressure().catch(() => null)
      const now = this.now()
      this.admitted = this.admitted.filter(at => now - at < this.settleMs)
      // A launch shows in the memory reading only after it ran: seats admitted in the last settleMs count as already there.
      if (!sample || (sample.anon + this.admitted.length * this.seatBytes) / sample.max < this.hold || now >= deadline) break
      await this.sleep(Math.min(this.pollMs, Math.max(1, deadline - now)))
    }
    this.admitted.push(this.now())
  }
}
