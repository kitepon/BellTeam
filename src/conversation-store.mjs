import { watch } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, basename } from 'node:path'

export class ConversationStore {
  constructor({ logPath }) {
    this.logPath = logPath
    // ログは追記だけ（BellTeamMessenger.append）。読み終えた行までの結果を持ち、次は増えた分だけ読む。
    // 全体を呼び出しのたびに読み直すと、同時の呼び出しの数だけログの写しがメモリに乗る。
    this.read = emptyRead()
    this.queue = Promise.resolve()
  }

  async records() {
    return (await this.entries()).filter(record => record.schema === 'bellteam.direct-message.v1')
  }

  // 直接会話と合間の言葉を、ログに書かれた順に返す。合間の言葉は表示だけの記録で、配送状態を持たない。
  async entries() {
    // 呼び出しごとに、前の読み込みが終わってから増えた分を読む。自分が書いた直後の行も必ず見える。
    const run = this.queue.then(() => this.readAppended())
    this.queue = run.catch(() => {})
    const { entries, statuses } = await run
    return entries.map(record => record.schema === 'bellteam.direct-message.v1' && statuses.has(record.delivery_id)
      ? { ...record, delivery: statuses.get(record.delivery_id) }
      : record)
  }

  async readAppended() {
    let file
    try {
      file = await open(this.logPath, 'r')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.read = emptyRead()
      return this.read
    }
    try {
      const { size, ino } = await file.stat()
      // 別のファイルに替わったか短くなった時は、最初から読み直す。
      if (ino !== this.read.ino || size < this.read.offset) this.read = { ...emptyRead(), ino }
      if (size === this.read.offset) return this.read

      const buffer = Buffer.alloc(size - this.read.offset)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.read.offset)
      const complete = bytesRead ? buffer.lastIndexOf(0x0a, bytesRead - 1) + 1 : 0
      const next = { ...this.read, entries: [...this.read.entries], statuses: new Map(this.read.statuses) }
      parseLines(buffer.toString('utf8', 0, complete), next)
      next.offset += complete
      this.read = next
      if (complete === bytesRead) return next

      // 改行で終わっていない最後の行は、次の読み込みでもう一度読む。今回の結果にだけ足す。
      const tail = { ...next, entries: [...next.entries], statuses: new Map(next.statuses) }
      parseLines(buffer.toString('utf8', complete, bytesRead), tail)
      return tail
    } finally {
      await file.close()
    }
  }

  async timeline(botId) {
    const items = []
    for (const record of await this.entries()) {
      if (record.schema === 'bellteam.interim-word.v1') {
        if (record.bot === botId) items.push(interimItem(record))
      } else if (record.from === 'user' && record.target === botId) {
        items.push(messageItem(record, 'outgoing'))
      } else if (record.from === botId && record.target === 'user') {
        items.push(messageItem(record, 'incoming'))
      } else if (record.from === botId && record.target !== 'user') {
        items.push(peerItem(record, 'sent', record.target))
      } else if (record.target === botId && record.from !== 'user') {
        items.push(peerItem(record, 'received', record.from))
      }
    }
    return items
  }

  async watch(onChange) {
    await mkdir(dirname(this.logPath), { recursive: true })
    const filename = basename(this.logPath)
    const watcher = watch(dirname(this.logPath), (event, changed) => {
      if (changed === filename) onChange()
    })
    return () => watcher.close()
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
  }
}

function emptyRead() {
  return { ino: null, offset: 0, lines: 0, entries: [], statuses: new Map() }
}

function parseLines(text, read) {
  for (const line of text.split('\n').filter(Boolean)) {
    read.lines += 1
    try {
      const record = JSON.parse(line)
      if (record?.schema === 'bellteam.direct-message.v1' || record?.schema === 'bellteam.interim-word.v1') read.entries.push(record)
      else if (record?.schema === 'bellteam.delivery-status.v1'
        && ['running', 'delivered', 'failed'].includes(record.delivery)) {
        read.statuses.set(record.delivery_id, record.delivery)
      } else throw new Error('schema')
    } catch {
      throw new Error(`MESSAGE_LOG_INVALID: line ${read.lines}`)
    }
  }
}
