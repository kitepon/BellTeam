import { open } from 'node:fs/promises'
import { TimelineIndex } from './timeline-index.mjs'

export class RoomHistory {
  constructor(path) {
    this.path = path; this.read = emptyRead(); this.observedSize = null
    this.queue = Promise.resolve(); this.preview = null
  }
  snapshot() {
    const run = this.queue.then(() => this.readAppended())
    this.queue = run.catch(() => {})
    return run
  }
  async messages() {
    const state = await this.snapshot()
    return state.visible ??= state.messages.map(message => state.index.get(message))
  }
  async view() { return (await this.snapshot()).index }
  async readAppended() {
    let file
    try { file = await open(this.path, 'r') }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.observedSize = null; this.preview = null
      return this.read = emptyRead()
    }
    try {
      const info = await file.stat({ bigint: true })
      const size = Number(info.size), ino = `${info.dev}:${info.ino}`, mtimeMs = Number(info.mtimeMs)
      const signature = `${info.mtimeNs}:${info.ctimeNs}`
      if (ino !== this.read.ino || (this.observedSize !== null && size < this.observedSize)
        || (size === this.observedSize && signature !== this.read.signature)) {
        this.read = { ...emptyRead(), ino, mtimeMs, signature }; this.preview = null
      }
      this.observedSize = size
      if (size === this.read.offset) return this.read
      const buffer = Buffer.alloc(size - this.read.offset)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.read.offset)
      const complete = bytesRead ? buffer.lastIndexOf(0x0a, bytesRead - 1) + 1 : 0
      const records = buffer.toString('utf8', 0, complete).split('\n').filter(Boolean).map(line => JSON.parse(line))
      // Project/validate before commit so a bad batch does not poison the prefix.
      for (const record of records) validate(record)
      if (records.length) { apply(records, this.read); this.preview = null }
      this.read.offset += complete; this.read.mtimeMs = mtimeMs; this.read.signature = signature
      if (complete === bytesRead) return this.read
      const text = buffer.toString('utf8', complete, bytesRead)
      const record = JSON.parse(text); validate(record)
      if (this.preview?.text !== text) {
        const state = clone(this.read); apply([record], state)
        this.preview = { text, state }
      }
      return this.preview.state
    } finally { await file.close() }
  }
}
function emptyRead() {
  return { ino: null, offset: 0, mtimeMs: null, messages: [], statuses: new Map(), routing: new Map(),
    byId: new Map(), index: new TimelineIndex(), visible: null }
}
function project(message, state) {
  return { ...message,
    ...(Array.isArray(message.deliveries) ? { deliveries: message.deliveries.map(item => ({ ...item,
      delivery: state.statuses.get(`${message.id}\0${item.target}`) ?? item.delivery })) } : {}),
    routing: state.routing.get(message.id) ?? message.routing }
}
function validate(record) {
  // The old projection required non-null rows and non-null delivery entries.
  if (record == null) throw new TypeError('ROOM_MESSAGE_INVALID')
  if (Array.isArray(record.deliveries)) for (const item of record.deliveries) if (item == null) throw new TypeError('ROOM_MESSAGE_INVALID')
}
function apply(records, state) {
  for (const record of records) {
    let changed
    if (record?.schema === 'bellteam.room-delivery-status.v1') {
      state.statuses.set(`${record.message_id}\0${record.target}`, record.delivery)
      changed = state.byId.get(record.message_id) ?? []
    } else if (record?.schema === 'bellteam.room-routing-status.v1') {
      state.routing.set(record.message_id, record.routing)
      changed = state.byId.get(record.message_id) ?? []
    } else {
      state.messages.push(record)
      if (!state.byId.has(record.id)) state.byId.set(record.id, [])
      state.byId.get(record.id).push(record); changed = [record]
    }
    for (const message of changed) {
      const item = project(message, state)
      state.index.set(message, item)
    }
  }
  state.visible = null
}
function clone(source) {
  const state = { ...emptyRead(), ino: source.ino, offset: source.offset, mtimeMs: source.mtimeMs,
    statuses: new Map(source.statuses), routing: new Map(source.routing) }
  apply(source.messages, state)
  return state
}
