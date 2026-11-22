import { createHash } from 'node:crypto'
import product from '../subscriptions/product.json' with { type: 'json' }
import { validatePushDevice } from '../../src/push-notifications.mjs'
import { validateFcmDevice, validateFcmProof, validateRelayFcmMessage } from '../../src/usage/fcm-schema.mjs'

function failure(code, status, message) {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

// The user's server presents the push ticket its app gave it (login-billing 0.10.0, contract 1.20; never a pass). The ticket is sealed, so only
// the Worker can read it: the relay asks the Worker's ticket/check and reads the entitlements and the value the app bound the ticket to
// (SHA-256, lowercase hex, of the device token the push goes to). It holds no key and keeps no ticket.
export function createNotificationRelay({ provider, fcmProvider = null, ticketCheckUrl, fetcher = fetch, clock = Date.now }) {
  async function entitlement(ticket, token) {
    let response
    try {
      response = await fetcher(ticketCheckUrl, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) })
    } catch { return failure('SUBSCRIPTION_CHECK_FAILED', 502, '購読確認サービスに接続できません。') }
    if (response.status === 401) {
      const code = (await response.json().catch(() => null))?.error
      return failure(code === 'ticket_ended' ? 'TICKET_ENDED' : 'TICKET_INVALID', 401, '通知の許可が無効です。アプリを開き直してください。')
    }
    const verdict = response.ok ? await response.json().catch(() => null) : null
    if (!Array.isArray(verdict?.entitlements) || typeof verdict.value !== 'string') return failure('SUBSCRIPTION_CHECK_FAILED', 502, '購読確認の応答を読めません。')
    // The ticket belongs to one device token: a ticket cannot carry pushes to another device.
    if (verdict.value !== createHash('sha256').update(token).digest('hex')) return failure('TICKET_DEVICE_MISMATCH', 401, '通知の許可がこの端末のものではありません。')
    const live = verdict.entitlements.some(item => item?.productId === product.productId && ['apple', 'google', 'exempt'].includes(item.store)
      && (item.expiresAt === undefined || Date.parse(item.expiresAt) > clock()))
    return live ? null : failure('SUBSCRIPTION_REQUIRED', 402, '通知の送信には有効なBellTeamの購読が必要です。')
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
      if (typeof proof.ticket !== 'string') throw new Error('PUSH_RELAY_REQUEST_INVALID')
      if (typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64) throw new Error('PUSH_RELAY_REQUEST_INVALID')
      validateRelayFcmMessage(input.message, device)
    } catch (error) { return failure(error.code ?? 'PUSH_RELAY_REQUEST_INVALID', 400, '購読の証明と通知情報の形式が正しくありません。') }
    const denied = await entitlement(proof.ticket, device.token)
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
        if (!ticketCheckUrl) {
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
      if (typeof input?.ticket !== 'string' || !input.ticket
        || typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64
        || typeof input.payload?.aps?.alert?.title !== 'string' || typeof input.payload?.aps?.alert?.body !== 'string') {
        return failure('PUSH_RELAY_REQUEST_INVALID', 400, 'サーバーのログインと通知情報が必要です。')
      }
      let device
      try { device = validatePushDevice(input.device) }
      catch { return failure('PUSH_DEVICE_INVALID', 400, '通知先の形式が正しくありません。') }
      if (input.payload.bellteam?.server !== device.server) return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知の接続先が一致しません。')
      if (!provider.environments.includes(device.environment)) return failure('PUSH_ENVIRONMENT_UNAVAILABLE', 400, '通知の実行環境に対応していません。')
      const denied = await entitlement(input.ticket, device.token)
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
