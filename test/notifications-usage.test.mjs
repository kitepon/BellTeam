import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import test from 'node:test'
import { createNotifications } from '../src/usage/notifications.mjs'
import { createNotificationsDispatcher, validateNotificationRequest } from '../src/usage/notifications-dispatcher.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'
import { respondHttpError } from '../src/http-errors.mjs'

const device = { token: 'a'.repeat(64), environment: 'production', server: 'https://bellteam.example', signedTransaction: 'PRIVATE_TRANSACTION' }
const event = { type: 'direct', id: 'existing-id', botId: 'bot-a', senderName: 'メンバー' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture(t, { provider, configuration = { enabled: true, relayUrl: '' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'notifications-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sent = [], reports = []
  provider ??= { environments: ['production'], async send(...args) { sent.push(args) }, close() {} }
  const dispatcher = createNotificationsDispatcher({ root, provider, diagnostic: async report => { reports.push(report) } })
  const initial = await dispatcher.control('initialize', { configuration })
  await dispatcher.control('resume', {})
  t.after(() => dispatcher.disconnect())
  const request = (method, params) => { dispatcher.validateRequest(method, params); return dispatcher.dispatch(method, params) }
  return { root, dispatcher, request, sent, reports, initial, provider }
}

function facadeFixture({ request = async () => ({ accepted: true }) } = {}) {
  const reports = [], sent = [], bots = new Map([['bot-a', { name: 'ミカ' }]])
  let options
  const controller = { start: async () => {}, close: async () => {},
    request(method, params) { sent.push({ method, params }); return request(method, params) } }
  const service = createNotifications({ root: 'unused', bots, diagnostics: { async record(report) { reports.push(report) } },
    configuration: () => ({}), createProcess(value) { options = value; return controller } })
  const state = value => options.onState({ phase: 'running', exchanging: false, available: true,
    status: { configured: true, environments: ['production'] }, applyError: null, ...value })
  state({})
  return { service, sent, reports, state, controller }
}

test('親の4callbackは既filterと名前を保ち、秘密や本文を子へ渡さない', async () => {
  const { service, sent } = facadeFixture()
  for (const record of [{ schema: 'bellteam.interim-word.v1' },
    { schema: 'bellteam.direct-message.v1', target: 'bot-a', from: 'bot-b' },
    { schema: 'bellteam.direct-message.v1', target: 'user', from: 'scheduler' }]) service.direct(record)
  service.direct({ schema: 'bellteam.direct-message.v1', target: 'user', from: 'bot-a', delivery_id: 'direct-id', message: 'PRIVATE_BODY', ownerGuide: { url: 'PRIVATE_URL' } })
  service.room({ id: 'room-message', sender: { id: 'bot-a', name: '保存名' }, room: { id: 'room-a', name: '相談室' }, message: 'PRIVATE_BODY' })
  service.secret({ id: 'secret-id', botId: 'missing', roomId: 'room-a', label: 'PRIVATE_LABEL', path: 'PRIVATE_PATH', value: 'PRIVATE_VALUE' })
  service.question({ id: 'question-id', botId: 'bot-a', roomId: 'not-forwarded', question: 'PRIVATE_QUESTION', options: ['PRIVATE_OPTION'] })
  assert.deepEqual(sent.map(item => item.params), [
    { ...event, id: 'direct-id', senderName: 'ミカ' },
    { type: 'room', id: 'room-message', botId: 'bot-a', senderName: '保存名', roomId: 'room-a', roomName: '相談室' },
    { type: 'secret', id: 'secret-id', botId: 'missing', senderName: 'メンバー', roomId: 'room-a' },
    { type: 'question', id: 'question-id', botId: 'bot-a', senderName: 'ミカ' },
  ])
  assert(!JSON.stringify(sent).includes('PRIVATE_'))
})

test('閉じたDTOは未知field・制御文字・不正端末・64KiB超過を拒否する', () => {
  for (const value of [{ ...event, body: 'secret' }, { ...event, id: 'bad\nname' }, { ...event, senderName: ' ' },
    { ...event, type: 'question', roomId: 'room' }, { ...event, senderName: 'x'.repeat(65536) }]) {
    assert.throws(() => validateNotificationRequest('publish', value), /PUSH_INPUT_INVALID/)
  }
  assert.throws(() => validateNotificationRequest('status', { token: device.token }), /PUSH_INPUT_INVALID/)
  assert.throws(() => validateNotificationRequest('register', { ...device, previousToken: 'invalid' }), /PUSH_DEVICE_INVALID/)
  assert.throws(() => validateNotificationRequest('delete', {}), /PUSH_INPUT_INVALID/)
})

test('子は4unionを固定payloadへ変換し、失効端末の保存までquiesceで待つ', async t => {
  const { request, dispatcher, sent, provider, root } = await fixture(t)
  await request('register', device)
  for (const value of [event, { ...event, type: 'room', roomId: 'room-a', roomName: '相談室' },
    { ...event, type: 'secret', roomId: null }, { ...event, type: 'question' }]) {
    assert.deepEqual(await request('publish', value), { accepted: true })
  }
  await dispatcher.control('quiesce', {})
  assert.deepEqual(sent.map(item => item[1].bellteam.kind), ['reply', 'reply', 'secret_request', 'owner_question'])
  assert.equal(sent[1][1].aps.alert.title, 'メンバー · 相談室')
  assert(!JSON.stringify(sent.map(item => item[1])).includes('PRIVATE_'))
  await dispatcher.control('resume', {})
  provider.send = async () => { throw Object.assign(new Error('PRIVATE_PROVIDER'), { code: 'APNS_UNREGISTERED' }) }
  await request('publish', event)
  await dispatcher.control('quiesce', {})
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state/push-devices.json'), 'utf8')), [])
})

test('送信中quiesceは待ち、resume後の遅いquiesce完了で受付を再停止しない', async t => {
  const pending = deferred(), entered = deferred()
  const { request, dispatcher } = await fixture(t, { provider: { environments: ['production'],
    async send() { entered.resolve(); await pending.promise }, close() {} } })
  await request('register', device)
  await request('publish', event)
  await entered.promise
  let finished = false
  const quiescing = dispatcher.control('quiesce', {}).then(value => { finished = true; return value })
  await tick()
  assert.equal(finished, false)
  assert.throws(() => dispatcher.validateRequest('status', {}), /PUSH_UNAVAILABLE/)
  assert.deepEqual(await dispatcher.control('resume', {}), { resumed: true })
  assert.doesNotThrow(() => dispatcher.validateRequest('status', {}))
  pending.resolve()
  assert.deepEqual(await quiescing, { quiesced: false })
  assert.doesNotThrow(() => dispatcher.validateRequest('status', {}))
})

test('登録保存完了を返し、旧版と同じ端末形式で再読取できる', async t => {
  const { request, root, dispatcher, provider } = await fixture(t)
  const replacement = { ...device, token: 'b'.repeat(64), previousToken: device.token }
  await request('register', device)
  await request('register', replacement)
  const saved = JSON.parse(await readFile(join(root, 'state/push-devices.json'), 'utf8'))
  assert.deepEqual(saved, [{ ...device, token: replacement.token }])
  await dispatcher.control('quiesce', {})
  await dispatcher.control('exit', {})
  const restored = createNotificationsDispatcher({ root, provider, diagnostic: async () => {} })
  await restored.control('initialize', { configuration: { enabled: true, relayUrl: '' } })
  await restored.control('resume', {})
  restored.validateRequest('unregister', { token: replacement.token })
  await restored.dispatch('unregister', { token: replacement.token })
  await restored.disconnect()
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state/push-devices.json'), 'utf8')), [])
})

test('保存失敗は成功を返さず、診断失敗も送信再試行へ変えない', async t => {
  const { root, request, dispatcher, provider, reports } = await fixture(t)
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'state/push-devices.json.tmp'))
  await assert.rejects(request('register', device))
  await dispatcher.control('quiesce', {})
  await rm(join(root, 'state/push-devices.json.tmp'), { recursive: true })
  await dispatcher.control('resume', {})
  await request('register', device)
  let sends = 0
  provider.send = async () => { sends++; throw Object.assign(new Error('PRIVATE'), { code: 'APNS_TIMEOUT' }) }
  await request('publish', event)
  await dispatcher.control('quiesce', {})
  assert.equal(sends, 1)
  assert.equal(reports.at(-1).diagnostic_log, 'APNS_TIMEOUT')
  assert(!JSON.stringify(reports).includes('PRIVATE'))
})

test('disabledと設定適用失敗はready statusへ、破損stateと不正鍵は初期化失敗', async t => {
  const off = await fixture(t, { configuration: { enabled: false, relayUrl: '' } })
  assert.deepEqual(off.initial, { status: { configured: false, environments: [] }, applyError: null })
  const invalid = await fixture(t, { configuration: { enabled: true, relayUrl: 'invalid-url' } })
  assert.equal(invalid.initial.applyError, 'PUSH_RELAY_URL_INVALID')
  assert.equal(invalid.initial.status.configured, false)
  assert.equal(invalid.reports.at(-1).code, 'SERVER_PUSH_UNAVAILABLE')
  const root = await mkdtemp(join(tmpdir(), 'notifications-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'))
  for (const text of ['{}', '[{"token":"bad"}]']) {
    await writeFile(join(root, 'state/push-devices.json'), text)
    const service = createNotificationsDispatcher({ root, diagnostic: async () => {} })
    await assert.rejects(service.control('initialize', { configuration: { enabled: false, relayUrl: '' } }), /PUSH_STATE_INVALID/)
    assert.equal(await readFile(join(root, 'state/push-devices.json'), 'utf8'), text)
  }
  await mkdir(join(root, 'shared/tools/apns'), { recursive: true })
  await writeFile(join(root, 'shared/tools/apns/config.json'), '{}')
  const service = createNotificationsDispatcher({ root, diagnostic: async () => {} })
  await assert.rejects(service.control('initialize', { configuration: { enabled: false, relayUrl: '' } }), /APNS_CONFIG_INVALID/)
})

test('親bufferは交換中の未送信256件までで、ACK不明イベントを再送しない', async () => {
  const { service, sent, reports, state } = facadeFixture({ request: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'PUSH_IPC_DISCONNECTED' }) } })
  service.question({ id: 'unknown-once', botId: 'bot-a' })
  state({ phase: 'quiescing', exchanging: true, available: false })
  for (let i = 0; i < 257; i++) service.question({ id: `unsent-${i}`, botId: 'bot-a' })
  assert.equal(sent.length, 1)
  state({})
  await tick()
  assert.equal(sent.length, 257)
  assert.equal(sent.filter(item => item.params.id === 'unknown-once').length, 1)
  assert.equal(reports.filter(item => item.diagnostic_log === 'PUSH_UPDATE_BUFFER_FULL').length, 1)
  assert(!JSON.stringify(reports).includes('PRIVATE'))
  state({})
  assert.equal(sent.length, 257)
})

test('親bufferの合計1MiB制限と利用不能時のcallback自己回収', async () => {
  const { service, sent, reports, state } = facadeFixture()
  state({ phase: 'quiescing', exchanging: true, available: false })
  for (let i = 0; i < 200; i++) service.room({ id: `id-${i}`, sender: { id: 'bot-a', name: 'x'.repeat(8000) }, room: { id: 'r', name: 'room' } })
  state({})
  assert(sent.length > 0 && sent.length < 200)
  assert(sent.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.params)), 0) <= 1048576)
  state({ phase: 'unavailable', available: false })
  assert.doesNotThrow(() => { service.question({ id: 'unavailable', botId: 'bot-a' }); service.room(null) })
  await tick()
  assert(reports.some(item => item.diagnostic_log === 'PUSH_UPDATE_BUFFER_FULL'))
  assert(reports.some(item => item.diagnostic_log === 'PUSH_UNAVAILABLE'))
})

test('HTTP statusは非同期結果を返し、初回featuresは既適用結果を確認する', async t => {
  const status = { configured: false, environments: [] }
  const handler = createUsageApi({ notifications: { async status() { await tick(); return status } } })
  const server = createServer((request, response) => handler(request, response, new URL(request.url, 'http://localhost')))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/api/notifications`)).json(), status)
  let initialCalls = 0, configureCalls = 0
  const settings = { configuration: () => ({ enabled: false }), setError() {} }
  const features = createApplicationFeatures({ services: { bots: new Map(), settings, diagnostics: { async record() {} }, notifications: {
    async initialStatus() { initialCalls++; return status }, async configure() { configureCalls++ },
  } }, aiterm: {}, home: 'unused', callBridgeHeaders: 'unused', environment: {}, notify: () => {}, configureHarnessConfig: async () => {} })
  await features.initialize()
  assert.equal(initialCalls, 1)
  assert.equal(configureCalls, 0)
  await settings.onChange('notifications', { enabled: false, relayUrl: '' })
  assert.equal(configureCalls, 1)
  await features.close()
})

test('IPCのtyped端末エラーでも既公開HTTPの400/503とbodyを維持する', async t => {
  let code = 'PUSH_DEVICE_INVALID'
  const { service } = facadeFixture({ request: async () => { throw Object.assign(new Error(code), { code, status: 503, outcome: 'not_accepted' }) } })
  const handler = createUsageApi({ notifications: service })
  const server = createServer((request, response) => {
    handler(request, response, new URL(request.url, 'http://localhost')).catch(error => respondHttpError(request, response, error))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  for (const [next, status] of [['PUSH_DEVICE_INVALID', 400], ['PUSH_NOT_CONFIGURED', 503], ['PUSH_ENVIRONMENT_UNAVAILABLE', 503]]) {
    code = next
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(device),
    })
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: code })
  }
})
