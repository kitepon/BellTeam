import assert from 'node:assert/strict'
import test from 'node:test'
import { CONVERSATION_ROOT_METHODS, CONVERSATION_ACTOR_METHODS } from '../src/conversation/authority.mjs'
import { validateConversationRequest, validateConversationControl, validateConversationBotSnapshot,
  validateConversationCallbackContext } from '../src/conversation/requests.mjs'

const root = { generation: 'builtin/generation-a', operationId: 'operation-a', actor: { kind: 'owner' }, continuation: false }
const due = { roomId: 'room-a', scheduleId: 'schedule-a', expectedRevision: 0,
  expectedNextRunAt: '2026-11-03T00:00:00Z', ranAt: '2026-11-03T00:01:00Z' }
const post = { message: '日本語', images: [] }
const launch = { session_id: 'bot-a', launch_id: 'a'.repeat(32) }
const examples = {
  'rooms.list': {}, 'observation.poll': {}, 'room.read': { roomId: 'room-a' },
  'room.schedules.list': { roomId: 'room-a' }, 'room.remove': { roomId: 'room-a' },
  'history.listRoomMessages': { roomId: 'room-a' },
  'room.authorize': { roomId: 'room-a', requirement: 'member' },
  'room.create': { name: 'A', memberIds: ['bot-a'] }, 'room.update': { roomId: 'room-a', changes: { purpose: '' } },
  'room.invite': { roomId: 'room-a', botId: 'bot-a' }, 'room.leave': { roomId: 'room-a', botId: 'bot-a' },
  'room.schedules.set': { roomId: 'room-a', schedule: { kind: 'once', at: '2030-01-01', prompt: 'fixture' } },
  'room.schedules.remove': { roomId: 'room-a', scheduleId: 'schedule-a' },
  'room.schedules.claimDue': due, 'room.schedules.skipDue': due,
  'member.removeFromRooms': { botId: 'bot-a' }, 'history.listMessages': { botId: 'bot-a' },
  'direct.post': { from: 'bot-a', target: 'user', ...post }, 'user.post': { target: 'bot-a', ...post },
  'user.turn': { target: 'bot-a', ...post }, 'room.post': { from: 'bot-a', room: 'room-a', ...post },
  'room.reply': { roomId: 'room-a', messageId: 'message-a', ...post },
  'room.silent': { roomId: 'room-a', messageId: 'message-a' },
  'assets.save': { owner: 'user', id: 'image-a', image: { path: '/fixed/parent-validated/image.png' } },
  'assets.saveAll': { owner: 'user', id: 'image-a', images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] },
  'delivery.resume': { deliveryId: 'delivery-a', target: launch },
  'delivery.closeLaunch': { deliveryId: 'delivery-a', target: launch },
  'call.receive': { event: 'session.message', session_id: 'call-a', target_id: 'bot-a',
    source_system: 'local', source_id: 'source-a', source_label: 'Local', message: 'Call' },
}
const contextFor = method => ({ ...root, actor: { kind: Object.keys(CONVERSATION_ACTOR_METHODS)
  .find(kind => CONVERSATION_ACTOR_METHODS[kind].includes(method)) } })

test('every fixed root has closed payload keys and required fields', () => {
  assert.deepEqual(Object.keys(examples).sort(), [...CONVERSATION_ROOT_METHODS].sort())
  for (const [method, params] of Object.entries(examples)) {
    const context = contextFor(method)
    assert.equal(validateConversationRequest(method, params, context), true, method)
    assert.throws(() => validateConversationRequest(method, { ...params, operationContext: {} }, context))
    for (const key of Object.keys(params)) {
      const missing = { ...params }; delete missing[key]
      if (!['history.page'].includes(method)) assert.throws(() => validateConversationRequest(method, missing, context))
    }
  }
})

test('root context, nested DTOs, callback bindings and control cannot carry authority extras', () => {
  for (const changes of [{ continuation: 'true' }, { generation: '' }, { operationId: null },
    { membersLease: {} }, { actor: { kind: 'owner', ownerWrite: true } }])
    assert.throws(() => validateConversationRequest('rooms.list', {}, { ...root, ...changes }))
  assert.throws(() => validateConversationRequest('room.update', { roomId: 'room-a', changes: { arbitraryPath: '/' } }, root))
  assert.throws(() => validateConversationRequest('assets.save', { ...examples['assets.save'],
    image: { path: '/x', data: 'mixed' } }, root))
  const binding = { generation: root.generation, operationId: root.operationId, deliveryId: 'delivery-a', target: 'bot-a', callbackKind: 'delivery.answer' }
  validateConversationCallbackContext('delivery.answer', binding)
  for (const value of [{ ...binding, actor: root.actor }, { ...binding, callbackKind: 'turn.end' },
    { ...binding, operationId: null }]) assert.throws(() => validateConversationCallbackContext('delivery.answer', value))
  const context = { generation: root.generation, operationId: null }
  const params = { generation: context.generation, mode: 'restore', bots: [{ id: 'bot-a', name: 'A' }] }
  validateConversationControl('initialize', params, context)
  validateConversationControl('routing.changed', { enabled: false, epoch: 1 }, context)
  for (const value of [{ ...params, generation: 'wrong' }, { ...params, bots: null },
    { ...params, bots: [...params.bots, ...params.bots] }, { ...params, bots: [{ ...params.bots[0], project: '/private' }] }])
    assert.throws(() => validateConversationControl('initialize', value, context))
  assert.throws(() => validateConversationControl('routing.changed', { enabled: false, epoch: 1, apiKey: 'forbidden' }, context))
  validateConversationBotSnapshot([])
})

test('private payload validation does not impose a new history count or image text limit', () => {
  const images = Array.from({ length: 257 }, () => ({ mime: 'image/png', data: 'a'.repeat(300000) }))
  validateConversationRequest('user.post', { target: 'bot-a', message: '', images }, root)
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() =>
    validateConversationRequest('room.schedules.claimDue', { ...due, expectedRevision }, contextFor('room.schedules.claimDue')))
})
