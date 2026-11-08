import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeAtomic } from './json-file.mjs'
import { performance } from 'node:perf_hooks'

const NATIVE_MS = 15_000, SUMMARY_MS = 600_000
const HARNESSES = new Set(['codex-cli', 'claude-code', 'grok-cli', 'cursor-cli', 'antigravity-cli'])
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)
const launch = value => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',')
const point = value => JSON.stringify([value.sessionId, value.launchId, value.turnId])
const failure = (kind, status) => Object.assign(new Error(`CURRENT_WORK_${kind}`), { code: `CURRENT_WORK_${kind}`, status })

export function workSummaryInput(input) {
  if (!keys(input, ['expected', 'summary']) || !keys(input.expected, ['sessionId', 'launchId', 'turnId', 'revision'])
    || !text(input.expected.sessionId) || !launch(input.expected.launchId) || !text(input.expected.turnId) || !uuid(input.expected.revision)
    || input.summary !== null && (typeof input.summary !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input.summary)
      || !input.summary.trim() || [...input.summary.trim()].length > 160)) throw failure('INPUT_INVALID', 400)
  return { expected: { ...input.expected }, summary: input.summary === null ? null : input.summary.trim() }
}

// after_turn (current-work.md): every change of read(botId) per listener over a queue change stream.
// A refused read (engine exchange) is retried on the next change of any Bot.
export function watchCurrentTurn(watchQueue, read, listener) {
  if (typeof listener !== 'function') throw failure('LISTENER_INVALID', 400)
  const last = new Map(), retry = new Set()
  return watchQueue(change => {
    for (const botId of [...retry, ...(Array.isArray(change?.botIds) ? change.botIds : [])]) {
      let turn
      try { turn = read(botId) } catch { retry.add(botId); continue }
      retry.delete(botId)
      const key = `${turn.state}:${turn.turnId}`
      if (last.get(botId) === key) continue
      last.set(botId, key)
      try { listener({ botId, state: turn.state, turnId: turn.turnId }) } catch {}
    }
  })
}

// UI state stays observation-based; restart references also use actual accepted native input.
export class CurrentWork {
  constructor({ now = () => new Date().toISOString(), monotonic = () => performance.now(), notify = () => {}, activityPath = null, reportActivity = () => {} } = {}) {
    this.now = now; this.monotonic = monotonic; this.notify = notify
    this.activityPath = activityPath; this.reportActivity = () => { try { Promise.resolve(reportActivity()).catch(() => {}) } catch {} }; this.restartActivity = new Map(); this.activityQueue = Promise.resolve(); this.activityPending = 0
    this.records = new Map(); this.pending = new Map(); this.seq = 0; this.closed = false; this.timer = null
  }
  saveActivity() {
    if (!this.activityPath) return this.activityQueue
    const targets = [...this.restartActivity.values()].map(value => ({ ...value }))
    this.activityPending++
    const saving = this.activityQueue.then(async () => {
      await mkdir(dirname(this.activityPath), { recursive: true, mode: 0o700 })
      await writeAtomic(this.activityPath, { schema: 'bellteam.execution-activity.v1', targets })
    })
    this.activityQueue = saving.catch(() => { this.reportActivity() }).finally(() => { this.activityPending-- })
    return saving
  }
  startedActivity(botId, harness, sessionId, receipt) {
    if (this.closed || !text(botId) || !text(harness) || receipt?.session_id !== sessionId || !launch(receipt.launch_id)) return null
    const value = { botId, harness, sessionId, launchId: receipt.launch_id, observedAt: this.now() }
    this.restartActivity.set(botId, value); void this.saveActivity().catch(() => {})
    return value
  }
  finishedActivity(botId, expected) {
    if (!expected || this.restartActivity.get(botId) !== expected) return
    this.restartActivity.delete(botId); void this.saveActivity().catch(() => {})
  }
  async takeRestartActivity() {
    if (!this.activityPath) return []
    await this.activityQueue
    let file
    try {
      file = await open(this.activityPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await file.stat()
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 65536) throw Error('ACTIVITY_INVALID')
      const value = JSON.parse(await file.readFile('utf8'))
      if (!keys(value, ['schema', 'targets']) || value.schema !== 'bellteam.execution-activity.v1' || !Array.isArray(value.targets)
        || value.targets.some(row => !keys(row, ['botId','harness','sessionId','launchId','observedAt'])
          || ![row.botId,row.harness,row.sessionId].every(text) || !launch(row.launchId) || typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt)))
        || new Set(value.targets.map(row => row.botId)).size !== value.targets.length) throw Error('ACTIVITY_INVALID')
      this.restartActivity.clear()
      await this.saveActivity()
      return value.targets
    } catch (error) {
      if (error.code !== 'ENOENT') this.reportActivity()
      return []
    } finally { await file?.close() }
  }
  record(botId) {
    if (!this.records.has(botId)) this.records.set(botId, {
      botId, sessionId: null, launchId: null, turnId: null, revision: randomUUID(), state: 'unknown',
      observedAt: null, observedMono: null, summary: null, summaryStatus: 'missing', summaryUpdatedAt: null,
      summaryMono: null, lastRead: 0, barrier: 0, completed: null,
    })
    return this.records.get(botId)
  }
  changed(record) {
    record.revision = randomUUID()
    const pending = this.pending.get(record.botId)
    if (pending && pending.expected.revision !== record.revision) this.finish(pending, failure('CONFLICT', 409))
    // Notification failure must not turn a committed self report into a failed/retried update.
    try { this.notify(record.botId) } catch {}
  }
  clearSummary(record) {
    record.summary = null; record.summaryStatus = 'missing'; record.summaryUpdatedAt = null; record.summaryMono = null
  }
  unknown(record, barrier = true) {
    if (barrier) record.barrier = ++this.seq
    const changed = record.state !== 'unknown' || record.launchId !== null || record.summaryStatus !== 'missing'
    record.state = 'unknown'; record.launchId = null; record.turnId = null; record.observedMono = null
    this.clearSummary(record)
    if (this.pending.has(record.botId)) this.finish(this.pending.get(record.botId), failure('UNAVAILABLE', 503))
    if (changed) this.changed(record)
  }
  invalidate(botId) { this.finishedActivity(botId, this.restartActivity.get(botId)); this.unknown(this.record(botId)); this.schedule() }
  sync(botId, sessionId, available = true) {
    const record = this.record(botId)
    if (record.sessionId !== sessionId) { this.unknown(record); record.sessionId = sessionId; record.absent = false }
    if (!available || this.closed) this.unknown(record)
    this.expire(record)
    return record
  }
  expire(record) {
    const now = this.monotonic()
    if (record.state !== 'unknown' && now - record.observedMono >= NATIVE_MS) this.unknown(record)
    else if (record.summaryStatus === 'current' && now - record.summaryMono >= SUMMARY_MS) {
      record.summary = null; record.summaryStatus = 'stale'; this.changed(record)
    }
  }
  snapshot(botId, sessionId, available = true) {
    const record = this.sync(botId, sessionId, available)
    return { state: record.state, summary: record.summary, summaryStatus: record.summaryStatus,
      summaryUpdatedAt: record.summaryUpdatedAt, observedAt: record.observedAt,
      source: record.summaryStatus === 'missing' ? null : 'self_reported' }
  }
  binding(botId, sessionId, available = true) {
    const record = this.sync(botId, sessionId, available)
    return record.state === 'working' ? { sessionId: record.sessionId, launchId: record.launchId, turnId: record.turnId, revision: record.revision } : null
  }
  // after_turn: the owning Bot's actual current turn (current-work.md). Pure read of the latest observation.
  turn(botId) {
    const record = this.records.get(botId)
    if (!record) return { state: 'unknown', turnId: null }
    this.expire(record)
    if (record.state === 'working')
      return { state: 'working', turnId: createHash('sha256').update(point(record)).digest('hex') }
    return { state: record.state === 'idle' || record.state === 'unknown' && record.absent ? 'idle' : 'unknown', turnId: null }
  }
  beginRead(targets) {
    for (const target of targets) this.sync(target.botId, target.sessionId, target.current())
    return { seq: ++this.seq, targets }
  }
  endRead(read, data) {
    if (this.closed) return
    const valid = data?.schema === 'aiterm.seat-turns.v1' && !Object.hasOwn(data, 'error') && Array.isArray(data.seats)
    const rows = valid ? data.seats : []
    for (const target of read.targets) {
      const record = this.record(target.botId)
      if (read.seq <= record.barrier || read.seq <= record.lastRead) continue
      record.lastRead = read.seq
      if (!target.current() || target.sessionId !== record.sessionId) { this.unknown(record); continue }
      const matches = rows.filter(row => row?.session_id === target.sessionId)
      // A valid read without this seat proves no turn can run (after_turn reads it as idle; the DTO stays unknown).
      const absent = valid && matches.length === 0
      if (record.absent !== absent) { record.absent = absent; try { this.notify(record.botId) } catch {} }
      const row = matches.length === 1 ? matches[0] : null, turn = row?.turn
      const running = turn?.state === 'running' && text(turn.turn_id) && (row.harness === 'codex-cli'
        || keys(turn, ['state', 'turn_id', 'started_at', 'event_cursor', 'interim_from', 'wait_process'])
          && typeof turn.started_at === 'string' && Number.isFinite(Date.parse(turn.started_at))
          && turn.event_cursor === null && turn.interim_from === null && turn.wait_process === null)
      const idle = turn?.state === 'idle' && Object.keys(turn).length === 1
      if (!valid || !HARNESSES.has(row?.harness) || row.harness !== (target.harness ?? 'codex-cli')
        || !launch(row?.launch_id) || !running && !idle) {
        this.unknown(record); continue
      }
      const next = { sessionId: target.sessionId, launchId: row.launch_id, turnId: running ? turn.turn_id : null }
      if (running && record.completed === point(next)) { this.unknown(record); continue }
      const state = running ? 'working' : 'idle'
      const changed = record.state !== state || record.launchId !== next.launchId || record.turnId !== next.turnId
      if (changed) { this.clearSummary(record); Object.assign(record, next, { state }) }
      record.observedAt = this.now(); record.observedMono = this.monotonic()
      const active = this.restartActivity.get(target.botId)
      if (running) {
        if (active?.sessionId === target.sessionId && active.launchId === row.launch_id) {
          active.observedAt = record.observedAt; void this.saveActivity().catch(() => {})
        } else this.startedActivity(target.botId, row.harness, target.sessionId, { session_id: target.sessionId, launch_id: row.launch_id })
      } else if (active?.sessionId === target.sessionId) this.finishedActivity(target.botId, active)
      if (changed) this.changed(record)
      this.expire(record)
      const pending = this.pending.get(target.botId)
      if (pending && read.seq > pending.seq) this.commit(pending, record)
    }
    this.schedule()
  }
  completedTurn(result) {
    if (result?.schema !== 'aiterm.agent-wait-result.v1' || result.outcome !== 'done'
      || !text(result.session_id) || !launch(result.launch_id) || !text(result.turn_id)) return
    const done = point({ sessionId: result.session_id, launchId: result.launch_id, turnId: result.turn_id })
    for (const record of this.records.values()) if (record.state === 'working' && point(record) === done) {
      record.completed = done; this.unknown(record)
    }
    this.schedule()
  }
  actor(record, source) {
    const origin = source?.source?.launch
    return source?.sourceSession === record.sessionId && origin?.session_id === record.sessionId && origin?.launch_id === record.launchId
  }
  selfBinding(botId, sessionId, source, available = true) {
    const binding = this.binding(botId, sessionId, available)
    return binding && this.actor(this.record(botId), source) ? binding : null
  }
  update(botId, sessionId, input, source, current = () => true) {
    const { expected, summary } = workSummaryInput(input)
    source = { sourceSession: source?.sourceSession, source: { launch: source?.source?.launch ? { ...source.source.launch } : null } }
    const record = this.sync(botId, sessionId, current())
    if (source.sourceSession !== sessionId || source.source.launch?.session_id !== sessionId || !launch(source.source.launch?.launch_id)) throw failure('FORBIDDEN', 403)
    if (record.state !== 'working' || this.closed) throw failure('UNAVAILABLE', 503)
    if (!this.actor(record, source)) throw failure('FORBIDDEN', 403)
    if (!Object.entries(expected).every(([key, value]) => record[key] === value)) throw failure('CONFLICT', 409)
    if (this.pending.has(botId)) throw failure('CONFLICT', 409)
    return new Promise((resolve, reject) => {
      const pending = { botId, expected, summary, source, current, seq: ++this.seq, resolve, reject }
      pending.timer = setTimeout(() => this.finish(pending, failure('UNAVAILABLE', 503)), NATIVE_MS)
      this.pending.set(botId, pending)
    })
  }
  commit(pending, record) {
    if (!pending.current()) { this.unknown(record); this.finish(pending, failure('UNAVAILABLE', 503)); return }
    if (!this.actor(record, pending.source)) { this.finish(pending, failure('FORBIDDEN', 403)); return }
    if (record.state !== 'working' || !Object.entries(pending.expected).every(([key, value]) => record[key] === value)) {
      this.finish(pending, failure('CONFLICT', 409)); return
    }
    this.pending.delete(record.botId); clearTimeout(pending.timer)
    const changed = pending.summary !== null || record.summaryStatus !== 'missing'
    record.summary = pending.summary; record.summaryStatus = pending.summary === null ? 'missing' : 'current'
    record.summaryUpdatedAt = pending.summary === null ? null : this.now()
    record.summaryMono = pending.summary === null ? null : this.monotonic()
    if (changed) this.changed(record)
    pending.resolve({ currentWork: this.snapshot(record.botId, record.sessionId), currentWorkBinding: this.binding(record.botId, record.sessionId) })
  }
  finish(pending, error) {
    if (this.pending.get(pending.botId) !== pending) return
    this.pending.delete(pending.botId); clearTimeout(pending.timer); pending.reject(error)
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null
    if (this.closed) return
    const deadlines = [...this.records.values()].flatMap(record => [
      ...(record.state !== 'unknown' ? [record.observedMono + NATIVE_MS] : []),
      ...(record.summaryStatus === 'current' ? [record.summaryMono + SUMMARY_MS] : []),
    ])
    if (!deadlines.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      for (const record of this.records.values()) this.expire(record)
      this.schedule()
    }, Math.max(1, Math.min(...deadlines) - this.monotonic()))
    this.timer.unref?.()
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.timer = null
    for (const pending of this.pending.values()) this.finish(pending, failure('UNAVAILABLE', 503))
    for (const record of this.records.values()) this.unknown(record)
  }
}
