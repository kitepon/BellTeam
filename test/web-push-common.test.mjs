import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createNotificationsDispatcher } from '../src/usage/notifications-dispatcher.mjs'

test('common server injects saved Origin after Owner authentication and rejects internal/body claims before provider effects', async t => {
  let publicUrl = 'https://owner.example/path'
  const effects = []
  const notifications = { webStatus: async (...args) => { effects.push(args); return { registered: false } } }
  const options = { bots: new Map(), transport: {}, messenger: {}, store: {}, notifications,
    settings: { configuration: () => ({ publicUrl }) }, writeLog() {},
    authorize: request => request.headers.authorization === 'Bearer synthetic-owner' }
  const server = createBellTeamServer(options)
  const internal = createBellTeamServer({ ...options, internal: true })
  for (const item of [server, internal]) {
    await new Promise(resolve => item.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => { item.closeAllConnections(); item.close(resolve) }))
  }
  const call = (item, headers = {}, body = { endpoint: 'https://fcm.googleapis.com/synthetic' }) => fetch(`http://127.0.0.1:${item.address().port}/api/web-push/status`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-owner', origin: 'https://owner.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  assert.equal((await call(server, { authorization: '' })).status, 401)
  assert.equal((await call(internal)).status, 403)
  assert.equal((await call(server, { origin: 'https://forged.example' })).status, 403)
  assert.equal((await call(server, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await call(server, {}, { endpoint: 'https://fcm.googleapis.com/synthetic', origin: 'https://owner.example' })).status, 400)
  assert.equal(effects.length, 0)
  assert.equal((await call(server, { host: 'forged.example', 'x-forwarded-host': 'forged.example' })).status, 200)
  assert.deepEqual(effects, [['https://fcm.googleapis.com/synthetic', 'https://owner.example']])
  publicUrl = 'https://changed.example'
  assert.equal((await call(server)).status, 403)
  assert.equal((await call(server, { origin: 'https://changed.example' })).status, 200)
  assert.equal(effects[1][1], 'https://changed.example')
  publicUrl = ''
  assert.equal((await call(server)).status, 503)
})

test('one assembly binds both saved configurations and sticky provider errors to the existing settings and HTTP facade', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-common-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const item of [bots, settings, ownerProfile, userRules]) await item.initialize()
  let options, creates = 0, closes = 0
  const runtime = await createApplicationRuntime({ root, appRoot: fileURLToPath(new URL('../', import.meta.url)), home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: {}, refreshGlobalInstructions: async () => {},
      createNotificationsProcess: input => {
        creates++; options = input
        const dispatcher = createNotificationsDispatcher({ root, diagnostic: async () => {} })
        let state
        return {
          async start() { state = { phase: 'running', available: true, exchanging: false,
            ...await dispatcher.control('initialize', { configuration: input.configuration() }) }; await dispatcher.control('resume', {}); input.onState(state) },
          snapshot: () => state,
          request(method, params) { dispatcher.validateRequest(method, params); return dispatcher.dispatch(method, params) },
          async close() { closes++; await dispatcher.disconnect() },
        }
      },
    }, client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() {} },
  })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal(creates, 1)
  assert.deepEqual(options.configuration(), { apns: settings.configuration('notifications'), webPush: settings.configuration('webPush') })
  await runtime.start()
  options.onState({ phase: 'running', available: true, exchanging: false, applyError: { apns: 'PUSH_UNAVAILABLE', webPush: 'WEB_PUSH_STATE_INVALID' }, status: null })
  const error = id => settings.list().find(item => item.id === id).error?.code
  assert.equal(error('notifications'), 'PUSH_UNAVAILABLE')
  assert.equal(error('webPush'), 'WEB_PUSH_STATE_INVALID')
  options.onState({ phase: 'running', available: true, exchanging: false, applyError: { apns: null, webPush: null }, status: null, configurationEpoch: 2, appliedEpoch: 2 })
  assert.equal(error('notifications'), 'PUSH_UNAVAILABLE')
  assert.equal(error('webPush'), 'WEB_PUSH_STATE_INVALID')
  await settings.update('webPush', { enabled: false, values: {} })
  assert.equal(error('webPush'), undefined)
  assert.equal(error('notifications'), 'PUSH_UNAVAILABLE')
  const base = `http://127.0.0.1:${runtime.gateway.address.port}`
  const status = await (await fetch(base + '/api/web-push/status')).json()
  assert.deepEqual(status, { enabled: false, configured: false, publicKey: null, error: null })
  assert.deepEqual(await (await fetch(base + '/api/notifications')).json(), { configured: false, environments: [] })
  const features = await (await fetch(base + '/api/settings')).json()
  assert.equal(features.settings.find(item => item.id === 'webPush').enabled, false)
  await runtime.close()
  assert.equal(closes, 1)
})
