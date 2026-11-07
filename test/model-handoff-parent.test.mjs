import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createExecutionAssembly } from '../src/execution-assembly.mjs'
import { createExecutionFactoryLoader } from '../src/execution-loader.mjs'
import * as engine from '../src/execution-dispatcher.mjs'
import { AitermClient } from '../src/aiterm-client.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { SEAT_HEADER, LAUNCH_HEADER } from '../src/seat-mcp.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'
import { AitermGenerationClient } from '../src/aiterm-generation-client.mjs'

test('original parent MCP keeps per-call context/meta and anchor actor/actual completion on the same graph', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-parent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [
    { id: 'bot-fixture', name: 'Fixture', harness: 'codex', session: 'bot-fixture', project: join(root, 'bots/bot-fixture') },
  ] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const client = new AitermClient({ command: 'synthetic-not-launched', args: [] })
  t.mock.method(client, 'call', async () => ({ content: [{ type: 'text', text: '' }] }))
  t.mock.method(client, 'close', async () => {})
  assert.equal(typeof client.captureHandoffConnection, 'function')
  let readAnchor, conversation, firstReady, releaseFirst
  const firstStarted = new Promise(resolve => { firstReady = resolve })
  const firstWait = new Promise(resolve => { releaseFirst = resolve })
  const seen = new Map()
  t.mock.method(BotAdministration.prototype, 'configureFromMcp', async function (botId, changes, context) {
    assert.equal(botId, 'bot-fixture')
    assert.deepEqual(Object.keys(context).sort(), ['actor', 'budget', 'expectedLaunch', 'nativeCall', 'originalMcpRequestId', 'schema', 'signal', 'toolName'])
    assert.deepEqual(context.actor, { kind: 'bot', botId })
    assert.deepEqual(context.expectedLaunch, { session_id: botId, launch_id: 'a'.repeat(32) })
    assert.equal(context.schema, 'bellteam.mcp-configuration-ingress.v1')
    assert.equal(context.toolName, 'update_self'); assert.equal(context.budget, null)
    assert.ok(context.signal instanceof AbortSignal); assert.equal(context.signal.aborted, false)
    assert.equal(context.nativeCall.call_token, changes.model)
    seen.set(changes.model, context)
    if (changes.model === 'first') { firstReady(); await firstWait }
    return { value: { saved: changes.model }, handoffMetadata: { operation: { id: changes.model }, origin_digest: 'd'.repeat(64), call_token: changes.model } }
  })
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'), client,
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess,
      loadExecutionFactory: createExecutionFactoryLoader({ builtinIdentity: async () => 'f'.repeat(40), importFactory: async () => engine }),
      createExecutionAssembly: options => {
        // The native port is the generation facade; its single current generation is the original client.
        assert.ok(options.ports.native instanceof AitermGenerationClient); assert.equal(options.ports.native.current.client, client)
        options.ports.configurationStorage.ownerUid = process.getuid()
        readAnchor = options.ports.storage.deliveryAnchor
        return createExecutionAssembly(options)
      },
      createConversationAssembly: options => conversation = createConversationAssembly({ ...options,
        spawnProcess: (_entry, args, options) => spawn(process.execPath,
          [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options) }),
    } })
  t.after(() => runtime.close())
  const actor = { kind: 'bot', botId: 'bot-fixture' }, anchor = { deliveryId: 'delivery', target: 'bot-fixture', context: 'direct', contextId: 'bot-fixture' }
  const options = { actor, signal: new AbortController().signal }
  let finish, actualActor
  const attempt = Object.assign(Promise.resolve(anchor), { completion: new Promise(resolve => { finish = resolve }) })
  const originalRun = conversation.run
  t.mock.method(conversation, 'run', (actor, ...args) => { actualActor = actor; return originalRun(actor, ...args) })
  t.mock.method(conversation.facade.store, 'deliveryAnchor', (input, readOptions) => {
    assert.equal(input, anchor); assert.equal(readOptions, options); return attempt
  })
  assert.equal(readAnchor(anchor, options), attempt)
  assert.equal(actualActor, actor)
  assert.equal(await attempt, anchor)
  let completed = false
  attempt.completion.then(() => { completed = true })
  await Promise.resolve(); assert.equal(completed, false)
  finish(); await attempt.completion; assert.equal(completed, true)

  runtime.internalServer.listen(0, '127.0.0.1'); await once(runtime.internalServer, 'listening')
  const url = `http://127.0.0.1:${runtime.internalServer.address().port}/mcp`
  const request = async (id, method, params) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      [SEAT_HEADER]: 'bot-fixture', [LAUNCH_HEADER]: 'a'.repeat(32) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const initialized = await request('init', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
  assert.deepEqual(initialized.result.capabilities.experimental['ai.aiterm/handoff.v1'], { version: 1, tools: ['update_self'] })
  const call = (id, model) => request(id, 'tools/call', { name: 'update_self', arguments: { model }, _meta: { 'ai.aiterm/handoff.v1': { call_token: model } } })
  const first = call('original-string-id', 'first')
  await firstStarted
  const second = await call(73, 'second')
  releaseFirst()
  const a = await first
  assert.equal(seen.get('first').originalMcpRequestId, 'original-string-id')
  assert.equal(seen.get('second').originalMcpRequestId, 73)
  assert.notEqual(seen.get('first').signal, seen.get('second').signal)
  for (const [response, name] of [[a, 'first'], [second, 'second']]) {
    assert.deepEqual(JSON.parse(response.result.content[0].text), { saved: name })
    assert.equal(response.result._meta['ai.aiterm/handoff.v1'].call_token, name)
    assert.doesNotMatch(response.result.content[0].text, /call_token|origin_digest/)
  }
  const ordinary = await request(74, 'tools/call', { name: 'get_self', arguments: {} })
  assert.equal(ordinary.result._meta, undefined)
})
