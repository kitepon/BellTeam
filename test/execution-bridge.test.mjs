import test from 'node:test'
import assert from 'node:assert/strict'
import { deliveryExecutionRef, roomExecutionRef, callExecutionRef } from '../src/execution-bridge.mjs'

test('既存delivery/room target/call seqを使い、新しいIDや本文queueを作らない', () => {
  assert.deepEqual(roomExecutionRef('room-message', 'bot-b'), { kind: 'room', message_id: 'room-message', target_session_id: 'bot-b' })
  assert.deepEqual(callExecutionRef({ sessionId: 'call-1', event: 'session.reply', seq: 3, deliveryId: 'fallback' }, 'bot-b'),
    { kind: 'call', call_session_id: 'call-1', event: 'session.reply', seq: 3, target_session_id: 'bot-b' })
  assert.deepEqual(callExecutionRef({ sessionId: 'call-1', event: 'session.reply', deliveryId: 'fallback' }, 'bot-b'), deliveryExecutionRef('fallback', 'bot-b'))
  assert.throws(() => deliveryExecutionRef('', 'bot-b'), { code: 'EXECUTION_INVALID' })
})
