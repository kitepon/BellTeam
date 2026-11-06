import assert from 'node:assert/strict'
import test from 'node:test'
import { DELIVERY_ERROR_CODES, deliveryError, deliveryFailureFields } from '../src/conversation-writer.mjs'
import { normalizeConversationCallbackError, conversationCallbackFailureFields } from '../src/conversation/callbacks.mjs'
import { validateDirectLogRecord } from '../src/direct-log-record.mjs'

test('delivery failure codes remain closed across pure callback and log validation boundaries', () => {
  for (const code of DELIVERY_ERROR_CODES) {
    const raw = Object.assign(new Error('private body'), { code, outcome: 'unknown', arbitrary: 'private' })
    const error = normalizeConversationCallbackError(raw)
    assert.equal(error.code, code)
    assert.deepEqual(error.delivery_error, { code })
    assert.deepEqual(conversationCallbackFailureFields(error).delivery_error, { code })
    assert.equal(deliveryError('running', error.delivery_error), null)
    assert.doesNotMatch(JSON.stringify(error), /private|stack|message/)
    const record = { schema: 'bellteam.delivery-status.v1', delivery_id: 'same-id', at: '2026-11-06T23:50:00+09:00',
      delivery: 'failed', ...deliveryFailureFields(raw) }
    validateDirectLogRecord(record)
    assert.throws(() => validateDirectLogRecord({ ...record, delivery_error: { code, message: 'private' } }))
    for (const delivery_error of [null, {}, { code: 'UNKNOWN' }])
      assert.throws(() => conversationCallbackFailureFields({ ...error, delivery_error }))
  }
  assert.deepEqual(deliveryFailureFields(Error('private')).delivery_error, { code: 'BOT_DELIVERY_FAILED' })
  assert.equal(deliveryError('failed', { code: 'UNKNOWN' }), null)
  assert.deepEqual(deliveryFailureFields(null), {})
})
