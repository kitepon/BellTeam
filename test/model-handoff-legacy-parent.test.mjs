import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createExecutionAssembly } from '../src/execution-assembly.mjs'
import { createExecutionFactoryLoader } from '../src/execution-loader.mjs'
import * as current from '../src/execution-dispatcher.mjs'
import { AitermClient } from '../src/aiterm-client.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { SEAT_HEADER, LAUNCH_HEADER } from '../src/seat-mcp.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

const oldId = '1'.repeat(64), brokenId = '2'.repeat(64), sourceCommit = 'b'.repeat(40)
const platform = { os: process.platform, arch: ({ x64: 'amd64', arm64: 'arm64' })[process.arch] }
const descriptor = versionId => ({ versionId, sourceCommit, appRoot: `/run/bellteam-maintenance/execution/releases/${versionId}/payload`,
  protocolVersion: 1, platform, stateCompatibility: current.EXECUTION_STATE_COMPATIBILITY })

test('loader reports the selected namespace capability without borrowing builtin support', async () => {
  let imports = 0, constructed = 0
  const factory = () => { constructed++ }
  const builtin = { ...current, createExecutionDispatcher: factory }
  const legacy = { EXECUTION_STATE_COMPATIBILITY: current.EXECUTION_STATE_COMPATIBILITY, createExecutionDispatcher: factory }
  const load = createExecutionFactoryLoader({ builtinIdentity: async () => sourceCommit, prepareRelease: async id => descriptor(id),
    importFactory: async () => ++imports === 1 ? builtin : legacy })
  assert.equal((await load(oldId)).supportsModelHandoff, false)
  const native = createExecutionFactoryLoader({ builtinIdentity: async () => sourceCommit, importFactory: async () => builtin })
  assert.equal((await native()).supportsModelHandoff, true)
  assert.equal(constructed, 0)
})

test('parent starts with closed legacy storage, follows exchanges and rejects a stale MCP generation before issuance', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-handoff-parent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [
    { id: 'bot-fixture', name: 'Fixture', harness: 'codex', session: 'bot-fixture', project: join(root, 'bots/bot-fixture') },
  ] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const v of [bots, settings, ownerProfile, userRules]) await v.initialize()
  const client = new AitermClient({ command: 'synthetic-not-launched', args: [] })
  t.mock.method(client, 'call', async () => ({ content: [{ type: 'text', text: '' }] }))
  t.mock.method(client, 'close', async () => {})
  let oldConstructs = 0, newConstructs = 0, normalCalls = 0, handoffCalls = 0, storageFunctions, anchor, conversation
  const legacy = { EXECUTION_STATE_COMPATIBILITY: current.EXECUTION_STATE_COMPATIBILITY,
    createExecutionDispatcher: input => {
      oldConstructs++
      assert.deepEqual(Object.keys(input.ports.storage).sort(), ['prepareStartup','updateFastMode','updateSession'])
      const functions = Object.values(input.ports.storage)
      if (!storageFunctions) storageFunctions = functions
      else assert.deepEqual(functions, storageFunctions)
      const engine = current.createExecutionDispatcher(input)
      return { ...engine, dispatch: request => {
        assert.notEqual(request.method, 'administration.configureFromMcp')
        return engine.dispatch(request)
      } }
    } }
  const modern = { ...current, createExecutionDispatcher: input => {
    newConstructs++
    assert.equal(input.ports.storage.deliveryAnchor, anchor)
    assert.deepEqual(Object.values(input.ports.storage).filter(v => v !== anchor), storageFunctions)
    return current.createExecutionDispatcher(input)
  } }
  const broken = { ...current, createExecutionDispatcher: input => {
    assert.equal(input.ports.storage.deliveryAnchor, anchor)
    const engine = current.createExecutionDispatcher(input)
    return { ...engine, control: action => action === 'initialize' ? Promise.reject(Error('fixture initialize failure')) : engine.control(action) }
  } }
  t.mock.method(BotAdministration.prototype, 'update', async () => { normalCalls++; return { saved: 'legacy' } })
  t.mock.method(BotAdministration.prototype, 'configureFromMcp', async () => {
    handoffCalls++; return { value: { saved: 'modern' }, handoffMetadata: { call_token: 'modern', origin_digest: 'd'.repeat(64) } }
  })
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'), client,
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: String(port) },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess,
      createExecutionAdoptionStore: () => ({ read: async () => ({ currentVersionId: oldId, previousVersionId: null }), save: async () => {} }),
      loadExecutionFactory: createExecutionFactoryLoader({ builtinIdentity: async () => sourceCommit, prepareRelease: async id => descriptor(id),
        importFactory: async url => url.startsWith('file:///app/') ? modern : url.includes(brokenId) ? broken : legacy }),
      createExecutionAssembly: options => {
        options.ports.configurationStorage.ownerUid = process.getuid()
        anchor = options.ports.storage.deliveryAnchor
        return createExecutionAssembly(options)
      },
      createConversationAssembly: options => conversation = createConversationAssembly({ ...options,
        spawnProcess: (_entry, args, options) => spawn(process.execPath,
          [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options) }),
    } })
  t.after(() => runtime.close())
  assert.equal(oldConstructs, 1); assert.equal(runtime.services.modelHandoffGeneration(), null)
  runtime.internalServer.listen(port, '127.0.0.1'); await once(runtime.internalServer, 'listening')
  const request = async (id, method, params) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', [SEAT_HEADER]: 'bot-fixture', [LAUNCH_HEADER]: 'a'.repeat(32) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    assert.equal(r.status, 200); return r.json()
  }
  const initialize = id => request(id, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
  const update = id => request(id, 'tools/call', { name: 'update_self', arguments: { model: 'fixture' } })
  assert.equal((await initialize('old')).result.capabilities.experimental['ai.aiterm/handoff.v1'], undefined)
  const old = await update(1)
  assert.equal(old.result._meta, undefined); assert.equal(normalCalls, 1); assert.equal(handoffCalls, 0)
  await runtime.services.execution.controller.replace('builtin')
  assert.equal(newConstructs, 1); assert.ok(runtime.services.modelHandoffGeneration())
  assert.equal((await initialize('modern')).result.capabilities.experimental['ai.aiterm/handoff.v1'].version, 1)
  assert.equal((await update(2)).result._meta['ai.aiterm/handoff.v1'].call_token, 'modern')
  assert.equal(handoffCalls, 1)
  let entered, release, hold = true
  const enteredPromise = new Promise(resolve => { entered = resolve }), wait = new Promise(resolve => { release = resolve })
  const originalRun = conversation.run
  t.mock.method(conversation, 'run', (actor, operation, ...rest) => {
    if (hold && actor.kind === 'bot') { hold = false; entered(); return wait.then(() => originalRun(actor, operation, ...rest)) }
    return originalRun(actor, operation, ...rest)
  })
  const stale = update(3); await enteredPromise
  await runtime.services.execution.controller.replace(oldId)
  release()
  const rejected = await stale
  assert.match(JSON.stringify(rejected), /EXECUTION_NOT_ACCEPTING/)
  assert.equal(normalCalls, 1); assert.equal(handoffCalls, 1)
  assert.equal(oldConstructs, 2); assert.equal(runtime.services.modelHandoffGeneration(), null)
  assert.equal((await initialize('old-again')).result.capabilities.experimental['ai.aiterm/handoff.v1'], undefined)
  assert.equal((await update(4)).result._meta, undefined)
  assert.equal(normalCalls, 2); assert.equal(handoffCalls, 1)
  await assert.rejects(runtime.services.execution.controller.replace(brokenId), /EXECUTION_REPLACE_ROLLBACK/)
  assert.equal(oldConstructs, 3); assert.equal(runtime.services.modelHandoffGeneration(), null)
  assert.equal((await update(5)).result._meta, undefined)
  assert.equal(normalCalls, 3); assert.equal(handoffCalls, 1)
})
