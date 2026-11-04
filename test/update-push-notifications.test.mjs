import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotifications } from '../src/usage/notifications.mjs'
import { createNotificationsDispatcher, validateNotificationRequest } from '../src/usage/notifications-dispatcher.mjs'
import { webPushPayload } from '../src/web-push-notifications.mjs'
import { writeNotificationsWebFixture } from './fixtures/notifications-web-push-state.mjs'

const id = 'a'.repeat(64), event = { type: 'update', id }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('update DTO admits only an existing candidate digest and Web payload contains fixed public fields', () => {
  validateNotificationRequest('publish', event)
  for (const invalid of [{ ...event, botId: 'private' }, { ...event, body: 'private' },
    { ...event, id: id.toUpperCase() }, { ...event, id: id.slice(1) }, { ...event, id: null },
    { type: 'new-kind', id }, { ...event, id: id + '\n' }]) {
    assert.throws(() => validateNotificationRequest('publish', invalid), /PUSH_INPUT_INVALID/)
  }
  assert.throws(() => webPushPayload({ ...event, id: 'invalid' }), /WEB_PUSH_PAYLOAD_INVALID/)
  assert.deepEqual(webPushPayload(event), { schema: 'bellteam.web-push.v1', kind: 'update', messageId: id,
    title: 'BellTeam', body: '更新があります。Updateで確認してください。' })
})

test('real dispatcher uses existing OFF state, drains both providers, and does not retry failed update sends', async t => {
  const root = await mkdtemp(join(tmpdir(), 'update-push-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await writeNotificationsWebFixture(root)
  const files = ['push-devices.json', 'web-push-subscriptions.json', 'web-push-keys.json'].map(name => join(root, 'state', name))
  const before = await Promise.all(files.map(file => readFile(file)))
  const apns = [], web = [], reports = []
  let release
  const done = new Promise(resolve => { release = resolve })
  t.after(release)
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async report => reports.push(report),
    provider: { environments: ['production'], close() {}, async send(...args) {
      apns.push(args); await done; throw Object.assign(new Error('PRIVATE_PROVIDER_TEXT'), { code: 'APNS_SEND_FAILED' })
    } },
    webPushProvider: { async send(...args) {
      web.push(args); await done; throw Object.assign(new Error('PRIVATE_PROVIDER_TEXT'), { code: 'WEB_PUSH_AUTH_FAILED' })
    } },
  })
  t.after(() => dispatcher.disconnect())
  await dispatcher.control('initialize', { configuration: fixture.configuration })
  await dispatcher.control('resume', {})
  const publish = () => { dispatcher.validateRequest('publish', event); return dispatcher.dispatch('publish', event) }
  await publish()
  await dispatcher.control('quiesce', {})
  assert.equal(apns.length, 0); assert.equal(web.length, 0)
  await dispatcher.control('resume', {})
  await dispatcher.dispatch('configure', { provider: 'apns', enabled: true, relayUrl: '' })
  await dispatcher.dispatch('configure', { provider: 'webPush', ...fixture.configuration.webPush, enabled: true })
  assert.deepEqual(await publish(), { accepted: true })
  let drained = false
  const draining = dispatcher.control('quiesce', {}).then(value => { drained = true; return value })
  await tick()
  assert.equal(drained, false)
  assert.equal(apns.length, 1); assert.equal(web.length, 2)
  assert.deepEqual(apns[0][1], {
    aps: { alert: { title: 'BellTeam', body: '更新があります。Updateで確認してください。' }, sound: 'default', 'thread-id': `${fixture.origin}/updates` },
    bellteam: { server: fixture.origin, kind: 'update', messageId: id },
  })
  assert.equal(apns[0][2], id)
  assert(web.every(([, payload]) => payload === JSON.stringify(webPushPayload(event))))
  release()
  assert.deepEqual(await draining, { quiesced: true })
  await tick()
  assert.equal(apns.length, 1); assert.equal(web.length, 2)
  assert.equal(reports.length, 3)
  assert(!JSON.stringify(reports).includes('PRIVATE_'))
  const after = await Promise.all(files.map(file => readFile(file)))
  assert.deepEqual(after, before)
})

test('facade projects digest only and exchange buffer tries an unknown ACK once', async () => {
  const sent = [], reports = []
  let options
  const service = createNotifications({ root: 'unused', bots: new Map(), configuration: () => ({}),
    diagnostics: { async record(report) { reports.push(report) } },
    createProcess(value) { options = value; return { async close() {}, async request(method, params) {
      sent.push({ method, params }); throw Object.assign(new Error('private'), { code: 'PUSH_IPC_DISCONNECTED', outcome: 'unknown' })
    } } },
  })
  options.onState({ exchanging: true, available: false, phase: 'quiescing' })
  service.update({ id, body: 'PRIVATE_BODY', secret: 'PRIVATE_SECRET' })
  assert.equal(sent.length, 0)
  options.onState({ exchanging: false, available: true, phase: 'running' })
  await tick()
  options.onState({ exchanging: false, available: true, phase: 'running' })
  await tick()
  assert.deepEqual(sent, [{ method: 'publish', params: event }])
  service.update({ id: 'invalid' })
  await tick()
  assert.equal(sent.length, 1)
  assert.deepEqual(reports.map(value => value.diagnostic_log), ['PUSH_IPC_DISCONNECTED', 'PUSH_INPUT_INVALID'])
  await service.close()
})
