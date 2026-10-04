import { createSubscriptionWorker } from '../subscriptions/worker.mjs'
import { validatePushDevice } from '../../src/push-notifications.mjs'

function failure(code, status, message) {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

// 端末・取引・通知の保存は利用者のコンテナが所有し、運営は照会と送信だけを行う。
export function createNotificationRelay({ provider, subscriptionEnvironment,
  subscriptionWorker = createSubscriptionWorker(), clock = Date.now }) {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v1/notifications/status') {
        if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 405, 'GETを使ってください。')
        if (!['Production', 'Sandbox'].includes(subscriptionEnvironment?.APPLE_ENVIRONMENT)
          || !subscriptionEnvironment.APPLE_ISSUER_ID || !subscriptionEnvironment.APPLE_KEY_ID || !subscriptionEnvironment.APPLE_PRIVATE_KEY) {
          return failure('SUBSCRIPTION_NOT_CONFIGURED', 503, '購読確認サービスのApple設定が完了していません。')
        }
        return Response.json({ configured: true, environments: provider.environments }, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (path !== '/v1/notifications/send') return failure('NOT_FOUND', 404, '見つかりません。')
      if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, 'POSTを使ってください。')
      let input
      try { input = await request.json() }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知情報をJSONで送信してください。')
      }
      if (typeof input?.signedTransaction !== 'string' || !input.signedTransaction
        || typeof input.id !== 'string' || !input.id || Buffer.byteLength(input.id) > 64
        || typeof input.payload?.aps?.alert?.title !== 'string' || typeof input.payload?.aps?.alert?.body !== 'string') {
        return failure('PUSH_RELAY_REQUEST_INVALID', 400, '署名付き購入情報と通知情報が必要です。')
      }
      let device
      try { device = validatePushDevice(input.device) }
      catch { return failure('PUSH_DEVICE_INVALID', 400, '通知先の形式が正しくありません。') }
      if (input.payload.bellteam?.server !== device.server) return failure('PUSH_RELAY_REQUEST_INVALID', 400, '通知の接続先が一致しません。')
      if (!provider.environments.includes(device.environment)) return failure('PUSH_ENVIRONMENT_UNAVAILABLE', 400, '通知の実行環境に対応していません。')
      const verification = await subscriptionWorker.fetch(new Request('https://subscriptions.bellteam.local/v1/subscriptions/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTransaction: input.signedTransaction }),
      }), subscriptionEnvironment)
      if (!verification.ok) return verification
      const subscription = await verification.json()
      if (typeof subscription?.entitled !== 'boolean'
        || (subscription.entitled && !Number.isFinite(Date.parse(subscription.validUntil)))) {
        return failure('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認の応答形式が一致しません。')
      }
      if (!subscription.entitled || Date.parse(subscription.validUntil) <= clock()) {
        return failure('SUBSCRIPTION_REQUIRED', 402, '通知の送信には有効なBellTeamの購読が必要です。')
      }
      try { await provider.send(device, input.payload, input.id) }
      catch (error) {
        const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_SEND_FAILED'
        return failure(code, code === 'APNS_UNREGISTERED' ? 410 : 502, 'APNsへの通知送信に失敗しました。')
      }
      return Response.json({ accepted: true }, { headers: { 'Cache-Control': 'no-store' } })
    },
  }
}
