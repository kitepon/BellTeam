import { validatePushDevice } from '../../src/push-notifications.mjs'
import { validateFcmDevice, validateFcmProof, validateRelayFcmMessage } from '../../src/usage/fcm-schema.mjs'

function failure(code, status, message) {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

// The user's server presents its login pass (login-billing, a485); the Worker is the only place that can read a pass.
// The relay asks the Worker's product route and forwards nothing but the verdict: it holds no key and keeps no pass.
export function createNotificationRelay({ provider, fcmProvider = null, entitlementUrl, fetcher = fetch, clock = Date.now }) {
  async function entitlement(pass) {
    let response
    try {
      response = await fetcher(entitlementUrl, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'application/json' }, body: '{}' })
    } catch { return failure('SUBSCRIPTION_CHECK_FAILED', 502, '購読確認サービスに接続できません。') }
    if (response.status === 401) {
      const code = (await response.json().catch(() => null))?.error
      return failure(/^pass_[a-z]+$/u.test(code ?? '') ? code.toUpperCase() : 'PASS_INVALID', 401, '利用者のサーバーのログインが無効です。スマホからサーバーをログインさせ直してください。')
    }
    const verdict = response.ok ? await response.json().catch(() => null) : null
    if (typeof verdict?.entitled !== 'boolean') return failure('SUBSCRIPTION_CHECK_FAILED', 502, '購読確認の応答を読めません。')
    if (!verdict.entitled || (verdict.validUntil !== undefined && Date.parse(verdict.validUntil) <= clock())) {
      return failure('SUBSCRIPTION_REQUIRED', 402, '通知の送信には有効なBellTeamの購読が必要です。')
    }
    return null
  }
  async function sendFcm(request) {
    if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, 'POSTを使ってください。')
    if (!fcmProvider) return failure('PUSH_NOT_CONFIGURED', 503, 'Android通知は設定されていません。')
    let input, device, proof
    try { input = await request.json() }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知情報をJSONで送信してください。')
    }
    try {
      device = validateFcmDevice({ token: input?.device?.token, server: input?.device?.server })
      proof = validateFcmProof(input?.proof)
      if (typeof proof.pass !== 'string') throw new Error('PUSH_RELAY_REQUEST_INVALID')
      if (typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64) throw new Error('PUSH_RELAY_REQUEST_INVALID')
      validateRelayFcmMessage(input.message, device)
    } catch (error) { return failure(error.code ?? 'PUSH_RELAY_REQUEST_INVALID', 400, '購読の証明と通知情報の形式が正しくありません。') }
    const denied = await entitlement(proof.pass)
    if (denied) return denied
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
        if (!entitlementUrl) {
          return failure('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスの接続先が設定されていません。')
        }
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
      if (typeof input?.pass !== 'string' || !input.pass
        || typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64
        || typeof input.payload?.aps?.alert?.title !== 'string' || typeof input.payload?.aps?.alert?.body !== 'string') {
        return failure('PUSH_RELAY_REQUEST_INVALID', 400, 'サーバーのログインと通知情報が必要です。')
      }
      let device
      try { device = validatePushDevice(input.device) }
      catch { return failure('PUSH_DEVICE_INVALID', 400, '通知先の形式が正しくありません。') }
      if (input.payload.bellteam?.server !== device.server) return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知の接続先が一致しません。')
      if (!provider.environments.includes(device.environment)) return failure('PUSH_ENVIRONMENT_UNAVAILABLE', 400, '通知の実行環境に対応していません。')
      const denied = await entitlement(input.pass)
      if (denied) return denied
      try { await provider.send(device, input.payload, input.id) }
      catch (error) {
        const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_SEND_FAILED'
        return failure(code, code === 'APNS_UNREGISTERED' ? 410 : 502, 'APNsへの通知送信に失敗しました。')
      }
      return Response.json({ accepted: true }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}
