// a525 (docs/architecture/modules/execution/memory-budget.md "The record"): what the memory control did, for whoever asks. Not a guard: a failed write is dropped.
import { rename, writeFile } from 'node:fs/promises'

export class MemoryBudgetRecord {
  constructor({ path, now = () => new Date() } = {}) {
    Object.assign(this, { path, now })
    this.data = { schema: 'bellteam.memory-budget.v1', since: now().toISOString(),
      early_sleep: { count: 0, last_at: null }, refusal: { count: 0, last_at: null }, peak: { share: 0, at: null } }
    this.writing = Promise.resolve()
  }

  earlySleep() { this.count('early_sleep') }
  refusal() { this.count('refusal') }

  // A rise below one point is not a change worth a write.
  peak(share) {
    if (!(share >= this.data.peak.share + 0.01)) return
    this.data.peak = { share: Math.round(share * 1000) / 1000, at: this.now().toISOString() }
    this.save()
  }

  count(key) {
    this.data[key] = { count: this.data[key].count + 1, last_at: this.now().toISOString() }
    this.save()
  }

  save() {
    if (!this.path) return
    const body = `${JSON.stringify(this.data, null, 2)}\n`
    this.writing = this.writing.then(async () => {
      await writeFile(`${this.path}.tmp`, body, { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    }).catch(() => {})
  }
}
