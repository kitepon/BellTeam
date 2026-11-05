import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'
import { validateCurrentWork } from '../src/current-work-contract.mjs'
import { createTeamBackgroundSummary } from '../src/background-summary-assembly.mjs'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('background model effect reads the shared catalog and exposes only model id and efforts', async () => {
  const calls = [], effect = createUsageParentEffects({ getServices: () => ({ models: { async list(harness) {
    calls.push(harness)
    return { codex: { models: [{ id: 'candidate', efforts: ['high'], private: 'hidden' }] } }
  } } }) })
  assert.deepEqual(await effect('backgroundAgent.models', { harness: 'codex' }), [{ id: 'candidate', efforts: ['high'] }])
  assert.deepEqual(calls, ['codex'])
  const unavailable = createUsageParentEffects({ getServices: () => ({ models: { list: async () => ({ codex: { models: [], error: { code: 'MODEL_CATALOG_UNAVAILABLE' } } }) } }) })
  await assert.rejects(unavailable('backgroundAgent.models', { harness: 'codex' }), { code: 'BACKGROUND_AGENT_MODELS_UNAVAILABLE' })
})

test('settings notification follows actual configure completion and survives missing executor', async () => {
  const configuration = { revision: null, selection: null }, events = []
  let finish
  const completion = new Promise(resolve => { finish = resolve })
  const effect = createUsageParentEffects({ getServices: () => ({
    backgroundSummary: { configure: value => { assert.equal(value, configuration); return Object.assign(Promise.resolve(), { completion }) } },
    notify: value => events.push(value),
  }) })
  const pending = effect('backgroundAgent.changed', { configuration })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, [])
  finish(); assert.equal(await pending, null)
  assert.deepEqual(events, [{ type: 'settings', featureId: 'backgroundAgent' }])
  const missing = createUsageParentEffects({ getServices: () => ({ notify: value => events.push(value) }) })
  await assert.rejects(missing('backgroundAgent.changed', { configuration }), { code: 'BACKGROUND_AGENT_UNAVAILABLE' })
  assert.equal(events.length, 2)
})

test('automatic summaries keep nine independent states while legacy self reports keep their original states', () => {
  const at = '2026-11-04T23:00:00Z'
  for (const state of ['working', 'idle', 'unknown']) for (const status of ['current', 'missing', 'stale']) {
    const value = { state, summary: status === 'current' ? '今の仕事' : null, summaryStatus: status,
      summaryUpdatedAt: status === 'missing' ? null : at, observedAt: state === 'unknown' ? null : at,
      source: status === 'missing' ? null : 'background_agent' }
    assert.equal(validateCurrentWork(value).valid, true, `${state}/${status}`)
    if (status !== 'missing') {
      assert.equal(validateCurrentWork({ ...value, source: 'self_reported' }).valid, state === 'working')
      assert.equal(validateCurrentWork({ ...value, source: 'unrecognized' }).valid, false)
    }
    if (status !== 'current') assert.equal(validateCurrentWork({ ...value, summary: 'invented' }).valid, false)
    if (state !== 'unknown') assert.equal(validateCurrentWork({ ...value, observedAt: null }).valid, false)
  }
})

test('parent assembly keeps the original authority and waits for the limited read actual completion', async t => {
  const input = { botId: 'bot-a', sessionId: 'session-a', launchId: 'a'.repeat(32), inputRevision: 'job-a',
    deliveryId: 'delivery-a', context: 'direct', contextId: 'bot-a' }
  const context = { actor: { kind: 'owner' }, rootMethod: 'user.post' }
  let scope = false, assertions = 0, finish, runs = 0
  const completion = new Promise(resolve => { finish = resolve })
  const assembly = {
    run(actor, operation, parent) {
      assert.equal(actor, context.actor); assert.equal(parent, context)
      scope = true
      try { return operation() } finally { scope = false }
    },
    facade: { store: { workInput(value) {
      assert.equal(scope, true); assert.deepEqual(value, input)
      return Object.assign(Promise.resolve({ ...value, text: '保存済みの仕事入力', progress: '' }), { completion })
    } } },
  }
  const configuration = { revision: '11111111-1111-4111-8111-111111111111',
    selection: { harness: 'claude', model: 'synthetic', reasoningEffort: 'high' } }
  const summary = createTeamBackgroundSummary({ project: '/unused-fixture', models: {}, conversation: () => assembly,
    settings: { backgroundAgentConfiguration: async () => configuration }, enabled: () => true, notify() {},
    run: async (_selection, prompt) => { runs++; assert.deepEqual(JSON.parse(prompt), { text: '保存済みの仕事入力', progress: '' }); return '接続結果を確認中' },
  })
  t.after(() => summary.close())
  summary.accept(input, { context, assertCurrent: value => { assertions++; assert.deepEqual(value, input); return true } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 0)
  finish(); await summary.draining
  const native = { state: 'unknown', observedAt: null }
  assert.deepEqual(summary.snapshot(input.botId, input.sessionId, native), {
    state: 'unknown', observedAt: null, summary: '接続結果を確認中', summaryStatus: 'current',
    summaryUpdatedAt: summary.snapshot(input.botId, input.sessionId, native).summaryUpdatedAt, source: 'background_agent',
  })
  assert.equal(runs, 1); assert.ok(assertions >= 2)
})

test('parent graph shares one worker and drains it before transport without requiring background settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'background-summary-parent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') }), settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const runtime = await createApplicationRuntime({ root, appRoot: fileURLToPath(new URL('../', import.meta.url)), home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { createNotificationsProcess: createSyntheticNotificationsProcess, bots, settings, ownerProfile, userRules,
      refreshGlobalInstructions: async () => {}, aiterm: { command: 'synthetic-aiterm', args: [] } },
    client: { async call() { throw Error('unexpected native invocation') }, async close() {} },
  })
  t.after(() => runtime.close())
  const worker = runtime.services.backgroundSummary
  assert.equal(runtime.services.transport.backgroundSummary, worker)
  assert.deepEqual(worker.settings, { revision: null, selection: null })
  assert.equal(runtime.server.listening, false)
  const close = runtime.services.transport.close.bind(runtime.services.transport)
  runtime.services.transport.close = async () => { assert.equal(worker.closed, true); return close() }
  await runtime.close()
  assert.equal(worker.closed, true)
})
