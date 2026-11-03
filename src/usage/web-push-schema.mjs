import { ECDH } from 'node:crypto'
import { isIP } from 'node:net'

export const WEB_PUSH_ERROR_MESSAGE = 'Web通知の設定・送信を確認できませんでした。設定を確認してください。'
export const webPushError = (code, status = 400, outcome = 'not_accepted') => Object.assign(new Error(code), {
  code, status, outcome, publicMessage: WEB_PUSH_ERROR_MESSAGE,
})
const invalid = () => webPushError('WEB_PUSH_INPUT_INVALID')
export function webPushFields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid()
}

export function decodeWebPushKey(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw invalid()
  return bytes
}

export function validateWebPushPublicKey(value) {
  const bytes = decodeWebPushKey(value, 65)
  try {
    if (bytes[0] !== 4 || !ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed').equals(bytes)) throw invalid()
  } catch { throw invalid() }
}

export function validateWebPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || Buffer.byteLength(endpoint) > 8192 || /[\s\u0000-\u001f\u007f\\]/u.test(endpoint)) throw invalid()
  let url
  try { url = new URL(endpoint) } catch { throw invalid() }
  const host = url.hostname
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
    || host.endsWith('.') || isIP(host.replace(/^\[|\]$/gu, ''))
    || !host.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(label))) throw invalid()
  if (host !== 'fcm.googleapis.com' && host !== 'updates.push.services.mozilla.com'
    && !(host.endsWith('.push.apple.com') && host !== 'push.apple.com')) throw webPushError('WEB_PUSH_SERVICE_UNSUPPORTED')
  const rawPath = endpoint.match(/^https:\/\/[^/?#]+(.*)$/u)?.[1]
  if (rawPath === undefined || `${url.pathname}${url.search}` !== (rawPath.startsWith('?') ? `/${rawPath}` : rawPath || '/')) throw invalid()
  return url
}

export function validateWebPushOrigin(origin) {
  if (typeof origin !== 'string' || Buffer.byteLength(origin) > 2048 || /[\u0000-\u0020\u007f]/u.test(origin)) throw invalid()
  let url
  try { url = new URL(origin) } catch { throw invalid() }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw invalid()
  return origin
}

export function validateWebPushSubject(subject) {
  if (typeof subject !== 'string' || Buffer.byteLength(subject) > 2048 || /[\u0000-\u0020\u007f]/u.test(subject)) throw invalid()
  let url
  try { url = new URL(subject) } catch { throw invalid() }
  if (url.protocol === 'mailto:') {
    if (!/^[^@/?#]+@[^@/?#]+\.[^@/?#]+$/u.test(url.pathname) || url.search || url.hash) throw invalid()
  } else if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname
    || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')
    || isIP(url.hostname.replace(/^\[|\]$/gu, '')) || !url.hostname.includes('.')) throw invalid()
}

export function validateWebPushSubscription(subscription, { allowExpired = false, now = Date.now() } = {}) {
  webPushFields(subscription, ['endpoint', 'expirationTime', 'keys'])
  validateWebPushEndpoint(subscription.endpoint)
  if (subscription.expirationTime !== null) {
    if (!Number.isSafeInteger(subscription.expirationTime) || subscription.expirationTime < 0) throw invalid()
    if (!allowExpired && subscription.expirationTime <= now) throw webPushError('WEB_PUSH_SUBSCRIPTION_EXPIRED', 409)
  }
  webPushFields(subscription.keys, ['p256dh', 'auth'])
  validateWebPushPublicKey(subscription.keys.p256dh)
  decodeWebPushKey(subscription.keys.auth, 16)
}

export function validateWebPushParams(method, params) {
  if (method === 'status') {
    if (Object.hasOwn(params, 'endpoint')) {
      webPushFields(params, ['provider', 'origin', 'endpoint'])
      validateWebPushOrigin(params.origin)
      validateWebPushEndpoint(params.endpoint)
    } else webPushFields(params, ['provider'])
  } else if (method === 'configure') {
    webPushFields(params, ['provider', 'enabled', 'subject'])
    if (typeof params.enabled !== 'boolean' || typeof params.subject !== 'string') throw invalid()
    if (params.subject || params.enabled) validateWebPushSubject(params.subject)
  } else if (method === 'register') {
    webPushFields(params, ['provider', 'origin', 'subscription', 'applicationServerKey'], ['previousEndpoint'])
    validateWebPushOrigin(params.origin)
    validateWebPushSubscription(params.subscription)
    validateWebPushPublicKey(params.applicationServerKey)
    if (Object.hasOwn(params, 'previousEndpoint')) validateWebPushEndpoint(params.previousEndpoint)
  } else if (method === 'unregister') {
    webPushFields(params, ['provider', 'origin', 'endpoint'])
    validateWebPushOrigin(params.origin)
    validateWebPushEndpoint(params.endpoint)
  } else throw invalid()
  if (params.provider !== 'webPush') throw invalid()
}

export function webPushStatusValid(value) {
  try {
    webPushFields(value, ['enabled', 'configured', 'publicKey', 'error'])
    if (typeof value.enabled !== 'boolean' || typeof value.configured !== 'boolean') return false
    if (value.publicKey !== null) validateWebPushPublicKey(value.publicKey)
    if (value.configured && value.publicKey === null) return false
    if (value.error !== null) {
      webPushFields(value.error, ['code', 'message'])
      if (!/^WEB_PUSH_[A-Z_0-9]{1,80}$/u.test(value.error.code) || value.error.message !== WEB_PUSH_ERROR_MESSAGE) return false
    }
    return true
  } catch { return false }
}
