import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as immediate } from 'node:timers/promises'
import test from 'node:test'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

test('一つの通知factoryをHTTP/設定/会話/終了へ接続し、通知失敗で保存済み設定と会話を戻さない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notifications-assembly-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const item of [bots, settings, ownerProfile, userRules]) await item.initialize()
  let creates = 0, starts = 0, closes = 0, options, controller, rejectConfigure = false
  const requests = []
  const runtime = await createApplicationRuntime({ root, appRoot: fileURLToPath(new URL('../', import.meta.url)), home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: {}, refreshGlobalInstructions: async () => {},
      createNotificationsProcess: input => {
        creates++; options = input
        const process = createSyntheticNotificationsProcess(input)
        controller = { ...process,
          start: async () => { starts++; return process.start() },
          close: async () => { closes++; await process.close() },
          request: async (method, params) => {
            requests.push({ method, params })
            if (method === 'publish' || method === 'configure' && rejectConfigure)
              throw Object.assign(new Error('NOTIFICATIONS_UNAVAILABLE'), { code: 'NOTIFICATIONS_UNAVAILABLE', status: 503 })
            return process.request(method, params)
          },
        }
        return controller
      },
    }, client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() {} },
  })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  await runtime.start()
  assert.equal(creates, 1); assert.equal(starts, 1)
  assert.equal(runtime.services.notifications.controller, controller)
  assert.equal(requests.filter(item => item.method === 'configure').length, 0)
  const base = `http://127.0.0.1:${runtime.gateway.address.port}`
  const state = await (await fetch(base + '/api/notifications-release')).json()
  assert.deepEqual(state.notificationsRelease, controller.snapshot())
  options.onState({ phase: 'running', available: true, exchanging: false, applyError: { apns: 'PUSH_UNAVAILABLE', webPush: null }, status: null })
  assert.equal(settings.list().find(item => item.id === 'notifications').error.code, 'PUSH_UNAVAILABLE')
  rejectConfigure = true
  await assert.rejects(settings.update('notifications', { enabled: false, values: { relayUrl: 'https://relay.example' } }), { code: 'FEATURE_APPLY_FAILED' })
  assert.equal(settings.configuration('notifications').relayUrl, 'https://relay.example')
  options.onState({ phase: 'running', available: true, exchanging: false, applyError: { apns: null, webPush: null }, status: null })
  assert.equal(settings.list().find(item => item.id === 'notifications').error.code, 'NOTIFICATIONS_UNAVAILABLE')
  rejectConfigure = false
  await settings.update('notifications', { enabled: false, values: {} })
  assert.equal(settings.list().find(item => item.id === 'notifications').error, undefined)
  await runtime.services.messenger.append({ schema: 'bellteam.direct-message.v1', delivery_id: 'message-one', from: 'bot-fixture', target: 'user', message: 'private fixture body' })
  await immediate(); await immediate()
  assert.match(await readFile(join(root, 'logs/direct-messages.jsonl'), 'utf8'), /private fixture body/)
  const publish = requests.find(item => item.method === 'publish')
  assert.deepEqual(publish.params, { type: 'direct', id: 'message-one', botId: 'bot-fixture', senderName: 'メンバー' })
  assert.equal(closes, 0)
  await runtime.close()
  assert.equal(closes, 1)
})
