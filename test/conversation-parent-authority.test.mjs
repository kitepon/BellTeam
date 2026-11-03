import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationAuthority } from '../src/conversation-authority.mjs'

test('captured actor is immutable, method-bound and valid only in the issuing parent factory', () => {
  const authority = createConversationAuthority()
  const actor = { kind: 'owner' }
  const token = authority.capture('room.remove', actor)
  actor.kind = 'observer'
  const projection = authority.authorizeActor('room.remove', token)
  assert.deepEqual(projection, { kind: 'owner' })
  assert.equal(Object.isFrozen(projection), true)
  assert.equal(authority.authorizeActor('room.create', token), false)
  for (const forged of [null, undefined, 'owner', actor, { ...token }, structuredClone(token), JSON.parse(JSON.stringify(token))])
    assert.equal(authority.authorizeActor('room.remove', forged), false)
  assert.equal(createConversationAuthority().authorizeActor('room.remove', token), false)
  assert.equal(authority.authorizeActor(undefined, undefined), false)
  authority.release(token)
  assert.equal(authority.authorizeActor('room.remove', token), false)
})

test('all seven authenticated ingress projections use the child method ceiling and reject extra authority fields', () => {
  const authority = createConversationAuthority()
  for (const [actor, method] of [
    [{ kind: 'owner' }, 'user.turn'], [{ kind: 'bot', botId: 'bot-a' }, 'room.post'],
    [{ kind: 'scheduler' }, 'room.schedules.claimDue'], [{ kind: 'bridge' }, 'call.receive'],
    [{ kind: 'onboarding', botId: 'bot-guide' }, 'user.post'],
    [{ kind: 'usage', botId: 'bot-a', source: 'secret' }, 'user.post'], [{ kind: 'observer' }, 'observation.poll'],
  ]) {
    const token = authority.capture(method, actor)
    assert.deepEqual(authority.authorizeActor(method, token), actor)
    assert.throws(() => authority.capture(method, { ...actor, owner: true }), { code: 'CONVERSATION_ACTOR_INVALID' })
  }
  assert.throws(() => authority.capture('room.remove', { kind: 'bridge' }), { code: 'CONVERSATION_METHOD_FORBIDDEN' })
  assert.throws(() => authority.capture('user.post', { kind: 'system' }), { code: 'CONVERSATION_ACTOR_INVALID' })
})
