import { validatePushDevice } from '../../src/push-notifications.mjs'
import { validateFcmDevice, validateRelayFcmMessage } from '../../src/usage/fcm-schema.mjs'

function failure(code, status, message) {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

// a540-form (client-only billing, Owner 2026-11-23): the relay holds the operator's APNs/FCM keys and nothing else. It makes NO money check, keeps no
// state and reads no proof: a `ticket`, `signedTransaction` or `proof` sent by a server on an older shape is ignored, never forwarded and never required.
export function createNotificationRelay({ provider, fcmProvider = null }) {
  async function sendFcm(request) {
    if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, 'POSTを使ってください。')
    if (!fcmProvider) return failure('PUSH_NOT_CONFIGURED', 503, 'Android通知は設定されていません。')
    let input, device
    try { input = await request.json() }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知情報をJSONで送信してください。')
    }
    try {
      device = validateFcmDevice({ token: input?.device?.token, server: input?.device?.server })
      if (typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64) throw new Error('PUSH_RELAY_REQUEST_INVALID')
      validateRelayFcmMessage(input.message, device)
    } catch (error) { return failure(error.code ?? 'PUSH_RELAY_REQUEST_INVALID', 400, '通知情報の形式が正しくありません。') }
    try { await fcmProvider.post(input.message) }
    catch (error) {
      const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_SEND_FAILED'
      return failure(code, code === 'FCM_UNREGISTERED' ? 410 : 502, 'FCMへの通知送信に失敗しました。')
    }
    return Response.json({ accepted: true }, { headers: { 'Cache-Control': 'no-store' } })
  }
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v1/notifications/status') {
        if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 405, 'GETを使ってください。')
        return Response.json({ configured: true, environments: provider.environments, ...(fcmProvider ? { android: true } : {}) }, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (path === '/v1/notifications/fcm/send') return sendFcm(request)
      if (path !== '/v1/notifications/send') return failure('NOT_FOUND', 404, '見つかりません。')
      if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, 'POSTを使ってください。')
      let input
      try { input = await request.json() }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知情報をJSONで送信してください。')
      }
      if (typeof input?.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64
        || typeof input.payload?.aps?.alert?.title !== 'string' || typeof input.payload?.aps?.alert?.body !== 'string') {
        return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知情報が必要です。')
      }
      let device
      try { device = validatePushDevice(input.device) }
      catch { return failure('PUSH_DEVICE_INVALID', 400, '通知先の形式が正しくありません。') }
      if (input.payload.bellteam?.server !== device.server) return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知の接続先が一致しません。')
      if (!provider.environments.includes(device.environment)) return failure('PUSH_ENVIRONMENT_UNAVAILABLE', 400, '通知の実行環境に対応していません。')
      try { await provider.send(device, input.payload, input.id) }
      catch (error) {
        const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_SEND_FAILED'
        return failure(code, code === 'APNS_UNREGISTERED' ? 410 : 502, 'APNsへの通知送信に失敗しました。')
      }
      return Response.json({ accepted: true }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}
