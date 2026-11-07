// Z-c body update hold (docs/architecture/modules/execution/update-hold.md). Parent-resident in the execution assembly.
import { readFile, rm } from 'node:fs/promises'
import { writeAtomic } from './json-file.mjs'

export const UPDATE_HOLD_STOP_WINDOW_MS = 120_000 // installer answer→SIGTERM is ≤ 30 s (container-update-bundled.md)
const POLL_MS = 250
const SCHEMA = 'bellteam.update-hold.v1'

export const updateHoldError = () => Object.assign(new Error('BOT_UPDATE_HOLD'), { code: 'BOT_UPDATE_HOLD', status: 503, effect: 'not_started',
  publicMessage: 'BellTeam本体の更新中のため、このメッセージは保留しました。更新後に順番どおり届けます。' })

export class UpdateHold {
  constructor({ path, active = () => [], now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimer = (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer }, clearTimer = clearTimeout,
    stopWindow = UPDATE_HOLD_STOP_WINDOW_MS, report = () => {} } = {}) {
    Object.assign(this, { path, active, now, sleep, setTimer, clearTimer, stopWindow, report })
    this.state = null
    this.quiescing = null
    this.expiry = null
    this.listeners = new Set()
  }

  get held() { return this.state !== null }

  assertInput() { if (this.state) throw updateHoldError() }

  // A hold saved by the previous box stays active until afterListenReady releases it.
  async initialize() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      this.state = value?.schema === SCHEMA ? value : { schema: SCHEMA, requestId: null, startedAt: this.now(), answeredAt: null, result: null, interrupted: [] }
    } catch (error) {
      // An unreadable file is still a hold: the previous box was being replaced, so input waits for startup release.
      if (error.code !== 'ENOENT') this.state = { schema: SCHEMA, requestId: null, startedAt: this.now(), answeredAt: null, result: null, interrupted: [] }
    }
  }

  activeDeliveries() {
    return this.active().filter(item => item.status !== 'failed')
      .map(item => ({ botId: item.botId, deliveryId: item.groupId ?? item.id, startedAt: item.startedAt ?? null }))
  }

  async save() { await writeAtomic(this.path, this.state) }

  quiesce({ requestId, deadline }) {
    if (this.quiescing?.requestId === requestId) return this.quiescing.answer
    if (this.state?.requestId === requestId && this.state.result) return Promise.resolve({ result: this.state.result })
    const answer = (async () => {
      this.state = { schema: SCHEMA, requestId, deadline, startedAt: this.now(), answeredAt: null, result: null, interrupted: [] }
      this.clearExpiry()
      // The hold is durable before anything waits on it.
      await this.save()
      while (this.activeDeliveries().length && this.now() < deadline) await this.sleep(Math.min(POLL_MS, Math.max(1, deadline - this.now())))
      const running = this.activeDeliveries()
      Object.assign(this.state, { answeredAt: this.now(), result: running.length ? 'deadline' : 'drained', interrupted: running })
      await this.save()
      // Lease exit: a body still alive after the stop window was not replaced (aborted update).
      this.expiry = this.setTimer(() => { this.release('expired').catch(error => this.report(error)) }, this.stopWindow)
      return { result: this.state.result }
    })().catch(async error => {
      // An unanswered quiesce must not leave input refused: the installer stops anyway (quiesce=unconfirmed).
      await this.release('quiesce_failed').catch(() => {})
      throw error
    }).finally(() => { if (this.quiescing?.answer === answer) this.quiescing = null })
    this.quiescing = { requestId, answer }
    return answer
  }

  // Shutdown before an answer (or without quiesce): keep what is still running as interrupted.
  async onShutdownSignal() {
    if (!this.state || this.state.answeredAt) return
    this.state.interrupted = this.activeDeliveries()
    await this.save()
  }

  async release(reason) {
    if (!this.state) return false
    this.clearExpiry()
    // Clear first so the exit is unconditional; a file that cannot be removed only re-holds until the next startup release.
    this.state = null
    await rm(this.path, { force: true }).catch(error => this.report(error))
    // Listeners hear the release only after input is admitted again; an earlier wake would only be held again.
    for (const listener of [...this.listeners]) { try { listener({ released: true, reason }) } catch (error) { this.report(error) } }
    return true
  }

  clearExpiry() { if (this.expiry) { this.clearTimer(this.expiry); this.expiry = null } }

  watch(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() { this.clearExpiry(); this.listeners.clear() }
}
