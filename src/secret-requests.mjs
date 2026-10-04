import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 秘密の値はこのクラスのsubmitだけが受け取り、一覧・通知・イベントへ渡さない。
export class SecretRequests {
  constructor({ root, bots, rooms, notify, onRequest = () => {} }) {
    this.directory = join(root, 'state/secret-requests')
    this.toolsDirectory = join(root, 'shared/tools')
    this.bots = bots
    this.rooms = rooms
    this.notify = notify
    this.onRequest = onRequest
    this.items = new Map()
    this.busy = new Set()
    this.events = new EventEmitter()
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json')) continue
      const item = JSON.parse(await readFile(join(this.directory, file), 'utf8'))
      this.items.set(item.id, item)
    }
  }

  get(id) {
    const item = this.items.get(id)
    if (!item) throw new Error('SECRET_REQUEST_NOT_FOUND')
    return { ...item }
  }

  async create({ botId, roomId = null, toolId, label, message }) {
    await this.bots.refresh?.()
    if (!this.bots.has(botId)) throw new Error('BOT_NOT_FOUND')
    if (typeof toolId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(toolId)
      || typeof label !== 'string' || !label.trim() || label.length > 80
      || typeof message !== 'string' || !message.trim() || message.length > 1000) {
      throw new Error('SECRET_REQUEST_INVALID')
    }
    if (roomId !== null) {
      await this.rooms.refresh()
      if (!this.rooms.get(roomId)?.memberIds.includes(botId)) throw new Error('SECRET_ROOM_INVALID')
    }
    const item = {
      id: randomUUID(), botId, roomId, toolId, label, message,
      at: new Date().toISOString(), status: 'pending',
    }
    await this.save(item)
    this.onRequest(this.get(item.id))
    return this.get(item.id)
  }

  timeline({ botId, roomId }) {
    return [...this.items.values()]
      .filter(item => roomId ? item.roomId === roomId : item.botId === botId && !item.roomId)
      .map(item => ({
        id: item.id, kind: 'secret_request', direction: 'incoming', at: item.at,
        message: item.message,
        sender: { id: item.botId, name: this.bots.get(item.botId)?.name ?? item.botId },
        secret_request: { ...item },
      }))
  }

  watch(listener) {
    this.events.on('change', listener)
    return () => this.events.off('change', listener)
  }

  async submit(id, value) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 16384 || value.includes('\0')) {
      throw new Error('SECRET_VALUE_INVALID')
    }
    return this.finish(id, async item => {
      const directory = join(this.toolsDirectory, item.toolId, 'secrets')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, item.id)
      // 再送や中断後の再操作で、登録済みのファイルを上書きしない。
      await writeFile(path, value, { mode: 0o600, flag: 'wx' })
      return { ...item, status: 'submitted', path }
    })
  }

  async cancel(id) {
    return this.finish(id, async item => ({ ...item, status: 'cancelled' }))
  }

  async finish(id, update) {
    const item = this.get(id)
    if (item.status !== 'pending' || this.busy.has(id)) throw new Error('SECRET_REQUEST_CLOSED')
    this.busy.add(id)
    try {
      const result = await update(item)
      await this.save({ ...result, notification: 'pending' })
      // 保存先だけを通常の配送経路へ渡す。秘密の値はコールバックに渡さない。
      let notification
      try {
        await this.notify({ ...result })
        notification = 'sent'
      } catch {
        notification = 'failed'
      }
      await this.save({ ...result, notification })
      return this.get(id)
    } finally {
      this.busy.delete(id)
    }
  }

  async save(item) {
    const path = join(this.directory, `${item.id}.json`)
    await writeFile(`${path}.tmp`, JSON.stringify(item), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    this.items.set(item.id, item)
    this.events.emit('change')
  }
}

export function secretCompletionMessage(item) {
  const destination = item.roomId ? `ルーム ${item.roomId} で依頼した` : 'あなたが依頼した'
  const result = item.status === 'submitted'
    ? `登録されました。保存先: ${item.path}\n利用するプログラムからこのファイルを読み込み、標準入力や認証APIへ渡してください。値を表示したり、会話・ツール出力・ログ・Gitへ書いたりしないでください。`
    : '入力は取り消されました。'
  return `${destination}「${item.label}」の秘密情報入力（${item.id}）について、${result}`
}
