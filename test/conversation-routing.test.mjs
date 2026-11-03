import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationRouting } from '../src/conversation/routing.mjs'

const endpoint = 'https://api.typesafe.ai/v1/systemone'
test('construction does no credential work; one call holds the same context and drops its reference at terminal', async () => {
  const context = Object.freeze({ operation: 'parent' }), calls = []
  const routing = new ConversationRouting({ read: async value => {
    assert.equal(value, context); calls.push('read'); return { enabled: true, epoch: 3, apiKey: 'private-provider-key' }
  }, fetcher: async () => { calls.push('fetch'); return 'judgment' } })
  assert.deepEqual(calls, [])
  let escaped
  assert.equal(await routing.withRouting(context, async configuration => {
    escaped = configuration
    assert.equal(configuration.apiKey, 'private-provider-key')
    assert.doesNotMatch(JSON.stringify(configuration), /private-provider-key|apiKey/u)
    return configuration.fetcher(endpoint, {})
  }), 'judgment')
  assert.deepEqual(calls, ['read', 'fetch'])
  assert.deepEqual(routing.snapshot(), { enabled: true, epoch: 3 })
  assert.throws(() => escaped.apiKey, { code: 'CONVERSATION_ROUTING_STALE' })
})

test('a read overtaken by changed never reaches the consumer or sends HTTP', async () => {
  const pending = Promise.withResolvers()
  const routing = new ConversationRouting({ read: () => pending.promise, fetcher: () => assert.fail('HTTP') })
  const run = routing.withRouting({}, () => assert.fail('stale credential consumer'))
  assert.deepEqual(routing.changed({ enabled: false, epoch: 1 }), { applied: true, epoch: 1 })
  pending.resolve({ enabled: true, epoch: 0, apiKey: 'late secret' })
  await assert.rejects(run, { code: 'CONVERSATION_ROUTING_STALE' })
})

test('disable or credential epoch change refuses a new fetch immediately without secret reflection', async () => {
  const routing = new ConversationRouting({ read: async () => ({ enabled: true, epoch: 1, apiKey: 'credential' }),
    fetcher: () => assert.fail('new HTTP after disable') })
  await routing.withRouting({}, async configuration => {
    routing.changed({ enabled: false, epoch: 2 })
    assert.throws(() => configuration.apiKey, { code: 'CONVERSATION_ROUTING_STALE' })
    assert.throws(() => configuration.fetcher(endpoint, {}), { code: 'CONVERSATION_ROUTING_STALE' })
  })
  assert.throws(() => routing.changed({ enabled: true, epoch: 1 }), { code: 'CONVERSATION_ROUTING_STALE' })
})

test('already issued fetch finishes once; changed does not abort or retry it', async () => {
  const response = Promise.withResolvers(), issued = Promise.withResolvers()
  let count = 0
  const routing = new ConversationRouting({ read: async () => ({ enabled: true, epoch: 1, apiKey: 'credential' }),
    fetcher: () => { count++; issued.resolve(); return response.promise } })
  const run = routing.withRouting({}, configuration => configuration.fetcher(endpoint, {}))
  await issued.promise
  routing.changed({ enabled: false, epoch: 2 })
  response.resolve('original result')
  assert.equal(await run, 'original result')
  assert.equal(count, 1)
})

test('unconfigured state is usable without HTTP, while extra settings and arbitrary endpoints are refused', async () => {
  const disabled = new ConversationRouting({ read: async () => ({ enabled: false, epoch: 0, apiKey: null }),
    fetcher: () => assert.fail('HTTP') })
  await disabled.withRouting({}, async configuration => {
    assert.equal(configuration.apiKey, null)
    assert.equal(configuration.enabled, false)
    assert.throws(() => configuration.fetcher(endpoint, {}), { code: 'JEV_API_KEY_MISSING' })
  })
  const invalid = new ConversationRouting({ read: async () => ({ enabled: true, epoch: 1, apiKey: 'secret', extraProvider: 'not allowed' }) })
  await assert.rejects(invalid.withRouting({}, () => {}), { code: 'CONVERSATION_ROUTING_INPUT_INVALID' })
  const active = new ConversationRouting({ read: async () => ({ enabled: true, epoch: 1, apiKey: 'secret' }) })
  await active.withRouting({}, async configuration => {
    assert.throws(() => configuration.fetcher('https://other.invalid', {}), { code: 'CONVERSATION_ROUTING_ENDPOINT_INVALID' })
  })
})
