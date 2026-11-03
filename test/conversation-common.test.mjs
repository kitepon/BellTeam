import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

test('normal conversation parent authenticates ingress and keeps its sole writer through exchange', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-common-')), children = []
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-fixture', name: 'Fixture', harness: 'codex', session: 'bot-fixture', project: join(root, 'bots/bot-fixture') }] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() {} },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess,
      createConversationAssembly: options => createConversationAssembly({ ...options,
        prepareRelease: async versionId => ({ versionId, appRoot: `/run/bellteam-maintenance/conversation/releases/${versionId}/payload` }),
        spawnProcess: (_entry, args, options) => {
          for (const old of children) assert(old.exitCode !== null && !old.connected && old.stdout.closed && old.stderr.closed)
          const child = spawn(process.execPath, [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options)
          children.push(child); return child
        } }),
    } })
  t.after(() => runtime.close())
  for (const producer of ['scheduler', 'selfTurns', 'seatTurns', 'idleSessions']) if (runtime.services[producer]) runtime.services[producer].start = () => {}
  await runtime.start()
  const port = runtime.gateway.address.port, url = `http://127.0.0.1:${port}`
  const internal = `http://127.0.0.1:${runtime.internalServer.address().port}`
  let denied = await fetch(internal + '/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Spoof', memberIds: ['bot-fixture'], actor: { kind: 'owner' } }) })
  assert.equal(denied.status, 403)
  denied = await fetch(internal + '/api/deliveries/direct/1234/resume', { method: 'POST', headers: { 'X-Bellteam-Seat': 'bot-fixture' }, body: JSON.stringify({ target: 'bot-fixture', actor: { kind: 'owner' } }) })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error, 'CONVERSATION_METHOD_FORBIDDEN')
  let response = await fetch(url + '/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Preserved', memberIds: ['bot-fixture'] }) })
  assert.equal(response.status, 201, await response.clone().text())
  const room = (await response.json()).room
  assert.equal(runtime.services.rooms.get(room.id).name, 'Preserved')
  const saved = await readFile(join(root, 'rooms', room.id, 'room.json'))
  const record = id => ({ schema: 'bellteam.direct-message.v1', delivery_id: id, from: 'user', target: 'bot-fixture', message: 'private fixture text', at: '2026-11-04T00:00:00Z' })
  const log = Buffer.concat([Buffer.from(JSON.stringify(record('before')) + '\n'), Buffer.alloc(147), Buffer.from('\n' + JSON.stringify(record('after')) + '\n')])
  await writeFile(join(root, 'logs/direct-messages.jsonl'), log)
  response = await fetch(url + '/api/bots/bot-fixture/export')
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual((await response.json()).messages.map(row => row.id), ['before', 'after'])
  for (let n = 0; n < 100 && !(await runtime.services.diagnostics.list()).some(row => row.category === 'MESSAGE_LOG_INVALID'); n++) await new Promise(resolve => setTimeout(resolve, 5))
  const reports = (await runtime.services.diagnostics.list()).filter(row => row.category === 'MESSAGE_LOG_INVALID')
  assert.equal(reports.length, 1)
  const diagnostic = JSON.parse(reports[0].diagnostic_log)
  assert.equal(diagnostic.line, 2); assert.equal(diagnostic.length, 147); assert.equal(diagnostic.reason, 'nul')
  assert.doesNotMatch(JSON.stringify(reports), /private fixture text/)
  assert.deepEqual(await readFile(join(root, 'logs/direct-messages.jsonl')), log)
  const parent = process.pid
  await runtime.services.conversationAssembly.controller.replace('a'.repeat(64))
  response = await fetch(url + '/api/rooms/' + room.id)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json()).room.name, 'Preserved')
  await runtime.services.conversationAssembly.controller.replace('builtin')
  assert.deepEqual(await readFile(join(root, 'rooms', room.id, 'room.json')), saved)
  assert.equal(children.length, 3); assert.equal(process.pid, parent); assert.equal(runtime.gateway.address.port, port)
  await assert.rejects(runtime.services.rooms.create({ name: 'No actor', memberIds: [] }), { code: 'CONVERSATION_CONTEXT_REQUIRED' })
  await runtime.close()
})
