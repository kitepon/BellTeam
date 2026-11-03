import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'

test('routing apply waits for matching child ACK without key exposure, preserves saved failure, and does not run at initialize', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-usage-apply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const calls = [], events = []
  let complete, entered
  const started = new Promise(resolve => { entered = resolve })
  const ack = new Promise(resolve => { complete = resolve })
  let mismatch = false
  const features = createApplicationFeatures({
    services: { bots: new Map(), messenger: {}, settings, diagnostics: { async record() {} },
      notifications: { async initialStatus() {} }, transport: {},
      conversationUsageChanged: async state => {
        calls.push(state)
        assert.deepEqual(Object.keys(state).sort(), ['enabled', 'epoch'])
        assert.equal(settings.routingEpoch, state.epoch)
        if (calls.length === 1) { entered(); await ack }
        return { applied: true, epoch: state.epoch + Number(mismatch) }
      },
    },
    home: root, callBridgeHeaders: join(root, 'headers'), environment: {},
    configureHarnessConfig: async () => {}, notify: event => events.push(event),
  })
  t.after(() => features.close())
  await features.initialize()
  assert.equal(calls.length, 0)
  let settled = false
  const update = settings.update('routing', { enabled: true, values: { apiKey: 'synthetic-typesafe-only' } }, { allowSecretValues: true })
    .then(value => { settled = true; return value })
  await started
  assert.equal(settled, false)
  assert.equal(settings.routingState().epoch, 1)
  complete()
  await update
  mismatch = true
  await assert.rejects(settings.update('routing', { enabled: false }), { code: 'FEATURE_APPLY_FAILED' })
  assert.deepEqual(settings.routingState(), { enabled: false, epoch: 2 })
  assert.equal(settings.list()[0].error.code, 'CONVERSATION_ROUTING_APPLY_FAILED')
  mismatch = false
  await settings.update('routing', { enabled: true })
  assert.equal(settings.list()[0].error, undefined)
  assert.deepEqual(calls, [{ enabled: true, epoch: 1 }, { enabled: false, epoch: 2 }, { enabled: true, epoch: 3 }])
  assert.equal(events.length, 3)
  assert.doesNotMatch(JSON.stringify({ calls, events, public: settings.list() }), /synthetic-typesafe-only/u)
})
