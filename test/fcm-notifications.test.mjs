import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FcmNotifications, fcmMessage } from '../src/fcm-notifications.mjs'
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

async function fixture(t, { config = { serviceAccount: { file: 'key.json' } }, answers, reports = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-fcm-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  if (config) {
    await mkdir(join(root, 'shared/tools/fcm'), { recursive: true })
    await writeFile(join(root, 'shared/tools/fcm/config.json'), JSON.stringify(config))
    await writeFile(join(root, 'shared/tools/fcm/key.json'), JSON.stringify(account), { mode: 0o600 })
  }
  const fake = google(answers)
  const service = new FcmNotifications({ root, diagnostics: { async record(report) { reports.push(report) } }, fetch: fake.fetch })
  await service.initialize()
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

test('no config means off, and a broken config or key reports a fixed code without throwing', async t => {
  const none = await fixture(t, { config: null })
  assert.deepEqual(none.service.status(), { configured: false })
  await assert.rejects(none.service.register({ token: tokenA, server }), { code: 'PUSH_NOT_CONFIGURED' })
  for (const [config, code] of [[{ serviceAccount: { file: '../x.json' } }, 'FCM_CONFIG_INVALID'], [{ serviceAccount: { reference: 'nope' } }, 'FCM_KEY_REFERENCE_INVALID'],
    [{ serviceAccount: { file: 'missing.json' } }, 'FCM_KEY_UNAVAILABLE'], [{ other: 1 }, 'FCM_CONFIG_INVALID']]) {
    const broken = await fixture(t, { config })
    assert.equal(broken.service.status().configured, false)
    assert.equal(broken.service.status().error.code, code)
    assert.ok(fcmStatusValid(broken.service.status()))
    assert.deepEqual(broken.reports.map(report => [report.code, report.diagnostic_log]), [['SERVER_PUSH_UNAVAILABLE', code]])
  }
  const bad = await fixture(t)
  await writeFile(join(bad.root, 'shared/tools/fcm/key.json'), JSON.stringify({ ...account, private_key: 'x' }))
  await bad.service.load()
  assert.equal(bad.service.status().error.code, 'FCM_KEY_INVALID')
})

test('a 1Password reference supplies the service account', async t => {
  const reference = `op://${'a'.repeat(26)}/${'b'.repeat(26)}/key`
  const root = await mkdtemp(join(tmpdir(), 'bellteam-fcm-op-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'shared/tools/fcm'), { recursive: true })
  await writeFile(join(root, 'shared/tools/fcm/config.json'), JSON.stringify({ serviceAccount: { reference } }))
  const service = new FcmNotifications({ root, diagnostics: { async record() {} }, readKeys: async refs => new Map(refs.map(ref => [ref, JSON.stringify(account)])) })
  await service.initialize()
  assert.deepEqual(service.status(), { configured: true })
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

test('the Owner notification setting and the update notice both keep FCM quiet', async t => {
  const { service, fake } = await fixture(t)
  await service.register({ token: tokenA, server })
  service.publish({ id: 'u'.repeat(64), kind: 'update', title: 'BellTeam', body: '更新があります。Updateで確認してください。' }); await settle(service)
  await service.configure({ enabled: false })
  service.publish(reply); await settle(service)
  assert.equal(fake.calls.sends.length, 0)
  assert.equal(service.status().configured, false)
  await service.configure({ enabled: true })
  service.publish(reply); await settle(service)
  assert.equal(fake.calls.sends.length, 1)
})

test('the dispatcher routes provider fcm and the four events, and keeps Apple requests unchanged', async t => {
  const { root, fake } = await fixture(t)
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async () => {}, fcmFetch: fake.fetch })
  await dispatcher.control('initialize', { configuration: { apns: { enabled: true, relayUrl: '' }, webPush: { enabled: false, subject: 'mailto:ops@example.com' } } })
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
  assert.deepEqual(fake.calls.sends.map(message => message.notification), [{ title: 'Alice · 開発', body: 'ルームに新しいメッセージが届きました。' }])
  await dispatcher.control('exit', {})
})
