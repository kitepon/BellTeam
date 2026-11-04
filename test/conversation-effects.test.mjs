import assert from 'node:assert/strict'
import test from 'node:test'
import { CONVERSATION_EFFECT_METHODS, validateConversationEffect, validateConversationEffectResult,
  normalizeConversationObserverResult } from '../src/conversation/effects.mjs'

const context = { generation: 'generation-a', operationId: 'operation-a', actor: { kind: 'observer' }, continuation: false }

test('not-issued report result is an exact report-only union', () => {
  const unavailable = { report: 'unavailable', reason: 'not_issued' }
  validateConversationEffectResult('execution.report', unavailable)
  for (const method of ['execution.notify', 'execution.turn']) assert.throws(() => validateConversationEffectResult(method, unavailable))
  for (const value of [{ ...unavailable, extra: true }, { report: 'unavailable' }, { ...unavailable, reason: 'unknown' }, { ...unavailable, delivery: 'running' }])
    assert.throws(() => validateConversationEffectResult('execution.report', value))
})
const scope = 'tlop1.' + 'a'.repeat(64)
const queue = { context: 'direct', contextId: 'bot-a', groupId: 'delivery-a', from: 'user', fromName: 'Owner', target: 'bot-a', message: 'Q' }
const native = { deliveryId: 'delivery-a', target: 'bot-a', message: 'Q', images: [], queue, kinds: ['delivery.status', 'delivery.answer'] }
const samples = {
  'execution.shown.read': [{ botId: 'bot-a' }, { shownId: 'shown-a', words: ['hello'], endedAt: null }],
  'execution.shown.consume': [{ botId: 'bot-a', shownId: 'shown-a' }, { applied: true }],
  'members.profiles.read': [{}, { bots: [{ id: 'bot-a', name: 'A' }] }],
  'execution.assertAccess': [{}, { allowed: true }],
  'execution.reconcile': [{ botId: 'bot-a', deliveryId: 'delivery-a', target: { session_id: 'bot-a', launch_id: 'a'.repeat(32) } }, { recoveryId: 'recovery-a' }],
  'execution.closeLaunch': [{ botId: 'bot-a', deliveryId: 'delivery-a', target: { session_id: 'bot-a', launch_id: 'a'.repeat(32) } }, { closureId: 'closure-a' }],
  'usage.routing.read': [{}, { enabled: false, epoch: 1, apiKey: null }],
  'usage.notify.direct': [{ deliveryId: 'delivery-a', from: 'bot-a', target: 'user' }, { accepted: true }],
  'usage.notify.room': [{ id: 'message-a', sender: { id: 'bot-a', name: 'A' }, room: { id: 'room-a', name: 'Room' } }, { accepted: true }],
  'assets.beginSave': [{ owner: 'user' }, { leaseId: 'lease-a' }],
  'assets.endSave': [{ leaseId: 'lease-a' }, { requested: true }],
  'runtime.image.read': [{ image: { path: '/parent/validated/image.png' }, leaseId: 'lease-a' }, { data: 'iVBORw0KGgo=' }],
  'runtime.room.context': [{ roomId: 'room-a', messageId: 'message-a', speaker: 'A', text: 'Q' }, { turns: [{ speaker: 'A', text: 'Q' }] }],
  'runtime.observer.snapshot': [{}, { projects: [{ botId: 'bot-a', scope, projectBytes: 20 }] }],
  'runtime.observer.check': [{ projects: [{ id: 'bot-a', scope, after: null }] }, { schema: 'throughline.observer_check_result.v1', status: 'complete', results: [{ id: 'bot-a', status: 'changed', token: 'tloc1.token' }] }],
  'runtime.observer.read': [{ botId: 'bot-a', scope, afterCursor: null }, { status: 'projection_pending', throughCursor: null, turns: [] }],
  'execution.notify': [native, { delivery: 'running' }],
  'execution.turn': [{ ...native, kinds: ['delivery.status', 'delivery.words', 'user.complete'] }, { delivery: 'steered' }],
  'execution.background.begin': [{ deliveryId: 'delivery-a', target: 'bot-a' }, { backgroundId: 'background-a' }],
  'execution.background.end': [{ backgroundId: 'background-a' }, { requested: true }],
  'execution.observation.source': [{ target: 'bot-a' }, { deliveryId: 'delivery-a', target: 'bot-a' }],
  'execution.report': [{ sourceDeliveryId: 'source-a', deliveryId: 'delivery-a', target: 'bot-a', reason: 'missing', message: 'Q',
    kinds: ['delivery.words', 'delivery.answer'], queue: { ...queue, context: 'report', from: 'bellteam' } }, { delivery: 'running' }],
}

test('all fixed effects/results reject authority, path, secret and arbitrary result extras', () => {
  assert.deepEqual(Object.keys(samples).sort(), [...CONVERSATION_EFFECT_METHODS].sort())
  for (const [method, [params, result]] of Object.entries(samples)) {
    validateConversationEffect(method, params, context)
    validateConversationEffectResult(method, result, params)
    assert.throws(() => validateConversationEffect(method, { ...params, arbitrary: '/' }, context))
    assert.throws(() => validateConversationEffectResult(method, { ...result, extra: 'secret' }, params))
    assert.throws(() => validateConversationEffect(method, params, { generation: 'generation-a', operationId: null }))
  }
  assert.throws(() => validateConversationEffect('arbitrary.rpc', {}, context))
  assert.throws(() => validateConversationEffectResult('arbitrary.rpc', {}))
})

test('native source/target/callback subsets are closed and turn.end cannot double-open its background window', () => {
  for (const value of [{ ...native, queue: { ...queue, groupId: 'wrong' } }, { ...native, queue: { ...queue, target: 'other' } },
    { ...native, kinds: ['delivery.answer', 'delivery.answer'] }, { ...native, kinds: ['user.complete'] }])
    assert.throws(() => validateConversationEffect('execution.notify', value, context))
  const report = samples['execution.report'][0]
  for (const value of [{ ...report, kinds: ['turn.end'] }, { ...report, reason: 'retry' }, { ...report, queue }])
    assert.throws(() => validateConversationEffect('execution.report', value, context))
  assert.throws(() => validateConversationEffect('execution.observation.source', { target: 'bot-a' }, { ...context, actor: { kind: 'owner' } }))
  const callback = { generation: 'generation-a', operationId: 'operation-a', deliveryId: 'delivery-a', target: 'bot-a', callbackKind: 'turn.end' }
  assert.throws(() => validateConversationEffect('execution.background.begin', samples['execution.background.begin'][0], callback))
  validateConversationEffect('usage.routing.read', {}, callback)
  assert.throws(() => validateConversationEffectResult('execution.observation.source', { deliveryId: 'delivery-a', target: 'other' }, { target: 'bot-a' }))
  validateConversationEffect('execution.notify', { ...native, recoveryId: 'recovery-a' }, context)
  assert.throws(() => validateConversationEffect('execution.turn', { ...samples['execution.turn'][0], recoveryId: 'recovery-a' }, context))
  assert.throws(() => validateConversationEffectResult('execution.assertAccess', { allowed: false }))
})

test('observer v2 projection preserves full body, known statuses and opaque paging without private metadata', () => {
  const assistant = '日本語'.repeat(3000)
  const raw = { schema: 'throughline.observer_read.v2', status: 'host_switched', throughCursor: 'opaque-cursor',
    page: { complete: false, nextToken: 'opaque-page' }, turns: [{ source_sha256: 'source', turn_start: 'self',
      user: 'input', assistant, completed_at: 42, host: 'claude', privatePath: '/not/forwarded' }], privatePath: '/not/forwarded' }
  const result = normalizeConversationObserverResult(raw)
  assert.equal(result.turns[0].assistant, assistant)
  assert.deepEqual(result.page, raw.page)
  assert.equal(result.throughCursor, raw.throughCursor)
  assert.equal(Object.hasOwn(result, 'privatePath'), false)
  assert.equal(Object.hasOwn(result.turns[0], 'privatePath'), false)
  for (const status of ['snapshot', 'delta', 'thread_switched', 'host_switched', 'resync_required', 'projection_pending', 'ambiguous_parent'])
    validateConversationEffectResult('runtime.observer.read', { status, turns: [] })
  assert.throws(() => normalizeConversationObserverResult({ ...raw, schema: 'throughline.observer_read.v1' }))
  assert.throws(() => validateConversationEffectResult('usage.routing.read', { enabled: false, epoch: 1, apiKey: 'forbidden' }))
})
