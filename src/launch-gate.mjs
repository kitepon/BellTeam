// a505c (docs/architecture/modules/execution/memory-budget.md): is the container's memory too full to start another cold seat?
import { HOLD, SEAT_BYTES } from './memory-pressure.mjs'

export class LaunchGate {
  constructor({ pressure, hold = HOLD, seatBytes = SEAT_BYTES, settleMs = 30_000, now = Date.now, record = null } = {}) {
    Object.assign(this, { pressure, hold, seatBytes, settleMs, now, record })
    this.recent = []
  }

  // Every cold launch is recorded: it shows in the memory reading only after it ran, so seats started in the last settleMs count as already there.
  // Returns the entry so a launch that did not start anything can take it back (abandon): a failed launch used no memory.
  launched() { const entry = { at: this.now() }; this.recent.push(entry); return entry }
  abandon(entry) { this.recent = this.recent.filter(item => item !== entry) }

  // No reading is no pressure (unknown is not danger).
  async tight() {
    const sample = await this.pressure().catch(() => null)
    if (!sample) return false
    const now = this.now()
    this.recent = this.recent.filter(item => now - item.at < this.settleMs)
    const effective = (sample.anon + this.recent.length * this.seatBytes) / sample.max
    this.record?.peak(effective)
    return effective >= this.hold
  }
}
