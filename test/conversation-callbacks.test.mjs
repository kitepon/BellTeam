import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConversationCallbackError, conversationCallbackFailureFields,
  normalizeConversationCallback, validateConversationCallback, validateConversationCallbackResult } from '../src/conversation/callbacks.mjs'

test('callback error projection never serializes raw Error text, cause, arbitrary fields or a private tool', () => {
  const error = Object.assign(new Error('secret raw body'), { code: 'PRIVATE_SECRET', status: 503, outcome: 'unknown',
    cause: new Error('private cause'), arbitrary: 'private', mcp_error: { tool: 'agent_auth', message: 'private', truncated: false } })
  assert.deepEqual(normalizeConversationCallbackError(error), { code: 'CONVERSATION_CALLBACK_FAILED', status: 503, outcome: 'unknown', delivery_error: { code: 'BOT_DELIVERY_FAILED' } })
  const stopped = normalizeConversationCallbackError(Object.assign(error, { code: 'BOT_STOPPED' }))
  assert.equal(stopped.code, 'BOT_STOPPED')
  assert.doesNotMatch(JSON.stringify(stopped), /secret|private|stack|cause|arbitrary/u)
})

test('safe MCP fields survive the plain callback roundtrip; a retired native_launch value is accepted and dropped (a366)', () => {
  const error = { mcp_error: { tool: 'pty_send', message: 'safe failure', truncated: false } }
  const plain = JSON.parse(JSON.stringify(normalizeConversationCallbackError(error)))
  assert.deepEqual(conversationCallbackFailureFields(plain).mcp_error, error.mcp_error)
  // Nothing writes native_launch any more; an older execution part or a stored delivery record may still carry one.
  const old = { harness: 'antigravity-cli', session_created: true, startup: { status: 'blocked', reason: 'vendor_action_required' } }
  assert.deepEqual(conversationCallbackFailureFields({ ...plain, native_launch: old }), conversationCallbackFailureFields(plain))
  assert.equal(Object.hasOwn(normalizeConversationCallbackError({ ...error, native_launch: old, launch: old }), 'native_launch'), false)
  assert.throws(() => conversationCallbackFailureFields({ ...plain, native_launch: 'x' }))
})

test('callback kind and params are closed, without self asserted binding/lease/record fields', () => {
  for (const [method, params] of [
    ['delivery.status', { delivery: 'running' }], ['delivery.words', { words: [{ text: '日本語', kind: 'answer', at: 'written' }] }],
    ['delivery.answer', { text: 'answer' }], ['user.complete', { reply: 'answer' }], ['user.complete', { reply: { delivery: 'steered' } }],
    ['turn.end', { startedAt: '2026-11-03T00:00:00Z', endedAt: '2026-11-03T00:00:01Z' }],
  ]) {
    const plain = normalizeConversationCallback(method, params)
    validateConversationCallback(method, plain)
    validateConversationCallbackResult(method, { applied: true })
    for (const key of ['deliveryId', 'target', 'membersLease', 'record'])
      assert.throws(() => validateConversationCallback(method, { ...plain, [key]: 'self asserted' }))
  }
  assert.throws(() => validateConversationCallback('arbitrary.method', {}))
  assert.throws(() => validateConversationCallbackResult('turn.end', { applied: true, accepted: true }))
})

test('accepted completion unknown remains exact and is never attached to non-failed status', () => {
  const tracking = { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }
  const plain = normalizeConversationCallback('delivery.status', { delivery: 'failed', tracking })
  assert.deepEqual(plain.tracking, tracking)
  assert.throws(() => validateConversationCallback('delivery.status', { delivery: 'running', tracking }))
  assert.throws(() => validateConversationCallback('delivery.status', { delivery: 'failed', tracking: { ...tracking, success: true } }))
  assert.throws(() => validateConversationCallback('delivery.status', { delivery: 'delivered', error: { code: 'BOT_STOPPED', message: 'not allowed' } }))
})
