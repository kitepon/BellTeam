import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importPKCS8, SignJWT } from 'jose'
import { NotificationRelayProvider } from './push-notifications.mjs'
import { FCM_CHANNEL, fcmError, validateFcmDevice, validateFcmToken } from './usage/fcm-schema.mjs'

// Fixed endpoints: nothing in the service account file chooses where the key or the token is sent.
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = project => `https://fcm.googleapis.com/v1/projects/${project}/messages:send`
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const STATE_SCHEMA = 'bellteam.fcm-devices.v1'
const MESSAGES = {
  FCM_CONFIG_INVALID: 'Android通知の設定（shared/tools/fcm/config.json）の形が正しくありません。',
  FCM_KEY_UNAVAILABLE: 'Android通知の鍵（Firebaseのサービスアカウント）のファイルを読めませんでした。',
  FCM_KEY_INVALID: 'Android通知の鍵（Firebaseのサービスアカウント）の中身が正しくありません。Firebaseから取得したJSONをそのまま保存し直してください。',
  FCM_STATE_INVALID: 'Android端末の登録ファイルを読めませんでした。',
}
const DEFAULT_MESSAGE = 'Android通知の設定・送信を確認できませんでした。設定と診断情報を確認してください。'
const safe = code => /^[A-Z_0-9]{1,100}$/u.test(code ?? '') ? code : 'PUSH_SEND_FAILED'

// Same title/body/ids as the APNs payload (event comes from the one notificationEvent mapping); FCM data values are strings.
export function fcmMessage(event, device) {
  // The update notice carries no sender; the app opens its Update screen (same wording as APNs).
  if (event.kind === 'update') return { message: { token: device.token, data: { server: device.server, kind: 'update', messageId: event.id },
    notification: { title: event.title, body: event.body },
    android: { priority: 'HIGH', ttl: '86400s', notification: { channel_id: FCM_CHANNEL, tag: event.id } } } }
  const build = (name, room) => {
    const data = { server: device.server, kind: event.kind, messageId: event.id, botId: event.botId, senderId: event.sender.id, senderName: name }
    if (event.roomId) data.roomId = event.roomId
    if (event.roomName) data.roomName = room
    if (event.kind === 'secret_request') data.requestId = event.id
    const title = event.roomName ? `${name} · ${room}` : name
    return { message: { token: device.token, data, notification: { title, body: event.body },
      android: { priority: 'HIGH', ttl: '86400s', notification: { channel_id: FCM_CHANNEL, tag: event.id } } } }
  }
  let message = build(event.sender.name, event.roomName)
  // FCM refuses more than 4 KB; fall back to the generic names like the Web push payload does.
  if (Buffer.byteLength(JSON.stringify(message)) > 4000) message = build('メンバー', 'ルーム')
  if (Buffer.byteLength(JSON.stringify(message)) > 4000) throw fcmError('FCM_PAYLOAD_INVALID')
  return message
}

export class FcmProvider {
  // serviceAccount is the parsed Firebase key; only project_id, client_email and private_key are used.
  static async create(serviceAccount, { fetch: request = fetch } = {}) {
    const { type, project_id: project, client_email: email, private_key: key } = serviceAccount ?? {}
    if (type !== 'service_account' || !/^[a-z][a-z0-9-]{4,29}$/u.test(project ?? '') || !/^[^\s@]+@[^\s@]+$/u.test(email ?? '')) throw fcmError('FCM_KEY_INVALID')
    try { return new FcmProvider({ project, email, key: await importPKCS8(key, 'RS256') }, request) }
    catch { throw fcmError('FCM_KEY_INVALID') }
  }

  constructor({ project, email, key }, request) { this.project = project; this.email = email; this.key = key; this.request = request; this.access = null; this.expiresAt = 0 }

  // One token request at a time: concurrent sends share the pending promise (the APNs token lesson).
  bearer() {
    if (!this.access || this.expiresAt - Date.now() < 60000) {
      this.expiresAt = Infinity
      const pending = this.access = this.#fetchToken().then(token => { this.expiresAt = token.expiresAt; return token })
      pending.catch(() => { if (this.access === pending) this.access = null })
    }
    return this.access
  }

  async #fetchToken() {
    const now = Math.floor(Date.now() / 1000)
    const assertion = await new SignJWT({ scope: SCOPE }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.email).setAudience(TOKEN_URL).setIssuedAt(now).setExpirationTime(now + 3600).sign(this.key)
    let response, body
    try {
      response = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(15000) })
      body = await response.json()
    } catch { throw fcmError('FCM_CONNECTION_FAILED') }
    if (!response.ok || typeof body?.access_token !== 'string') throw fcmError('FCM_AUTH_FAILED')
    return { token: body.access_token, expiresAt: Date.now() + (Number.isFinite(body.expires_in) ? body.expires_in : 3000) * 1000 }
  }

  send(device, event) { return this.post(fcmMessage(event, device)) }

  async post(message) {
    const { token } = await this.bearer()
    let response, body
    try {
      response = await this.request(SEND_URL(this.project), { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) })
      if (response.ok) return
      body = await response.json().catch(() => null)
    } catch { throw fcmError('FCM_CONNECTION_FAILED') }
    const detail = body?.error?.details?.find(row => typeof row?.errorCode === 'string')?.errorCode ?? body?.error?.status
    throw fcmError(`FCM_${/^[A-Z_0-9]{1,60}$/u.test(detail ?? '') ? detail : `HTTP_${response.status}`}`)
  }

  close() {}
}

// Only the operator relay builds this (services/notifications): shared config.json = {serviceAccount:{file}}, the Firebase key JSON beside it.
export async function loadFcmProvider(directory, { fetch: request = fetch } = {}) {
  let config
  try { config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw fcmError('FCM_CONFIG_INVALID') }
  const source = config?.serviceAccount
  if (Object.keys(config ?? {}).join() !== 'serviceAccount' || Object.keys(source ?? {}).join() !== 'file' || !/^[\w.-]+\.json$/u.test(source.file ?? '')) throw fcmError('FCM_CONFIG_INVALID')
  const text = await readFile(join(directory, source.file), 'utf8').catch(() => { throw fcmError('FCM_KEY_UNAVAILABLE') })
  let account
  try { account = JSON.parse(text) } catch { throw fcmError('FCM_KEY_INVALID') }
  return FcmProvider.create(account, { fetch: request })
}

// Sends through the operator relay with its own credential (a540: no proof of payment goes along).
export class FcmRelayProvider {
  static async create(relayUrl, request) {
    const relay = new NotificationRelayProvider({ relayUrl, fetch: request })
    const status = await relay.call('/v1/notifications/status', { method: 'GET' })
    if (status?.android !== true) throw fcmError('FCM_RELAY_UNSUPPORTED')
    return new FcmRelayProvider(relay)
  }

  constructor(relay) { this.relay = relay }

  async send(device, event) {
    const { server, token } = device
    await this.relay.call('/v1/notifications/fcm/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: { token, server }, id: event.id, message: fcmMessage(event, device).message }) })
  }

  close() {}
}

export class FcmNotifications {
  constructor({ root, diagnostics, fetch: request = fetch }) {
    this.root = root
    this.diagnostics = diagnostics
    this.request = request
    this.file = join(root, 'state/fcm-devices.json')
    this.devices = new Map()
    this.enabled = true
    this.relayUrl = ''
    this.provider = null
    this.error = null
    this.broken = false
    this.inflight = new Set()
    this.saving = Promise.resolve()
  }

  // Never throws: a broken config, key or device file reports a fixed code and leaves APNs / Web push untouched.
  async initialize() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error }))
      if (state !== null) {
        if (state?.schema !== STATE_SCHEMA || !Array.isArray(state.devices)) throw new Error()
        for (const device of state.devices) this.devices.set(device.token, validateFcmDevice(device))
      }
    } catch { this.broken = true; await this.#fail(fcmError('FCM_STATE_INVALID'), 'SERVER_PUSH_UNAVAILABLE'); return }
  }

  // relayUrl set = the operator relay carries the send (like APNs); empty = no provider: the server holds no Firebase credential (Tronie 2026-11-27).
  async load() {
    this.provider?.close(); this.provider = null
    try {
      this.provider = this.relayUrl ? await FcmRelayProvider.create(this.relayUrl, this.request) : null
      this.error = null
    // The relay being unreachable is the cause the APNs apply already reports; FCM only shows it on its status.
    } catch (error) { await this.#fail(error, 'SERVER_PUSH_UNAVAILABLE', !/^PUSH_RELAY_/u.test(error.code ?? '')) }
  }

  // The Owner's notification setting (apns.enabled) and relay URL are the one setting for every platform.
  async configure({ enabled, relayUrl = '' }) {
    const changed = (relayUrl.trim() || null) !== (this.relayUrl || null)
    this.enabled = enabled
    this.relayUrl = relayUrl.trim()
    if (enabled && !this.broken && (changed || !this.provider)) await this.load()
  }

  status() {
    return { configured: this.enabled && Boolean(this.provider) && !this.broken, ...(this.error ? { error: this.error } : {}) }
  }

  async register({ token, server, previousToken }) {
    const device = validateFcmDevice({ token, server })
    if (previousToken !== undefined) validateFcmToken(previousToken)
    if (this.broken) throw fcmError('FCM_STATE_INVALID', 'not_accepted')
    if (!this.provider || !this.enabled) throw fcmError('PUSH_NOT_CONFIGURED')
    if (previousToken && previousToken !== token) this.devices.delete(previousToken)
    this.devices.set(token, device)
    await this.save()
    return { registered: true }
  }

  async unregister({ token }) {
    validateFcmToken(token)
    this.devices.delete(token)
    await this.save()
    return { registered: false }
  }

  publish(event) {
    if (!this.provider || !this.enabled || this.broken) return
    const provider = this.provider
    let failed = false
    const task = Promise.all([...this.devices.values()].map(async device => {
      try { await provider.send(device, event) }
      catch (error) {
        if (error.code === 'FCM_UNREGISTERED') return void await this.unregister(device)
        failed = true
        if (error.code === 'FCM_SENDER_ID_MISMATCH') await this.unregister(device)
        await this.#fail(error, 'SERVER_PUSH_SEND_FAILED')
      }
    })).then(() => { if (!failed) this.error = null })
      .catch(error => process.stderr.write(`BellTeam: Android通知の診断または登録の更新に失敗しました (${safe(error.code)})\n`))
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task))
  }

  async #fail(error, report, record = true) {
    const code = safe(error.code)
    this.error = { code, message: MESSAGES[code] ?? DEFAULT_MESSAGE }
    if (record) await this.diagnostics.record({ code: report, module: 'notifications', diagnostic_log: code })
  }

  save() {
    const task = this.saving.then(async () => {
      await mkdir(join(this.root, 'state'), { recursive: true })
      await writeFile(`${this.file}.tmp`, JSON.stringify({ schema: STATE_SCHEMA, devices: [...this.devices.values()] }), { mode: 0o600 })
      await rename(`${this.file}.tmp`, this.file)
    })
    this.saving = task.catch(() => {})
    return task
  }

  async close() { await Promise.all(this.inflight); this.provider?.close() }
}
