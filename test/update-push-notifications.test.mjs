import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotifications } from '../src/usage/notifications.mjs'
import { createNotificationsDispatcher, validateNotificationRequest } from '../src/usage/notifications-dispatcher.mjs'
import { PushNotifications } from '../src/push-notifications.mjs'

const id = 'a'.repeat(64), event = { type: 'update', id }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('update DTO admits only an existing candidate digest', () => {
  validateNotificationRequest('publish', event)
  for (const invalid of [{ ...event, botId: 'private' }, { ...event, body: 'private' },
    { ...event, id: id.toUpperCase() }, { ...event, id: id.slice(1) }, { ...event, id: null },
    { type: 'new-kind', id }, { ...event, id: id + '\n' }]) {
    assert.throws(() => validateNotificationRequest('publish', invalid), /PUSH_INPUT_INVALID/)
  }
})

test('real dispatcher uses existing OFF state, drains the provider, and does not retry failed update sends', async t => {
  const root = await mkdtemp(join(tmpdir(), 'update-push-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const origin = 'https://bellteam-fixture.example'
  // Synthetic state only: one registered APNs device, nothing published, no network.
  const service = new PushNotifications({ root, provider: { environments: ['production'], close() {} }, diagnostics: { async record() {} } })
  await service.initialize()
  await service.register({ token: 'a'.repeat(64), environment: 'production', server: origin, signedTransaction: 'ARTIFICIAL_NOT_AN_APPLE_TRANSACTION' })
  await service.close()
  const file = join(root, 'state', 'push-devices.json')
  const before = await readFile(file)
  const apns = [], reports = []
  let release
  const done = new Promise(resolve => { release = resolve })
  t.after(release)
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async report => reports.push(report),
    provider: { environments: ['production'], close() {}, async send(...args) {
      apns.push(args); await done; throw Object.assign(new Error('PRIVATE_PROVIDER_TEXT'), { code: 'APNS_SEND_FAILED' })
    } },
  })
  t.after(() => dispatcher.disconnect())
  await dispatcher.control('initialize', { configuration: { apns: { enabled: false, relayUrl: '' } } })
  await dispatcher.control('resume', {})
  const publish = () => { dispatcher.validateRequest('publish', event); return dispatcher.dispatch('publish', event) }
  await publish()
  await dispatcher.control('quiesce', {})
  assert.equal(apns.length, 0)
  await dispatcher.control('resume', {})
  await dispatcher.dispatch('configure', { provider: 'apns', enabled: true, relayUrl: '' })
  assert.deepEqual(await publish(), { accepted: true })
  let drained = false
  const draining = dispatcher.control('quiesce', {}).then(value => { drained = true; return value })
  await tick()
  for (let attempts = 0; apns.length < 1 && attempts < 400; attempts++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(drained, false); assert.equal(apns.length, 1)
  assert.deepEqual(apns[0][1], {
    aps: { alert: { title: 'BellTeam', body: '更新があります。Updateで確認してください。' }, sound: 'default', 'thread-id': `${origin}/updates` },
    bellteam: { server: origin, kind: 'update', messageId: id },
  })
  assert.equal(apns[0][2], id)
  release()
  assert.deepEqual(await draining, { quiesced: true })
  await tick()
  assert.equal(apns.length, 1)
  assert.equal(reports.length, 1)
  assert(!JSON.stringify(reports).includes('PRIVATE_'))
  assert.deepEqual(await readFile(file), before)
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
