import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createApplicationFeatures } from '../src/application-features.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))

test('監視開始に失敗した本体は取得済み監視と機能のsocketを解放し、元の失敗を返す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-start-failure-'))
  const home = join(root, 'home'), socketPath = join(root, 'calls.sock')
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  await settings.update('callBridge', { enabled: true,
    values: { url: 'http://127.0.0.1:9/mcp', token: 'synthetic-startup-token' } }, { allowSecretValues: true })
  let clientClosed = 0
  const runtime = await createApplicationRuntime({ root, appRoot, home,
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0', BELLTEAM_CALL_BRIDGE_SOCKET: socketPath },
    bootstrap: { bots, settings, ownerProfile, userRules,
      aiterm: { command: 'synthetic-aiterm', args: ['/synthetic/native.js', '--execution-interrupt'] },
      refreshGlobalInstructions: async () => {} },
    client: { async close() { clientClosed++ } },
  })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const failure = Object.assign(new Error('synthetic rooms watcher resource failure'), { code: 'EMFILE' })
  runtime.services.rooms.watch = async () => {
    assert.equal(runtime.services.store.listeners.size, 1)
    assert.ok((await stat(socketPath)).isSocket())
    throw failure
  }
  await assert.rejects(runtime.start(), error => error === failure)
  assert.equal(runtime.services.store.listeners.size, 0)
  assert.equal(runtime.server.listening, false)
  assert.equal(runtime.internalServer.listening, false)
  assert.equal(runtime.services.scheduler.timer, null)
  assert.equal(runtime.services.messenger.store, runtime.services.store)
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
  assert.equal(clientClosed, 1)
  await runtime.close()
  assert.equal(clientClosed, 1)
})

test('実HTTP終了のwatch例外を呼出元へ返し、後続の資源も解放して再closeで同じ結果を返す', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-watch-close-failure-'))
  const home = join(root, 'home'), socketPath = join(root, 'calls.sock')
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  await settings.update('callBridge', { enabled: true,
    values: { url: 'http://127.0.0.1:9/mcp', token: 'synthetic-close-token' } }, { allowSecretValues: true })
  let clientClosed = 0, notificationsClosed = 0, failure
  const runtime = await createApplicationRuntime({ root, appRoot, home,
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0', BELLTEAM_CALL_BRIDGE_SOCKET: socketPath },
    bootstrap: { bots, settings, ownerProfile, userRules,
      aiterm: { command: 'synthetic-aiterm', args: ['/synthetic/native.js', '--execution-interrupt'] },
      refreshGlobalInstructions: async () => {} },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientClosed++ } },
  })
  t.after(async () => { await runtime.close().catch(() => {}); await rm(root, { recursive: true, force: true }) })
  const watch = runtime.services.store.watch.bind(runtime.services.store)
  const original = new Error('synthetic real HTTP watch close failure')
  runtime.services.store.watch = async (...args) => {
    const stop = await watch(...args)
    return () => { stop(); throw original }
  }
  const closeNotifications = runtime.services.notifications.close.bind(runtime.services.notifications)
  runtime.services.notifications.close = async () => { notificationsClosed++; await closeNotifications() }
  await runtime.start()
  if (!runtime.server.listening) await once(runtime.server, 'listening')
  if (!runtime.internalServer.listening) await once(runtime.internalServer, 'listening')
  assert.ok((await stat(socketPath)).isSocket())
  const firstClose = runtime.close()
  assert.equal(runtime.close(), firstClose)
  await assert.rejects(firstClose, error => {
    failure = error
    assert.equal(error.message, 'APPLICATION_CLOSE_FAILED')
    assert.equal(error.errors[0].message, 'MESSAGE_WATCH_CLOSE_FAILED')
    return error.errors[0].errors[0] === original
  })
  assert.equal(runtime.services.store.listeners.size, 0)
  assert.equal(runtime.server.listening, false)
  assert.equal(runtime.internalServer.listening, false)
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
  assert.equal(clientClosed, 1)
  assert.equal(notificationsClosed, 1)
  assert.equal(runtime.close(), firstClose)
  await assert.rejects(runtime.close(), error => error === failure)
})

test('runtime factoryのimportだけでは本体起動・台帳作成・CLI接続をしない', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-runtime-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'not-created')
  const module = new URL('../src/application-runtime.mjs', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    const module = await import(${JSON.stringify(module)});
    assert.equal(typeof module.createApplicationRuntime, 'function');
    assert.equal(existsSync(${JSON.stringify(root)}), false);
    console.log('import-only');
  `], { env: { ...process.env, BELLTEAM_ROOT: root }, timeout: 15000 })
  assert.equal(stdout.trim(), 'import-only')
})

test('隔離した本体を組み立て、公開/内部API・設定通知・終了と保存を一緒に保つ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-application-'))
  const home = join(root, 'home')
  await mkdir(join(root, 'logs'), { recursive: true })
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root })
  const userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const socketPath = join(root, 'calls.sock')
  await settings.update('callBridge', { enabled: true, values: { url: 'http://127.0.0.1:9/mcp', token: 'synthetic-runtime-token' } }, { allowSecretValues: true })
  const calls = [], closed = []
  let refreshes = 0
  const runtime = await createApplicationRuntime({ root, appRoot, home,
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0', BELLTEAM_CALL_BRIDGE_SOCKET: socketPath },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: { command: 'synthetic-aiterm', args: ['/synthetic/native.js', '--execution-interrupt'] }, refreshGlobalInstructions: async () => { refreshes++ } },
    client: { async call(name) {
      calls.push(name)
      return { content: [{ type: 'text', text: '(セッション無し)' }], _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [] } } }
    }, async close() { closed.push('client') } },
  })
  let stopped = false
  t.after(async () => { if (!stopped) await runtime.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal(runtime.server.listening, false)
  assert.equal(runtime.internalServer.listening, false)
  assert.equal(runtime.services.scheduler.timer, null)
  assert.deepEqual(calls, [])
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
  await runtime.start()
  if (!runtime.server.listening) await once(runtime.server, 'listening')
  if (!runtime.internalServer.listening) await once(runtime.internalServer, 'listening')
  const base = `http://127.0.0.1:${runtime.server.address().port}`
  const internal = `http://127.0.0.1:${runtime.internalServer.address().port}`
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok' })
  assert.deepEqual(await (await fetch(internal + '/healthz')).json(), { status: 'ok' })
  assert.equal((await (await fetch(base + '/api/setup')).json()).phase, 'select_harness')
  assert.ok((await (await fetch(base + '/api/settings')).json()).settings.every(value => value.enabled === (value.id === 'callBridge')))
  assert.ok((await stat(socketPath)).isSocket())
  const rules = await fetch(base + '/api/user-rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'synthetic preserved rule' }) })
  assert.equal(rules.status, 200)
  assert.equal(refreshes, 1)
  const response = await fetch(base + '/api/events')
  const reader = response.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
  await settings.update('routing', { enabled: false })
  assert.match(new TextDecoder().decode((await reader.read()).value), /"featureId":"routing"/)
  for (const [value, method, name] of [
    [runtime.services.scheduler, 'stop', 'scheduler'], [runtime.services.idleSessions, 'stop', 'idle'],
    [runtime.services.selfTurns, 'stop', 'self'], [runtime.services.seatTurns, 'stop', 'seat'],
    [runtime.server, 'close', 'web'], [runtime.internalServer, 'close', 'internal'],
    [runtime.features, 'close', 'features'], [runtime.services.notifications, 'close', 'notifications'],
  ]) {
    const original = value[method].bind(value)
    value[method] = (...args) => { closed.push(name); return original(...args) }
  }
  await runtime.close(); stopped = true
  assert.deepEqual(closed, ['scheduler', 'idle', 'self', 'seat', 'web', 'internal', 'features', 'client', 'notifications'])
  assert.equal((await reader.read()).done, true)
  assert.equal(runtime.services.scheduler.timer, null)
  assert.equal(runtime.services.idleSessions.timer, null)
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
  assert.equal(await userRules.get(), 'synthetic preserved rule\n')
  assert.ok(calls.every(name => name === 'pty_list'))
})

test('追加機能は設定反映と通信資源を所有し、無効化後も設定値とCLIの他項目を保持する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-runtime-features-'))
  const home = join(root, 'home'), socketPath = join(root, 'calls.sock')
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const changes = [], errors = [], configurations = []
  const features = createApplicationFeatures({ home, callBridgeHeaders: join(root, 'auth/headers'),
    environment: { BELLTEAM_CALL_BRIDGE_SOCKET: socketPath }, aiterm: { command: 'synthetic-aiterm', args: ['/synthetic/native.js', '--execution-interrupt'] },
    services: { bots: new Map(), messenger: {}, settings, diagnostics: { async record(value) { errors.push(value) } },
      notifications: { async configure(value) { configurations.push(value) } }, transport: {} },
    notify: value => changes.push(value),
  })
  t.after(async () => { await features.close(); await rm(root, { recursive: true, force: true }) })
  await features.initialize()
  const configPath = join(home, '.claude.json')
  const baseline = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...baseline, unrelated: 'preserved', mcpServers: { ...baseline.mcpServers, custom: { command: 'synthetic-custom' } } }))
  await settings.update('callBridge', { enabled: true, values: { url: 'http://127.0.0.1:9/mcp', token: 'synthetic-only-token' } }, { allowSecretValues: true })
  assert.ok((await stat(socketPath)).isSocket())
  const members = await new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/v0/directory' }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', text => { body += text }); response.on('end', () => resolve(JSON.parse(body))) })
    req.on('error', reject); req.end()
  })
  assert.deepEqual(members, { schema: 'bellteam.call-directory.v1', members: [] })
  assert.equal(await readFile(join(root, 'auth/headers'), 'utf8'), 'Authorization: Bearer synthetic-only-token\n')
  await settings.update('callBridge', { enabled: false })
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
  assert.equal(settings.configuration('callBridge').token, 'synthetic-only-token')
  const final = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(final.unrelated, 'preserved')
  assert.deepEqual(final.mcpServers.custom, { command: 'synthetic-custom' })
  assert.equal(final.mcpServers['call-bridge'], undefined)
  assert.deepEqual(changes.map(value => value.featureId), ['callBridge', 'callBridge'])
  assert.equal(configurations.length, 1)
  assert.deepEqual(errors, [])
})

test('任意機能の起動失敗を残して他を起動し、設定保存は既存ターンの終了を待たない', { timeout: 3000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-feature-failure-'))
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const bot = { id: 'bot-synthetic', project: join(root, 'bot') }
  const records = [], notifications = [], stopped = []
  let rejectStop
  const pendingStop = new Promise((_, reject) => { rejectStop = reject })
  let configuring = 0
  const features = createApplicationFeatures({ home: join(root, 'home'),
    callBridgeHeaders: join(root, 'auth/headers'), environment: {},
    aiterm: { command: 'synthetic-aiterm', args: ['/synthetic/native.js', '--execution-interrupt'] },
    services: { bots: new Map([[bot.id, bot]]), messenger: {}, settings,
      diagnostics: { async record(value) { records.push(value) } },
      notifications: { async configure() { if (configuring++ === 0) throw Object.assign(new Error('synthetic provider failure'), { code: 'SYNTHETIC_PROVIDER_FAILURE' }) } },
      transport: { async isRunning() { return true }, stopForConfiguration(value) { stopped.push(value.id); return pendingStop } },
    }, notify: value => notifications.push(value),
  })
  t.after(async () => { await features.close(); await rm(root, { recursive: true, force: true }) })
  await features.initialize()
  assert.equal(records[0].code, 'SERVER_FEATURE_CONFIGURATION_FAILED')
  assert.equal(records[0].diagnostic_log, 'notifications')
  await settings.update('notifications', { enabled: false })
  const saved = await settings.update('callBridge', { enabled: true, values: { url: 'http://127.0.0.1:9/mcp', token: 'synthetic-token' } }, { allowSecretValues: true })
  assert.equal(saved.enabled, true)
  assert.deepEqual(stopped, [bot.id])
  assert.equal(records.length, 1)
  rejectStop(Object.assign(new Error('synthetic interruption failure'), { code: 'SYNTHETIC_INTERRUPTION' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records.at(-1).code, 'SERVER_CALL_CONFIGURATION_FAILED')
  assert.equal(records.at(-1).diagnostic_log, 'SYNTHETIC_INTERRUPTION')
  assert.equal(settings.configuration('callBridge').enabled, true)
  assert.deepEqual(notifications.map(value => value.featureId), ['notifications', 'callBridge', 'callBridge'])
})
