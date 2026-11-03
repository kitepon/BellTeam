import { createECDH } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createNotificationsChildChannel, notificationError } from '../../src/notifications-ipc.mjs'
import { WEB_PUSH_ERROR_MESSAGE } from '../../src/usage/web-push-schema.mjs'

// Runtime fixture only: no provider, external request, persistent VAPID generation or C bypass in product.
const mode = process.argv[3], root = process.argv[4]
const publicKey = createECDH('prime256v1').setPrivateKey(Buffer.alloc(32, 1)).getPublicKey(undefined, 'uncompressed').toString('base64url')
const status = { apns: { configured: false, environments: [] }, webPush: { enabled: false, configured: false, publicKey: null, error: null } }
const applyError = { apns: null, webPush: null }
let channel, reported = false
const apply = (provider, value) => {
  if (provider === 'apns') status.apns = { configured: value.enabled, environments: value.enabled ? ['development'] : [] }
  else if (value.subject === 'mailto:fail@example.test') {
    status.webPush = { enabled: false, configured: false, publicKey: null,
      error: { code: 'WEB_PUSH_KEY_SAVE_FAILED', message: WEB_PUSH_ERROR_MESSAGE } }
    throw notificationError('WEB_PUSH_KEY_SAVE_FAILED')
  } else status.webPush = { enabled: value.enabled, configured: value.enabled, publicKey: value.enabled ? publicKey : null, error: null }
}
channel = createNotificationsChildChannel({ validateRequest() {}, async dispatch(method, params) {
  if (method === 'publish') return { accepted: true }
  if (method === 'configure') {
    if (mode === 'configure-delay' && !reported) {
      reported = true
      await channel.diagnostic({ code: 'SERVER_PUSH_UNAVAILABLE', module: 'notifications', diagnostic_log: 'FIXTURE_CONFIGURE' })
    }
    const { provider, ...value } = params; apply(provider, value)
    await writeFile(join(root, 'last-configuration.json'), JSON.stringify(params))
  }
  if (method === 'status' || method === 'configure') return Object.hasOwn(params, 'endpoint') ? { registered: false } : status[params.provider]
  return { registered: method === 'register' }
}, async control(method, params) {
  if (method === 'initialize') {
    for (const provider of ['apns', 'webPush']) {
      try { apply(provider, params.configuration[provider]) }
      catch (error) { applyError[provider] = error.code }
    }
    if (mode === 'delay-ready') await channel.diagnostic({ code: 'SERVER_PUSH_UNAVAILABLE', module: 'notifications', diagnostic_log: 'FIXTURE_INITIALIZED' })
    return { status, applyError }
  }
  if (method === 'resume') return { resumed: true }
  if (method === 'quiesce') return { quiesced: true }
  return { closed: true }
}, async disconnect() {}, async afterControl(method, value) {
  if (method === 'initialize') await channel.ready(mode === 'bad-ready' ? { ...value, applyError: { apns: null, webPush: null } } : value)
  if (method === 'exit') channel.close()
} })
