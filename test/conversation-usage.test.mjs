import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { createConversationUsage } from '../src/usage/conversation-effects.mjs'

test('construction and routing state acquire no credential; only enabled private reads project one key', async () => {
  let reads = 0
  let state = { enabled: false, epoch: 2 }
  const usage = createConversationUsage({ settings: {
    routingState: () => ({ ...state }),
    configuration(id) {
      reads++
      assert.equal(id, 'routing')
      return { enabled: true, apiKey: 'synthetic-typesafe-only', unrelated: 'must-not-project' }
    },
  }, notifications: {} })
  assert.equal(reads, 0)
  assert.deepEqual(usage.routingState(), { enabled: false, epoch: 2 })
  assert.deepEqual(await usage.dispatch('usage.routing.read', {}), { enabled: false, epoch: 2, apiKey: null })
  assert.equal(reads, 0)
  state = { enabled: true, epoch: 3 }
  assert.deepEqual(await usage.dispatch('usage.routing.read', {}), { enabled: true, epoch: 3, apiKey: 'synthetic-typesafe-only' })
  assert.equal(reads, 1)
  state = { enabled: false, epoch: 4 }
  assert.deepEqual(await usage.dispatch('usage.routing.read', {}), { enabled: false, epoch: 4, apiKey: null })
  assert.equal(reads, 1)
})

test('closed usage effects reject secret/URL/method additions before credentials or notifications', async () => {
  let effects = 0
  const usage = createConversationUsage({ settings: {
    routingState() { effects++; return { enabled: true, epoch: 0 } },
    configuration() { effects++; return { apiKey: 'synthetic-typesafe-only' } },
  }, notifications: { direct() { effects++ }, room() { effects++ } } })
  const direct = { deliveryId: 'delivery-1', from: 'bot-a', target: 'user' }
  const room = { id: 'message-1', sender: { id: 'bot-a', name: 'Alice' }, room: { id: 'room-1', name: 'Room' } }
  for (const [method, params] of [
    ['usage.routing.read', { apiKey: 'injected-secret' }], ['usage.routing.read', null],
    ['usage.routing.read', []], ['usage.settings.read', {}], ['usage.notify.secret', {}],
    ['usage.notify.direct', { ...direct, body: 'injected-secret' }],
    ['usage.notify.direct', { ...direct, from: 12 }],
    ['usage.notify.direct', { ...direct, target: '' }],
    ['usage.notify.room', { ...room, url: 'https://example.invalid' }],
    ['usage.notify.room', { ...room, room: { ...room.room, body: 'injected-secret' } }],
    ['usage.notify.room', { ...room, sender: { id: 'bot-a' } }],
  ]) {
    await assert.rejects(usage.dispatch(method, params), error => {
      assert.equal(error.code, 'CONVERSATION_USAGE_INPUT_INVALID')
      assert.equal(error.outcome, 'not_accepted')
      assert.doesNotMatch(error.message, /secret|example/u)
      return true
    })
  }
  assert.equal(effects, 0)
})

test('minimal notification DTOs restore existing metadata without message bodies or shared nested references', async () => {
  const events = []
  const usage = createConversationUsage({ settings: {}, notifications: {
    direct: value => events.push(['direct', value]), room: value => events.push(['room', value]),
  } })
  assert.deepEqual(await usage.dispatch('usage.notify.direct', { deliveryId: 'delivery-1', from: 'bot-a', target: 'user' }), { accepted: true })
  const room = { id: 'message-1', sender: { id: 'bot-a', name: 'Alice' }, room: { id: 'room-1', name: 'Room' } }
  assert.deepEqual(await usage.dispatch('usage.notify.room', room), { accepted: true })
  room.sender.name = 'changed'
  room.room.name = 'changed'
  assert.deepEqual(events, [
    ['direct', { schema: 'bellteam.direct-message.v1', delivery_id: 'delivery-1', from: 'bot-a', target: 'user' }],
    ['room', { id: 'message-1', sender: { id: 'bot-a', name: 'Alice' }, room: { id: 'room-1', name: 'Room' } }],
  ])
})

test('routing epoch follows durable saves before apply and survives apply failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-conversation-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  assert.equal(settings.routingEpoch, 0)
  assert.deepEqual(settings.routingState(), { enabled: false, epoch: 0 })
  await assert.rejects(settings.update('routing', { enabled: true }))
  assert.equal(settings.routingEpoch, 0)
  const key = 'synthetic-routing-key'
  const observed = []
  settings.onChange = async (id, config) => {
    observed.push([id, settings.routingEpoch, config.enabled])
    const saved = JSON.parse(await readFile(settings.path, 'utf8'))
    assert.equal(saved[id].enabled, config.enabled)
    if (id === 'routing' && !config.enabled) throw Object.assign(new Error('synthetic apply failure'), { code: 'ROUTING_APPLY_FAILED' })
  }
  await settings.update('routing', { enabled: true, values: { apiKey: key } }, { allowSecretValues: true })
  assert.equal(settings.routingEpoch, 1)
  await assert.rejects(settings.update('routing', { enabled: false }), { code: 'FEATURE_APPLY_FAILED' })
  assert.equal(settings.routingEpoch, 2)
  assert.equal(settings.configuration('routing').enabled, false)
  await settings.update('diagnostics', { enabled: false })
  assert.equal(settings.routingEpoch, 2)
  await settings.update('routing', { enabled: true })
  assert.equal(settings.routingEpoch, 3)
  assert.deepEqual(observed, [['routing', 1, true], ['routing', 2, false], ['diagnostics', 2, false], ['routing', 3, true]])
  assert.deepEqual(settings.configuration('routing'), { enabled: true, apiKey: key })
  assert.doesNotMatch(JSON.stringify(settings.list()), /synthetic-routing-key|routingEpoch|synthetic apply failure/u)
  const saved = await readFile(settings.path, 'utf8')
  assert.doesNotMatch(saved, /routingEpoch|epoch/u)
  const save = settings.save.bind(settings)
  settings.save = async () => { throw new Error('synthetic disk failure') }
  await assert.rejects(settings.update('routing', { enabled: false }))
  assert.equal(settings.routingEpoch, 3)
  assert.equal(settings.configuration('routing').enabled, true)
  settings.save = save
})
