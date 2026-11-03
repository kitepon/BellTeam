import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createConversationAssembly } from '../src/conversation-assembly.mjs'
import { createExecutionFactoryLoader } from '../src/execution-loader.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'
import { createConversationExecutionLifetimeFixture } from './helpers/conversation-execution-lifetime.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const version = 'b'.repeat(64)
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-execution-lifetime-'))
  await mkdir(join(root, 'state'), { mode: 0o700 })
  const seedPath = join(root, 'seed.json'), botId = 'bot-lifetime-fixture', children = []
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: botId, name: 'Synthetic lifetime', harness: 'codex', session: botId, project: join(root, 'bots', botId) }] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const fixture = createConversationExecutionLifetimeFixture({ botId })
  // Local I/O fixtures use real loader/Assembly/channel code; fixed C/root/default import stay in Centi's image test.
  const loadExecutionFactory = createExecutionFactoryLoader({ builtinIdentity: async () => 'a'.repeat(40),
    importFactory: async url => { assert.equal(url, 'file:///app/src/execution-dispatcher.mjs'); return import('../src/execution-dispatcher.mjs') } })
  const runtime = await createApplicationRuntime({ root, appRoot: new URL('../', import.meta.url).pathname, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' }, client: fixture.client,
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic', args: [] },
      createNotificationsProcess: createSyntheticNotificationsProcess, olrwManagement: null,
      createExecutionAssembly: fixture.createExecutionAssembly, loadExecutionFactory,
      createConversationAssembly: options => createConversationAssembly({ ...options,
        prepareRelease: async versionId => ({ versionId, appRoot: `/run/bellteam-maintenance/conversation/releases/${versionId}/payload` }),
        spawnProcess: (_entry, args, options) => {
          const child = spawn(process.execPath, [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options)
          children.push(child); return child
        } }),
    } })
  fixture.attach(runtime)
  t.after(async () => { await fixture.close(); await runtime.close(); await rm(root, { recursive: true, force: true }) })
  return { fixture, runtime, children }
}

test('lifetime helper is dormant and rejects missing runtime, invalid target and synthetic success', async () => {
  assert.throws(() => createConversationExecutionLifetimeFixture({ botId: 'bad target' }), { code: 'CONVERSATION_LIFETIME_BOT_INVALID' })
  const f = createConversationExecutionLifetimeFixture({ botId: 'bot-fixture' })
  assert.equal(f instanceof Promise, false); assert.equal(f.snapshot().sourceSends, 0)
  await assert.rejects(f.hold('ai'), /CONVERSATION_LIFETIME_NOT_ATTACHED/)
  await f.close(); assert.equal(f.snapshot().closed, true)
})

for (const kind of ['ai', 'callback', 'report']) test(`actual AppRuntime RPC ${kind} holds original operation across timed busy/resume then permits replacement`, { timeout: kind === 'report' ? 80_000 : 15_000 }, async t => {
  const { fixture, runtime, children } = await setup(t)
  const controller = runtime.services.conversationAssembly.controller, before = controller.snapshot()
  const held = await fixture.hold(kind), pending = held.snapshot()
  assert.equal(pending.originalOperationLive, true)
  if (kind === 'callback') assert.equal(pending.callbackPending, true)
  if (kind === 'report') {
    assert.equal(pending.rootResultSettled, true); assert.equal(pending.rootRPCSettled, true)
    assert.equal(pending.reportUsesOriginalOperation, true); assert.equal(pending.reportSends, 1)
  }
  if (kind !== 'report') t.mock.timers.enable({ apis: ['setTimeout'] })
  const began = performance.now()
  const replacing = controller.replace(version)
  const rejected = assert.rejects(replacing, { code: 'CONVERSATION_DRAIN_TIMEOUT' })
  for (let n = 0; n < 100 && controller.snapshot().phase !== 'quiescing'; n++) await tick()
  assert.equal(controller.snapshot().phase, 'quiescing')
  await tick()
  if (kind !== 'report') t.mock.timers.tick(60_000)
  await rejected
  if (kind !== 'report') t.mock.timers.reset()
  else assert.ok(performance.now() - began >= 59_000)
  assert.equal(children.length, 1); assert.equal(controller.snapshot().generation, before.generation)
  held.assertResumed()
  await held.release()
  assert.equal(fixture.snapshot().sourceSends, 1); assert.equal(fixture.snapshot().bodyResends, 0)
  assert.equal(fixture.snapshot().nativeAborts, 0); assert.equal(fixture.snapshot().nativeStops, 0)
  assert.equal(fixture.snapshot().sdkCloses, 0); assert.equal(fixture.snapshot().ptyCloses, 0)
  await controller.replace(version); await controller.replace('builtin')
  assert.equal(children.length, 3); assert.equal(controller.snapshot().currentVersionId, null)
  t.diagnostic(JSON.stringify({ kind, clock: kind === 'report' ? 'actual 60 seconds' : 'local setTimeout advanced; native image must measure actual 60 seconds', ...fixture.snapshot() }))
})

test('all three same-root phases finish their own operation and preserve the original report identity after earlier replies', { timeout: 15_000 }, async t => {
  const { fixture } = await setup(t)
  for (const kind of ['ai', 'callback', 'report']) {
    const held = await fixture.hold(kind)
    assert.equal(held.snapshot().originalOperationLive, true)
    await held.release()
    assert.equal(held.snapshot().originalOperationLive, false)
  }
  const state = fixture.snapshot()
  assert.equal(state.holds, 3); assert.equal(state.released, 3)
  assert.equal(state.sourceSends, 3); assert.equal(state.reportSends, 1)
  assert.equal(state.reportUsesOriginalOperation, true); assert.equal(state.nativeDone, 4)
  assert.equal(state.nativeAborts, 0); assert.equal(state.bodyResends, 0)
  t.diagnostic(JSON.stringify({ scope: 'same-root-after-three-phases', ...state }))
})

test('caller rejection still waits a separate real callback ACK and original operation done before preserving the same error', { timeout: 15_000 }, async t => {
  const { fixture, runtime } = await setup(t)
  const refused = Promise.withResolvers(), entered = Promise.withResolvers(), ack = Promise.withResolvers()
  refused.promise.catch(() => {})
  const userTurn = runtime.services.messenger.userTurn
  runtime.services.messenger.userTurn = (...args) => {
    const original = userTurn(...args), caller = Promise.race([original, refused.promise])
    caller.accepted = original.accepted; caller.completion = original.completion
    return caller
  }
  let armed = false
  const unsubscribe = runtime.services.conversationAssembly.watch(async change => {
    if (armed && change.all === true) { entered.resolve(); await ack.promise }
  })
  t.after(() => { ack.resolve(); unsubscribe() })
  const held = await fixture.hold('ai'), originalError = Object.assign(Error('caller deadline'), { code: 'CONVERSATION_IPC_TIMEOUT' })
  armed = true; refused.reject(originalError); await tick()
  assert.equal(held.snapshot().rootResultSettled, true)
  assert.equal(held.snapshot().rootRPCSettled, false)
  let released = false
  const releasing = held.release()
  const rejected = assert.rejects(releasing, error => { assert.equal(error, originalError); return true })
  releasing.then(() => { released = true }, () => { released = true })
  await entered.promise; await tick()
  assert.equal(released, false); assert.equal(held.snapshot().originalOperationLive, true)
  ack.resolve(); await rejected
  assert.equal(held.snapshot().originalOperationLive, false)
  assert.equal(held.snapshot().rootRPCSettled, true)
  assert.equal(held.snapshot().released, 1)
  assert.equal(held.release(), releasing)
  t.diagnostic(JSON.stringify({ scope: 'caller-error-after-actual-done', ...fixture.snapshot() }))
})

test('original accepted native survives the actual channel 60-second boundary then ends its real AppRuntime RPC', { timeout: 80_000 }, async t => {
  const { fixture, runtime, children } = await setup(t)
  const controller = runtime.services.conversationAssembly.controller, generation = controller.snapshot().generation
  const held = await fixture.hold('ai'), before = held.snapshot(), began = performance.now(), pid = children[0].pid
  assert.equal(before.rootResultSettled, false); assert.equal(before.rootRPCSettled, false)
  await new Promise(resolve => setTimeout(resolve, 61_000))
  const elapsed = performance.now() - began, retained = held.snapshot()
  assert.ok(elapsed >= 60_000)
  assert.equal(retained.rootResultSettled, false); assert.equal(retained.rootRPCSettled, false)
  assert.equal(retained.originalOperationLive, true); assert.equal(retained.nativeDone, 0)
  assert.equal(children.length, 1); assert.equal(children[0].pid, pid); assert.equal(children[0].exitCode, null)
  assert.equal(controller.snapshot().generation, generation)
  await held.release()
  const ended = held.snapshot()
  assert.equal(ended.rootResultSettled, true); assert.equal(ended.rootRPCSettled, true)
  assert.equal(ended.originalOperationLive, false); assert.equal(ended.nativeDone, 1)
  assert.equal(ended.sourceSends, 1); assert.equal(ended.nativeAborts, 0); assert.equal(ended.nativeStops, 0); assert.equal(ended.bodyResends, 0)
  t.diagnostic(JSON.stringify({ scope: 'actual-AppRuntime-original-native61s', elapsedMilliseconds: elapsed, before, retained, ended }))
})
