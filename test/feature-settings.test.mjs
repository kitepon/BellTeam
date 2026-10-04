import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeatureSettings, FeatureSettingsError } from '../src/feature-settings.mjs'
import { SecretRequests } from '../src/secret-requests.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = new FeatureSettings({ root, environment: {}, ...options })
  await settings.initialize()
  return { root, settings }
}

function errorCode(code) {
  return error => error instanceof FeatureSettingsError && error.code === code
}

test('未設定で起動でき、全機能は未設定・無効で秘密の値を返さない', async t => {
  const { settings, root } = await fixture(t)
  assert.deepEqual(settings.list().map(item => item.id), ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications'])
  for (const item of settings.list()) {
    assert.equal(item.enabled, false)
    assert.equal(item.status, 'unconfigured')
    assert.ok(item.fields.every(field => field.value === '' && !field.configured && typeof field.secret === 'boolean'))
  }
  assert.equal((await stat(join(root, 'shared/tools/bellteam-settings/settings.json'))).mode & 0o777, 0o600)
  await assert.rejects(settings.update('routing', { enabled: true }), errorCode('FEATURE_UNCONFIGURED'))
})

test('既存envと通話Bearer値を初回だけ取り込み、保存後はenvで上書きしない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-settings-env-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'shared/tools/call-bridge'), { recursive: true })
  await writeFile(join(root, 'shared/tools/call-bridge/headers'), 'Authorization: Bearer bridge-secret\n')
  const environment = {
    TYPESAFE_API_KEY: 'routing-secret', BELLTEAM_CALL_BRIDGE_MCP_URL: 'http://localhost:18910/mcp',
    BELLTEAM_CF_TEAM_DOMAIN: 'example.cloudflareaccess.com', BELLTEAM_CF_AUD: 'test-audience',
    BELLTEAM_BUGHUB_KEY: 'diagnostic-secret',
  }
  const settings = new FeatureSettings({ root, environment })
  await settings.initialize()
  assert.deepEqual(settings.list().map(item => item.status), ['enabled', 'enabled', 'enabled', 'enabled', 'unconfigured'])
  assert.deepEqual(settings.configuration('callBridge'), { enabled: true, url: environment.BELLTEAM_CALL_BRIDGE_MCP_URL, token: 'bridge-secret' })
  assert.equal(settings.configuration('cloudflare').publicUrl, '')
  const visible = JSON.stringify(settings.list())
  for (const value of ['routing-secret', 'bridge-secret', 'diagnostic-secret']) assert.ok(!visible.includes(value))
  await settings.update('routing', { enabled: false })
  await writeFile(join(root, 'shared/tools/call-bridge/headers'), 'Authorization: Bearer replacement\n')
  const restored = new FeatureSettings({ root, environment: { ...environment, TYPESAFE_API_KEY: 'replacement' } })
  await restored.initialize()
  assert.equal(restored.configuration('routing').apiKey, 'routing-secret')
  assert.equal(restored.configuration('routing').enabled, false)
  assert.equal(restored.configuration('callBridge').token, 'bridge-secret')
})

test('設定不足の機能は移行後も無効になり、既存の値は保持する', async t => {
  const { settings } = await fixture(t, { environment: {
    BELLTEAM_CALL_BRIDGE_MCP_URL: 'http://localhost:18910/mcp', BELLTEAM_CF_TEAM_DOMAIN: 'example.cloudflareaccess.com',
  } })
  assert.equal(settings.configuration('callBridge').url, 'http://localhost:18910/mcp')
  assert.equal(settings.configuration('callBridge').enabled, false)
  assert.equal(settings.configuration('cloudflare').enabled, false)
})

test('秘密の登録・無効化・読戻しとUIからの明示削除を扱う', async t => {
  const { settings, root } = await fixture(t)
  const enabled = await settings.update('routing', { enabled: true, values: { apiKey: '  routing-secret  ' } }, { allowSecretValues: true })
  assert.equal(enabled.status, 'enabled')
  assert.deepEqual(enabled.fields[0], { key: 'apiKey', label: 'TypeSafe APIキー', secret: true, value: '', configured: true })
  assert.equal((await settings.update('routing', { enabled: false })).status, 'disabled')
  const restored = new FeatureSettings({ root, environment: {} })
  await restored.initialize()
  assert.deepEqual(restored.configuration('routing'), { enabled: false, apiKey: '  routing-secret  ' })
  const configuration = restored.configuration('routing')
  configuration.apiKey = '外部で変更'
  assert.equal(restored.configuration('routing').apiKey, '  routing-secret  ')
  const deleted = await restored.update('routing', { values: { apiKey: '' } }, { allowSecretValues: true })
  assert.equal(deleted.status, 'unconfigured')
  assert.equal(deleted.fields[0].configured, false)
  assert.equal((await stat(join(root, 'shared/tools/bellteam-settings/settings.json'))).mode & 0o777, 0o600)
})

test('既存SecretRequestsの提出値を依頼Botと登録先を照合して取り込む', async t => {
  const { settings, root } = await fixture(t)
  const secrets = new SecretRequests({ root, bots: new Map([['bot-a', {}]]), rooms: new Map(), notify: () => {} })
  await secrets.initialize()
  const request = await secrets.create({ botId: 'bot-a', toolId: 'bellteam-settings', label: 'APIキー', message: '入力してください。' })
  await assert.rejects(settings.update('routing', { enabled: true, secretRequestId: request.id }, { secretRequests: secrets, botId: 'bot-a' }), errorCode('FEATURE_SECRET_REQUEST_INVALID'))
  const submitted = await secrets.submit(request.id, 'submitted-secret')
  const result = await settings.update('routing', { enabled: true, secretRequestId: request.id }, { secretRequests: secrets, botId: 'bot-a' })
  assert.equal(settings.configuration('routing').apiKey, 'submitted-secret')
  assert.equal(result.status, 'enabled')
  const visible = JSON.stringify(result)
  for (const value of ['submitted-secret', submitted.path, request.id]) assert.ok(!visible.includes(value))
  await assert.rejects(settings.update('diagnostics', { secretRequestId: request.id }, { secretRequests: secrets, botId: 'bot-b' }), errorCode('FEATURE_SECRET_REQUEST_INVALID'))
  const other = await secrets.create({ botId: 'bot-a', toolId: 'another-tool', label: 'APIキー', message: '入力してください。' })
  await secrets.submit(other.id, 'wrong-tool-secret')
  await assert.rejects(settings.update('diagnostics', { secretRequestId: other.id }, { secretRequests: secrets, botId: 'bot-a' }), errorCode('FEATURE_SECRET_REQUEST_INVALID'))
  await assert.rejects(settings.update('notifications', { secretRequestId: request.id }, { secretRequests: secrets, botId: 'bot-a' }), errorCode('FEATURE_SECRET_REQUEST_INVALID'))
})

test('MCPからの秘密の生値・消去と二重の秘密指定を拒否する', async t => {
  const { settings } = await fixture(t)
  for (const apiKey of ['direct-secret', '']) {
    await assert.rejects(settings.update('routing', { values: { apiKey } }), errorCode('FEATURE_SECRET_VALUE_FORBIDDEN'))
  }
  await assert.rejects(settings.update('routing', { values: { apiKey: 'direct-secret' }, secretRequestId: 'request' }, { allowSecretValues: true, botId: 'bot-a', secretRequests: { get: () => {} } }), errorCode('FEATURE_SECRET_REQUEST_INVALID'))
})

test('外部入力の未知項目・形式・URL・ドメインをtyped errorで拒否する', async t => {
  const { settings } = await fixture(t)
  assert.throws(() => settings.configuration('unknown'), errorCode('FEATURE_NOT_FOUND'))
  await assert.rejects(settings.update('unknown', {}), errorCode('FEATURE_NOT_FOUND'))
  for (const input of [null, [], { unknown: true }, { enabled: 'yes' }, { values: null }, { values: [] }, { values: { unknown: 'x' } }]) {
    await assert.rejects(settings.update('cloudflare', input), errorCode('FEATURE_INPUT_INVALID'))
  }
  for (const values of [{ audience: 12 }, { audience: 'a\0b' }, { publicUrl: 'not-url' }, { publicUrl: 'file:///tmp/example' }, { teamDomain: 'https://example.com' }, { teamDomain: 'example.com/path' }]) {
    await assert.rejects(settings.update('cloudflare', { values }), errorCode('FEATURE_VALUE_INVALID'))
  }
  await settings.update('cloudflare', { enabled: true, values: { teamDomain: 'example.cloudflareaccess.com', audience: 'audience' } })
  await assert.rejects(settings.update('cloudflare', { values: { audience: '' } }), errorCode('FEATURE_UNCONFIGURED'))
  assert.equal(settings.configuration('cloudflare').audience, 'audience')
  await settings.update('notifications', { enabled: true, values: { relayUrl: 'https://relay.example.com' } })
  assert.equal(settings.list().find(item => item.id === 'notifications').status, 'enabled')
})

test('変更の保存と反映を直列に実行し、反映が終わるまで成功を返さない', async t => {
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const applied = []
  const { settings, root } = await fixture(t, { onChange: async (id, values) => {
    applied.push({ id, values })
    if (applied.length === 1) { entered(); await barrier }
  } })
  let firstCompleted = false
  const first = settings.update('notifications', { enabled: true, values: { relayUrl: 'https://relay.example.com' } }).then(value => { firstCompleted = true; return value })
  await started
  const second = settings.update('cloudflare', { enabled: true, values: { teamDomain: 'example.cloudflareaccess.com', audience: 'audience' } })
  assert.equal(firstCompleted, false)
  assert.equal(applied.length, 1)
  const saved = JSON.parse(await readFile(join(root, 'shared/tools/bellteam-settings/settings.json'), 'utf8'))
  assert.equal(saved.notifications.enabled, true)
  assert.equal(saved.cloudflare.enabled, false)
  release()
  await Promise.all([first, second])
  assert.deepEqual(applied.map(item => item.id), ['notifications', 'cloudflare'])
  assert.equal(applied[0].values.relayUrl, 'https://relay.example.com')
})

test('反映失敗は原因を保持して報告し、保存済み状態と次の変更を扱える', async t => {
  const cause = Object.assign(new Error('内部の詳細'), { code: 'RELAY_CONNECTION_FAILED' })
  let failure = true
  const { settings, root } = await fixture(t, { onChange: async () => { if (failure) throw cause } })
  await assert.rejects(settings.update('notifications', { enabled: true, values: { relayUrl: 'https://relay.example.com' } }), error => {
    assert.equal(error.code, 'FEATURE_APPLY_FAILED')
    assert.equal(error.status, 500)
    assert.equal(error.cause, cause)
    assert.ok(!error.message.includes(cause.message))
    return true
  })
  assert.equal(settings.configuration('notifications').enabled, true)
  const failed = settings.list().find(item => item.id === 'notifications')
  assert.equal(failed.error.code, 'RELAY_CONNECTION_FAILED')
  assert.ok(!JSON.stringify(failed).includes(cause.message))
  const restored = new FeatureSettings({ root, environment: {} })
  await restored.initialize()
  assert.equal(restored.configuration('notifications').enabled, true)
  failure = false
  assert.equal((await settings.update('notifications', { enabled: false })).status, 'disabled')
  assert.equal(settings.list().find(item => item.id === 'notifications').error, undefined)
})

test('破損した保存設定と不正な移行入力を隠さずエラーにする', async t => {
  const { root, settings } = await fixture(t)
  await writeFile(settings.path, '{invalid-json')
  await assert.rejects(new FeatureSettings({ root, environment: { TYPESAFE_API_KEY: 'ignored' } }).initialize(), errorCode('FEATURE_SETTINGS_INVALID'))
  const separate = await mkdtemp(join(tmpdir(), 'bellteam-settings-invalid-'))
  t.after(() => rm(separate, { recursive: true, force: true }))
  await assert.rejects(new FeatureSettings({ root: separate, environment: { BELLTEAM_CALL_BRIDGE_MCP_URL: 'invalid-url' } }).initialize(), errorCode('FEATURE_VALUE_INVALID'))
  await mkdir(join(separate, 'shared/tools/call-bridge'), { recursive: true })
  await writeFile(join(separate, 'shared/tools/call-bridge/headers'), 'invalid-header')
  await assert.rejects(new FeatureSettings({ root: separate, environment: {} }).initialize(), errorCode('FEATURE_VALUE_INVALID'))
})

test('旧APNs設定は初回だけ通知ONへ移行し、OFF保存を再起動でも保持する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-settings-apns-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'shared/tools/apns'), { recursive: true })
  // 設定の読み取りと鍵の診断はPushNotificationsが行う。
  await writeFile(join(root, 'shared/tools/apns/config.json'), '{legacy-config}')
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  assert.deepEqual(settings.configuration('notifications'), { enabled: true, relayUrl: '' })
  assert.equal(settings.list().find(item => item.id === 'notifications').status, 'enabled')
  await settings.update('notifications', { enabled: false })
  const restored = new FeatureSettings({ root, environment: {} })
  await restored.initialize()
  assert.deepEqual(restored.configuration('notifications'), { enabled: false, relayUrl: '' })
  assert.equal(restored.list().find(item => item.id === 'notifications').status, 'disabled')
  assert.equal((await restored.update('notifications', { enabled: true })).status, 'enabled')
})

test('通知relayURLは登録する接続先と同じHTTPS・LAN HTTP契約を使う', async t => {
  const { settings } = await fixture(t)
  for (const relayUrl of ['https://relay.example', 'http://192.168.1.2:18920', 'http://[::1]:18920']) {
    await settings.update('notifications', { enabled: true, values: { relayUrl } })
    assert.equal(settings.configuration('notifications').relayUrl, relayUrl)
  }
  for (const relayUrl of ['http://relay.example', 'https://relay.example/path', 'https://user:secret@relay.example']) {
    await assert.rejects(settings.update('notifications', { values: { relayUrl } }), errorCode('FEATURE_VALUE_INVALID'))
  }
  await assert.rejects(settings.update('notifications', { values: { relayUrl: '' } }), errorCode('FEATURE_UNCONFIGURED'))
})
