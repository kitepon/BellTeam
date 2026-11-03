import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createUsageAssembly } from '../../src/usage-assembly.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const session = 'synthetic-usage-native-session'
const value = 'synthetic-usage-native-secret'
const applyError = 'SYNTHETIC_USAGE_APPLY_FAILED'
const hash = value => createHash('sha256').update(value ?? '').digest('hex')
const owner = { kind: 'owner', botId: null }, bot = { kind: 'bot', botId: 'bot-usage-fixture' }

// Only the outer fixture supplies a prepared root and observes the unchanged fixed-C spawn.
export function createUsageNativeFixture({ root, spawnProcess }) {
  const bots = new Map([[bot.botId, { id: bot.botId, name: 'Usage fixture', harness: 'codex' }]])
  const counters = { settingsEffects: 0, errorCallbacks: 0, secretNotifications: 0, secretCompletions: 0, authCalls: 0, authStarts: 0 }
  const checks = { settingsKept: false, epochKept: false, stickyErrorKept: false, secretKept: false, authSessionKept: false, notificationOnce: false, stableFacade: false }
  let assembly, started = false, closed = false, gate = null, savedSecret, secretId, expectedEpoch = 0, expectedEnabled = true
  let exchanges = 0, attempts = 0, failedExchanges = 0
  const targets = []
  assembly = createUsageAssembly({ root, seatRuntime: true, getServices: () => ({ bots }), spawnProcess,
    onState: state => { if (state.phase === 'quiescing') gate?.draining.resolve() },
    onEffect: async (method, params) => {
      switch (method) {
        case 'members.read': return [...bots.values()].map(item => ({ ...item }))
        case 'rooms.read': return []
        case 'settings.changed': {
          counters.settingsEffects++
          if (gate) {
            const current = gate
            assert.equal(params.id, 'routing')
            current.epoch = params.epoch
            current.entered.resolve()
            await current.release.promise
            await assembly.facade.settings.setError(params.id, { code: applyError }, {
              epoch: params.epoch, usageContext: assembly.systemContext('settings.setError'),
            })
            counters.errorCallbacks++
          }
          return null
        }
        case 'secret.created': counters.secretNotifications++; return null
        case 'secret.completed': counters.secretCompletions++; return null
        case 'auth.call':
          counters.authCalls++
          if (params.action === 'start') { assert.equal(counters.authStarts++, 0) }
          else { assert.equal(params.action, 'status'); assert.equal(hash(params.session_id), hash(session)) }
          return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: session, input_required: false } }
        default: throw Object.assign(new Error('USAGE_FIXTURE_EFFECT_UNEXPECTED'), { code: 'USAGE_FIXTURE_EFFECT_UNEXPECTED' })
      }
    },
  })
  const { controller, facade } = assembly
  const stableSettings = facade.settings, stableSecrets = facade.secretRequests
  const capture = (method, actor = owner) => assembly.capture(method, actor)
  const snapshot = () => ({ started, closed, attempts, exchanges, failedExchanges, latestEpoch: expectedEpoch,
    ...checks, ...counters, nativeAuth: false, externalEffects: 0 })
  const inspect = async () => {
    assert.equal(facade.settings, stableSettings); assert.equal(facade.secretRequests, stableSecrets)
    const configuration = facade.settings.configuration('routing')
    assert.equal(configuration.enabled, expectedEnabled)
    assert.equal(hash(configuration.apiKey), hash('synthetic-usage-native-key'))
    assert.equal(facade.settings.routingState().epoch, expectedEpoch)
    if (exchanges) assert.equal(facade.settings.list().find(item => item.id === 'routing').error?.code, applyError)
    const secret = facade.secretRequests.get(secretId)
    assert.equal(secret.status, 'submitted'); assert.equal(secret.notification, 'sent')
    assert.equal(hash(await readFile(savedSecret.path)), hash(value))
    const receipt = await facade.harnessAuth.status('codex', capture('auth.status'))
    assert.equal(hash(receipt.auth.session_id), hash(session)); assert.equal(counters.authStarts, 1)
    assert.equal(counters.secretNotifications, 1); assert.equal(counters.secretCompletions, 1)
    Object.assign(checks, { settingsKept: true, epochKept: true, stickyErrorKept: exchanges > 0,
      secretKept: true, authSessionKept: true, notificationOnce: true, stableFacade: true })
    return snapshot()
  }
  return {
    controller, snapshot,
    async start() {
      assert.equal(started, false); assert.equal(closed, false)
      await assembly.initializeSettings()
      assert.equal(controller.snapshot().available, false)
      assert.equal(facade.settings.list().length, 6)
      await assembly.initializeSubscriptions(); await assembly.initializeServices()
      assert.equal(controller.snapshot().available, true)
      await facade.settings.update('routing', { enabled: expectedEnabled, values: { apiKey: 'synthetic-usage-native-key' } }, { usageContext: capture('settings.update') })
      expectedEpoch = facade.settings.routingState().epoch
      const item = await facade.secretRequests.create({ botId: bot.botId, toolId: 'usage-fixture', label: '人工鍵', message: '人工入力だけ' }, capture('secrets.create', bot))
      secretId = item.id
      savedSecret = await facade.secretRequests.submit(secretId, value, capture('secrets.submit'))
      await facade.harnessAuth.start('codex', capture('auth.start'))
      started = true
      return inspect()
    },
    async replace(target) {
      assert.equal(started, true); assert.equal(closed, false); assert.equal(gate, null)
      assert.ok(target === 'builtin' || typeof target === 'string' && /^[a-f0-9]{64}$/.test(target))
      if ((target === 'builtin' ? null : target) === controller.snapshot().currentVersionId)
        throw Object.assign(new Error('USAGE_FIXTURE_TARGET_UNCHANGED'), { code: 'USAGE_FIXTURE_TARGET_UNCHANGED' })
      attempts++
      const current = gate = { entered: deferred(), release: deferred(), draining: deferred(), epoch: null }
      expectedEnabled = !expectedEnabled
      const updating = facade.settings.update('routing', { enabled: expectedEnabled }, { usageContext: capture('settings.update') })
      updating.catch(() => {})
      let replacing
      try {
        await Promise.race([current.entered.promise, updating.then(() => assert.fail('USAGE_FIXTURE_EFFECT_NOT_OBSERVED'))])
        expectedEpoch = current.epoch
        replacing = controller.replace(target)
        replacing.catch(() => {})
        // Reader failure is terminal before quiesce; never leave the accepted effect waiting.
        await Promise.race([current.draining.promise, replacing.then(() => assert.fail('USAGE_FIXTURE_DRAIN_NOT_OBSERVED'))])
        assert.equal(controller.snapshot().phase, 'quiescing')
        current.release.resolve()
        const result = await updating; await updating.completion
        assert.equal(result.error?.code, applyError)
        await replacing
        exchanges++; targets.push(target)
        assert.equal(controller.snapshot().currentVersionId, target === 'builtin' ? null : target)
        return await inspect()
      } catch (error) {
        failedExchanges++
        throw error
      } finally {
        current.release.resolve()
        await Promise.allSettled([updating, updating.completion, replacing])
        gate = null
      }
    },
    async verify() {
      assert.equal(exchanges, 2, 'USAGE_FIXTURE_EXCHANGE_INCOMPLETE')
      assert.match(targets[0], /^[a-f0-9]{64}$/); assert.equal(targets[1], 'builtin')
      assert.equal(controller.snapshot().currentVersionId, null)
      assert.equal(counters.errorCallbacks, 2); assert.equal(failedExchanges, 0)
      return inspect()
    },
    async close() {
      gate?.release.resolve()
      await assembly.close(); closed = true
      assert.equal(controller.snapshot().phase, 'closed')
      return snapshot()
    },
  }
}
