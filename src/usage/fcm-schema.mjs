import { isSupportedServerURL } from '../server-address.mjs'

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
  fields(value, ['token', 'server'], ['previousToken'])
  validateFcmDevice(value)
  if (value.previousToken !== undefined) validateFcmToken(value.previousToken)
}

export const fcmStatusValid = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.configured !== 'boolean') return false
  const names = Object.keys(value).sort().join(',')
  if (names === 'configured') return true
  return names === 'configured,error' && Object.keys(value.error ?? {}).sort().join(',') === 'code,message'
    && SAFE_CODE.test(value.error.code) && typeof value.error.message === 'string' && value.error.message.length <= 200
}
