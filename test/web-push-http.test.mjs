import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { createNotificationsDispatcher } from '../src/usage/notifications-dispatcher.mjs'
import { createNotifications } from '../src/usage/notifications.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'
import { respondHttpError } from '../src/http-errors.mjs'

const origin = 'https://app.example'
test('Owner HTTP connects settings, facade and both-provider dispatcher; Origin/body gates precede effects and Apple projection stays exact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const configuration = () => ({ apns: settings.configuration('notifications'), webPush: settings.configuration('webPush') })
  const reports = [], sent = []
  const dispatcher = createNotificationsDispatcher({ root, diagnostic: async value => reports.push(value),
    webPushProvider: { async send(sub, payload) { sent.push({ sub, payload }) } } })
  let options
  const notifications = createNotifications({ root, bots: new Map([['bot-a', { name: 'Alice' }]]),
    diagnostics: { async record(value) { reports.push(value) } }, configuration,
    createProcess(value) { options = value; return {
      async start() {
        const initial = await dispatcher.control('initialize', { configuration: configuration() })
        await dispatcher.control('resume', {})
        options.onState({ phase: 'running', available: true, exchanging: false, ...initial })
      },
      request(method, params) { dispatcher.validateRequest(method, params); return dispatcher.dispatch(method, params) },
      close: () => dispatcher.disconnect(),
    } },
  })
  await notifications.initialize()
  t.after(() => notifications.close())
  const features = createApplicationFeatures({ services: { bots: new Map(), settings, notifications, diagnostics: { async record() {} } },
    home: root, callBridgeHeaders: join(root, 'headers'), environment: {}, notify() {}, configureHarnessConfig: async () => {} })
  await features.initialize()
  t.after(() => features.close())
  const assertWebPushOrigin = request => {
    if (request.headers.origin !== origin) throw Object.assign(new Error('WEB_PUSH_ORIGIN_FORBIDDEN'), { code: 'WEB_PUSH_ORIGIN_FORBIDDEN', status: 403 })
    return origin
  }
  const handler = createUsageApi({ settings, notifications, assertWebPushOrigin })
  const internal = createUsageApi({ settings, notifications, internal: true, assertWebPushOrigin() { assert.fail('internal must be rejected first') } })
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const handle = req.headers['x-synthetic-internal'] ? internal : handler
    handle(req, res, url).catch(error => respondHttpError(req, res, error))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, body, method = 'POST', headers = {}) => fetch(base + path, { method,
    headers: { 'content-type': 'application/json', origin, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  let response = await call('/api/web-push/status', undefined, 'GET', { origin: '' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { enabled: false, configured: false, publicKey: null, error: null })
  await assert.rejects(readFile(join(root, 'state/web-push-keys.json')), { code: 'ENOENT' })
  for (const path of ['/api/web-push/status', '/api/web-push/subscriptions', '/api/web-push/unregister']) {
    assert.equal((await call(path, {}, 'POST', { 'x-synthetic-internal': '1' })).status, 403)
    assert.equal((await call(path, {}, 'POST', { origin: '' })).status, 403)
  }
  assert.equal((await call('/api/settings/webPush', { enabled: true }, 'PATCH', { 'x-synthetic-internal': '1' })).status, 403)
  assert.equal((await call('/api/settings/webPush', { enabled: true }, 'PATCH', { origin: '' })).status, 403)
  response = await call('/api/settings/webPush', { enabled: true, values: { subject: 'mailto:operator@example.com' } }, 'PATCH')
  assert.equal(response.status, 200)
  const status = await (await call('/api/web-push/status', undefined, 'GET')).json()
  assert.equal(status.configured, true)
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  const subscription = { endpoint: 'https://fcm.googleapis.com/synthetic', expirationTime: null,
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  const registration = { subscription, applicationServerKey: status.publicKey }
  assert.equal((await call('/api/web-push/subscriptions', { ...registration, origin: 'https://forged.example' })).status, 400)
  assert.equal((await call('/api/web-push/subscriptions', { ...registration, applicationServerKey: subscription.keys.p256dh })).status, 409)
  assert.equal((await call('/api/web-push/subscriptions', registration)).status, 200)
  assert.deepEqual(await (await call('/api/web-push/status', { endpoint: subscription.endpoint })).json(), { registered: true })
  assert.equal((await call('/api/web-push/status', { endpoint: subscription.endpoint, privateKey: 'forbidden' })).status, 400)
  assert.equal((await call('/api/web-push/status', { endpoint: subscription.endpoint }, 'POST', { 'content-type': 'text/plain' })).status, 400)
  assert.equal((await call('/api/web-push/status', { endpoint: 'x'.repeat(17000) })).status, 400)
  assert.deepEqual(await (await call('/api/notifications', undefined, 'GET')).json(), { configured: false, environments: [] })
  notifications.question({ id: 'request-1', botId: 'bot-a', question: 'PRIVATE_QUESTION' })
  await new Promise(resolve => setImmediate(resolve))
  await dispatcher.control('quiesce', {})
  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0].payload, /PRIVATE_QUESTION/u)
  assert.equal(JSON.parse(sent[0].payload).requestId, 'request-1')
  await dispatcher.control('resume', {})
  assert.deepEqual(await (await call('/api/web-push/unregister', { endpoint: subscription.endpoint })).json(), { registered: false })
  assert.doesNotMatch(JSON.stringify(reports), /fcm|synthetic|privateKey|PRIVATE_/u)
})

test('Origin rejection occurs before the first request body await', async () => {
  let read = false
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { read = true; yield Buffer.from('{}') } }
  const handler = createUsageApi({ notifications: {}, assertWebPushOrigin() {
    throw Object.assign(new Error('WEB_PUSH_ORIGIN_FORBIDDEN'), { code: 'WEB_PUSH_ORIGIN_FORBIDDEN', status: 403 })
  } })
  await assert.rejects(handler(request, {}, new URL('https://app.example/api/web-push/subscriptions')), { code: 'WEB_PUSH_ORIGIN_FORBIDDEN' })
  assert.equal(read, false)
})
