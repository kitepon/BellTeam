import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { connect, createServer as createHttp2Server } from 'node:http2'
import { generateKeyPair } from 'jose'
import { APNsProvider, PushNotifications } from '../src/push-notifications.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { SecretRequests } from '../src/secret-requests.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const device = { token: 'a'.repeat(64), environment: 'production', server: 'https://bellteam.example' }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-push-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sent = [], reports = []
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'テストメンバー' }], ['bot-b', { id: 'bot-b', name: '別メンバー' }]])
  const provider = { environments: ['production'], send: async (...args) => { sent.push(args) }, close() {} }
  const diagnostics = { record: async item => { reports.push(item) } }
  const service = new PushNotifications({ root, bots, provider, diagnostics })
  await service.initialize()
  await service.register(device)
  return { root, bots, provider, service, sent, reports, diagnostics }
}

test('返信だけを通知し、明示返信とターン完了で二重送信しない', async t => {
  const { root, bots, service, sent } = await fixture(t)
  const messenger = new BellTeamMessenger({ bots, transport: { notify: async () => ({ delivery: 'running' }) },
    logPath: join(root, 'messages.jsonl'), onMessage: item => service.direct(item) })
  const prepared = await messenger.prepareUserTurn({ target: 'bot-a', message: '秘密の質問' })
  await messenger.appendDeliveryStatus(prepared.deliveryId, 'running')
  await messenger.sendmessage({ from: 'bot-a', target: 'bot-b', message: '内部の連絡' })
  await messenger.sendmessage({ from: 'bot-a', target: 'user', message: '秘密の回答' })
  await messenger.finishUserTurn(prepared, '秘密の回答')
  await service.close()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].bellteam.botId, 'bot-a')
  assert.equal(sent[0][1].aps.alert.title, 'テストメンバー')
  assert.equal(sent[0][1].aps['mutable-content'], 1)
  assert.deepEqual(sent[0][1].bellteam.sender, { id: 'bot-a', name: 'テストメンバー' })
  assert.ok(!JSON.stringify(sent).includes('秘密'))
})

test('入力依頼は作成時に一度だけ通知し、文面と入力値を含めない', async t => {
  const { root, bots, service, sent } = await fixture(t)
  const requests = new SecretRequests({ root, bots, rooms: new Map(), notify: async () => {}, onRequest: item => service.secret(item) })
  await requests.initialize()
  const request = await requests.create({ botId: 'bot-a', toolId: 'example', label: 'PRIVATE_LABEL', message: 'PRIVATE_MESSAGE' })
  await requests.submit(request.id, 'PRIVATE_VALUE')
  await service.close()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].bellteam.requestId, request.id)
  assert.equal(sent[0][1].bellteam.kind, 'secret_request')
  assert.ok(!JSON.stringify(sent).includes('PRIVATE_'))
})

test('ルームはメンバーの投稿だけ通知し、部屋へ移動する情報を含む', async t => {
  const { service, sent } = await fixture(t)
  const room = { id: 'room-a', name: '相談室' }
  for (const id of ['user', 'scheduler', 'bot-a']) service.room({ id: 'message-id', room, sender: { id, name: id }, message: 'PRIVATE_BODY' })
  await service.close()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].bellteam.roomId, 'room-a')
  assert.deepEqual(sent[0][1].bellteam.sender, { id: 'bot-a', name: 'bot-a' })
  assert.equal(sent[0][1].bellteam.roomName, '相談室')
  assert.ok(!JSON.stringify(sent).includes('PRIVATE_BODY'))
})

test('端末登録を永続化し、トークン更新とログアウトで古い送信先を削除する', async t => {
  const { root, bots, service, provider, diagnostics } = await fixture(t)
  const replacement = { ...device, token: 'b'.repeat(64), previousToken: device.token, signedTransaction: '本人の署名付き取引' }
  await service.register(replacement)
  assert.equal(service.devices.size, 1)
  const file = join(root, 'state/push-devices.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const restored = new PushNotifications({ root, bots, provider, diagnostics })
  await restored.initialize()
  assert.equal(restored.devices.size, 1)
  assert.ok(restored.devices.has(replacement.token))
  assert.equal(restored.devices.get(replacement.token).signedTransaction, replacement.signedTransaction)
  await restored.register({ ...device, token: replacement.token })
  assert.equal(restored.devices.get(replacement.token).signedTransaction, undefined)
  await restored.unregister(replacement)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [])
  await assert.rejects(service.register({ ...device, server: 'http://example.com' }), /PUSH_DEVICE_INVALID/)
  await assert.rejects(service.register({ ...device, environment: 'development' }), /PUSH_ENVIRONMENT_UNAVAILABLE/)
})

test('失効端末は削除し、通信障害は再試行せず秘密を含めず診断する', async t => {
  const { service, provider, reports } = await fixture(t)
  let count = 0
  provider.send = async () => { count++; throw Object.assign(new Error(device.token), { code: 'APNS_CONNECTION_FAILED' }) }
  service.secret({ id: 'request-a', botId: 'bot-a' })
  await service.close()
  assert.equal(count, 1)
  assert.equal(reports[0].code, 'SERVER_PUSH_SEND_FAILED')
  assert.ok(!JSON.stringify(reports).includes(device.token))
  provider.send = async () => { throw Object.assign(new Error('期限切れ'), { code: 'APNS_UNREGISTERED' }) }
  service.secret({ id: 'request-b', botId: 'bot-a' })
  await service.close()
  assert.equal(service.devices.size, 0)
})

test('通知APIは認証が必要で、設定取得にトークンを返さない', async t => {
  const { service, bots } = await fixture(t)
  const server = createBellTeamServer({ bots, notifications: service, authorize: req => req.headers.authorization === 'Bearer test' })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/api/notifications`
  assert.equal((await fetch(`${base}/devices`, { method: 'POST', body: JSON.stringify(device) })).status, 401)
  const headers = { authorization: 'Bearer test', 'content-type': 'application/json' }
  assert.deepEqual(await (await fetch(base, { headers })).json(), { configured: true, environments: ['production'] })
  const signedTransaction = 'SIGNED_TRANSACTION_' + 'x'.repeat(5000)
  assert.equal((await fetch(`${base}/devices`, { method: 'POST', headers, body: JSON.stringify({ ...device, signedTransaction }) })).status, 200)
  assert.equal(service.devices.get(device.token).signedTransaction, signedTransaction)
  assert.ok(!JSON.stringify(await (await fetch(base, { headers })).json()).includes(signedTransaction))
  assert.equal((await fetch(`${base}/devices`, { method: 'POST', headers, body: JSON.stringify(device) })).status, 200)
  assert.equal(service.devices.get(device.token).signedTransaction, undefined)
  assert.equal((await fetch(`${base}/unregister`, { method: 'POST', headers, body: JSON.stringify({ token: device.token }) })).status, 200)
  assert.equal(service.devices.size, 0)
})

test('空volumeは通知OFF、既存直送のON/OFFを起動中に反映する', async t => {
  const { root, bots, service, diagnostics, sent } = await fixture(t)
  const empty = new PushNotifications({ root, bots, diagnostics })
  await empty.initialize()
  assert.deepEqual(empty.status(), { configured: false, environments: [] })
  await assert.rejects(empty.register(device), /PUSH_NOT_CONFIGURED/)
  await service.configure({ enabled: false, relayUrl: '' })
  service.secret({ id: 'off', botId: 'bot-a' })
  await service.close()
  assert.equal(sent.length, 0)
  await service.configure({ enabled: true, relayUrl: '' })
  service.secret({ id: 'on', botId: 'bot-a' })
  await service.close()
  assert.equal(sent.length, 1)
})

test('HTTPのLAN・loopback登録を共通の接続URL契約に合わせる', async t => {
  const { service } = await fixture(t)
  for (const server of ['http://127.0.0.1:18891', 'http://192.168.1.2:18891', 'http://bellteam.local:18891', 'http://[::1]:18891']) {
    await service.register({ ...device, server })
    assert.equal(service.devices.get(device.token).server, new URL(server).origin)
  }
  for (const server of ['http://example.com', 'http://8.8.8.8', 'https://example.com/path', 'https://user:password@example.com', 'https://example.com?token=secret']) {
    await assert.rejects(service.register({ ...device, server }), /PUSH_DEVICE_INVALID/)
  }
})

test('relayの設定反映は実接続を待ち、失敗を診断と状態へ残す', async t => {
  const { root, bots, diagnostics, reports } = await fixture(t)
  let calls = 0
  const service = new PushNotifications({ root, bots, diagnostics,
    fetch: async () => { calls++; throw new Error('PRIVATE_URL') } })
  await service.initialize()
  await assert.rejects(service.configure({ enabled: true, relayUrl: 'https://relay.example' }), /PUSH_RELAY_CONNECTION_FAILED/)
  assert.equal(calls, 1)
  assert.equal(service.status().configured, false)
  assert.equal(service.status().error.code, 'PUSH_RELAY_CONNECTION_FAILED')
  assert.equal(reports.at(-1).diagnostic_log, 'PUSH_RELAY_CONNECTION_FAILED')
  assert.equal(reports.at(-1).code, 'SERVER_PUSH_UNAVAILABLE')
  assert.ok(!JSON.stringify(reports).includes('PRIVATE_URL'))
  service.request = async () => Response.json({ configured: true, environments: ['production'] })
  await service.configure({ enabled: true, relayUrl: 'https://relay.example' })
  assert.deepEqual(service.status(), { configured: true, environments: ['production'] })
})

test('relayは端末本人の購入情報だけを送り、未登録・不正な成功応答を明示する', async t => {
  const { root, bots, diagnostics, reports } = await fixture(t)
  const requests = []
  const service = new PushNotifications({ root, bots, diagnostics,
    fetch: async (url, options) => {
      requests.push({ url: url.pathname, input: options.body ? JSON.parse(options.body) : null })
      return Response.json(options.method === 'GET' ? { configured: true, environments: ['production'] } : {})
    } })
  await service.initialize()
  await service.configure({ enabled: true, relayUrl: 'http://127.0.0.1:18920' })
  service.secret({ id: 'no-subscription', botId: 'bot-a' })
  await service.close()
  assert.equal(requests.length, 1)
  assert.equal(reports.at(-1).diagnostic_log, 'SUBSCRIPTION_REQUIRED')
  const signedTransaction = 'DEVICE_SIGNED_TRANSACTION'
  await service.register({ ...device, signedTransaction })
  const other = { ...device, token: 'b'.repeat(64), signedTransaction: 'OTHER_SIGNED_TRANSACTION' }
  await service.register(other)
  service.secret({ id: 'has-subscription', botId: 'bot-a' })
  await service.close()
  assert.deepEqual(requests.slice(1).map(request => [request.input.device.token, request.input.signedTransaction]), [
    [device.token, signedTransaction], [other.token, other.signedTransaction],
  ])
  assert.equal(requests.at(-1).input.device.signedTransaction, undefined)
  assert.equal(reports.at(-1).diagnostic_log, 'PUSH_RELAY_RESPONSE_INVALID')
  assert.ok(!JSON.stringify(reports).includes(signedTransaction))
  const sent = requests.length
  await service.register(device)
  await service.unregister(other)
  service.secret({ id: 'cleared-subscription', botId: 'bot-a' })
  await service.close()
  assert.equal(requests.length, sent)
  assert.equal(reports.at(-1).diagnostic_log, 'SUBSCRIPTION_REQUIRED')
  await assert.rejects(service.register({ ...device, signedTransaction: 42 }), /PUSH_DEVICE_INVALID/u)
  await assert.rejects(service.register({ ...device, signedTransaction: '' }), /PUSH_DEVICE_INVALID/u)
})

async function apnsServer(t, respond) {
  const sessions = []
  const server = createHttp2Server()
  const tokens = []
  server.on('session', session => sessions.push(session))
  server.on('stream', (stream, headers) => {
    tokens.push(headers.authorization)
    if (respond) return respond(stream, headers)
    stream.respond({ ':status': 200 })
    stream.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { for (const session of sessions) session.destroy(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { sessions, tokens, open: () => connect(origin) }
}

test('update receipts retain actual APNs HTTP status and apns-id for accepted and rejected sends', async t => {
  const apnsId = '11111111-2222-3333-4444-555555555555'
  let status = 200
  const { open } = await apnsServer(t, stream => {
    stream.respond({ ':status': status, 'apns-id': apnsId })
    stream.end(status === 200 ? '' : JSON.stringify({ reason: 'BadDeviceToken' }))
  })
  const provider = await apnsProvider({ open })
  t.after(() => provider.close())
  const accepted = await provider.send(device, { aps: {} }, 'receipt')
  assert.deepEqual(accepted, { sentAt: accepted.sentAt, apnsStatus: 200, apnsId })
  assert.match(accepted.sentAt, /\+09:00$/u)
  status = 400
  await assert.rejects(provider.send(device, { aps: {} }, 'receipt'), { code: 'APNS_HTTP_400_BADDEVICETOKEN', apnsStatus: 400, apnsId })
  status = 410
  await assert.rejects(provider.send(device, { aps: {} }, 'receipt'), { code: 'APNS_UNREGISTERED', apnsStatus: 410, apnsId })
})

test('update receipts persist one candidate attempt with separate device results and no secrets or retry', async t => {
  const { root, service, provider, reports } = await fixture(t)
  for (const suffix of ['b', 'c']) await service.register({ ...device, token: suffix.repeat(64), signedTransaction: 'PRIVATE_TRANSACTION' })
  const calls = []
  const apnsId = '11111111-2222-3333-4444-555555555555'
  const sentAt = '2026-11-08T14:00:00.000+09:00'
  provider.send = async destination => {
    calls.push(destination.token)
    if (destination.token === device.token) return { sentAt, apnsStatus: 200, apnsId, token: 'PRIVATE_TOKEN' }
    if (destination.token.startsWith('b')) throw Object.assign(new Error('PRIVATE_MESSAGE'), { sentAt, code: 'APNS_HTTP_400_BADDEVICETOKEN', apnsStatus: 400, apnsId })
    throw Object.assign(new Error('PRIVATE_MESSAGE'), { sentAt, code: 'APNS_TIMEOUT', apnsId: 'PRIVATE_TOKEN' })
  }
  service.publish({ kind: 'update', id: 'f'.repeat(64) })
  await service.close()
  const page = service.status().updateAttempts
  assert.equal(page.total, 1)
  const record = page.items[0]
  assert.equal(record.candidateId, 'f'.repeat(64))
  assert.equal(record.targetDeviceCount, 3)
  assert.match(record.sentAt, /\+09:00$/u)
  assert.equal(record.state, 'completed')
  assert.deepEqual(record.devices.map(row => [row.outcome, row.apnsStatus, row.apnsId, row.errorReason]), [
    ['accepted', 200, apnsId, null], ['rejected', 400, apnsId, 'APNS_HTTP_400_BADDEVICETOKEN'], ['unknown', null, null, 'APNS_TIMEOUT'],
  ])
  assert.equal(calls.length, 3)
  assert.equal(reports.length, 2)
  const directory = join(root, 'state/update-push-attempts')
  assert.deepEqual(await readdir(directory), [`${record.attemptId}.json`])
  const saved = JSON.parse(await readFile(join(directory, `${record.attemptId}.json`), 'utf8'))
  assert.equal(saved.devices.length, 3)
  const exposed = JSON.stringify([page, saved, reports])
  assert(!exposed.includes('PRIVATE_'))
  for (const token of calls) assert(!exposed.includes(token))
  const selected = service.status({ attemptId: record.attemptId, deviceOffset: 1 }).updateAttempts.items[0]
  assert.equal(selected.devices[0].device, 2)
})

test('update receipt write failure never blocks sending and not-configured or zero-device attempts stay explicit', async t => {
  const { root, service, provider } = await fixture(t)
  await writeFile(join(root, 'state/update-push-attempts'), 'existing state')
  let sent = 0
  provider.send = async () => { sent++; return { apnsStatus: 200, apnsId: null } }
  service.publish({ kind: 'update', id: 'd'.repeat(64) })
  await service.close()
  assert.equal(sent, 1)
  assert.equal(service.status().updateAttemptStorageError, 'PUSH_ATTEMPT_SAVE_FAILED')
  assert.equal(await readFile(join(root, 'state/update-push-attempts'), 'utf8'), 'existing state')
  await rm(join(root, 'state/update-push-attempts'))
  await service.configure({ enabled: false, relayUrl: '' })
  service.publish({ kind: 'update', id: 'e'.repeat(64) })
  await service.close()
  assert.equal(service.status().updateAttempts.items[0].errorReason, 'PUSH_NOT_CONFIGURED')
  await service.configure({ enabled: true, relayUrl: '' })
  await service.unregister(device)
  service.publish({ kind: 'update', id: 'a'.repeat(64) })
  await service.close()
  assert.equal(service.status().updateAttempts.items[0].errorReason, 'PUSH_NO_REGISTERED_DEVICES')
  assert.equal(sent, 1)
})

test('update receipt timeout has no invented APNs response and sends only once', async () => {
  let requests = 0
  const connection = new EventEmitter()
  connection.setTimeout = () => {}
  connection.request = () => {
    requests++
    const stream = new EventEmitter()
    stream.setEncoding = () => {}
    stream.setTimeout = (_milliseconds, callback) => queueMicrotask(callback)
    stream.close = () => {}
    stream.end = () => {}
    return stream
  }
  const provider = await apnsProvider({ open: () => connection })
  await assert.rejects(provider.send(device, { aps: {} }, 'receipt'), { code: 'APNS_TIMEOUT', apnsStatus: null, apnsId: null })
  assert.equal(requests, 1)
})

test('update receipt keeps preflight rejection and receipt-less relay acceptance distinct from an APNs send', async t => {
  const { service, provider } = await fixture(t)
  provider.send = async () => { throw Object.assign(new Error('PRIVATE_TRANSACTION'), { code: 'SUBSCRIPTION_REQUIRED' }) }
  service.publish({ kind: 'update', id: 'd'.repeat(64) })
  await service.close()
  let result = service.status().updateAttempts.items[0]
  assert.equal(result.sentAt, null)
  assert.equal(result.devices[0].outcome, 'not_sent')
  assert.equal(result.devices[0].errorReason, 'SUBSCRIPTION_REQUIRED')
  provider.send = async () => {}
  service.publish({ kind: 'update', id: 'e'.repeat(64) })
  await service.close()
  result = service.status().updateAttempts.items[0]
  assert.equal(result.sentAt, null)
  assert.equal(result.devices[0].outcome, 'unknown')
  assert.equal(result.devices[0].apnsStatus, null)
  assert.equal(result.devices[0].errorReason, 'APNS_RECEIPT_UNAVAILABLE')
})

async function apnsProvider(options) {
  const { privateKey } = await generateKeyPair('ES256')
  return new APNsProvider({ teamId: 'TEAM123456', topic: 'dev.example.bellteam' },
    new Map([['production', { keyId: 'KEY1234567', key: privateKey }]]), options)
}

test('APNsの接続は使わない間に閉じ、次の通知は新しい接続で送る', async t => {
  const { sessions, open } = await apnsServer(t)
  const provider = await apnsProvider({ open, idleTimeout: 50 })
  t.after(() => provider.close())
  await provider.send(device, { aps: {} }, 'a')
  await provider.send(device, { aps: {} }, 'b')
  assert.equal(sessions.length, 1)
  const first = provider.connections.get('production')
  await once(first, 'close')
  assert.equal(provider.connections.has('production'), false)
  await provider.send(device, { aps: {} }, 'c')
  assert.equal(sessions.length, 2)
})

test('同時に送る通知は同じ認証トークンを使い、期限まで作り直さない', async t => {
  const { tokens, open } = await apnsServer(t)
  const provider = await apnsProvider({ open })
  t.after(() => provider.close())
  const devices = ['a', 'b', 'c'].map(suffix => ({ ...device, token: suffix.repeat(64) }))
  await Promise.all(devices.map(item => provider.send(item, { aps: {} }, 'a')))
  await provider.send(device, { aps: {} }, 'b')
  assert.equal(tokens.length, 4)
  assert.equal(new Set(tokens).size, 1)
})
