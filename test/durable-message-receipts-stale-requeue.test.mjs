import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableMessageReceipts } from '../src/durable-message-receipts.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const stale = { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_STALE_GENERATION',
  effect: 'not_started', follow_up: 'none' }
const target = { id: 'bot-target', name: 'Target' }

async function fixture(t, dispatch) {
  const root = await mkdtemp(join(tmpdir(), 'durable-receipt-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-sender', { id: 'bot-sender', name: 'Sender' }], ['bot-target', target]])
  const pending = []
  const receipts = new DurableMessageReceipts({ root, bots, dispatch, requireAccess: () => {},
    deliveryId: () => id, onPending: deliveryId => pending.push(deliveryId) })
  await receipts.sendmessage({ from: 'bot-sender', target: 'bot-target', message: 'Original body' })
  assert.deepEqual(pending, [id])
  pending.length = 0
  return { receipts, pending }
}

const rejected = executionError => Object.assign(new Error('wrapped invoked failure'), {
  effect: 'unknown', executionError,
})

test('typed terminal stale generation durably requeues and requests the same ID once', async t => {
  const sent = []
  let attempts = 0
  const f = await fixture(t, async input => {
    sent.push(input)
    attempts++
    if (attempts === 1) {
      await input.callbacks.onStatus('failed', Object.assign(new Error('fixture terminal stale refusal'), { code: 'BOT_SEND_FAILED' }))
      throw rejected(stale)
    }
    await input.callbacks.onStatus('running')
    return { delivery: 'running' }
  })

  assert.deepEqual(await f.receipts.dispatchSaved(id), { delivery_id: id, delivery: 'queued', dispatched: false })
  assert.deepEqual(f.pending, [id])
  assert.equal((await f.receipts.store.records())[0].delivery, 'queued')

  const drained = await f.receipts.drain()
  assert.deepEqual(drained, [{ delivery_id: id, delivery: 'running', dispatched: true }])
  assert.equal(attempts, 2)
  assert.equal(sent[0].record.delivery_id, id)
  assert.equal(sent[1].record.delivery_id, id)
  assert.equal(sent[1].record.message, 'Original body')
  assert.equal(sent[1].queue.groupId, id)
  const records = await f.receipts.store.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].delivery_id, id)
  assert.equal(records[0].delivery, 'running')
})

for (const [name, executionError, callbackStatus, expected] of [
  ['typed BUSY not_started with a failed callback remains failed',
    { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_BUSY', effect: 'not_started', follow_up: 'none' }, 'failed', 'failed'],
  ['invalid typed frame stays unknown',
    { schema: 'wrong.schema', code: 'EXECUTION_STALE_GENERATION', effect: 'not_started', follow_up: 'none' }, null, 'unknown'],
  ['possible stale frame stays unknown',
    { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_STALE_GENERATION', effect: 'possible', follow_up: 'none' }, null, 'unknown'],
  ['stale marker without failed callback stays unknown', stale, null, 'unknown'],
  ['observed acceptance is preserved', stale, 'running', 'running'],
]) {
  test(name, async t => {
    let attempts = 0
    const f = await fixture(t, async input => {
      attempts++
      if (callbackStatus) await input.callbacks.onStatus(callbackStatus,
        callbackStatus === 'failed' ? new Error('fixture delivery failure') : undefined)
      throw rejected(executionError)
    })
    const result = await f.receipts.dispatchSaved(id)
    assert.deepEqual(result, { delivery_id: id, delivery: expected, dispatched: false })
    assert.deepEqual(f.pending, [])
    assert.equal((await f.receipts.store.records())[0].delivery, expected)
    await f.receipts.drain()
    assert.equal(attempts, 1, 'nonqueued state is not automatically dispatched again')
  })
}

test('historical unknown receipt without a matching attempt proof is retained', async t => {
  let attempts = 0
  const f = await fixture(t, async () => { attempts++; return { delivery: 'running' } })
  await f.receipts.appendDeliveryStatus(id, 'unknown')
  f.pending.length = 0
  assert.deepEqual(await f.receipts.dispatchSaved(id), { delivery_id: id, delivery: 'unknown', dispatched: false })
  await f.receipts.drain()
  assert.equal(attempts, 0)
  assert.deepEqual(f.pending, [])
  assert.equal((await f.receipts.store.records())[0].delivery, 'unknown')
})
