import { createECDH } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import webPush from 'web-push'
import { WebPushProvider } from './web-push-provider.mjs'
import { decodeWebPushKey, validateWebPushOrigin, validateWebPushParams, validateWebPushPublicKey,
  validateWebPushSubscription, webPushError, webPushFields, WEB_PUSH_ERROR_MESSAGE } from './usage/web-push-schema.mjs'

const safeCode = code => typeof code === 'string' && /^WEB_PUSH_[A-Z_0-9]{1,80}$/u.test(code) ? code : 'WEB_PUSH_SEND_FAILED'
const stateSchema = 'bellteam.web-push-subscriptions.v1'
const keySchema = 'bellteam.web-push-keys.v1'

function validateKeys(value) {
  webPushFields(value, ['schema', 'publicKey', 'privateKey'])
  if (value.schema !== keySchema) throw webPushError('WEB_PUSH_KEYS_INVALID', 503)
  validateWebPushPublicKey(value.publicKey)
  const key = createECDH('prime256v1')
  key.setPrivateKey(decodeWebPushKey(value.privateKey, 32))
  if (key.getPublicKey().toString('base64url') !== value.publicKey) throw webPushError('WEB_PUSH_KEYS_INVALID', 503)
}

export function webPushPayload(event) {
  const id = value => typeof value === 'string' && Boolean(value) && Buffer.byteLength(value) <= 200
    && !/\p{Cc}/u.test(value)
  if (!['direct', 'room', 'secret', 'question'].includes(event.type) || !id(event.id) || !id(event.botId)
    || event.roomId != null && !id(event.roomId) || event.type === 'room' && !id(event.roomId)) throw webPushError('WEB_PUSH_PAYLOAD_INVALID')
  const name = value => typeof value === 'string' && Boolean(value.trim()) && !/\p{Cc}/u.test(value)
  const make = (senderName, roomName) => ({ schema: 'bellteam.web-push.v1',
    kind: event.type === 'secret' ? 'secret_request' : event.type === 'question' ? 'owner_question' : 'reply',
    messageId: event.id, requestId: ['secret', 'question'].includes(event.type) ? event.id : null,
    botId: event.botId, roomId: ['room', 'secret'].includes(event.type) ? event.roomId ?? null : null,
    sender: { id: event.botId, name: senderName }, roomName: event.type === 'room' ? roomName : null,
    title: event.type === 'room' ? `${senderName} · ${roomName}` : senderName,
    body: event.type === 'secret' ? '秘密情報の入力が必要です。' : event.type === 'question' ? '選んでほしいことがあります。'
      : event.type === 'room' ? 'ルームに新しいメッセージが届きました。' : '返信が届きました。',
  })
  let payload = make(name(event.senderName) ? event.senderName : 'メンバー', name(event.roomName) ? event.roomName : 'ルーム')
  if (Buffer.byteLength(JSON.stringify(payload)) > 3072) payload = make('メンバー', 'ルーム')
  if (Buffer.byteLength(JSON.stringify(payload)) > 3072) throw webPushError('WEB_PUSH_PAYLOAD_INVALID')
  return payload
}

export class WebPushNotifications {
  constructor({ root, diagnostic, createProvider = options => new WebPushProvider(options), generateKeys = () => webPush.generateVAPIDKeys() }) {
    this.directory = join(root, 'state')
    this.file = join(this.directory, 'web-push-subscriptions.json')
    this.keysFile = join(this.directory, 'web-push-keys.json')
    this.diagnostic = diagnostic
    this.createProvider = createProvider
    this.generateKeys = generateKeys
    this.subscriptions = new Map()
    this.keys = null
    this.enabled = false
    this.error = null
    this.broken = false
    this.provider = null
    this.inflight = new Set()
    this.saving = Promise.resolve()
  }

  async initialize() {
    try {
      let keys, state
      try { keys = JSON.parse(await readFile(this.keysFile, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw webPushError('WEB_PUSH_KEYS_INVALID', 503) }
      if (keys !== undefined) {
        try { validateKeys(keys) } catch { throw webPushError('WEB_PUSH_KEYS_INVALID', 503) }
        this.keys = keys
      }
      try { state = JSON.parse(await readFile(this.file, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw webPushError('WEB_PUSH_STATE_INVALID', 503) }
      if (state !== undefined) {
        try {
          webPushFields(state, ['schema', 'subscriptions'])
          if (state.schema !== stateSchema || !Array.isArray(state.subscriptions)) throw new Error()
          for (const entry of state.subscriptions) {
            webPushFields(entry, ['origin', 'subscription'])
            validateWebPushOrigin(entry.origin)
            validateWebPushSubscription(entry.subscription, { allowExpired: true })
            if (this.subscriptions.has(entry.subscription.endpoint)) throw new Error()
            this.subscriptions.set(entry.subscription.endpoint, entry)
          }
        } catch { throw webPushError('WEB_PUSH_STATE_INVALID', 503) }
      }
      if (this.subscriptions.size && !this.keys) throw webPushError('WEB_PUSH_KEYS_MISSING', 503)
    } catch (error) {
      this.broken = true
      this.setError(error.code)
    }
  }

  setError(code) { this.error = { code: safeCode(code), message: WEB_PUSH_ERROR_MESSAGE } }

  assertState() { if (this.broken) throw webPushError(this.error.code, 503) }

  status(params = {}) {
    if (Object.hasOwn(params, 'endpoint')) {
      validateWebPushParams('status', { provider: 'webPush', origin: params.origin, endpoint: params.endpoint })
      this.assertState()
      return { registered: this.subscriptions.get(params.endpoint)?.origin === params.origin }
    }
    return { enabled: this.enabled, configured: Boolean(this.provider && this.keys && !this.broken),
      publicKey: this.broken ? null : this.keys?.publicKey ?? null, error: this.error }
  }

  enqueue(operation) {
    const task = this.saving.then(operation)
    this.saving = task.catch(() => {})
    return task
  }

  async persist(file, value) {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const handle = await open(`${file}.tmp`, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
      try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync() }
      finally { await handle.close() }
      await rename(`${file}.tmp`, file)
      const directory = await open(this.directory, constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      this.broken = true
      const code = file === this.keysFile ? 'WEB_PUSH_KEY_SAVE_FAILED' : 'WEB_PUSH_STATE_SAVE_FAILED'
      this.setError(code)
      throw webPushError(code, 503, 'unknown')
    }
  }

  async configure(config) {
    validateWebPushParams('configure', { provider: 'webPush', ...config })
    this.enabled = false
    await Promise.all([...this.inflight])
    return this.enqueue(async () => {
      this.assertState()
      if (config.enabled && !this.keys) {
        const keys = { schema: keySchema, ...this.generateKeys() }
        validateKeys(keys)
        await this.persist(this.keysFile, keys)
        this.keys = keys
      }
      this.provider = this.keys && config.subject ? this.createProvider({ vapid: {
        subject: config.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey,
      } }) : null
      this.enabled = config.enabled
      this.error = null
      return this.status()
    })
  }

  register(params) {
    validateWebPushParams('register', { provider: 'webPush', ...params })
    return this.enqueue(async () => {
      this.assertState()
      if (!this.enabled || !this.provider) throw webPushError('WEB_PUSH_DISABLED', 409)
      if (params.applicationServerKey !== this.keys.publicKey) throw webPushError('WEB_PUSH_KEY_MISMATCH', 409)
      validateWebPushSubscription(params.subscription)
      const endpoint = params.subscription.endpoint
      const existing = this.subscriptions.get(endpoint)
      if (existing && existing.origin !== params.origin
        || Object.hasOwn(params, 'previousEndpoint') && this.subscriptions.get(params.previousEndpoint)?.origin !== params.origin) {
        throw webPushError('WEB_PUSH_SUBSCRIPTION_CONFLICT', 409)
      }
      const next = new Map(this.subscriptions)
      if (params.previousEndpoint) next.delete(params.previousEndpoint)
      next.set(endpoint, { origin: params.origin, subscription: {
        endpoint, expirationTime: params.subscription.expirationTime, keys: { ...params.subscription.keys },
      } })
      await this.saveSubscriptions(next)
      return { registered: true }
    })
  }

  unregister(params) {
    validateWebPushParams('unregister', { provider: 'webPush', ...params })
    return this.enqueue(async () => {
      this.assertState()
      if (this.subscriptions.get(params.endpoint)?.origin === params.origin) {
        const next = new Map(this.subscriptions); next.delete(params.endpoint)
        await this.saveSubscriptions(next)
      }
      return { registered: false }
    })
  }

  async saveSubscriptions(next) {
    await this.persist(this.file, { schema: stateSchema, subscriptions: [...next.values()] })
    this.subscriptions = next
  }

  expire(entry) {
    return this.enqueue(async () => {
      this.assertState()
      if (this.subscriptions.get(entry.subscription.endpoint) !== entry) return
      const next = new Map(this.subscriptions); next.delete(entry.subscription.endpoint)
      await this.saveSubscriptions(next)
    })
  }

  async recordFailure(error) {
    const code = safeCode(error?.code)
    this.setError(code)
    try { await this.diagnostic({ code: 'SERVER_PUSH_SEND_FAILED', module: 'notifications', diagnostic_log: code }) }
    catch { process.stderr.write('WEB_PUSH_DIAGNOSTIC_FAILED\n') }
  }

  publish(event) {
    if (!this.enabled || !this.provider || this.broken) return
    const provider = this.provider
    const task = (async () => {
      const payload = JSON.stringify(webPushPayload(event))
      let failed = false
      await Promise.all([...this.subscriptions.values()].map(async entry => {
        if (entry.subscription.expirationTime !== null && entry.subscription.expirationTime <= Date.now()) return
        try { await provider.send(entry.subscription, payload) }
        catch (error) {
          if (error.code === 'WEB_PUSH_EXPIRED') {
            try { await this.expire(entry); return } catch (saveError) { error = saveError }
          }
          failed = true
          await this.recordFailure(error)
        }
      }))
      if (!failed && !this.broken) this.error = null
    })().catch(error => this.recordFailure(error))
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task))
  }

  async close() {
    this.enabled = false
    await Promise.all([...this.inflight])
    await this.saving
    this.provider = null
    this.keys = null
  }
}
