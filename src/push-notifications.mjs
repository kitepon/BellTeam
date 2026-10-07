import { connect } from 'node:http2'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importPKCS8, SignJWT } from 'jose'
import { isSupportedServerURL } from './server-address.mjs'

export const APNS_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export class PushNotifications {
  constructor({ root, bots, diagnostics, provider = null, fetch: request = fetch }) {
    this.root = root
    this.bots = bots
    this.diagnostics = diagnostics
    this.provider = provider
    this.request = request
    this.error = null
    this.devices = new Map()
    this.saving = Promise.resolve()
    this.inflight = new Set()
  }

  async initialize() {
    const directory = join(this.root, 'shared/tools/apns')
    if (!this.provider) {
      let config
      try { config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (config) this.provider = await APNsProvider.create(config, directory)
    }
    this.directProvider = this.provider
    this.file = join(this.root, 'state/push-devices.json')
    try {
      for (const device of JSON.parse(await readFile(this.file, 'utf8'))) this.devices.set(device.token, device)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  status() {
    return { configured: Boolean(this.provider), environments: this.provider?.environments ?? [],
      ...(this.error ? { error: this.error } : {}) }
  }

  async configure({ enabled, relayUrl }) {
    const previous = this.provider
    this.provider = null
    this.error = null
    await Promise.all(this.inflight)
    previous?.close()
    if (!enabled) return this.status()
    try {
      if (!relayUrl?.trim()) {
        if (!this.directProvider) throw pushError('PUSH_NOT_CONFIGURED')
        this.provider = this.directProvider
        return this.status()
      }
      const provider = new NotificationRelayProvider({ relayUrl, fetch: this.request })
      await provider.initialize()
      this.provider = provider
      return this.status()
    } catch (error) {
      // 通知の機能が動いていない状態。1件の送信の失敗（SERVER_PUSH_FAILED）とは影響が違うので、分けて記録する。
      await this.recordFailure(error, 'SERVER_PUSH_UNAVAILABLE')
      throw error
    }
  }

  async register({ token, environment, server, previousToken, signedTransaction }) {
    const device = validatePushDevice({ token, environment, server, signedTransaction })
    if (previousToken) validateToken(previousToken)
    if (!this.provider) throw new Error('PUSH_NOT_CONFIGURED')
    if (!this.provider.environments.includes(environment)) throw new Error('PUSH_ENVIRONMENT_UNAVAILABLE')
    if (previousToken && previousToken !== token) this.devices.delete(previousToken)
    this.devices.set(token, device)
    await this.save()
    return { registered: true }
  }

  async unregister({ token }) {
    validateToken(token)
    this.devices.delete(token)
    await this.save()
    return { registered: false }
  }

  direct(record) {
    if (record.schema !== 'bellteam.direct-message.v1' || record.target !== 'user' || ['user', 'scheduler'].includes(record.from)) return
    const name = this.bots.get(record.from)?.name ?? 'メンバー'
    this.publish({ id: record.delivery_id, kind: 'reply', botId: record.from,
      sender: { id: record.from, name }, title: name, body: '返信が届きました。' })
  }

  room(record) {
    if (['user', 'scheduler'].includes(record.sender.id)) return
    this.publish({ id: record.id, kind: 'reply', botId: record.sender.id, roomId: record.room.id,
      sender: { id: record.sender.id, name: record.sender.name }, roomName: record.room.name,
      title: `${record.sender.name} · ${record.room.name}`, body: 'ルームに新しいメッセージが届きました。' })
  }

  secret(item) {
    const name = this.bots.get(item.botId)?.name ?? 'メンバー'
    this.publish({ id: item.id, kind: 'secret_request', botId: item.botId, roomId: item.roomId,
      sender: { id: item.botId, name }, title: name, body: '秘密情報の入力が必要です。' })
  }

  question(item) {
    const name = this.bots.get(item.botId)?.name ?? 'メンバー'
    this.publish({ id: item.id, kind: 'owner_question', botId: item.botId,
      sender: { id: item.botId, name }, title: name, body: '選んでほしいことがあります。' })
  }

  publish(event) {
    if (!this.provider) return
    const provider = this.provider
    let failed = false
    const task = Promise.all([...this.devices.values()].map(async device => {
      try {
        await provider.send(device, notificationPayload(event, device.server), event.id)
      } catch (error) {
        if (error.code === 'APNS_UNREGISTERED') {
          await this.unregister(device)
          return
        }
        failed = true
        await this.recordFailure(error)
      }
    })).then(() => { if (!failed) this.error = null })
      .catch(error => process.stderr.write(`BellTeam: 通知の診断または登録の更新に失敗しました (${error.code ?? 'PUSH_STATE_FAILED'})\n`))
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task))
  }

  async recordFailure(error, report = 'SERVER_PUSH_FAILED') {
    // 接続URL・端末トークン・署名付き取引・秘密鍵は診断へ含めない。
    const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_SEND_FAILED'
    this.error = { code, message: '通知の設定・送信を確認できませんでした。設定と診断情報を確認してください。' }
    await this.diagnostics.record({ code: report, module: 'notifications', diagnostic_log: code })
  }

  save() {
    const task = this.saving.then(async () => {
      await mkdir(join(this.root, 'state'), { recursive: true })
      await writeFile(`${this.file}.tmp`, JSON.stringify([...this.devices.values()]), { mode: 0o600 })
      await rename(`${this.file}.tmp`, this.file)
    })
    this.saving = task.catch(() => {})
    return task
  }

  async close() {
    await Promise.all(this.inflight)
    this.provider?.close()
  }
}

// mutable-content で、アプリの通知拡張が送り主（sender）のアバター付きの通知へ書き換える。拡張が無い端末では title と body のまま出る。
export function notificationPayload(event, server) {
  return {
    aps: { alert: { title: event.title, body: event.body }, sound: 'default', 'mutable-content': 1,
      'thread-id': `${server}/${event.roomId ? `rooms/${event.roomId}` : `bots/${event.botId}`}` },
    bellteam: { server, kind: event.kind, botId: event.botId, roomId: event.roomId ?? null,
      sender: event.sender ?? null, roomName: event.roomName ?? null,
      messageId: event.id, requestId: event.kind === 'secret_request' ? event.id : null },
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,512}$/u.test(token)) throw new Error('PUSH_DEVICE_INVALID')
}

export function validatePushDevice({ token, environment, server, signedTransaction } = {}) {
  validateToken(token)
  let url
  try { url = new URL(server) } catch { throw pushError('PUSH_DEVICE_INVALID') }
  if (!['development', 'production'].includes(environment) || !isSupportedServerURL(url)) throw pushError('PUSH_DEVICE_INVALID')
  if (signedTransaction != null && (typeof signedTransaction !== 'string' || !signedTransaction.trim())) throw pushError('PUSH_DEVICE_INVALID')
  return { token, environment, server: url.origin, ...(signedTransaction != null ? { signedTransaction } : {}) }
}

export class NotificationRelayProvider {
  constructor({ relayUrl, fetch: request = fetch }) {
    let url
    try { url = new URL(relayUrl) } catch { throw pushError('PUSH_RELAY_URL_INVALID') }
    if (!isSupportedServerURL(url)) throw pushError('PUSH_RELAY_URL_INVALID')
    this.url = url
    this.request = request
    this.environments = []
  }

  async initialize() {
    const result = await this.call('/v1/notifications/status', { method: 'GET' })
    if (result?.configured !== true || !Array.isArray(result.environments) || !result.environments.length
      || result.environments.some(item => !['development', 'production'].includes(item))) throw pushError('PUSH_RELAY_RESPONSE_INVALID')
    this.environments = result.environments
  }

  async send(device, payload, id) {
    const { signedTransaction, ...destination } = device
    if (typeof signedTransaction !== 'string' || !signedTransaction) throw pushError('SUBSCRIPTION_REQUIRED')
    const result = await this.call('/v1/notifications/send', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedTransaction, device: destination, payload, id }) })
    if (result?.accepted !== true) throw pushError('PUSH_RELAY_RESPONSE_INVALID')
  }

  async call(path, options) {
    let response
    try { response = await this.request(new URL(path, this.url), { ...options, signal: AbortSignal.timeout(30000) }) }
    catch { throw pushError('PUSH_RELAY_CONNECTION_FAILED') }
    let result
    try { result = await response.json() } catch { throw pushError('PUSH_RELAY_RESPONSE_INVALID') }
    if (!response.ok) {
      if (!/^[A-Z_0-9]+$/u.test(result?.error?.code ?? '')) throw pushError('PUSH_RELAY_RESPONSE_INVALID')
      throw pushError(result.error.code)
    }
    return result
  }

  close() {}
}

export class APNsProvider {
  static async create(config, directory) {
    if (!/^[A-Z0-9]{10}$/u.test(config.teamId ?? '') || !/^[\w.-]+$/u.test(config.topic ?? ''))
      throw new Error('APNS_CONFIG_INVALID')
    const keys = new Map()
    for (const environment of ['development', 'production']) {
      const item = config.keys?.[environment]
      if (!item) continue
      if (!/^[A-Z0-9]{10}$/u.test(item.keyId ?? '') || !/^[\w.-]+\.p8$/u.test(item.file ?? ''))
        throw new Error('APNS_CONFIG_INVALID')
      keys.set(environment, { keyId: item.keyId, key: await importPKCS8(await readFile(join(directory, item.file), 'utf8'), 'ES256') })
    }
    if (!keys.size) throw new Error('APNS_CONFIG_INVALID')
    return new APNsProvider(config, keys)
  }

  constructor(config, keys, { open = host => connect(`https://${host}`), idleTimeout = APNS_IDLE_TIMEOUT_MS } = {}) {
    this.config = config
    this.keys = keys
    this.environments = [...keys.keys()]
    this.connections = new Map()
    this.open = open
    this.idleTimeout = idleTimeout
  }

  async send(device, payload, id) {
    const key = this.keys.get(device.environment)
    if (!key) throw pushError('PUSH_ENVIRONMENT_UNAVAILABLE')
    const now = Math.floor(Date.now() / 1000)
    // 端末の数だけ同時に呼ばれる。署名を待つ間に別の呼び出しがトークンを作り直すと、同じ接続へ違うトークンが続けて届き、
    // APNsが TooManyProviderTokenUpdates（429）で拒む。作るのは一度だけにして、同時の送信は同じトークンを待つ。
    if (!key.token || now - key.issuedAt > 3000) {
      key.issuedAt = now
      key.token = new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: key.keyId })
        .setIssuer(this.config.teamId).setIssuedAt(now).sign(key.key)
      key.token.catch(() => { key.token = null })
    }
    const token = await key.token
    let connection = this.connections.get(device.environment)
    if (!connection || connection.closed || connection.destroyed) {
      const host = device.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
      const opened = this.open(host)
      opened.on('error', () => opened.destroy())
      // 長く使わなかった接続は途中の経路で切れていて、次の送信が APNS_CONNECTION_FAILED になる。
      // 送信を繰り返す代わりに、しばらく使わなかった接続は閉じ、次の送信は新しい接続で送る。
      opened.setTimeout(this.idleTimeout, () => opened.close())
      opened.on('close', () => { if (this.connections.get(device.environment) === opened) this.connections.delete(device.environment) })
      this.connections.set(device.environment, opened)
      connection = opened
    }
    await new Promise((resolve, reject) => {
      const request = connection.request({ ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${token}`, 'apns-topic': this.config.topic,
        'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': id,
        'apns-expiration': String(now + 86400) })
      let status, response = ''
      request.on('response', headers => { status = headers[':status'] })
      request.setEncoding('utf8')
      request.on('data', chunk => { response += chunk })
      request.on('error', () => reject(pushError('APNS_CONNECTION_FAILED')))
      request.setTimeout(15000, () => { request.close(); reject(pushError('APNS_TIMEOUT')) })
      request.on('end', () => {
        if (status === 200) return resolve()
        if (status === 410) return reject(pushError('APNS_UNREGISTERED'))
        let reason
        try { reason = JSON.parse(response).reason } catch { /* HTTPステータスを診断へ残す。 */ }
        const detail = typeof reason === 'string' && /^[A-Za-z]+$/u.test(reason) ? `_${reason.toUpperCase()}` : ''
        reject(pushError(`APNS_HTTP_${status ?? 'UNKNOWN'}${detail}`))
      })
      request.end(JSON.stringify(payload))
    })
  }

  close() { for (const connection of this.connections.values()) connection.close() }
}

function pushError(code) { return Object.assign(new Error(code), { code }) }
