import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { createNotificationRelay } from '../services/notifications/relay.mjs'
import { notificationPayload, PushNotifications } from '../src/push-notifications.mjs'

const device = { token: 'a'.repeat(64), environment: 'production', server: 'http://192.168.1.2:18891' }
const event = { id: 'message-a', kind: 'reply', botId: 'bot-a', title: 'メンバー', body: '返信が届きました。' }

// a540-form: the relay makes no money check; it needs only a well-formed notification for a known device.
function fixture({ send = async () => {} } = {}) {
  const pushes = []
  const provider = { environments: ['production'], send: async (...args) => { pushes.push(args); await send(...args) } }
  const relay = createNotificationRelay({ provider })
  const input = { device, payload: notificationPayload(event, device.server), id: event.id }
  return { relay, input, pushes, provider }
}

async function send(relay, input) {
  const response = await relay.fetch(new Request('https://relay.example/v1/notifications/send', { method: 'POST', body: JSON.stringify(input) }))
  return { status: response.status, body: await response.json() }
}

test('a request with no proof is sent, and a proof of an older shape is ignored, never required', async () => {
  const { relay, input, pushes } = fixture()
  assert.deepEqual(await send(relay, input), { status: 200, body: { accepted: true } })
  for (const old of [{ ticket: 'sealed.ticket' }, { signedTransaction: 'signed.transaction' }, { proof: { ticket: 'x' } }]) {
    assert.deepEqual(await send(relay, { ...input, ...old }), { status: 200, body: { accepted: true } })
  }
  assert.equal(pushes.length, 4)
  for (const [sent, payload, id] of pushes) assert.deepEqual([sent, payload, id], [device, input.payload, input.id])
})

test('APNs failures are returned without a retry and without the private text', async () => {
  for (const [code, status] of [['APNS_CONNECTION_FAILED', 502], ['APNS_UNREGISTERED', 410]]) {
    const item = fixture({ send: async () => { throw Object.assign(new Error('PRIVATE_TOKEN'), { code }) } })
    const result = await send(item.relay, item.input)
    assert.equal(result.status, status)
    assert.equal(result.body.error.code, code)
    assert.equal(item.pushes.length, 1)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'))
  }
})

test('invalid notification input is never a success', async () => {
  const { relay, input, pushes } = fixture()
  for (const patch of [{ device: { ...device, server: 'http://public.example' } }, { id: 'a'.repeat(65) }, { id: '' }, { payload: {} }]) {
    assert.equal((await send(relay, { ...input, ...patch })).status, 400)
  }
  assert.equal(pushes.length, 0)
})

test('the status check needs no configuration beyond the keys', async () => {
  const { relay } = fixture()
  const status = await relay.fetch(new Request('https://relay.example/v1/notifications/status'))
  assert.deepEqual([status.status, await status.json()], [200, { configured: true, environments: ['production'] }])
})

test('the user\'s notification entrance sends through the relay and removes a revoked device from its registry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { relay, input, pushes, provider } = fixture()
  const reports = []
  const service = new PushNotifications({ root, bots: new Map([['bot-a', { name: 'メンバー' }]]),
    diagnostics: { record: async record => reports.push(record) },
    // The server may still send its proof field (signedTransaction): the relay ignores it.
    fetch: (url, options) => relay.fetch(new Request(url, options)) })
  await service.initialize()
  await service.configure({ enabled: true, relayUrl: 'http://localhost:18920' })
  await service.register({ ...device, signedTransaction: 'ignored.by.the.relay' })
  service.secret({ id: 'request-a', botId: 'bot-a' })
  await service.close()
  assert.equal(pushes.length, 1)
  assert.equal(reports.length, 0)
  provider.send = async () => { throw Object.assign(new Error('期限切れ'), { code: 'APNS_UNREGISTERED' }) }
  service.secret({ id: 'request-b', botId: 'bot-a' })
  await service.close()
  assert.equal(service.devices.size, 0)
})

test('the Node.js entrance signs through the caller socket, answers the status check and refuses an empty request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-relay-server-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // The module's caller socket, as a stand-in: it answers every sign with a 64-byte signature.
  const socket = join(directory, 'caller.sock')
  const asked = []
  const module = createNetServer(connection => connection.on('data', chunk => { asked.push(JSON.parse(chunk.toString())); connection.end(JSON.stringify({ outcome: 'granted', data: Buffer.alloc(64, 1).toString('base64') }) + '\n') }))
  await new Promise(resolve => module.listen(socket, resolve))
  t.after(() => module.close())
  await writeFile(join(directory, 'config.json'), JSON.stringify({ teamId: 'TESTTEAM01', topic: product.bundleId,
    keys: { production: { keyId: 'TESTKEY001', sign: 'apns-test' } } }))
  const child = spawn(process.execPath, ['services/notifications/index.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', BELLTEAM_APNS_DIRECTORY: directory, BELLTEAM_AUTH_CALLER_SOCKET: socket },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
  const output = await once(child.stdout, 'data')
  const port = output[0].toString().match(/\((\d+)\)/u)?.[1]
  assert.ok(port, output[0].toString())
  const base = `http://127.0.0.1:${port}`
  const ready = await fetch(`${base}/v1/notifications/status`)
  assert.deepEqual(await ready.json(), { configured: true, environments: ['production'] })
  assert.deepEqual(asked.map(item => [item.op, item.name]), [['sign', 'apns-test']]) // one sign at start, none per status check
  const invalid = await fetch(`${base}/v1/notifications/send`, { method: 'POST', body: '{}' })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'PUSH_RELAY_REQUEST_INVALID')
  child.kill('SIGTERM')
  assert.deepEqual(await once(child, 'exit'), [0, null])
})
