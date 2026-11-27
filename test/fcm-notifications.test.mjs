import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FcmNotifications, FcmProvider, fcmMessage, loadFcmProvider } from '../src/fcm-notifications.mjs'
import { createNotificationRelay } from '../services/notifications/relay.mjs'
import { notificationPayload } from '../src/push-notifications.mjs'
import { createNotificationsDispatcher, validateNotificationRequest } from '../src/usage/notifications-dispatcher.mjs'
import { fcmStatusValid } from '../src/usage/fcm-schema.mjs'

const server = 'https://bell.example.com'
const tokenA = 'a'.repeat(40), tokenB = 'b:C-d_'.repeat(10)
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
const account = { type: 'service_account', project_id: 'bell-test-1', client_email: 'push@bell-test-1.iam.gserviceaccount.com', private_key: privateKey }
const reply = { id: 'm1', kind: 'reply', botId: 'bot-a', sender: { id: 'bot-a', name: 'Alice' }, title: 'Alice', body: '返信が届きました。' }
const room = { id: 'm2', kind: 'reply', botId: 'bot-a', roomId: 'room-1', roomName: '開発', sender: { id: 'bot-a', name: 'Alice' }, title: 'Alice · 開発', body: 'ルームに新しいメッセージが届きました。' }
const secret = { id: 's1', kind: 'secret_request', botId: 'bot-a', roomId: null, sender: { id: 'bot-a', name: 'Alice' }, title: 'Alice', body: '秘密情報の入力が必要です。' }

// A fake Google: counts OAuth calls and answers each FCM send from `answers`.
function google(answers = {}) {
  const calls = { oauth: 0, sends: [] }
  const fetch = async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.oauth++
      assert.match(options.body.get('assertion'), /^[\w-]+\.[\w-]+\.[\w-]+$/u)
      return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 })
    }
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/bell-test-1/messages:send')
    assert.equal(options.headers.authorization, 'Bearer synthetic-access-token')
    const message = JSON.parse(options.body).message
    calls.sends.push(message)
    const answer = answers[message.token]
    return answer ? Response.json({ error: { status: answer.status, details: [{ errorCode: answer.errorCode }] } }, { status: answer.http }) : Response.json({ name: 'projects/x/messages/1' })
  }
  return { calls, fetch }
}

// 2026-11-27: a user's server holds no Firebase credential (the relay is the only path); this stands in for the relay's own provider, which sends the same way.
async function fixture(t, { answers, reports = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-fcm-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = google(answers)
  const service = new FcmNotifications({ root, diagnostics: { async record(report) { reports.push(report) } }, fetch: fake.fetch })
  await service.initialize()
  await service.configure({ enabled: true, relayUrl: '' })
  service.provider = await FcmProvider.create(account, { fetch: fake.fetch })
  return { root, service, fake, reports }
}
const settle = async service => { await Promise.all(service.inflight); await service.saving }

test('the FCM message carries the APNs title and body and string data for the same event', () => {
  const device = { token: tokenA, server }
  for (const event of [reply, room, secret]) {
    const { message } = fcmMessage(event, device)
    const alert = notificationPayload(event, server).aps.alert
    assert.deepEqual(message.notification, alert)
    assert.ok(Object.values(message.data).every(value => typeof value === 'string'))
    assert.equal(message.data.messageId, event.id); assert.equal(message.data.server, server)
    assert.equal(message.android.priority, 'HIGH'); assert.equal(message.android.notification.tag, event.id)
  }
  assert.equal(fcmMessage(secret, device).message.data.requestId, 's1')
  assert.equal('roomId' in fcmMessage(reply, device).message.data, false)
  assert.equal(fcmMessage(room, device).message.data.roomName, '開発')
  const big = fcmMessage({ ...room, sender: { id: 'bot-a', name: 'あ'.repeat(2000) } }, device).message
  assert.equal(big.data.senderName, 'メンバー')
})

test('without a relay URL the server is off and reads no file; the relay credential loader reports fixed codes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-fcm-off-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reports = []
  await mkdir(join(root, 'shared/tools/fcm'), { recursive: true })
  await writeFile(join(root, 'shared/tools/fcm/config.json'), JSON.stringify({ serviceAccount: { file: 'key.json' } }))
  await writeFile(join(root, 'shared/tools/fcm/key.json'), JSON.stringify(account), { mode: 0o600 })
  const off = new FcmNotifications({ root, diagnostics: { async record(report) { reports.push(report) } } })
  await off.initialize()
  await off.configure({ enabled: true, relayUrl: '' })
  assert.deepEqual(off.status(), { configured: false })
  assert.deepEqual(reports, []) // an old shared/tools/fcm is never read
  await assert.rejects(off.register({ token: tokenA, server }), { code: 'PUSH_NOT_CONFIGURED' })
  const directory = join(root, 'relay')
  await mkdir(directory)
  assert.equal(await loadFcmProvider(directory), null)
  for (const [config, code] of [[{ serviceAccount: { file: '../x.json' } }, 'FCM_CONFIG_INVALID'], [{ serviceAccount: { reference: 'op://x/y/z' } }, 'FCM_CONFIG_INVALID'],
    [{ serviceAccount: { file: 'missing.json' } }, 'FCM_KEY_UNAVAILABLE'], [{ other: 1 }, 'FCM_CONFIG_INVALID']]) {
    await writeFile(join(directory, 'config.json'), JSON.stringify(config))
    await assert.rejects(loadFcmProvider(directory), { code })
  }
  await writeFile(join(directory, 'config.json'), JSON.stringify({ serviceAccount: { file: 'key.json' } }))
  await writeFile(join(directory, 'key.json'), JSON.stringify({ ...account, private_key: 'x' }))
  await assert.rejects(loadFcmProvider(directory), { code: 'FCM_KEY_INVALID' })
  await writeFile(join(directory, 'key.json'), JSON.stringify(account))
  assert.ok(await loadFcmProvider(directory) instanceof FcmProvider)
})

test('register persists privately, replaces previousToken, survives a restart and unregister removes', async t => {
  const { root, service } = await fixture(t)
  assert.deepEqual(service.status(), { configured: true })
  assert.deepEqual(await service.register({ token: tokenA, server }), { registered: true })
  await service.register({ token: tokenB, server, previousToken: tokenA })
  const file = join(root, 'state/fcm-devices.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schema: 'bellteam.fcm-devices.v1', devices: [{ token: tokenB, server }] })
  const again = new FcmNotifications({ root, diagnostics: { async record() {} }, fetch: google().fetch })
  await again.initialize()
  assert.deepEqual([...again.devices.keys()], [tokenB])
  assert.deepEqual(await again.unregister({ token: tokenB }), { registered: false })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).devices, [])
  await writeFile(file, '{"schema":"other"}')
  const broken = new FcmNotifications({ root, diagnostics: { async record() {} } })
  await broken.initialize()
  assert.equal(broken.status().error.code, 'FCM_STATE_INVALID')
  await assert.rejects(broken.register({ token: tokenA, server }), { code: 'FCM_STATE_INVALID' })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schema, 'other')
})

test('publish sends to every device with one OAuth token, drops UNREGISTERED silently and SENDER_ID_MISMATCH with one report', async t => {
  const dead = 'd'.repeat(40), foreign = 'f'.repeat(40), reports = []
  const { service, fake } = await fixture(t, { reports, answers: { [dead]: { http: 404, status: 'NOT_FOUND', errorCode: 'UNREGISTERED' }, [foreign]: { http: 403, status: 'PERMISSION_DENIED', errorCode: 'SENDER_ID_MISMATCH' } } })
  for (const token of [tokenA, tokenB, dead, foreign]) await service.register({ token, server })
  service.publish(reply); await settle(service)
  assert.equal(fake.calls.oauth, 1)
  assert.deepEqual(fake.calls.sends.map(message => message.token).sort(), [tokenA, tokenB, dead, foreign].sort())
  assert.deepEqual([...service.devices.keys()].sort(), [tokenA, tokenB].sort())
  assert.deepEqual(reports, [{ code: 'SERVER_PUSH_SEND_FAILED', module: 'notifications', diagnostic_log: 'FCM_SENDER_ID_MISMATCH' }])
  assert.equal(service.status().error.code, 'FCM_SENDER_ID_MISMATCH')
  service.publish(reply); await settle(service)
  assert.equal(service.status().error, undefined)
  assert.equal(fake.calls.oauth, 1)
  assert.ok(!JSON.stringify([reports, service.status()]).includes('synthetic-access-token'))
})

test('the update notice reaches Android with the APNs wording; the Owner notification setting keeps FCM quiet', async t => {
  const { service, fake } = await fixture(t)
  await service.register({ token: tokenA, server })
  const update = { id: 'a'.repeat(64), kind: 'update', title: 'BellTeam', body: '更新があります。Updateで確認してください。' }
  service.publish(update); await settle(service)
  assert.deepEqual(fake.calls.sends.map(message => [message.notification, message.data]),
    [[notificationPayload(update, server).aps.alert, { server, kind: 'update', messageId: update.id }]])
  fake.calls.sends.length = 0
  await service.configure({ enabled: false })
  service.publish(reply); await settle(service)
  assert.equal(fake.calls.sends.length, 0)
  assert.equal(service.status().configured, false)
  await service.configure({ enabled: true })
  service.publish(reply); await settle(service)
  assert.equal(fake.calls.sends.length, 1)
})

test('the dispatcher routes provider fcm through the relay, the four events and the update notice, and keeps Apple requests unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-fcm-dispatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const world = relayWorld()
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async () => {}, fcmFetch: (url, options) => world.relay.fetch(new Request(url, options)) })
  await dispatcher.control('initialize', { configuration: { apns: { enabled: true, relayUrl: 'http://127.0.0.1:1' }, webPush: { enabled: false, subject: 'mailto:ops@example.com' } } })
  await dispatcher.control('resume', {})
  const request = (method, params) => { dispatcher.validateRequest(method, params); return dispatcher.dispatch(method, params) }
  assert.deepEqual(await request('status', { provider: 'fcm' }), { configured: true })
  assert.deepEqual(await request('register', { provider: 'fcm', token: tokenA, server }), { registered: true })
  for (const bad of [{ provider: 'fcm', token: 'short', server }, { provider: 'fcm', token: tokenA, server: 'not a url' }, { provider: 'fcm', token: tokenA, server, extra: 1 }])
    assert.throws(() => validateNotificationRequest('register', bad), { code: 'PUSH_DEVICE_INVALID' })
  assert.throws(() => validateNotificationRequest('configure', { provider: 'fcm', enabled: true }), { code: 'PUSH_INPUT_INVALID' })
  assert.throws(() => validateNotificationRequest('register', { token: tokenA, server }), { code: 'PUSH_INPUT_INVALID' })
  await request('publish', { type: 'room', id: 'm2', botId: 'bot-a', senderName: 'Alice', roomId: 'room-1', roomName: '開発' })
  await request('publish', { type: 'update', id: 'a'.repeat(64) })
  await dispatcher.control('quiesce', {})
  assert.deepEqual(world.posted.map(message => message.notification).sort((a, b) => a.title.localeCompare(b.title)),
    [{ title: 'Alice · 開発', body: 'ルームに新しいメッセージが届きました。' }, { title: 'BellTeam', body: '更新があります。Updateで確認してください。' }])
  await dispatcher.control('exit', {})
})

// ---- operator relay (a381; a540: no proof, no ticket, no money check anywhere)
function relayWorld({ android = true, answer = null } = {}) {
  const posted = []
  const fcmProvider = android ? { async post(message) { posted.push(message); if (answer) throw Object.assign(new Error(answer), { code: answer }) } } : null
  const relay = createNotificationRelay({ provider: { environments: ['production'], send: async () => {} }, fcmProvider })
  const call = (path, body, method = 'POST') => relay.fetch(new Request(`https://relay.example.com${path}`, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }))
  return { relay, call, posted }
}
const goodRelayBody = (overrides = {}) => ({ device: { token: tokenA, server }, id: reply.id,
  message: fcmMessage(reply, { token: tokenA, server }).message, ...overrides })

test('the operator relay sends Android with no proof and ignores a proof or ticket an older server still sends', async () => {
  const { call, posted } = relayWorld()
  assert.equal((await (await call('/v1/notifications/status', null, 'GET')).json()).android, true)
  assert.equal((await call('/v1/notifications/fcm/send', goodRelayBody())).status, 200)
  assert.equal(posted.length, 1); assert.equal(posted[0].token, tokenA)
  assert.equal((await call('/v1/notifications/fcm/send', goodRelayBody({ proof: { ticket: 'old.ticket' } }))).status, 200)
  assert.equal((await call('/v1/notifications/fcm/send', goodRelayBody({ proof: { signedTransaction: 'old.jws' } }))).status, 200)
  assert.equal(posted.length, 3)
  assert.ok(posted.every(message => !JSON.stringify(message).includes('old.')))
})

test('the operator relay refuses Android sends that are unsupported or not the closed message', async () => {
  const off = relayWorld({ android: false })
  assert.deepEqual(await (await off.call('/v1/notifications/status', null, 'GET')).json(), { configured: true, environments: ['production'] })
  assert.equal((await off.call('/v1/notifications/fcm/send', goodRelayBody())).status, 503)
  const world = relayWorld()
  const message = goodRelayBody().message
  for (const bad of [goodRelayBody({ message: { ...message, token: tokenB } }), goodRelayBody({ message: { ...message, data: { ...message.data, server: 'https://other.example.com' } } }),
    goodRelayBody({ message: { ...message, extra: 1 } }), goodRelayBody({ message: { ...message, android: { ...message.android, priority: 'NORMAL' } } }),
    goodRelayBody({ device: { token: tokenA, server: 'not a url' } })]) {
    assert.equal((await world.call('/v1/notifications/fcm/send', bad)).status, 400)
  }
  assert.equal(world.posted.length, 0)
  const gone = relayWorld({ answer: 'FCM_UNREGISTERED' })
  const result = await gone.call('/v1/notifications/fcm/send', goodRelayBody())
  assert.equal(result.status, 410); assert.equal((await result.json()).error.code, 'FCM_UNREGISTERED')
})

test('with the relay URL the child sends every device through the relay with no proof and follows its answers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-fcm-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const relay = relayWorld(), seen = []
  let answer = null
  const fetch = async (url, options) => {
    const path = new URL(url).pathname
    seen.push(path)
    if (answer && path.endsWith('/fcm/send')) return Response.json({ error: { code: answer } }, { status: 410 })
    return relay.relay.fetch(new Request(url, options))
  }
  const reports = []
  const service = new FcmNotifications({ root, diagnostics: { async record(report) { reports.push(report) } }, fetch })
  await service.initialize()
  await service.configure({ enabled: true, relayUrl: 'https://relay.example.com' })
  assert.deepEqual(service.status(), { configured: true })
  // an older server's proof is accepted and dropped: nothing of it is kept or sent
  await service.register({ token: tokenA, server, proof: { ticket: 'synthetic.ticket.value' } })
  await service.register({ token: tokenB, server })
  service.publish(reply); await settle(service)
  assert.deepEqual(relay.posted.map(message => message.token).sort(), [tokenA, tokenB].sort())
  assert.deepEqual(reports, [])
  assert.ok(!JSON.stringify([...service.devices.values()]).includes('synthetic.ticket'))
  answer = 'FCM_UNREGISTERED'
  service.publish(reply); await settle(service)
  assert.deepEqual([...service.devices.keys()], []) // every device is sent now, so each one the relay calls unregistered is removed
  // a relay without Android support is a fixed error, not a silent success
  const old = new FcmNotifications({ root, diagnostics: { async record() {} },
    fetch: async () => Response.json({ configured: true, environments: ['production'] }) })
  await old.configure({ enabled: true, relayUrl: 'https://relay.example.com' })
  assert.equal(old.status().error.code, 'FCM_RELAY_UNSUPPORTED')
})
