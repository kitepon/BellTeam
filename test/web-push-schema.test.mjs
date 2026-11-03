import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import test from 'node:test'
import { validateWebPushEndpoint, validateWebPushOrigin, validateWebPushParams, validateWebPushSubject,
  validateWebPushSubscription, webPushStatusValid, WEB_PUSH_ERROR_MESSAGE } from '../src/usage/web-push-schema.mjs'

export function subscription(endpoint = 'https://fcm.googleapis.com/opaque%2Fpath?token=synthetic') {
  const key = createECDH('prime256v1'); key.generateKeys()
  return { endpoint, expirationTime: null, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}

test('fixed endpoint policy preserves opaque suffix and rejects lookalikes, redirects and nonpublic destinations', () => {
  for (const endpoint of ['https://fcm.googleapis.com/a%2Fb?q=x%2Fy', 'https://updates.push.services.mozilla.com/wpush/v2/opaque', 'https://web.push.apple.com/Q?token=x']) {
    assert.equal(validateWebPushEndpoint(endpoint).href, endpoint)
  }
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://push.apple.com/a', 'https://evilpush.apple.com/a',
    'https://x.push.apple.com.evil.invalid/a', 'https://fcm.googleapis.com./a', 'https://fcm.googleapis.com:444/a',
    'https://user:pass@fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://[::1]/a',
    'https://fcm.googleapis.com/a#b', 'https://fcm.googleapis.com/a/../b', 'https://fcm.googleapis.com/a\nb']) {
    assert.throws(() => validateWebPushEndpoint(endpoint), error => /^WEB_PUSH_/u.test(error.code))
  }
})

test('subscription and private origin have closed canonical shapes with validated P256 and future expiry', () => {
  const sub = subscription()
  validateWebPushSubscription(sub)
  assert.equal(validateWebPushOrigin('https://app.example:8443'), 'https://app.example:8443')
  for (const origin of ['https://app.example/', 'https://app.example:443', 'https://app.example/path', 'https://app.example?x', 'http://app.example', 'null']) {
    assert.throws(() => validateWebPushOrigin(origin))
  }
  for (const bad of [{ ...sub, unknown: true }, { ...sub, expirationTime: Date.now() - 1 },
    { ...sub, keys: { ...sub.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } },
    { ...sub, keys: { ...sub.keys, auth: sub.keys.auth + '=' } }]) assert.throws(() => validateWebPushSubscription(bad))
  const params = { provider: 'webPush', origin: 'https://app.example', subscription: sub, applicationServerKey: sub.keys.p256dh }
  validateWebPushParams('register', params)
  for (const bad of [{ ...params, body: 'secret' }, { ...params, origin: undefined }, { ...params, subscription: { ...sub, origin: params.origin } }]) {
    assert.throws(() => validateWebPushParams('register', bad))
  }
  validateWebPushParams('status', { provider: 'webPush' })
  assert.throws(() => validateWebPushParams('status', { provider: 'webPush', endpoint: sub.endpoint }))
})

test('contact settings and Web status expose only the fixed public shape', () => {
  for (const subject of ['mailto:operator@example.com', 'https://example.com/contact']) validateWebPushSubject(subject)
  for (const subject of ['', 'mailto:', 'mailto:a@example.com?body=secret', 'mailto:a\u0085@example.com', 'https://user:pass@example.com/', 'https://localhost/', 'https://example.com/#x']) assert.throws(() => validateWebPushSubject(subject))
  const value = { enabled: false, configured: false, publicKey: null, error: null }
  assert.equal(webPushStatusValid(value), true)
  assert.equal(webPushStatusValid({ ...value, error: { code: 'WEB_PUSH_STATE_INVALID', message: WEB_PUSH_ERROR_MESSAGE } }), true)
  assert.equal(webPushStatusValid({ ...value, privateKey: 'must-not-expose' }), false)
  assert.equal(webPushStatusValid({ ...value, error: { code: 'WEB_PUSH_STATE_INVALID', message: 'private endpoint' } }), false)
  assert.equal(webPushStatusValid({ ...value, configured: true }), false)
})
