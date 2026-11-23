import { isSupportedServerURL } from '../server-address.mjs'

// The one FCM message shape both the user's server and the operator relay agree on.
export const FCM_CHANNEL = 'bellteam_messages'
export const FCM_TOKEN = /^[A-Za-z0-9_:-]{32,4096}$/u
const SAFE_CODE = /^[A-Z_0-9]{1,100}$/u
export const fcmError = (code, outcome = 'not_accepted') => Object.assign(new Error(code), { code, outcome })
const invalid = () => fcmError('PUSH_DEVICE_INVALID')

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid()
}
export function validateFcmToken(token) { if (typeof token !== 'string' || !FCM_TOKEN.test(token)) throw invalid() }

// a540: `proof` may still arrive from an older server's record or call; it is neither checked nor kept.
export function validateFcmDevice({ token, server }) {
  validateFcmToken(token)
  let url
  try { url = new URL(server) } catch { throw invalid() }
  if (!isSupportedServerURL(url)) throw invalid()
  return { token, server: url.origin }
}

// register / unregister / status only: the Owner's notification setting reaches FCM through the apns configure, never as an fcm method.
export function validateFcmParams(method, params) {
  const { provider, ...value } = params ?? {}
  if (provider !== 'fcm') throw invalid()
  if (method === 'status') return fields(value, [])
  if (method === 'unregister') { fields(value, ['token']); return validateFcmToken(value.token) }
  if (method !== 'register') throw fcmError('PUSH_INPUT_INVALID')
  fields(value, ['token', 'server'], ['previousToken', 'proof'])
  validateFcmDevice({ token: value.token, server: value.server })
  if (value.previousToken !== undefined) validateFcmToken(value.previousToken)
}

export const fcmStatusValid = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.configured !== 'boolean') return false
  const names = Object.keys(value).sort().join(',')
  if (names === 'configured') return true
  return names === 'configured,error' && Object.keys(value.error ?? {}).sort().join(',') === 'code,message'
    && SAFE_CODE.test(value.error.code) && typeof value.error.message === 'string' && value.error.message.length <= 200
}

// The operator relay forwards only this closed message: the device's own token and server, the fixed channel, string data.
export function validateRelayFcmMessage(message, device) {
  const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === names
  const text = (value, limit) => typeof value === 'string' && value.length > 0 && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= limit
  const { token, data, notification, android } = message ?? {}
  const ok = exact(message, 'android,data,notification,token') && token === device.token
    && exact(notification, 'body,title') && text(notification.title, 400) && text(notification.body, 400)
    && data && typeof data === 'object' && !Array.isArray(data) && data.server === device.server
    && ['kind', 'messageId', 'server'].every(key => text(data[key], 400))
    && Object.entries(data).every(([key, value]) => /^[A-Za-z]{1,40}$/u.test(key) && text(value, 400))
    && exact(android, 'notification,priority,ttl') && android.priority === 'HIGH' && android.ttl === '86400s'
    && exact(android.notification, 'channel_id,tag') && android.notification.channel_id === FCM_CHANNEL && text(android.notification.tag, 80)
    && Buffer.byteLength(JSON.stringify(message)) <= 4000
  if (!ok) throw fcmError('PUSH_RELAY_REQUEST_INVALID')
}
