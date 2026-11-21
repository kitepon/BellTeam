import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createNotificationsChildChannel, notificationError } from '../../src/notifications-ipc.mjs'

// Runtime fixture only: no provider, external request, persistent VAPID generation or C bypass in product.
const mode = process.argv[3], root = process.argv[4]
const status = { apns: { configured: false, environments: [] } }
const applyError = { apns: null }
let channel, reported = false
const apply = (provider, value) => {
  if (provider === 'apns') status.apns = { configured: value.enabled, environments: value.enabled ? ['development'] : [] }
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
    try { apply('apns', params.configuration.apns) } catch (error) { applyError.apns = error.code }
    if (mode === 'delay-ready') await channel.diagnostic({ code: 'SERVER_PUSH_UNAVAILABLE', module: 'notifications', diagnostic_log: 'FIXTURE_INITIALIZED' })
    return { status, applyError }
  }
  if (method === 'resume') return { resumed: true }
  if (method === 'quiesce') return { quiesced: true }
  return { closed: true }
}, async disconnect() {}, async afterControl(method, value) {
  if (method === 'initialize') await channel.ready(mode === 'bad-ready' ? { ...value, status: { apns: { configured: true, environments: ['development'] } } } : value)
  if (method === 'exit') channel.close()
} })
