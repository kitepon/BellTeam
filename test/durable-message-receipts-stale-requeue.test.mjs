import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableMessageReceipts } from '../src/durable-message-receipts.mjs'
import { createDirectReceiptAssembly } from '../src/direct-receipt-assembly.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const stale = { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_STALE_GENERATION',
  effect: 'not_started', follow_up: 'none' }
const target = { id: 'bot-target', name: 'Target' }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function settled(predicate) {
  for (let n = 0; n < 500; n++) { if (await predicate()) return; await tick() }
  assert.fail('operation did not settle')
}

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

test('typed terminal stale generation durably requeues for a later same-ID drain', async t => {
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
  assert.deepEqual(f.pending, [])
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

test('queue release wakes a requeued stale receipt only after the target becomes idle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'durable-receipt-queue-release-'))
  const bots = new Map([['bot-sender', { id: 'bot-sender', name: 'Sender' }], ['bot-target', target]])
  const queueListeners = new Set(), sent = [], errors = []
  let watchCalls = 0, unwatchCalls = 0, attempts = 0, targetIdle = false, idleError = null
  let blockMutex = false, releaseMutex, enteredMutex
  const mutexEntered = () => new Promise(resolve => { enteredMutex = resolve })
  let waitEntered = mutexEntered()
  const mutexBlock = new Promise(resolve => { releaseMutex = resolve })
  const transport = {
    membersAdmission: { withLease: run => run({}) },
    watchQueue(listener) { watchCalls++; queueListeners.add(listener); return () => { unwatchCalls++; queueListeners.delete(listener) } },
    isIdle(botId) { assert.equal(botId, target.id); if (idleError) throw idleError; return targetIdle },
    async notify(_bot, text, options) {
      attempts++; sent.push({ text, options })
      if (attempts < 3) {
        await options.onStatus('failed', Object.assign(new Error('terminal stale refusal'), { code: 'BOT_SEND_FAILED' }))
        throw rejected(stale)
      }
      await options.onStatus('running')
      return { delivery: 'running' }
    },
  }
  const aiControl = { paused: false, admit: () => () => {}, watch: () => () => {} }
  const exchangeMutex = { async waitForIdle() { if (blockMutex) { enteredMutex(); await mutexBlock } } }
  const direct = createDirectReceiptAssembly({ root, bots, transport, aiControl, legacy: { onMessage() {} },
    conversation: { captureReceipt() {} }, exchangeMutex, onMessage() {}, onError: error => { errors.push(error) } })
  t.after(async () => { releaseMutex(); if (queueListeners.size) await direct.close(); await rm(root, { recursive: true, force: true }) })
  const saved = await direct.messenger.sendmessage({ from: 'bot-sender', target: target.id, message: 'Original body' })
  direct.start(); direct.start()
  assert.equal(watchCalls, 1)
  assert.equal(queueListeners.size, 1)
  await settled(async () => attempts === 1 && (await direct.receipts.store.records())[0]?.delivery === 'queued')
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(attempts, 1, 'a queued status does not notify onPending or self-retry')

  direct.requestDrain()
  await settled(async () => attempts === 2 && (await direct.receipts.store.records())[0]?.delivery === 'queued')
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(attempts, 2, 'an ordinary drain remains bounded while the target is busy')

  const reportsBeforeQueue = errors.length
  for (const error of [null, Object.assign(new Error('generation unavailable'), { code: 'EXECUTION_NOT_ACCEPTING' })]) {
    idleError = error
    for (const listener of queueListeners) listener({ all: false, topics: ['queue'], botIds: [target.id], roomIds: [] })
    for (let i = 0; i < 5; i++) await tick()
    assert.equal(attempts, 2, 'busy and unavailable queue checks do not redrain')
  }
  assert.equal(errors.length, reportsBeforeQueue, 'unavailable queue reads are skipped without reporting')

  idleError = null; targetIdle = true
  for (const listener of queueListeners) listener({ all: false, topics: ['queue'], botIds: [target.id], roomIds: [] })
  await settled(async () => attempts === 3 && (await direct.receipts.store.records())[0]?.delivery === 'running')
  const deliveryId = saved.delivery_id
  assert.equal(sent.length, 3)
  assert.ok(sent.every(item => item.text === sent[0].text))
  assert.ok(sent.every(item => item.options.queue.groupId === deliveryId))
  assert.ok(sent.every(item => item.options.queue.message === 'Original body'))
  assert.equal((await direct.receipts.store.records()).length, 1)
  assert.equal((await direct.receipts.store.records())[0].delivery_id, deliveryId)
  assert.equal(errors.length, 2, 'the two terminal dispatch failures are reported')

  blockMutex = true
  waitEntered = mutexEntered()
  direct.requestDrain()
  await waitEntered
  const closing = direct.close()
  assert.equal(queueListeners.size, 0, 'close unsubscribes before waiting for a drain')
  assert.equal(unwatchCalls, 1)
  releaseMutex()
  await closing
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
