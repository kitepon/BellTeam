import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { createNotificationRelay } from '../services/notifications/relay.mjs'
import { notificationPayload, PushNotifications } from '../src/push-notifications.mjs'

const now = Date.parse('2026-11-21T12:00:00Z')
const entitlementUrl = 'https://worker.example/v1/entitlement'
const device = { token: 'a'.repeat(64), environment: 'production', server: 'http://192.168.1.2:18891' }
const event = { id: 'message-a', kind: 'reply', botId: 'bot-a', title: 'メンバー', body: '返信が届きました。' }
const PASS = 'sealed.pass.value'

// The Worker's product route, replaced by a verdict per pass: the relay reads nothing but `entitled`, `validUntil` and a 401 code.
function fixture({ verdict = { entitled: true, validUntil: new Date(now + 3600000).toISOString() }, status = 200, send = async () => {}, unreachable = false } = {}) {
  const asked = [], pushes = []
  const fetcher = async (url, init) => {
    asked.push({ url, authorization: init.headers.Authorization })
    if (unreachable) throw new Error('network')
    return Response.json(verdict, { status })
  }
  const provider = { environments: ['production'], send: async (...args) => { pushes.push(args); await send(...args) } }
  const relay = createNotificationRelay({ provider, entitlementUrl, fetcher, clock: () => now })
  const input = { pass: PASS, device, payload: notificationPayload(event, device.server), id: event.id }
  return { relay, input, pushes, asked, provider }
}

async function send(relay, input) {
  const response = await relay.fetch(new Request('https://relay.example/v1/notifications/send', { method: 'POST', body: JSON.stringify(input) }))
  return { status: response.status, body: await response.json() }
}

test('the server\'s pass is asked at the Worker and APNs is not reached before the answer', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const { relay, input, pushes, asked } = fixture({ send: async () => { entered(); await barrier } })
  let complete = false
  const result = send(relay, input).then(value => { complete = true; return value })
  await started
  assert.equal(complete, false)
  assert.deepEqual(asked, [{ url: entitlementUrl, authorization: `Bearer ${PASS}` }])
  assert.deepEqual(pushes[0], [device, input.payload, input.id])
  release()
  assert.deepEqual(await result, { status: 200, body: { accepted: true } })
})

test('no contract, an ended contract or a dead pass sends nothing to APNs', async () => {
  for (const options of [{ verdict: { entitled: false } }, { verdict: { entitled: true, validUntil: new Date(now - 1).toISOString() } }]) {
    const { relay, input, pushes } = fixture(options)
    const result = await send(relay, input)
    assert.equal(result.status, 402)
    assert.equal(result.body.error.code, 'SUBSCRIPTION_REQUIRED')
    assert.equal(pushes.length, 0)
  }
  for (const code of ['pass_invalid', 'pass_expired', 'pass_refused']) {
    const { relay, input, pushes } = fixture({ status: 401, verdict: { error: code } })
    const result = await send(relay, input)
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, code.toUpperCase())
    assert.equal(pushes.length, 0)
  }
})

test('a Worker that cannot be reached or answers badly is 502, and APNs failures are returned without a retry', async () => {
  for (const options of [{ unreachable: true }, { status: 503, verdict: { error: 'not_configured' } }, { verdict: { entitled: 'yes' } }]) {
    const { relay, input, pushes } = fixture(options)
    const result = await send(relay, input)
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'SUBSCRIPTION_CHECK_FAILED')
    assert.equal(pushes.length, 0)
  }
  for (const [code, status] of [['APNS_CONNECTION_FAILED', 502], ['APNS_UNREGISTERED', 410]]) {
    const item = fixture({ send: async () => { throw Object.assign(new Error('PRIVATE_TOKEN'), { code }) } })
    const result = await send(item.relay, item.input)
    assert.equal(result.status, status)
    assert.equal(result.body.error.code, code)
    assert.equal(item.pushes.length, 1)
    assert.equal(item.asked.length, 1)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'))
  }
})

test('an unset Worker address and invalid notification input are never a success', async () => {
  const { relay, input, pushes, provider } = fixture()
  const missing = createNotificationRelay({ provider })
  const status = await missing.fetch(new Request('https://relay.example/v1/notifications/status'))
  assert.equal(status.status, 503)
  for (const patch of [{ pass: '' }, { pass: undefined }, { signedTransaction: 'old', pass: undefined }, { device: { ...device, server: 'http://public.example' } },
    { id: 'a'.repeat(65) }, { payload: {} }]) {
    const result = await send(relay, { ...input, ...patch })
    assert.equal(result.status, 400)
  }
  assert.equal(pushes.length, 0)
})

test('the user\'s notification entrance sends through the relay and removes a revoked device from its registry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { relay, input, pushes, provider } = fixture()
  const reports = []
  const service = new PushNotifications({ root, bots: new Map([['bot-a', { name: 'メンバー' }]]),
    diagnostics: { record: async record => reports.push(record) },
    // The server still names the proof field signedTransaction; the relay's wire field is `pass` (a485-lb-server renames it).
    fetch: (url, options) => {
      if (!options.body) return relay.fetch(new Request(url, options))
      const body = JSON.parse(options.body)
      return relay.fetch(new Request(url, { ...options, body: JSON.stringify({ ...body, pass: body.signedTransaction, signedTransaction: undefined }) }))
    } })
  await service.initialize()
  await service.configure({ enabled: true, relayUrl: 'http://localhost:18920' })
  await service.register({ ...device, signedTransaction: input.pass })
  service.secret({ id: 'request-a', botId: 'bot-a' })
  await service.close()
  assert.equal(pushes.length, 1)
  assert.equal(reports.length, 0)
  provider.send = async () => { throw Object.assign(new Error('期限切れ'), { code: 'APNS_UNREGISTERED' }) }
  service.secret({ id: 'request-b', botId: 'bot-a' })
  await service.close()
  assert.equal(service.devices.size, 0)
})

test('the Node.js entrance reads the operator key, answers the status check and refuses a request with no pass', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-relay-server-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  await writeFile(join(directory, 'test.p8'), privateKey.export({ format: 'pem', type: 'pkcs8' }))
  await writeFile(join(directory, 'config.json'), JSON.stringify({ teamId: 'TESTTEAM01', topic: product.bundleId,
    keys: { production: { keyId: 'TESTKEY001', file: 'test.p8' } } }))
  const child = spawn(process.execPath, ['services/notifications/index.mjs'], {
    env: { ...process.env, BELLTEAM_ENTITLEMENT_URL: entitlementUrl, HOST: '127.0.0.1', PORT: '0', BELLTEAM_APNS_DIRECTORY: directory },
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
