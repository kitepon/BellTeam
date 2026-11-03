import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotificationsDispatcher } from '../src/usage/notifications-dispatcher.mjs'
import { writeNotificationsWebFixture } from './fixtures/notifications-web-push-state.mjs'

test('combined dispatcher retains Apple bytes and VAPID across restart; Web ownership mutations use the same private origin contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-dispatcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await writeNotificationsWebFixture(root)
  const apnsPath = join(root, 'state/push-devices.json'), keysPath = join(root, 'state/web-push-keys.json')
  const apnsBytes = await readFile(apnsPath), keyBytes = await readFile(keysPath)
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async () => {} })
  const ready = await dispatcher.control('initialize', { configuration: fixture.configuration })
  assert.deepEqual(ready.applyError, { apns: null, webPush: null })
  assert.equal(ready.status.webPush.enabled, false)
  assert.equal(ready.status.webPush.publicKey, fixture.applicationServerKey)
  assert.deepEqual(await readFile(apnsPath), apnsBytes)
  assert.deepEqual(await readFile(keysPath), keyBytes)
  await dispatcher.control('resume', {})
  const request = (method, params) => { dispatcher.validateRequest(method, params); return dispatcher.dispatch(method, params) }
  assert.deepEqual(await request('status', { provider: 'webPush', origin: fixture.otherOrigin, endpoint: fixture.subscription.endpoint }), { registered: false })
  assert.deepEqual(await request('unregister', { provider: 'webPush', origin: fixture.otherOrigin, endpoint: fixture.subscription.endpoint }), { registered: false })
  await request('configure', { provider: 'webPush', ...fixture.configuration.webPush, enabled: true })
  const file = join(root, 'state/web-push-subscriptions.json'), before = await readFile(file)
  await assert.rejects(request('register', { provider: 'webPush', origin: fixture.origin,
    subscription: fixture.replacementSubscription, applicationServerKey: fixture.applicationServerKey, previousEndpoint: fixture.foreignSubscription.endpoint }),
  { code: 'WEB_PUSH_SUBSCRIPTION_CONFLICT', status: 409 })
  assert.deepEqual(await readFile(file), before)
  await request('register', { provider: 'webPush', origin: fixture.origin, subscription: fixture.replacementSubscription,
    applicationServerKey: fixture.applicationServerKey, previousEndpoint: fixture.subscription.endpoint })
  await dispatcher.control('quiesce', {}); await dispatcher.control('exit', {})
  assert.deepEqual(await readFile(apnsPath), apnsBytes)
  assert.deepEqual(await readFile(keysPath), keyBytes)
})

test('quiesce waits for both provider sends, Web failure never rolls back Apple acceptance, and invalid Web IDs do not stop Apple', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-dual-drain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await writeNotificationsWebFixture(root)
  let releaseApns, releaseWeb, apns = 0, web = 0
  const apnsDone = new Promise(resolve => { releaseApns = resolve }), webDone = new Promise(resolve => { releaseWeb = resolve })
  const reports = []
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async value => reports.push(value),
    provider: { environments: ['production'], close() {}, async send() { apns++; await apnsDone } },
    webPushProvider: { async send() { web++; await webDone; throw { code: 'WEB_PUSH_AUTH_FAILED' } } },
  })
  await dispatcher.control('initialize', { configuration: { apns: { enabled: true, relayUrl: '' }, webPush: { ...fixture.configuration.webPush, enabled: true } } })
  await dispatcher.control('resume', {})
  const event = { type: 'direct', id: 'event-1', botId: 'bot-a', senderName: 'Alice' }
  await dispatcher.dispatch('publish', event)
  let quiesced = false
  const draining = dispatcher.control('quiesce', {}).then(value => { quiesced = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(apns, 1); assert.equal(web, 2); assert.equal(quiesced, false)
  releaseApns()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quiesced, false)
  releaseWeb()
  assert.deepEqual(await draining, { quiesced: true })
  assert.equal(JSON.parse(await readFile(join(root, 'state/web-push-subscriptions.json'))).subscriptions.length, 2)
  await dispatcher.control('resume', {})
  await dispatcher.dispatch('publish', { ...event, id: 'x'.repeat(201) })
  await dispatcher.control('quiesce', {})
  assert.equal(apns, 2); assert.equal(web, 2)
  assert.equal(reports.at(-1).diagnostic_log, 'WEB_PUSH_PAYLOAD_INVALID')
  await dispatcher.control('exit', {})
})
