import { isDeepStrictEqual as same } from 'node:util'
import { performance } from 'node:perf_hooks'

const TTL = 600_000
const fields = ['botId', 'sessionId', 'launchId', 'inputRevision', 'deliveryId', 'context', 'contextId']
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...names].sort().join()
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const allowed = context => ['owner', 'bot', 'scheduler'].includes(context?.actor?.kind)
  && ['user.post', 'user.turn', 'direct.post', 'room.post', 'room.reply'].includes(context?.rootMethod)
const fail = () => { throw new Error('BACKGROUND_SUMMARY_INVALID') }
// East Asian Width F/W = 2, everything else 1 (Owner 2026-11-08: the member list fits width 40 under a name).
// shortcut: block-level F/W ranges (CJK, kana, Hangul, fullwidth forms, emoji planes); a few narrow symbols inside the emoji
// blocks count 2 (stricter, never cut off) and rare wide symbols in U+2xxx count 1. Use a full EAW table if those matter.
const WIDE = [[0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
  [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
  [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF], [0x1F900, 0x1F9FF], [0x1FA70, 0x1FAFF], [0x20000, 0x3FFFD]]
export const BACKGROUND_SUMMARY_MAX_WIDTH = 40
export const summaryWidth = text => [...text].reduce((sum, char) => {
  const code = char.codePointAt(0)
  return sum + (WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1)
}, 0)
// Over-width output is rejected, never cut.
export function backgroundSummaryText(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) fail()
  const text = value.trim()
  if (!text) fail()
  const width = summaryWidth(text)
  if (width > BACKGROUND_SUMMARY_MAX_WIDTH) throw Object.assign(new Error('BACKGROUND_SUMMARY_TOO_WIDE'), { code: 'BACKGROUND_SUMMARY_TOO_WIDE', width })
  return text
}
function configuration(value) {
  if (!exact(value, ['revision', 'selection'])) fail()
  if ((value.revision === null) !== (value.selection === null)
    || value.revision !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.revision)) fail()
  if (value.selection !== null && (!value.revision || !exact(value.selection, ['harness', 'model', 'reasoningEffort'])
    || !['claude', 'codex', 'grok', 'cursor', 'antigravity'].includes(value.selection.harness)
    || !id(value.selection.model) || typeof value.selection.reasoningEffort !== 'string' || value.selection.reasoningEffort.length > 256)) fail()
  return structuredClone(value)
}

// One parent instance owns all runs, including cancellation until actual settlement.
export class TeamBackgroundSummary {
  constructor({ configuration: readConfiguration, readInput, run, notify = () => {}, enabled = () => true,
    now = () => new Date().toISOString(), monotonic = () => performance.now() }) {
    if (![readConfiguration, readInput, run, notify, enabled].every(value => typeof value === 'function')) fail()
    this.configuration = readConfiguration; this.readInput = readInput; this.run = run; this.notify = notify
    this.enabled = enabled; this.now = now; this.monotonic = monotonic
    this.settings = { revision: null, selection: null }; this.records = new Map(); this.queue = new Map()
    this.active = null; this.draining = null; this.closed = false; this.timer = null
  }
  changed(botId) { try { this.notify(botId) } catch {} }
  dropped(botId, stage, error = null) {
    // No text or summary is written; this line is the only trace of an attempt that produced nothing.
    const code = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error?.code ?? '') ? error.code : error ? 'UNKNOWN' : 'none'
    try { process.stderr.write(`BellTeam background summary: ${botId} ${stage} ${code}\n`) } catch {}
  }
  clear(record) {
    record.summary = null; record.summaryUpdatedAt = null; record.summaryStatus = 'missing'; record.summaryMono = null
  }
  configure(value) {
    const next = configuration(value)
    if (same(next, this.settings)) return
    this.settings = next
    if (this.active?.revision && this.active.revision !== next.revision) this.active.controller.abort()
    for (const record of this.records.values()) {
      this.clear(record); this.changed(record.input.botId)
      if (this.current(record)) this.queue.set(record.input.botId, record)
    }
    this.schedule(); this.start()
  }
  current(record) {
    if (this.closed || this.records.get(record.input.botId) !== record) return false
    try { return record.authority.assertCurrent(record.input) !== false && this.enabled() !== false } catch { return false }
  }
  accept(input, authority) {
    if (!exact(input, fields) || !fields.every(key => id(input[key])) || !/^[a-f0-9]{32}$/u.test(input.launchId)
      || !['direct', 'room'].includes(input.context) || !allowed(authority?.context)
      || typeof authority?.assertCurrent !== 'function' || this.closed) return
    const old = this.records.get(input.botId)
    if (old && same(old.input, input)) return
    if (this.active?.record.input.botId === input.botId) this.active.controller.abort()
    const record = { input: Object.freeze({ ...input }), authority }
    this.clear(record); this.records.set(input.botId, record)
    this.queue.set(input.botId, record); this.changed(input.botId); this.start()
  }
  invalidate(botId, inputRevision = null) {
    const record = this.records.get(botId)
    if (!record || inputRevision !== null && record.input.inputRevision !== inputRevision) return
    this.records.delete(botId); this.queue.delete(botId)
    if (this.active?.record === record) this.active.controller.abort()
    this.changed(botId); this.schedule()
  }
  snapshot(botId, sessionId, fallback) {
    const record = this.records.get(botId)
    if (!record) return { ...fallback, summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, source: null }
    if (record.input.sessionId !== sessionId || !this.current(record)) {
      this.invalidate(botId)
      return { ...fallback, summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, source: null }
    }
    this.expire(record)
    return { state: fallback.state, summary: record.summary, summaryStatus: record.summaryStatus,
      summaryUpdatedAt: record.summaryUpdatedAt, observedAt: fallback.observedAt,
      source: record.summaryStatus === 'missing' ? null : 'background_agent' }
  }
  expire(record) {
    if (record.summaryStatus === 'current' && this.monotonic() - record.summaryMono >= TTL) {
      record.summary = null; record.summaryStatus = 'stale'; this.changed(record.input.botId)
    }
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null
    if (this.closed) return
    const deadlines = [...this.records.values()].filter(record => record.summaryStatus === 'current').map(record => record.summaryMono + TTL)
    if (!deadlines.length) return
    this.timer = setTimeout(() => { for (const record of this.records.values()) this.expire(record); this.schedule() },
      Math.max(1, Math.min(...deadlines) - this.monotonic()))
    this.timer.unref?.()
  }
  start() {
    if (this.draining || this.closed || !this.queue.size) return
    this.draining = this.drainQueue().finally(() => { this.draining = null; if (this.queue.size && !this.closed) this.start() })
    this.draining.catch(() => {})
  }
  async drainQueue() {
    while (this.queue.size && !this.closed) {
      const [botId, record] = this.queue.entries().next().value
      this.queue.delete(botId)
      const controller = new AbortController(), active = { record, controller, revision: null }
      this.active = active
      let stage = 'configuration'
      try {
        const fresh = configuration(await this.configuration())
        this.configure(fresh)
        // configure may coalesce the same record; this iteration owns its attempt.
        if (this.queue.get(botId) === record) this.queue.delete(botId)
        active.revision = fresh.revision
        if (!fresh.selection || !this.current(record) || controller.signal.aborted) continue
        const revision = fresh.revision
        stage = 'read'
        const input = await this.readInput(record.input, record.authority)
        if (!input || !exact(input, [...fields, 'text', 'progress']) || !fields.every(key => input[key] === record.input[key])
          || typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 4000
          || typeof input.progress !== 'string' || [...input.progress].length > 1000) { this.dropped(botId, 'read_empty'); continue }
        if (!this.current(record) || controller.signal.aborted || this.settings.revision !== revision) continue
        stage = 'run'
        const material = { text: input.text, progress: input.progress }
        let summary
        try { summary = backgroundSummaryText(await this.run(fresh.selection, JSON.stringify(material), { signal: controller.signal })) }
        catch (error) {
          // Over-width output gets exactly one regeneration told its measured width; any other failure is not retried.
          if (error.code !== 'BACKGROUND_SUMMARY_TOO_WIDE' || !this.current(record) || controller.signal.aborted) throw error
          summary = backgroundSummaryText(await this.run(fresh.selection, JSON.stringify({ ...material, previous_width: error.width }), { signal: controller.signal }))
        }
        stage = 'result'
        stage = 'configuration'
        const latest = configuration(await this.configuration())
        this.configure(latest)
        if (!this.current(record) || controller.signal.aborted || !same(fresh, latest)) continue
        record.summary = summary; record.summaryStatus = 'current'; record.summaryUpdatedAt = this.now(); record.summaryMono = this.monotonic()
        this.changed(botId); this.schedule()
      } catch (error) {
        // An unknown attempt is never retried; only a new input or configuration can enqueue it.
        if (!controller.signal.aborted && !this.closed) this.dropped(botId, stage, error)
      } finally { if (this.active === active) this.active = null }
    }
  }
  async close() {
    this.closed = true; this.queue.clear(); this.active?.controller.abort()
    clearTimeout(this.timer); this.timer = null
    for (const botId of this.records.keys()) this.changed(botId)
    this.records.clear()
    await this.draining
  }
}
