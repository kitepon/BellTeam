import { open } from 'node:fs/promises'

// Rebuildable process-local view of an append-only room log. Never writes the log.
export class RoomHistory {
  constructor(path) {
    this.path = path
    this.read = emptyRead()
    this.observedSize = null
    this.queue = Promise.resolve()
  }

  messages() {
    const run = this.queue.then(() => this.readAppended())
    this.queue = run.catch(() => {})
    return run.then(state => state.visible ??= state.messages.map(message => ({
      ...message,
      ...(Array.isArray(message.deliveries) ? {
        deliveries: message.deliveries.map(item => ({ ...item,
          delivery: state.statuses.get(`${message.id}\0${item.target}`) ?? item.delivery,
        })),
      } : {}),
      routing: state.routing.get(message.id) ?? message.routing,
    })))
  }

  async readAppended() {
    let file
    try { file = await open(this.path, 'r') }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.observedSize = null
      return this.read = emptyRead()
    }
    try {
      const { ino, size, mtimeMs } = await file.stat()
      // offset excludes a newline-free tail; only the last total size detects
      // truncation that leaves the file larger than that committed prefix.
      const shrunk = this.observedSize !== null && size < this.observedSize
      const rewritten = size === this.observedSize && mtimeMs !== this.read.mtimeMs
      this.observedSize = size
      if (ino !== this.read.ino || shrunk || rewritten) this.read = emptyRead()
      if (ino === this.read.ino && size === this.read.offset) return this.read
      const buffer = Buffer.alloc(size - this.read.offset)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.read.offset)
      const complete = bytesRead ? buffer.lastIndexOf(0x0a, bytesRead - 1) + 1 : 0
      const next = copyRead(this.read)
      next.ino = ino; next.mtimeMs = mtimeMs
      applyLines(buffer.toString('utf8', 0, complete), next)
      next.offset += complete
      this.read = next
      if (complete === bytesRead) return next
      // A complete JSON tail without a newline is visible, but not committed.
      // Malformed room logs retain the existing explicit parse failure.
      const rest = buffer.toString('utf8', complete, bytesRead)
      JSON.parse(rest)
      const tail = copyRead(next)
      applyLines(rest, tail)
      return tail
    } finally { await file.close() }
  }
}

function emptyRead() {
  return { ino: null, offset: 0, mtimeMs: null, messages: [], statuses: new Map(), routing: new Map() }
}

function copyRead(state) {
  return { ...state, visible: undefined, messages: [...state.messages],
    statuses: new Map(state.statuses), routing: new Map(state.routing) }
}

function applyLines(text, state) {
  for (const line of text.split('\n').filter(Boolean)) {
    const record = JSON.parse(line)
    if (record?.schema === 'bellteam.room-delivery-status.v1')
      state.statuses.set(`${record.message_id}\0${record.target}`, record.delivery)
    else if (record?.schema === 'bellteam.room-routing-status.v1') state.routing.set(record.message_id, record.routing)
    else state.messages.push(record)
  }
}
