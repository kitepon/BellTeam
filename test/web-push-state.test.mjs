import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import webPush from 'web-push'
import { WebPushNotifications, webPushPayload } from '../src/web-push-notifications.mjs'

const origin = 'https://app.example', other = 'https://other.example'
const config = { enabled: true, subject: 'mailto:operator@example.com' }
const event = { type: 'direct', id: 'event-1', botId: 'bot-a', senderName: 'Alice' }
function subscription(suffix = 'a') {
  const key = createECDH('prime256v1'); key.generateKeys()
  return { endpoint: `https://fcm.googleapis.com/${suffix}`, expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-web-push-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reports = [], sent = []
  const base = { root, diagnostic: async report => reports.push(report), createProvider: () => ({ async send(...args) { sent.push(args) } }), ...options }
  const service = new WebPushNotifications(base)
  await service.initialize()
  return { root, service, reports, sent, base,
    register: (sub, extras = {}) => service.register({ origin, subscription: sub, applicationServerKey: service.status().publicKey, ...extras }) }
}

test('OFF creates no key; explicit enable saves one 0600 pair and restart/disable retain exact bytes', async t => {
  let generated = 0
  const { service, base } = await fixture(t, { generateKeys() { generated++; return webPush.generateVAPIDKeys() } })
  assert.deepEqual(await service.configure({ enabled: false, subject: '' }), { enabled: false, configured: false, publicKey: null, error: null })
  await assert.rejects(readFile(service.keysFile), { code: 'ENOENT' })
  await service.configure(config)
  const keys = await readFile(service.keysFile)
  assert.equal(generated, 1)
  assert.equal((await stat(service.keysFile)).mode & 0o777, 0o600)
  assert.doesNotMatch(JSON.stringify(service.status()), /privateKey|schema/u)
  await service.configure({ ...config, enabled: false })
  assert.deepEqual(await readFile(service.keysFile), keys)
  const restored = new WebPushNotifications({ ...base, generateKeys() { throw new Error('must not rotate') } })
  await restored.initialize(); await restored.configure(config)
  assert.equal(restored.status().publicKey, service.status().publicKey)
  assert.deepEqual(await readFile(service.keysFile), keys)
})

test('origin ownership/previousEndpoint refusal is atomic and same-origin replacement is one durable update', async t => {
  const { service, register } = await fixture(t)
  await service.configure(config)
  const first = subscription('first'), foreign = subscription('foreign'), replacement = subscription('replacement')
  await register(first)
  await register(foreign, { origin: other })
  const before = await readFile(service.file), keys = await readFile(service.keysFile)
  assert.deepEqual(service.status({ endpoint: first.endpoint, origin: other }), { registered: false })
  assert.deepEqual(await service.unregister({ endpoint: first.endpoint, origin: other }), { registered: false })
  for (const [sub, extras] of [[first, { origin: other }], [replacement, { previousEndpoint: foreign.endpoint }],
    [replacement, { previousEndpoint: 'https://fcm.googleapis.com/missing' }]]) {
    await assert.rejects(register(sub, extras), { code: 'WEB_PUSH_SUBSCRIPTION_CONFLICT', status: 409 })
    assert.deepEqual(await readFile(service.file), before)
    assert.deepEqual(await readFile(service.keysFile), keys)
  }
  await register(replacement, { previousEndpoint: first.endpoint })
  assert.deepEqual(service.status({ endpoint: first.endpoint, origin }), { registered: false })
  assert.deepEqual(service.status({ endpoint: replacement.endpoint, origin }), { registered: true })
  assert.equal((await stat(service.file)).mode & 0o777, 0o600)
  await service.configure({ ...config, enabled: false })
  assert.deepEqual(await service.unregister({ endpoint: replacement.endpoint, origin }), { registered: false })
  assert.deepEqual(service.status({ endpoint: foreign.endpoint, origin: other }), { registered: true })
})

test('missing/corrupt keys and corrupt registration fail Web only without reset or regeneration', async t => {
  const { service, base, register } = await fixture(t)
  await service.configure(config); await register(subscription())
  const state = await readFile(service.file), keys = await readFile(service.keysFile)
  await unlink(service.keysFile)
  for (const bad of [null, Buffer.from('{bad')]) {
    if (bad) await writeFile(service.keysFile, bad)
    const restored = new WebPushNotifications({ ...base, generateKeys() { assert.fail('rotation forbidden') } })
    await restored.initialize()
    assert.equal(restored.status().configured, false)
    assert.equal(restored.status().publicKey, null)
    await assert.rejects(restored.configure(config), error => /^WEB_PUSH_KEYS_/u.test(error.code))
    assert.deepEqual(await readFile(service.file), state)
  }
  await writeFile(service.keysFile, keys)
  await writeFile(service.file, '{invalid')
  const restored = new WebPushNotifications(base)
  await restored.initialize()
  await assert.rejects(restored.configure(config), { code: 'WEB_PUSH_STATE_INVALID' })
  assert.equal(await readFile(service.file, 'utf8'), '{invalid')
  assert.deepEqual(await readFile(service.keysFile), keys)
})

test('save failure gives no registration ACK or new map, and does not overwrite durable state', async t => {
  const { service, register } = await fixture(t)
  await service.configure(config); await register(subscription('old'))
  const before = await readFile(service.file)
  await mkdir(`${service.file}.tmp`)
  await assert.rejects(register(subscription('new')), { code: 'WEB_PUSH_STATE_SAVE_FAILED', outcome: 'unknown' })
  assert.deepEqual(await readFile(service.file), before)
  assert.equal(service.subscriptions.size, 1)
  assert.equal(service.status().configured, false)
})

test('404/410 expiry removes only captured registration; auth/unknown retain and never retry or reflect secrets', async t => {
  let failure, attempts = 0
  const { service, register, reports } = await fixture(t, { createProvider: () => ({ async send() {
    attempts++; throw Object.assign(new Error('private endpoint/auth/body'), { code: failure })
  } }) })
  await service.configure(config)
  const sub = subscription()
  await register(sub)
  for (failure of ['WEB_PUSH_AUTH_FAILED', 'WEB_PUSH_TIMEOUT', 'WEB_PUSH_SERVICE_FAILED']) {
    const before = attempts
    service.publish(event); await Promise.all([...service.inflight])
    assert.equal(attempts, before + 1)
    assert.deepEqual(service.status({ origin, endpoint: sub.endpoint }), { registered: true })
  }
  failure = 'WEB_PUSH_EXPIRED'
  service.publish(event); await Promise.all([...service.inflight]); await service.saving
  assert.deepEqual(service.status({ origin, endpoint: sub.endpoint }), { registered: false })
  assert.doesNotMatch(JSON.stringify(reports), /endpoint|auth|body|fcm/u)
})

test('late expiry cannot delete an updated subscription and close waits for the actual send', async t => {
  let fail, issued
  const began = new Promise(resolve => { issued = resolve })
  const { service, register } = await fixture(t, { createProvider: () => ({ send() {
    issued(); return new Promise((_, reject) => { fail = reject })
  } }) })
  await service.configure(config)
  const sub = subscription()
  await register(sub)
  service.publish(event); await began
  await register(subscription())
  let closed = false
  const closing = service.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  fail({ code: 'WEB_PUSH_EXPIRED' })
  await closing
  const saved = JSON.parse(await readFile(service.file))
  assert.equal(saved.subscriptions.length, 1)
  assert.equal(saved.subscriptions[0].subscription.endpoint, sub.endpoint)
})

test('four safe payload variants exclude source content; large names shrink but IDs never change', () => {
  for (const type of ['direct', 'room', 'secret', 'question']) {
    const value = webPushPayload({ ...event, type, roomId: ['room', 'secret'].includes(type) ? 'room-a' : undefined,
      roomName: 'Room', body: 'PRIVATE_BODY', question: 'PRIVATE_QUESTION', ownerGuide: 'PRIVATE_GUIDE', value: 'PRIVATE_VALUE' })
    assert.equal(Object.keys(value).length, 10)
    assert.equal(value.sender.id, value.botId)
    assert.equal(value.requestId, ['secret', 'question'].includes(type) ? event.id : null)
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/u)
  }
  const value = webPushPayload({ ...event, senderName: 'あ'.repeat(4000) })
  assert.equal(value.sender.name, 'メンバー')
  assert.equal(value.messageId, event.id)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 3072)
  assert.throws(() => webPushPayload({ ...event, id: 'x'.repeat(201) }), { code: 'WEB_PUSH_PAYLOAD_INVALID' })
  assert.throws(() => webPushPayload({ ...event, id: 'id\u0085' }), { code: 'WEB_PUSH_PAYLOAD_INVALID' })
})

test('close includes an accepted registration whose atomic saving has not terminated', async t => {
  const { service, register } = await fixture(t)
  await service.configure(config)
  const persist = service.persist.bind(service)
  let entered, release
  const began = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  service.persist = async (...args) => { entered(); await barrier; return persist(...args) }
  const pending = register(subscription())
  await began
  let closed = false
  const closing = service.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  release()
  assert.deepEqual(await pending, { registered: true })
  await closing
  assert.equal(JSON.parse(await readFile(service.file)).subscriptions.length, 1)
})

test('lifecycle: accepted registration prunes explicit expired entries after ownership validation only', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const { service, register } = await fixture(t)
  await service.configure(config)
  const expired = { ...subscription('old'), expirationTime: now + 10 }, retained = subscription('retained')
  await register(expired); await register(retained)
  const keys = await readFile(service.keysFile), before = await readFile(service.file)
  now += 11
  await assert.rejects(register({ ...expired, expirationTime: now + 10 }, { origin: other }), { code: 'WEB_PUSH_SUBSCRIPTION_CONFLICT' })
  assert.deepEqual(await readFile(service.file), before)
  await register(subscription('new'))
  const saved = JSON.parse(await readFile(service.file))
  assert.deepEqual(saved.subscriptions.map(entry => entry.subscription.endpoint).sort(), [retained.endpoint, 'https://fcm.googleapis.com/new'].sort())
  assert.deepEqual(await readFile(service.keysFile), keys)
})

test('lifecycle: OFF retains state; normal ON publish durably removes expired entries without sending them', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const { service, register, sent, base } = await fixture(t)
  await service.configure(config)
  const expired = { ...subscription('old'), expirationTime: now + 10 }, retained = subscription('retained')
  await register(expired); await register(retained)
  await service.configure({ ...config, enabled: false })
  const before = await readFile(service.file), keys = await readFile(service.keysFile)
  now += 11
  service.publish(event)
  assert.deepEqual(await readFile(service.file), before)
  await service.configure(config)
  service.publish(event); await Promise.all([...service.inflight]); await service.saving
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0].endpoint, retained.endpoint)
  assert.deepEqual(await readFile(service.keysFile), keys)
  const restored = new WebPushNotifications(base)
  await restored.initialize()
  assert.deepEqual([...restored.subscriptions.keys()], [retained.endpoint])
})

test('lifecycle: expired-entry save failure preserves original bytes and refuses Web instead of retrying', async t => {
  let now = 1800000000000
  t.mock.method(Date, 'now', () => now)
  const { service, register, sent } = await fixture(t)
  await service.configure(config)
  await register({ ...subscription('old'), expirationTime: now + 10 })
  const before = await readFile(service.file)
  now += 11
  await mkdir(service.file + '.tmp')
  service.publish(event); await Promise.all([...service.inflight]); await service.saving
  assert.deepEqual(await readFile(service.file), before)
  assert.equal(service.subscriptions.size, 1)
  assert.equal(service.status().configured, false)
  assert.equal(service.status().error.code, 'WEB_PUSH_STATE_SAVE_FAILED')
  assert.equal(sent.length, 0)
})
