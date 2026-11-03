import assert from 'node:assert/strict'
import test from 'node:test'
import { CONVERSATION_ACTOR_METHODS, CONVERSATION_ROOT_METHODS, CONVERSATION_PARENT_METHODS,
  validateConversationActor, assertConversationRootAuthority } from '../src/conversation/authority.mjs'

test('all seven parent projections validate only their exact fields', () => {
  const actors = [{ kind: 'owner' }, { kind: 'bot', botId: 'bot-a' }, { kind: 'scheduler' }, { kind: 'bridge' },
    { kind: 'onboarding', botId: 'bot-a' }, { kind: 'usage', source: 'secret', botId: 'bot-a' }, { kind: 'observer' }]
  assert.equal(actors.length, Object.keys(CONVERSATION_ACTOR_METHODS).length)
  for (const actor of actors) {
    validateConversationActor(actor)
    for (const field of ['ownerWrite', 'seatSession', 'launch', 'membersLease'])
      assert.throws(() => validateConversationActor({ ...actor, [field]: 'self asserted' }), { code: 'CONVERSATION_ACTOR_INVALID' })
    for (const method of CONVERSATION_ACTOR_METHODS[actor.kind]) assertConversationRootAuthority(method, actor)
  }
  for (const actor of [{ kind: 'system' }, { kind: 'report' }, { kind: 'bot' }, { kind: 'usage', botId: 'bot-a', source: 'arbitrary' }])
    assert.throws(() => validateConversationActor(actor))
})

test('actor ceilings reject unrelated roots and do not expose parent FD or callback authority', () => {
  for (const [method, actor] of [
    ['room.schedules.claimDue', { kind: 'bot', botId: 'bot-a' }],
    ['direct.post', { kind: 'usage', source: 'question', botId: 'bot-a' }],
    ['user.post', { kind: 'observer' }], ['room.create', { kind: 'bridge' }],
    ['delivery.status', { kind: 'owner' }], ['assets.open', { kind: 'owner' }],
  ]) assert.throws(() => assertConversationRootAuthority(method, actor), { code: 'CONVERSATION_METHOD_FORBIDDEN' })
  assert.deepEqual(CONVERSATION_PARENT_METHODS, ['assets.open', 'history.page', 'history.recent', 'history.export'])
  for (const method of CONVERSATION_PARENT_METHODS) assert.equal(CONVERSATION_ROOT_METHODS.includes(method), false)
  assert.equal(CONVERSATION_ROOT_METHODS.includes('assets.open'), false)
  assert.equal(CONVERSATION_ROOT_METHODS.includes('arbitrary.method'), false)
  assert.throws(() => CONVERSATION_ACTOR_METHODS.owner.push('arbitrary'), TypeError)
})
