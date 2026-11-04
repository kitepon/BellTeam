import { deliveryTracking } from './delivery-tracking.mjs'
import { watch } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { TimelineIndex } from './timeline-index.mjs'

export class ConversationStore {
  constructor({ logPath, onCorruption = logCorruption }) {
    this.logPath = logPath
    this.onCorruption = onCorruption
    this.read = emptyRead()
    this.observedSize = null
    this.queue = Promise.resolve()
    this.listeners = new Set()
    this.preview = null
  }
  async records() { return (await this.entries()).filter(record => record.schema === 'bellteam.direct-message.v1') }
  async deliveryAnchor({ deliveryId, target, context, contextId }) {
    await this.snapshot()
    const records = this.read.byDelivery.get(deliveryId), record = records?.length === 1 ? records[0] : null
    return !this.read.anchorInvalid && record?.target === target && typeof record.from === 'string'
      && typeof record.message === 'string' && typeof record.at === 'string'
      ? { deliveryId, target, context, contextId } : null
  }
  async entries() {
    const state = await this.snapshot()
    return state.resolved ??= state.entries.map(record => record.schema === 'bellteam.direct-message.v1' && state.statuses.has(record.delivery_id)
      ? resolveStatus(record, state.statuses) : record)
  }
  snapshot() {
    const run = this.queue.then(() => this.readAppended())
    this.queue = run.catch(() => {})
    return run
  }
  async readAppended() {
    let file
    try { file = await open(this.logPath, 'r') }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (this.observedSize !== null) this.changed({ all: true })
      this.observedSize = null; this.preview = null
      return this.read = emptyRead()
    }
    try {
      const info = await file.stat({ bigint: true })
      const size = Number(info.size), ino = `${info.dev}:${info.ino}`, mtimeMs = Number(info.mtimeMs)
      const signature = `${info.mtimeNs}:${info.ctimeNs}`
      const reset = ino !== this.read.ino || (this.observedSize !== null && size < this.observedSize)
        || (size === this.observedSize && signature !== this.read.signature)
      this.observedSize = size
      if (reset) {
        this.read = { ...emptyRead(), ino, mtimeMs, signature }
        this.preview = null
        this.changed({ all: true })
      }
      if (size === this.read.offset) return this.read
      const buffer = Buffer.alloc(size - this.read.offset)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.read.offset)
      const complete = bytesRead ? buffer.lastIndexOf(0x0a, bytesRead - 1) + 1 : 0
      const previewChanged = this.preview && complete && buffer.toString('utf8', 0, buffer.indexOf(0x0a)) !== this.preview.text
      const { records, lines } = parseRecords(buffer.subarray(0, complete), this.read, diagnostic => {
        this.read.anchorInvalid = true
        // 診断先の失敗や未終端Promiseで、有効な履歴の読取りを止めない。
        try { Promise.resolve(this.onCorruption(diagnostic)).catch(() => logCorruption(diagnostic)) }
        catch { logCorruption(diagnostic) }
      })
      if (complete) {
        const change = applyRecords(records, this.read)
        this.read.offset += complete
        this.read.lines += lines
        this.preview = null
        if (records.length || previewChanged) this.changed({ ...change, all: change.all || Boolean(previewChanged) })
      }
      this.read.mtimeMs = mtimeMs; this.read.signature = signature
      if (complete === bytesRead) return this.read
      const rest = buffer.toString('utf8', complete, bytesRead)
      let value
      try { value = JSON.parse(rest) } catch { return this.read }
      validateRecord(value, this.read.lines + 1)
      // JSONとして完結していても、改行なしの末尾は暫定表示とする。
      // 内容が同じ間は表示を再利用し、確定した行へ二重に追加しない。
      if (this.preview?.text !== rest || this.preview.base !== this.read) {
        const state = cloneRead(this.read)
        applyRecords([value], state)
        this.preview = { text: rest, base: this.read, state }
        this.changed(changeFor([value], this.read))
      }
      return this.preview.state
    } finally { await file.close() }
  }
  async timelineView(botId) {
    const state = await this.snapshot()
    return botView(state, botId).index
  }
  async timeline(botId) {
    const state = await this.snapshot(), view = botView(state, botId)
    return view.snapshot ??= (state.byBot.get(botId) ?? []).map(key => view.index.get(key))
  }
  async timelineViews(botIds) {
    const state = await this.snapshot()
    return new Map(botIds.map(id => [id, botView(state, id).index]))
  }
  changed(change) {
    for (const listener of this.listeners) listener({ topics: ['timeline'], botIds: [], roomIds: [], all: false, ...change })
  }
  async watch(onChange) {
    await mkdir(dirname(this.logPath), { recursive: true })
    const filename = basename(this.logPath)
    const watcher = watch(dirname(this.logPath), (_event, changed) => {
      if (changed == null || changed === filename) this.snapshot().catch(() => this.changed({ all: true }))
    })
    watcher.on('error', () => this.changed({ all: true }))
    this.listeners.add(onChange)
    // 初回の読取は別の利用箇所が先に行う場合もある。再構築時は全体へ通知し、
    // クライアントも初回・再接続のreadyごとに全体を照合する。
    return () => { this.listeners.delete(onChange); watcher.close() }
  }
}

function messageItem(record, direction) {
  return {
    id: record.delivery_id,
    kind: 'message',
    direction,
    at: record.at,
    message: record.message,
    image: record.image === true,
    ...(record.image_count ? { image_count: record.image_count } : {}),
    imageAsset: record.image_asset ?? null,
    imageAssets: record.image_assets ?? [],
    delivery: record.delivery ?? 'delivered',
    ...(deliveryTracking(record.delivery, record.delivery_tracking) ? { deliveryTracking: deliveryTracking(record.delivery, record.delivery_tracking) } : {}),
  }
}

// 合間の言葉はBotの発言と同じ吹き出しで出す。ラベルは付けない。
function interimItem(record) {
  return {
    id: record.id,
    kind: 'interim',
    direction: 'incoming',
    at: record.at,
    message: record.text,
    image: false,
    imageAsset: null,
    delivery: 'delivered',
  }
}

function peerItem(record, direction, peer) {
  const identity = direction === 'sent' ? record.target_identity : record.from_identity
  return {
    id: record.delivery_id,
    kind: 'peer',
    direction,
    at: record.at,
    peer,
    peerName: identity?.name ?? peer,
    peerPosition: identity?.position ?? '',
    peerRole: identity?.role ?? '',
    message: record.message,
    image: record.image === true,
    ...(record.image_count ? { image_count: record.image_count } : {}),
    imageAsset: record.image_asset ?? null,
    imageAssets: record.image_assets ?? [],
    delivery: record.delivery ?? 'delivered',
    ...(deliveryTracking(record.delivery, record.delivery_tracking) ? { deliveryTracking: deliveryTracking(record.delivery, record.delivery_tracking) } : {}),
  }
}

function emptyRead() {
  return { ino: null, mtimeMs: null, offset: 0, lines: 0, anchorInvalid: false, entries: [], statuses: new Map(), byBot: new Map(), byDelivery: new Map(), views: new Map(), resolved: null }
}
function participants(record) {
  return record.schema === 'bellteam.interim-word.v1' ? [record.bot]
    : [...new Set([record.from, record.target].filter(id => id !== 'user'))]
}
function resolveStatus(record, statuses) {
  const status = statuses.get(record.delivery_id) ?? record
  const { delivery_tracking: _tracking, ...original } = record
  const tracking = deliveryTracking(status.delivery, status.delivery_tracking)
  return { ...original, delivery: status.delivery, ...(tracking ? { delivery_tracking: tracking } : {}) }
}
function display(record, bot, statuses) {
  if (record.schema === 'bellteam.interim-word.v1') return interimItem(record)
  const value = resolveStatus(record, statuses)
  if (record.from === 'user' && record.target === bot) return messageItem(value, 'outgoing')
  if (record.from === bot && record.target === 'user') return messageItem(value, 'incoming')
  if (record.from === bot && record.target !== 'user') return peerItem(value, 'sent', record.target)
  return peerItem(value, 'received', record.from)
}
function botView(state, bot) {
  if (!state.views.has(bot)) {
    const records = state.byBot.get(bot) ?? []
    const view = { index: new TimelineIndex(records.map(record => display(record, bot, state.statuses)), records), snapshot: null }
    state.views.set(bot, view)
  }
  return state.views.get(bot)
}
function put(view, key, item) {
  view.index.set(key, item); view.snapshot = null
}
function changeFor(records, state) {
  const bots = new Set(); let all = false
  for (const record of records) {
    if (record.schema === 'bellteam.delivery-status.v1') {
      const originals = state.byDelivery.get(record.delivery_id)
      if (!originals?.length) all = true
      for (const original of originals ?? []) for (const bot of participants(original)) bots.add(bot)
    } else for (const bot of participants(record)) bots.add(bot)
  }
  return { botIds: [...bots], all }
}
function applyRecords(records, state) {
  for (const record of records) {
    if (record.schema === 'bellteam.delivery-status.v1') {
      state.statuses.set(record.delivery_id, record)
      for (const original of state.byDelivery.get(record.delivery_id) ?? []) {
        for (const bot of participants(original)) {
          const view = state.views.get(bot)
          if (view) put(view, original, display(original, bot, state.statuses))
        }
      }
    } else {
      state.entries.push(record)
      if (record.schema === 'bellteam.direct-message.v1') {
        if (!state.byDelivery.has(record.delivery_id)) state.byDelivery.set(record.delivery_id, [])
        state.byDelivery.get(record.delivery_id).push(record)
      }
      for (const bot of participants(record)) {
        if (!state.byBot.has(bot)) state.byBot.set(bot, [])
        state.byBot.get(bot).push(record)
        const view = state.views.get(bot)
        if (view) put(view, record, display(record, bot, state.statuses))
      }
    }
  }
  state.resolved = null
  return changeFor(records, state)
}
function validateRecord(record, line) {
  if (record?.schema === 'bellteam.direct-message.v1' || record?.schema === 'bellteam.interim-word.v1'
    || (record?.schema === 'bellteam.delivery-status.v1' && ['running', 'delivered', 'failed', 'stopped'].includes(record.delivery))) return
  throw new Error(`MESSAGE_LOG_INVALID: line ${line}`)
}
function logCorruption(diagnostic) { console.error(JSON.stringify(diagnostic)) }
function parseRecords(buffer, state, onCorruption) {
  const records = []; let lines = 0, start = 0
  for (let end = buffer.indexOf(0x0a); end !== -1; end = buffer.indexOf(0x0a, start)) {
    const bytes = buffer.subarray(start, end), line = state.lines + ++lines
    if (bytes.length) {
      let record, reason
      if (bytes.includes(0)) reason = 'nul'
      else {
        try { record = JSON.parse(bytes.toString('utf8')) } catch { reason = 'syntax' }
        if (!reason) {
          try { validateRecord(record, line) } catch { reason = 'schema' }
        }
      }
      if (reason) onCorruption(Object.freeze({ code: 'MESSAGE_LOG_INVALID', line, offset: state.offset + start, length: bytes.length, reason }))
      else records.push(record)
    }
    start = end + 1
  }
  return { records, lines }
}
function cloneRead(source) {
  const state = { ...emptyRead(), ino: source.ino, mtimeMs: source.mtimeMs, offset: source.offset }
  applyRecords(source.entries, state)
  state.statuses = new Map(source.statuses); state.lines = source.lines
  return state
}
