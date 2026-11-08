import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotificationsParentChannel, waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

const fixture = new URL('./fixtures/notifications-usage-child.mjs', import.meta.url).pathname
const device = { token: 'a'.repeat(64), environment: 'production', server: 'https://bellteam.example', signedTransaction: 'PRIVATE_TRANSACTION' }
const event = { type: 'direct', id: 'slow', botId: 'bot-a', senderName: 'ミカ' }

async function start(t, { mode = '', configuration = { enabled: false, relayUrl: '' }, webConfiguration = { enabled: false, subject: '' }, onDiagnostic = async () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'notifications-usage-ipc-'))
  const child = spawn(process.execPath, [fixture, 'builtin', root, mode], { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const ended = waitNotificationsChildClose(child)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const channel = createNotificationsParentChannel(child, { onDiagnostic })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.dispose(); await rm(root, { recursive: true, force: true }) })
  await channel.control('initialize', { configuration: { apns: configuration, webPush: webConfiguration } })
  const ready = await channel.ready
  return { channel, ready, root, child, ended, stderr: () => stderr }
}

test('update receipt IPC returns concurrent saved attempts and quiesce waits their provider outcomes', async t => {
  const { channel, root } = await start(t, { mode: 'receipt-provider', configuration: { enabled: true, relayUrl: '' } })
  await channel.control('resume')
  await channel.request('register', { ...device, provider: 'apns' })
  for (const suffix of ['e', 'f']) await channel.request('publish', { type: 'update', id: suffix.repeat(64) })
  const pending = await channel.request('status', { provider: 'apns' })
  assert.equal(pending.updateAttempts.total, 2)
  assert(pending.updateAttempts.items.every(item => item.state === 'pending'))
  let drained = false
  const drain = channel.control('quiesce', {}).then(value => { drained = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(drained, false)
  await writeFile(join(root, 'release'), '')
  assert.deepEqual(await drain, { quiesced: true })
  await channel.control('resume')
  const result = await channel.request('status', { provider: 'apns' })
  assert(result.updateAttempts.items.every(item => item.state === 'completed' && item.devices[0].outcome === 'accepted'))
  const selected = await channel.request('status', { provider: 'apns', attemptId: result.updateAttempts.items[0].attemptId, deviceOffset: 0 })
  assert.equal(selected.updateAttempts.items.length, 1)
  assert.equal((await readdir(join(root, 'state/update-push-attempts'))).length, 2)
  assert(!JSON.stringify(result).includes(device.token))
  assert(!JSON.stringify(result).includes('PRIVATE_TRANSACTION'))
})

test('実IPCとusage dispatcherは未設定ready・resume前拒否・正常exitを接続する', async t => {
  const { channel, ready, ended } = await start(t)
  assert.deepEqual(ready, { type: 'ready', versionId: null, protocolVersion: 2, stateSchema: 2,
    status: { apns: { configured: false, environments: [] }, webPush: { enabled: false, configured: false, publicKey: null, error: null } }, applyError: { apns: null, webPush: null } })
  await assert.rejects(channel.request('status', { provider: 'apns' }), { outcome: 'not_accepted' })
  await channel.control('resume')
  assert.deepEqual(await channel.request('status', { provider: 'apns' }), ready.status.apns)
  await assert.rejects(channel.request('register', { ...device, provider: 'apns' }), { code: 'PUSH_NOT_CONFIGURED', outcome: 'unknown' })
  await channel.control('quiesce')
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
})

test('実IPCでpublish受付後のquiesceはprovider終端まで待ち、状態を同形式で保存する', async t => {
  const { channel, root, ended } = await start(t, { mode: 'provider', configuration: { enabled: true, relayUrl: '' } })
  await channel.control('resume')
  await assert.rejects(channel.request('publish', { ...event, body: 'PRIVATE_BODY' }), { code: 'PUSH_INPUT_INVALID', outcome: 'not_accepted' })
  await assert.rejects(channel.request('register', { ...device, provider: 'apns', token: 'bad' }), { code: 'PUSH_DEVICE_INVALID', outcome: 'not_accepted' })
  assert.deepEqual(await channel.request('register', { ...device, provider: 'apns' }), { registered: true })
  assert.deepEqual(await channel.request('publish', event), { accepted: true })
  let finished = false
  const quiescing = channel.control('quiesce').then(value => { finished = true; return value })
  await assert.rejects(channel.request('status', { provider: 'apns' }), { outcome: 'not_accepted' })
  assert.equal(finished, false)
  await writeFile(join(root, 'release'), '')
  assert.deepEqual(await quiescing, { quiesced: true })
  await assert.rejects(channel.request('publish', event), { outcome: 'not_accepted' })
  const sent = await readFile(join(root, 'sent.jsonl'), 'utf8')
  assert.equal(sent.trim().split('\n').length, 1)
  assert(!sent.includes('PRIVATE_'))
  const saved = JSON.parse(await readFile(join(root, 'state/push-devices.json'), 'utf8'))
  assert.deepEqual(saved, [device])
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
})

test('実IPCの診断ACK失敗でも設定の元エラーとreadyを保ち、再設定しない', async t => {
  let reports = 0
  const { ready, channel, stderr } = await start(t, { configuration: { enabled: true, relayUrl: 'PRIVATE_INVALID_URL' },
    onDiagnostic: async () => { reports++; throw new Error('PRIVATE_DIAGNOSTIC') } })
  assert.equal(reports, 1)
  assert.equal(ready.applyError.apns, 'PUSH_RELAY_URL_INVALID')
  assert.equal(ready.status.apns.configured, false)
  assert(!stderr().includes('PRIVATE_'))
  await channel.control('resume')
  await channel.control('quiesce')
  await channel.control('exit')
})

test('親IPC切断後もusage送信終端を待ち、OS/IPC/pipe回収barrierで終了する', async t => {
  const { channel, child, root, ended } = await start(t, { mode: 'provider', configuration: { enabled: true, relayUrl: '' } })
  await channel.control('resume')
  await channel.request('register', { ...device, provider: 'apns' })
  await channel.request('publish', event)
  let closed = false
  void ended.then(() => { closed = true })
  child.disconnect()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  await writeFile(join(root, 'release'), '')
  assert.deepEqual(await ended, { code: 0, signal: null })
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state/push-devices.json'), 'utf8')), [device])
})

test('ABI2 real IPC correlates Web origin/409 and drains both artificial providers before exit', async t => {
  const { channel, root, ready, ended } = await start(t, { mode: 'both-providers', configuration: { enabled: true, relayUrl: '' },
    webConfiguration: { enabled: true, subject: 'mailto:fixture@example.com' } })
  const keyBytes = await readFile(join(root, 'state/web-push-keys.json'))
  await channel.control('resume')
  await channel.request('register', { provider: 'apns', ...device })
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  const origin = 'https://fixture.example'
  const subscription = { endpoint: 'https://fcm.googleapis.com/artificial', expirationTime: null,
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  const params = { provider: 'webPush', origin, subscription, applicationServerKey: ready.status.webPush.publicKey }
  assert.deepEqual(await channel.request('register', params), { registered: true })
  assert.deepEqual(await channel.request('status', { provider: 'webPush', origin: 'https://other.example', endpoint: subscription.endpoint }), { registered: false })
  assert.deepEqual(await channel.request('unregister', { provider: 'webPush', origin: 'https://other.example', endpoint: subscription.endpoint }), { registered: false })
  await assert.rejects(channel.request('register', { ...params, origin: 'https://other.example' }), { code: 'WEB_PUSH_SUBSCRIPTION_CONFLICT', status: 409 })
  await assert.rejects(channel.request('status', { provider: 'webPush', endpoint: subscription.endpoint }), { code: 'WEB_PUSH_INPUT_INVALID', outcome: 'not_accepted' })
  await channel.request('publish', event)
  let done = false
  const draining = channel.control('quiesce').then(value => { done = true; return value })
  await writeFile(join(root, 'release'), '')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(done, false)
  await writeFile(join(root, 'web-release'), '')
  assert.deepEqual(await draining, { quiesced: true })
  const webEvent = JSON.parse((await readFile(join(root, 'web-sent.jsonl'), 'utf8')).trim())
  assert.equal(webEvent.messageId, event.id)
  assert.equal(webEvent.schema, 'bellteam.web-push.v1')
  assert.deepEqual(await readFile(join(root, 'state/web-push-keys.json')), keyBytes)
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
})
