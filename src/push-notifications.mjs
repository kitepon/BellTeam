import { connect } from 'node:http2'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importPKCS8, SignJWT } from 'jose'
import { isSupportedServerURL } from './server-address.mjs'
import { UpdatePushAttempts, apnsReceipt, jstNow, updatePushReason } from './update-push-attempts.mjs'
import { createOnePasswordSource, validateOnePasswordReference } from './usage/onepassword-source.mjs'

export const APNS_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const keyErrors = {
  APNS_KEY_REFERENCE_INVALID: 'APNsの鍵の1Password参照の形式が正しくありません。op://保管庫のID/アイテムのID/フィールド名 の形で書いてください。',
  APNS_KEY_UNAVAILABLE: '1PasswordからAPNsの鍵を読めませんでした。設定の「1Password連携」がつながっているか、鍵の参照が正しいかを確かめてください。',
  APNS_KEY_INVALID: '1Passwordから読んだ値がAPNsの鍵（.p8）ではありません。.p8ファイルの中身をそのまま保存し直してください。',
}

// Resolves op:// references through the usage 1Password source; one short-lived source per load.
export function onePasswordKeyReader(root, { create = () => createOnePasswordSource({ autoRetry: false }) } = {}) {
  return async references => {
    const source = create()
    // The token is the usage settings' own: read it for each op call and keep it nowhere.
    // Without root (the operator relay) op takes OP_SERVICE_ACCOUNT_TOKEN from the process env instead.
    if (root) source.setToken?.(async () => {
      try {
        const { onePassword: entry } = JSON.parse(await readFile(join(root, 'shared/tools/bellteam-settings/settings.json'), 'utf8'))
        return entry?.enabled === true && typeof entry.token === 'string' && entry.token.trim() ? entry.token.trim() : null
      } catch { return null }
    })
    try { return new Map(await Promise.all(references.map(async reference => [reference, await source.resolve(reference)]))) }
    catch { throw pushError('APNS_KEY_UNAVAILABLE') }
    finally { source.close() }
  }
}

export class PushNotifications {
  constructor({ root, bots, diagnostics, provider = null, fetch: request = fetch, readKeys = onePasswordKeyReader(root) }) {
    this.root = root
    this.readKeys = readKeys
    this.injected = Boolean(provider)
    this.keyError = null
    this.bots = bots
    this.diagnostics = diagnostics
    this.provider = provider
    this.request = request
    this.error = null
    this.devices = new Map()
    this.saving = Promise.resolve()
    this.inflight = new Set()
    this.updateAttempts = new UpdatePushAttempts(root)
  }

  // A key that cannot be obtained leaves APNs unconfigured with keyError; a malformed config.json still fails.
  async loadDirect() {
    const directory = join(this.root, 'shared/tools/apns')
    let config
    try { config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    this.keyError = null
    if (!config) return null
    try { return await APNsProvider.create(config, directory, { readKeys: this.readKeys }) }
    catch (error) { if (!Object.hasOwn(keyErrors, error.code)) throw error; this.keyError = error.code; return null }
  }

  async initialize() {
    if (!this.provider) this.provider = await this.loadDirect()
    this.directProvider = this.provider
    this.loaded = true
    this.file = join(this.root, 'state/push-devices.json')
    try {
      const devices = JSON.parse(await readFile(this.file, 'utf8'))
      if (!Array.isArray(devices)) throw pushError('PUSH_STATE_INVALID')
      for (const device of devices) {
        try { validatePushDevice(device) } catch { throw pushError('PUSH_STATE_INVALID') }
        this.devices.set(device.token, device)
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await this.updateAttempts.initialize()
  }

  status(options) {
    return { configured: Boolean(this.provider), environments: this.provider?.environments ?? [],
      ...(this.error ? { error: this.error } : {}), ...this.updateAttempts.status(options) }
  }

  async configure({ enabled, relayUrl }) {
    const previous = this.provider, fresh = this.loaded
    this.provider = null
    this.error = null
    this.loaded = false
    await Promise.all(this.inflight)
    previous?.close()
    if (!enabled) return this.status()
    try {
      if (!relayUrl?.trim()) {
        // The first apply after initialize uses its fresh load; later ones re-read config.json so a re-entered key applies without a restart.
        if (!this.injected && !fresh) {
          if (this.directProvider !== previous) this.directProvider?.close()
          this.directProvider = await this.loadDirect()
        }
        if (!this.directProvider) throw pushError(this.keyError ?? 'PUSH_NOT_CONFIGURED')
        this.provider = this.directProvider
        return this.status()
      }
      const provider = new NotificationRelayProvider({ relayUrl, fetch: this.request })
      await provider.initialize()
      this.provider = provider
      return this.status()
    } catch (error) {
      // 通知の機能が動いていない状態。1件の送信の失敗（SERVER_PUSH_SEND_FAILED）とは影響が違うので、分けて記録する。
      await this.recordFailure(error, 'SERVER_PUSH_UNAVAILABLE')
      throw error
    }
  }

  async register({ token, environment, server, previousToken, signedTransaction }) {
    const device = validatePushDevice({ token, environment, server, signedTransaction })
    if (previousToken) validateToken(previousToken)
    if (!this.provider) throw pushError('PUSH_NOT_CONFIGURED')
    if (!this.provider.environments.includes(environment)) throw pushError('PUSH_ENVIRONMENT_UNAVAILABLE')
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
    if (event.kind === 'update') {
      const task = this.publishUpdate(event).catch(() => process.stderr.write('BellTeam: 更新通知の記録を完了できませんでした (PUSH_ATTEMPT_SAVE_FAILED)\n'))
      this.inflight.add(task)
      void task.finally(() => this.inflight.delete(task))
      return
    }
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

  async publishUpdate(event) {
    const provider = this.provider, devices = [...this.devices.values()]
    const attempt = this.updateAttempts.create(event.id, devices, Boolean(provider))
    const save = async () => {
      if (!await this.updateAttempts.save(attempt)) {
        try { await this.recordFailure({ code: 'PUSH_ATTEMPT_SAVE_FAILED' }) }
        catch { process.stderr.write('BellTeam: 更新通知の保存失敗を診断できませんでした (PUSH_DIAGNOSTIC_FAILED)\n') }
      }
    }
    await save()
    if (provider) await Promise.all(devices.map(async (device, index) => {
      const result = attempt.devices[index]
      try {
        Object.assign(result, apnsReceipt(await provider.send(device, notificationPayload(event, device.server), event.id)))
        result.outcome = result.apnsStatus === 200 ? 'accepted' : 'unknown'
        if (result.apnsStatus === null) result.errorReason = 'APNS_RECEIPT_UNAVAILABLE'
      } catch (error) {
        Object.assign(result, apnsReceipt(error))
        result.errorReason = updatePushReason(error.code)
        result.outcome = result.apnsStatus !== null && result.apnsStatus !== 200 ? 'rejected'
          : ['PUSH_ENVIRONMENT_UNAVAILABLE', 'SUBSCRIPTION_REQUIRED', 'PUSH_NOT_CONFIGURED'].includes(error.code) ? 'not_sent' : 'unknown'
        try {
          if (error.code === 'APNS_UNREGISTERED') await this.unregister(device)
          else await this.recordFailure(error)
        } catch { process.stderr.write('BellTeam: 更新通知の診断または登録を保存できませんでした (PUSH_STATE_FAILED)\n') }
      }
      if (result.sentAt && (!attempt.sentAt || result.sentAt < attempt.sentAt)) attempt.sentAt = result.sentAt
    }))
    if (attempt.state === 'pending') attempt.state = 'completed'
    attempt.completedAt = jstNow()
    await save()
    if (provider && !attempt.devices.some(row => row.errorReason) && !this.updateAttempts.writeError) this.error = null
  }

  async recordFailure(error, report = 'SERVER_PUSH_SEND_FAILED') {
    // 接続URL・端末トークン・署名付き取引・秘密鍵は診断へ含めない。
    const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_SEND_FAILED'
    this.error = { code, message: keyErrors[code] ?? '通知の設定・送信を確認できませんでした。設定と診断情報を確認してください。' }
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
  if (event.kind === 'update') return {
    aps: { alert: { title: 'BellTeam', body: '更新があります。Updateで確認してください。' }, sound: 'default', 'thread-id': `${server}/updates` },
    bellteam: { server, kind: 'update', messageId: event.id },
  }
  return {
    aps: { alert: { title: event.title, body: event.body }, sound: 'default', 'mutable-content': 1,
      'thread-id': `${server}/${event.roomId ? `rooms/${event.roomId}` : `bots/${event.botId}`}` },
    bellteam: { server, kind: event.kind, botId: event.botId, roomId: event.roomId ?? null,
      sender: event.sender ?? null, roomName: event.roomName ?? null,
      messageId: event.id, requestId: event.kind === 'secret_request' ? event.id : null },
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,512}$/u.test(token)) throw pushError('PUSH_DEVICE_INVALID')
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
  // keys.<env> is {keyId, file} (a .p8 beside config.json) or {keyId, reference} (an op:// 1Password reference); both are supported.
  static async create(config, directory, { readKeys } = {}) {
    if (!/^[A-Z0-9]{10}$/u.test(config.teamId ?? '') || !/^[\w.-]+$/u.test(config.topic ?? ''))
      throw new Error('APNS_CONFIG_INVALID')
    const entries = ['development', 'production'].filter(environment => config.keys?.[environment]).map(environment => [environment, config.keys[environment]])
    for (const [, item] of entries) {
      const file = Object.hasOwn(item, 'file')
      if (!/^[A-Z0-9]{10}$/u.test(item.keyId ?? '') || file === Object.hasOwn(item, 'reference')
        || (file ? !/^[\w.-]+\.p8$/u.test(item.file ?? '') : !readKeys)) throw new Error('APNS_CONFIG_INVALID')
    }
    if (!entries.length) throw new Error('APNS_CONFIG_INVALID')
    const references = entries.filter(([, item]) => !Object.hasOwn(item, 'file')).map(([, item]) => item.reference)
    try { references.forEach(validateOnePasswordReference) } catch { throw pushError('APNS_KEY_REFERENCE_INVALID') }
    const values = references.length ? await readKeys(references) : new Map()
    const keys = new Map()
    for (const [environment, item] of entries) {
      if (Object.hasOwn(item, 'file')) { keys.set(environment, { keyId: item.keyId, key: await importPKCS8(await readFile(join(directory, item.file), 'utf8'), 'ES256') }); continue }
      let key
      try { key = await importPKCS8(values.get(item.reference).trim(), 'ES256') } catch { throw pushError('APNS_KEY_INVALID') }
      keys.set(environment, { keyId: item.keyId, key })
    }
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
    return new Promise((resolve, reject) => {
      const request = connection.request({ ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${token}`, 'apns-topic': this.config.topic,
        'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': id,
        'apns-expiration': String(now + 86400) })
      const sentAt = jstNow()
      let status, apnsId, response = ''
      const receipt = () => apnsReceipt({ sentAt, apnsStatus: status, apnsId })
      const fail = code => reject(Object.assign(pushError(code), receipt()))
      request.on('response', headers => { status = headers[':status']; apnsId = headers['apns-id'] })
      request.setEncoding('utf8')
      request.on('data', chunk => { response += chunk })
      request.on('error', () => fail('APNS_CONNECTION_FAILED'))
      request.setTimeout(15000, () => { request.close(); fail('APNS_TIMEOUT') })
      request.on('end', () => {
        if (status === 200) return resolve(receipt())
        if (status === 410) return fail('APNS_UNREGISTERED')
        let reason
        try { reason = JSON.parse(response).reason } catch { /* HTTPステータスを診断へ残す。 */ }
        const detail = typeof reason === 'string' && /^[A-Za-z]+$/u.test(reason) ? `_${reason.toUpperCase()}` : ''
        fail(`APNS_HTTP_${status ?? 'UNKNOWN'}${detail}`)
      })
      request.end(JSON.stringify(payload))
    })
  }

  close() { for (const connection of this.connections.values()) connection.close() }
}

function pushError(code) { return Object.assign(new Error(code), { code }) }
