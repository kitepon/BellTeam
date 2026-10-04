import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import fixtures from './fixtures/subscriptions/certificates.json' with { type: 'json' }
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { createSubscriptionWorker } from '../services/subscriptions/worker.mjs'
import { createNotificationRelay } from '../services/notifications/relay.mjs'
import { notificationPayload, PushNotifications } from '../src/push-notifications.mjs'

const now = fixtures.signedDate + 3600000
const env = { APPLE_ENVIRONMENT: 'Sandbox', APPLE_ISSUER_ID: 'test', APPLE_KEY_ID: 'test', APPLE_PRIVATE_KEY: fixtures.signingKey }
const transaction = { bundleId: product.bundleId, environment: 'Sandbox', productId: product.productId,
  type: 'Auto-Renewable Subscription', originalTransactionId: '100000000000001', signedDate: fixtures.signedDate, expiresDate: now + 3600000 }
const renewal = { environment: 'Sandbox', productId: product.productId, originalTransactionId: transaction.originalTransactionId,
  signedDate: fixtures.signedDate, autoRenewStatus: 1 }
const device = { token: 'a'.repeat(64), environment: 'production', server: 'http://192.168.1.2:18891' }
const event = { id: 'message-a', kind: 'reply', botId: 'bot-a', title: 'メンバー', body: '返信が届きました。' }

function signed(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: fixtures.x5c })).toString('base64url')
  const message = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  return `${message}.${sign('sha256', Buffer.from(message), { key: fixtures.signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

function fixture({ status = 1, tx = {}, send = async () => {}, appleFailure = false } = {}) {
  const appleCalls = [], pushes = []
  const subscriptionWorker = createSubscriptionWorker({ rootCertificates: [Buffer.from(fixtures.rootCertificate, 'base64')],
    clock: () => now, createAPIClient: () => ({ getAllSubscriptionStatuses: async id => {
      appleCalls.push(id)
      if (appleFailure) throw new Error('Apple接続の失敗')
      return { bundleId: product.bundleId, appAppleId: product.appAppleId, environment: 'Sandbox',
        data: [{ lastTransactions: [{ status, originalTransactionId: id,
          signedTransactionInfo: signed({ ...transaction, ...tx }), signedRenewalInfo: signed(renewal) }] }] }
    } }) })
  const provider = { environments: ['production'], send: async (...args) => { pushes.push(args); await send(...args) } }
  const relay = createNotificationRelay({ provider, subscriptionWorker, subscriptionEnvironment: env, clock: () => now })
  const input = { signedTransaction: signed(transaction), device, payload: notificationPayload(event, device.server), id: event.id }
  return { relay, input, pushes, appleCalls, provider }
}

async function send(relay, input) {
  const response = await relay.fetch(new Request('https://relay.example/v1/notifications/send', { method: 'POST', body: JSON.stringify(input) }))
  return { status: response.status, body: await response.json() }
}

test('公式署名検証と最新の購読照会を通し、APNs受理まで成功を返さない', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const { relay, input, pushes, appleCalls } = fixture({ send: async () => { entered(); await barrier } })
  input.signedTransaction = signed({ ...transaction, expiresDate: now - 1 })
  let complete = false
  const result = send(relay, input).then(value => { complete = true; return value })
  await started
  assert.equal(complete, false)
  assert.deepEqual(appleCalls, [transaction.originalTransactionId])
  assert.deepEqual(pushes[0], [device, input.payload, input.id])
  release()
  assert.deepEqual(await result, { status: 200, body: { accepted: true } })
})

test('購読切れ・返金・署名不正ではAPNsへ送信しない', async () => {
  for (const options of [{ status: 2, tx: { expiresDate: now - 1 } }, { status: 5 }, { tx: { revocationDate: now - 1 } }]) {
    const { relay, input, pushes } = fixture(options)
    const result = await send(relay, input)
    assert.equal(result.status, 402)
    assert.equal(result.body.error.code, 'SUBSCRIPTION_REQUIRED')
    assert.equal(pushes.length, 0)
  }
  const { relay, input, pushes, appleCalls } = fixture()
  input.signedTransaction = signed({ ...transaction, bundleId: 'com.other' })
  const result = await send(relay, input)
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'INVALID_APPLE_SIGNATURE')
  assert.equal(pushes.length, 0)
  assert.equal(appleCalls.length, 0)
})

test('AppleとAPNsの失敗を返し、再試行しない', async () => {
  const apple = fixture({ appleFailure: true })
  const failed = await send(apple.relay, apple.input)
  assert.equal(failed.status, 502)
  assert.equal(failed.body.error.code, 'APPLE_API_ERROR')
  assert.equal(apple.appleCalls.length, 1)
  assert.equal(apple.pushes.length, 0)
  for (const [code, status] of [['APNS_CONNECTION_FAILED', 502], ['APNS_UNREGISTERED', 410]]) {
    const item = fixture({ send: async () => { throw Object.assign(new Error('PRIVATE_TOKEN'), { code }) } })
    const result = await send(item.relay, item.input)
    assert.equal(result.status, status)
    assert.equal(result.body.error.code, code)
    assert.equal(item.pushes.length, 1)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'))
  }
})

test('空の購読設定と不正な通知入力は成功応答にしない', async () => {
  const { relay, input, pushes, provider } = fixture()
  const missing = createNotificationRelay({ provider, subscriptionEnvironment: {} })
  const status = await missing.fetch(new Request('https://relay.example/v1/notifications/status'))
  assert.equal(status.status, 503)
  for (const patch of [{ signedTransaction: '' }, { device: { ...device, server: 'http://public.example' } },
    { id: 'a'.repeat(65) }, { payload: {} }]) {
    const result = await send(relay, { ...input, ...patch })
    assert.equal(result.status, 400)
  }
  assert.equal(pushes.length, 0)
})

test('利用者の通知入口からrelayへ送り、失効した端末を既存登録から削除する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { relay, input, pushes, provider } = fixture()
  const reports = []
  const service = new PushNotifications({ root, bots: new Map([['bot-a', { name: 'メンバー' }]]),
    diagnostics: { record: async record => reports.push(record) },
    fetch: (url, options) => relay.fetch(new Request(url, options)) })
  await service.initialize()
  await service.configure({ enabled: true, relayUrl: 'http://localhost:18920' })
  await service.register({ ...device, signedTransaction: input.signedTransaction })
  service.secret({ id: 'request-a', botId: 'bot-a' })
  await service.close()
  assert.equal(pushes.length, 1)
  assert.equal(reports.length, 0)
  provider.send = async () => { throw Object.assign(new Error('期限切れ'), { code: 'APNS_UNREGISTERED' }) }
  service.secret({ id: 'request-b', botId: 'bot-a' })
  await service.close()
  assert.equal(service.devices.size, 0)
})

test('Node.jsの正規入口で運営の鍵を読み、HTTPの設定確認と未購入エラーを返す', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-relay-server-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  await writeFile(join(directory, 'test.p8'), privateKey.export({ format: 'pem', type: 'pkcs8' }))
  await writeFile(join(directory, 'config.json'), JSON.stringify({ teamId: 'TESTTEAM01', topic: product.bundleId,
    keys: { production: { keyId: 'TESTKEY001', file: 'test.p8' } } }))
  const child = spawn(process.execPath, ['services/notifications/index.mjs'], {
    env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: '0', BELLTEAM_APNS_DIRECTORY: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
  const output = await once(child.stdout, 'data')
  const port = output[0].toString().match(/\((\d+)\)/u)?.[1]
  assert.ok(port, output[0].toString())
  const base = `http://127.0.0.1:${port}`
  const ready = await fetch(`${base}/v1/notifications/status`)
  assert.deepEqual(await ready.json(), { configured: true, environments: ['production'] })
  const invalid = await fetch(`${base}/v1/notifications/send`, { method: 'POST', body: '{}' })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'PUSH_RELAY_REQUEST_INVALID')
  child.kill('SIGTERM')
  assert.deepEqual(await once(child, 'exit'), [0, null])
})
