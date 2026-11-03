import { createECDH, randomBytes } from 'node:crypto'
import { PushNotifications } from '../../src/push-notifications.mjs'
import { WebPushNotifications } from '../../src/web-push-notifications.mjs'

function subscription(name) {
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  return { endpoint: `https://fcm.googleapis.com/bellteam-artificial-${name}`, expirationTime: null,
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}

// Synthetic state only. No publish, network, external account or product entry injection.
export async function writeNotificationsWebFixture(root) {
  const origin = 'https://bellteam-fixture.example', otherOrigin = 'https://other-fixture.example'
  const webPush = { enabled: true, subject: 'mailto:fixture@example.com' }
  const service = new WebPushNotifications({ root, diagnostic: async () => {} })
  await service.initialize(); await service.configure(webPush)
  const applicationServerKey = service.status().publicKey
  const first = subscription('first'), foreign = subscription('foreign'), replacement = subscription('replacement')
  await service.register({ origin, subscription: first, applicationServerKey })
  await service.register({ origin: otherOrigin, subscription: foreign, applicationServerKey })
  await service.close()
  const apnsDevice = { token: 'a'.repeat(64), environment: 'production', server: origin, signedTransaction: 'ARTIFICIAL_NOT_AN_APPLE_TRANSACTION' }
  const apns = new PushNotifications({ root, provider: { environments: ['production'], close() {} }, diagnostics: { async record() {} } })
  await apns.initialize(); await apns.register(apnsDevice); await apns.close()
  return { origin, otherOrigin, applicationServerKey, subscription: first, foreignSubscription: foreign, replacementSubscription: replacement, apnsDevice,
    configuration: { apns: { enabled: false, relayUrl: '' }, webPush: { ...webPush, enabled: false } } }
}
