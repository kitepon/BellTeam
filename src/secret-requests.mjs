import { CardTimelines } from './card-timelines.mjs'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SecretCredentials, normalizeCredentialScope, readPrivateSecret } from './usage/secret-credentials.mjs'

// The Owner's stored value on this reserved tool card is the server's 1Password service account token.
export const onePasswordTokenTool = 'onepassword-service-account'

// 秘密の値はこのクラスのsubmitだけが受け取り、一覧・通知・イベントへ渡さない。
export class SecretRequests {
  constructor({ root, bots, rooms, notify, onRequest = () => {}, onSave = () => {}, onePassword, secretProviders, credentialRetryMs }) {
    this.directory = join(root, 'state/secret-requests')
    this.toolsDirectory = join(root, 'state/secret-values')
    this.bots = bots
    this.rooms = rooms
    this.notify = notify
    this.onRequest = onRequest
    this.onSave = onSave
    this.items = new Map()
    this.cardTimelines = new CardTimelines(bots, 'secret_request')
    this.busy = new Set()
    this.events = new EventEmitter()
    this.terminalKeyTail = Promise.resolve()
    this.credentials = new SecretCredentials({ root, getRequest: id => this.getPrivate(id), onePassword, providers: secretProviders, retryMs: credentialRetryMs })
    this.credentials.watch(event => this.events.emit('credential', event))
    this.credentials.watchRecovery(event => this.events.emit('recovery', event))
    this.credentials.onePassword.setToken?.(() => this.onePasswordToken())
    this.credentials.onePassword.watch(() => {
      for (const item of this.items.values()) {
        if (item.botId !== null) this.cardTimelines.put(this.get(item.id))
        this.onSave(this.get(item.id))
      }
      this.events.emit('change', { all: true, topics: ['requests'], botIds: [], roomIds: [] })
    })
  }

  async initialize({ readOnly = false } = {}) {
    if (!readOnly) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json')) continue
      const item = JSON.parse(await readFile(join(this.directory, file), 'utf8'))
      // 配送済みの状態は'queued'から'sent'へ改名した。改名前に保存した依頼も同じ意味で読む。
      if (item.notification === 'queued') item.notification = 'sent'
      this.items.set(item.id, item)
      if (item.botId !== null) this.cardTimelines.put(item)
    }
    await this.credentials.initialize({ readOnly })
    for (const item of this.items.values()) if (item.botId !== null) this.cardTimelines.put(this.get(item.id))
  }

  async onePasswordToken() {
    const item = [...this.items.values()].filter(row => row.toolId === onePasswordTokenTool && row.status === 'submitted' && row.path)
      .sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    if (!item || item.path !== join(this.toolsDirectory, item.toolId, 'secrets', item.id)) return null
    return (await readPrivateSecret(item.path)).trim()
  }

  async onePasswordItems(id) {
    if (this.get(id).status !== 'pending') throw new Error('SECRET_REQUEST_CLOSED')
    return this.credentials.onePassword.listSshKeys()
  }

  getPrivate(id) {
    const item = this.items.get(id)
    if (!item) throw new Error('SECRET_REQUEST_NOT_FOUND')
    return { ...item }
  }

  get(id) {
    const { terminalSuperseded, ...item } = this.getPrivate(id)
    return { ...item, inputOptions: this.credentials.inputOptions() }
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

  terminalKeyOperation(operation) {
    const run = this.terminalKeyTail.then(operation)
    this.terminalKeyTail = run.catch(() => {})
    return run
  }

  requestTerminalKey({ terminalId, purpose, label }) {
    return this.terminalKeyOperation(async () => {
      const scope = normalizeCredentialScope({ terminalId, purpose })
      if (!['terminal.ssh', 'terminal.sudo'].includes(scope.purpose) || typeof label !== 'string' || !label.trim() || label.length > 128) throw new Error('SECRET_REQUEST_INVALID')
      await this.cancelTerminalRequests(scope)
      const item = { id: randomUUID(), botId: null, roomId: null, toolId: 'terminal-key', ...scope,
        label, message: `端末「${terminalId}」の${scope.purpose === 'terminal.ssh' ? 'SSH鍵' : 'sudo認証情報'}を登録してください。値や1Password参照は、この専用欄へ入力してください。`,
        at: new Date().toISOString(), status: 'pending' }
      await this.save(item)
      return { secretRequest: this.get(item.id) }
    })
  }

  async cancelTerminalRequests(scope) {
    scope = normalizeCredentialScope(scope)
    for (const item of this.items.values()) if (item.botId === null && item.terminalId === scope.terminalId && item.purpose === scope.purpose && !item.terminalSuperseded) {
      await this.save({ ...item, terminalSuperseded: true,
        ...(item.status === 'pending' ? { status: 'cancelled', notification: 'not_needed' } : {}) })
    }
  }

  async currentCredential(scope) {
    scope = normalizeCredentialScope(scope)
    const latest = [...this.items.values()].find(item => item.botId === null && item.terminalId === scope.terminalId && item.purpose === scope.purpose && !item.terminalSuperseded && item.status === 'submitted')
    if (latest && !this.credentials.hasRequestBinding(latest.id, scope)) await this.bindCredential(latest.id, scope)
    return this.credentials.current(scope)
  }
  unbindCredential(handle, scope) {
    return this.terminalKeyOperation(async () => {
      const result = await this.credentials.unbind(handle, scope)
      await this.cancelTerminalRequests(scope)
      await this.credentials.unbindScope(scope)
      return result
    })
  }
  revokeTerminalRequests(scope) { return this.terminalKeyOperation(async () => {
    await this.cancelTerminalRequests(scope)
    await this.credentials.unbindScope(scope)
  }) }

  timeline(target) { return this.cardTimelines.timeline(target) }
  timelineView(target) { return this.cardTimelines.view(target) }

  watch(listener) {
    this.events.on('change', listener)
    return () => this.events.off('change', listener)
  }

  // The run guide becomes readable after create's first card invalidation.
  notifyOwnerGuide(id) {
    const item = this.get(id)
    this.events.emit('change', { all: false, topics: ['requests'], botIds: [item.botId], roomIds: item.roomId ? [item.roomId] : [] })
  }

  async submit(id, value) {
    if (this.get(id).botId === null && this.get(id).status === 'submitted') return this.terminalKeyOperation(async () => {
      const item = this.getPrivate(id)
      if (item.terminalSuperseded) throw new Error('SECRET_REQUEST_CLOSED')
      await this.bindCredential(id, { terminalId: item.terminalId, purpose: item.purpose })
      return this.get(id)
    })
    const token = this.get(id).toolId === onePasswordTokenTool
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (token || Object.keys(value).sort().join(',') !== 'reference,source' || value.source !== 'onepassword') throw new Error('SECRET_VALUE_INVALID')
      return this.finish(id, async item => {
        await this.credentials.registerSource(id, value)
        return { ...item, status: 'submitted' }
      })
    }
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 16384 || value.includes('\0')) {
      throw new Error('SECRET_VALUE_INVALID')
    }
    const result = await this.finish(id, async item => {
      const directory = join(this.toolsDirectory, item.toolId, 'secrets')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, item.id)
      // 再送や中断後の再操作で、登録済みのファイルを上書きしない。
      await writeFile(path, value, { mode: 0o600, flag: 'wx' })
      return { ...item, status: 'submitted', path }
    })
    // A new token connects 1Password now; pending cards receive the new inputOptions in this same operation.
    if (token) await this.credentials.refreshAvailability().catch(() => {})
    return result
  }

  // Only a trusted composition can register a fixed provider capability.
  async submitProvider(id, providerId) {
    return this.finish(id, async item => {
      await this.credentials.registerSource(id, { source: 'provider', providerId })
      return { ...item, status: 'submitted' }
    })
  }

  resolveValue(id) { return this.credentials.resolveRequest(id) }
  bindCredential(id, scope) { return this.credentials.bind(id, scope) }
  credential(handle, context) { return this.credentials.credential(handle, context) }
  replaceCredential(handle, id, context) { return this.credentials.replace(handle, id, context) }
  withResolved(handle, context, consume) { return this.credentials.withResolved(handle, context, consume) }
  watchCredentials(listener) { this.events.on('credential', listener); return () => this.events.off('credential', listener) }
  watchRecovery(listener) { this.events.on('recovery', listener); return () => this.events.off('recovery', listener) }
  close() { this.credentials.close() }

  async cancel(id) {
    return this.finish(id, async item => ({ ...item, status: 'cancelled' }))
  }

  // 依頼したBotが、未入力の自分の依頼を取り下げる。画面のカードはオーナーの取消と同じ「取消」になる。
  // 取り下げた本人へは通知しない（道具の返りで分かる。通知すると、自分の取り下げで自分の番がもう1回起きる）。
  async withdraw(id, botId) {
    if (this.get(id).botId !== botId) throw new Error('SECRET_REQUEST_NOT_FOUND')
    return this.finish(id, async item => ({ ...item, status: 'cancelled', withdrawn: true }), { notify: false })
  }

  async finish(id, update, { notify = true } = {}) {
    if (this.get(id).botId === null) return this.terminalKeyOperation(() => this.finishRequest(id, update, { notify: false }))
    return this.finishRequest(id, update, { notify })
  }

  async finishRequest(id, update, { notify = true } = {}) {
    const item = this.get(id)
    if (item.status !== 'pending' || this.busy.has(id)) throw new Error('SECRET_REQUEST_CLOSED')
    this.busy.add(id)
    try {
      const result = await update(item)
      if (!notify) {
        await this.save({ ...result, notification: 'not_needed' })
        if (result.botId === null && result.status === 'submitted') await this.bindCredential(id, { terminalId: result.terminalId, purpose: result.purpose })
        return this.get(id)
      }
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
    if (item.botId !== null) this.cardTimelines.put(this.get(item.id))
    this.onSave(this.get(item.id))
    this.events.emit('change', { all: false, topics: ['requests'], botIds: item.botId === null ? [] : [item.botId], roomIds: item.roomId ? [item.roomId] : [] })
  }
}

export function secretCompletionMessage(item) {
  const destination = item.roomId ? `ルーム ${item.roomId} で依頼した` : 'あなたが依頼した'
  const result = item.status === 'submitted'
    ? `登録されました。${item.path ? `保存先: ${item.path}\n利用するプログラムからこのファイルを読み込み、標準入力や認証APIへ渡してください。` : '利用するプログラムへ、秘密入力の承認済み解決窓口から直接渡してください。'}本体と席のユーザーが異なる場合は、承認済みの管理経路で利用するプログラムへ直接渡してください。値を表示したり、会話・ツール出力・ログ・Gitへ書いたりしないでください。`
    : '入力は取り消されました。'
  return `${destination}「${item.label}」の秘密情報入力（${item.id}）について、${result}`
}
