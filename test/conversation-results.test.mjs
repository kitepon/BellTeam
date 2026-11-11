import assert from 'node:assert/strict'
import test from 'node:test'
import { validateConversationResult, validateConversationControlResult } from '../src/conversation/results.mjs'
import { CONVERSATION_STATE_COMPATIBILITY } from '../src/conversation/state-compatibility.mjs'
import { CONVERSATION_ROOT_METHODS, CONVERSATION_PARENT_METHODS } from '../src/conversation/authority.mjs'
import { validateConversationRequest, validateConversationControl } from '../src/conversation/requests.mjs'

test('writer retirement controls and ACKs are exact and generation-bound', () => {
  const context = { generation: 'writer-a', operationId: null }
  for (const [method, field] of [['quiesceWriter', 'writerQuiesced'], ['exitWriter', 'writerClosed']]) {
    validateConversationControl(method, {}, context)
    validateConversationControlResult(method, { [field]: true })
    assert.throws(() => validateConversationControl(method, { generation: 'other' }, context))
    assert.throws(() => validateConversationControl(method, {}, { ...context, operationId: 'arbitrary' }))
    for (const value of [{ [field]: false }, { [field]: true, extra: true }, {}])
      assert.throws(() => validateConversationControlResult(method, value))
  }
})

const room = { id: 'room-a', name: 'A', purpose: '', representativeId: null, memberIds: ['bot-a'], avatar: '' }
const schedule = { id: 'schedule-a', kind: 'once', at: '2030-01-01', prompt: 'fixture', future: { preserved: true } }
const post = { delivery: 'running', delivery_id: 'delivery-a', from: 'bot-a', target: 'user' }
const asset = { owner: 'user', file: 'image-a.png', mime: 'image/png' }
const stream = async function * () { yield { schema: 'fixture.future', retained: true } }
const samples = {
  'rooms.list': { rooms: [room] }, 'room.read': { room }, 'room.authorize': { room }, 'room.create': { room },
  'room.update': { room }, 'room.invite': { room }, 'room.leave': { room }, 'room.remove': { removed: room.id },
  'room.schedules.list': { schedules: [schedule] }, 'room.schedules.set': { schedule },
  'room.schedules.remove': { removed: schedule.id }, 'room.schedules.claimDue': schedule, 'room.schedules.skipDue': null,
  'member.removeFromRooms': { removed: 'bot-a' }, 'history.listMessages': stream(), 'history.listRoomMessages': stream(),
  'history.page': stream(), 'history.recentBatch': stream(),
  'history.deliveryAnchor': { deliveryId: 'delivery-a', target: 'bot-a', context: 'direct', contextId: 'bot-a' },
  'direct.post': post, 'fork.ask': { delivery: 'running', delivery_id: 'delivery-a', fork_id: 'fork-a', from: 'bot-a', target: 'bot-b', seat: 'fork' },
  'history.workInput': null, 'user.post': { ...post, from: 'user', target: 'bot-a' }, 'delivery.resume': post,
  'user.turn': { ...post, delivery: 'delivered', reply: null },
  'delivery.closeLaunch': { closureId: 'closure-a', delivery_id: 'delivery-a', from: 'bot-a', target: 'bot-b' },
  'room.post': { id: 'message-a', room: room.id, targets: ['bot-a'], delivery: 'posted_with_failed_deliveries', failedTargets: [{ id: 'bot-a', error: 'unavailable' }] },
  'room.reply': { id: 'message-a', delivery: 'already_posted' }, 'room.silent': { delivery: 'suppressed' },
  'assets.save': asset, 'assets.saveAll': [asset], 'call.receive': { delivery: 'running', delivery_id: 'delivery-a', target: 'bot-a' },
  'observation.poll': { applied: true }, 'fork.sweep': { relayed: 0, owed: 0 }, 'history.recent': { message: { id: 'row-a', at: '2026-11-04T08:00:00+09:00' } },
}

test('every child wire root has a finite result shape while disk optional data remains compatible', () => {
  assert.deepEqual(Object.keys(samples).sort(), [...CONVERSATION_ROOT_METHODS].sort())
  for (const [method, result] of Object.entries(samples)) {
    assert.equal(validateConversationResult(method, result), true, method)
    if (!['history.listMessages', 'history.listRoomMessages', 'history.page', 'history.recentBatch', 'room.schedules.claimDue', 'room.schedules.skipDue', 'assets.saveAll'].includes(method))
      assert.throws(() => validateConversationResult(method, { ...result, authority: {} }))
  }
  assert.deepEqual(samples['room.schedules.list'].schedules[0].future, { preserved: true })
  assert.throws(() => validateConversationResult('history.listMessages', []))
  assert.throws(() => validateConversationResult('delivery.closeLaunch', { ...samples['delivery.closeLaunch'], closed: { outcome: 'closed' } }))
})

test('export and the parent FD remain parent methods', () => {
  const context = { generation: 'generation-a', operationId: 'operation-a', actor: { kind: 'owner' }, continuation: false }
  for (const method of CONVERSATION_PARENT_METHODS) {
    assert.equal(CONVERSATION_ROOT_METHODS.includes(method), false)
    assert.throws(() => validateConversationRequest(method, {}, context))
    assert.throws(() => validateConversationResult(method, {}))
  }
})

test('control success means exact terminal proof, with no invented ready or partial quiesce', () => {
  const results = { initialize: { stateCompatibility: CONVERSATION_STATE_COMPATIBILITY },
    quiesce: { quiesced: true }, resume: { resumed: true }, exit: { closed: true }, 'routing.changed': { applied: true, epoch: 1 } }
  for (const [method, result] of Object.entries(results)) {
    validateConversationControlResult(method, result)
    assert.throws(() => validateConversationControlResult(method, { ...result, partial: true }))
  }
  assert.throws(() => validateConversationControlResult('quiesce', { quiesced: false }))
  assert.throws(() => validateConversationControlResult('initialize', { stateCompatibility: { ...CONVERSATION_STATE_COMPATIBILITY, stateSchema: 1 } }))
})
