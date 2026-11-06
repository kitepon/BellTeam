import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DurableMessageReceipts } from '../src/durable-message-receipts.mjs'
import { createConversationParentEffects } from '../src/conversation-parent-effects.mjs'
import { validateConversationEffect } from '../src/conversation/effects.mjs'
import { createConversationDispatcher } from '../src/conversation/dispatcher.mjs'
import { MessageAssets } from '../src/message-assets.mjs'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'durable-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  let serial = 0
  const notices = []
  const options = { root, bots, deliveryId: () => `delivery-${++serial}`, onMessage: record => notices.push(record),
    admitWork: () => { throw Error('child admission unavailable') }, dispatch: async () => ({ delivery: 'running' }), ...overrides }
  return { root, bots, options, notices, service: new DurableMessageReceipts(options), input: { from: 'bot-a', target: 'bot-b', message: 'saved once' } }
}

test('receipt survives unavailable execution and notification; recreated parent dispatches the same saved ID once', async t => {
  let dispatches = 0, pending = 0
  const f = await fixture(t, { onMessage: () => { throw Error('notification unavailable') }, onError: () => {}, onPending: () => { pending++ } })
  const receipt = await f.service.receive(f.input)
  assert.equal(receipt.delivery, 'queued'); assert.equal(pending, 1)
  const rows = (await readFile(f.service.logPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 1); assert.equal(rows[0].delivery, 'queued')
  const restored = new DurableMessageReceipts({ ...f.options, dispatch: async ({ record, queue, callbacks }) => {
    dispatches++; assert.equal(record.delivery_id, receipt.delivery_id); assert.equal(queue.groupId, receipt.delivery_id)
    await callbacks.onStatus('running')
    return { delivery: 'running' }
  } })
  await Promise.all([restored.drain(), restored.drain()])
  await restored.dispatchSaved(receipt.delivery_id)
  assert.equal(dispatches, 1); assert.deepEqual(await restored.pending(), [])
})

test('write failure rejects receipt; failed claim does not call execution', async t => {
  let dispatches = 0
  const f = await fixture(t, { dispatch: async () => { dispatches++; return { delivery: 'running' } } })
  await writeFile(join(f.root, 'not-directory'), 'x')
  const bad = new DurableMessageReceipts({ ...f.options, logPath: join(f.root, 'not-directory/log') })
  await assert.rejects(bad.receive(f.input), error => ['EEXIST', 'ENOTDIR'].includes(error.code))
  const receipt = await f.service.receive(f.input)
  f.service.appendDeliveryStatus = async () => { throw Object.assign(Error('full disk'), { code: 'ENOSPC' }) }
  await assert.rejects(f.service.dispatchSaved(receipt.delivery_id), { code: 'ENOSPC' })
  assert.equal(dispatches, 0)
})

test('only proven not_started requeues; unknown and restart after claim never resend old input', async t => {
  let count = 0, failure = Object.assign(Error('busy'), { effect: 'not_started' })
  const f = await fixture(t, { dispatch: async () => { count++; throw failure } })
  const receipt = await f.service.receive(f.input)
  assert.equal((await f.service.dispatchSaved(receipt.delivery_id)).delivery, 'queued')
  failure = Error('input outcome unknown')
  assert.equal((await f.service.dispatchSaved(receipt.delivery_id)).delivery, 'unknown')
  const second = await f.service.receive(f.input)
  await f.service.appendDeliveryStatus(second.delivery_id, 'dispatching')
  const restored = new DurableMessageReceipts(f.options)
  await restored.drain()
  assert.equal((await restored.dispatchSaved(second.delivery_id)).dispatched, false)
  assert.equal(count, 2)
  const completed = await f.service.receive(f.input)
  restored.dispatch = async ({ callbacks }) => { await callbacks.onStatus('delivered'); throw Object.assign(Error('late error'), { effect: 'not_started' }) }
  assert.equal((await restored.dispatchSaved(completed.delivery_id)).delivery, 'delivered')
  const old = { ...f.service.record({ deliveryId: 'legacy', from: 'bot-a', target: 'bot-b', message: 'old', delivery: 'running' }) }
  await f.service.append(old)
  assert.deepEqual(await restored.pending(), [])
})

test('saved image references and owner/Bridge metadata survive recreation; unterminated preview grants no dispatch', async t => {
  const f = await fixture(t)
  const assets = new MessageAssets({ root: f.root })
  const service = new DurableMessageReceipts({ ...f.options, assets })
  const originalPath = join(f.root, 'incoming.png')
  await writeFile(originalPath, Buffer.from('iVBORw0KGgo=', 'base64'))
  const receipt = await service.enqueueUserTurn({ target: 'bot-b', message: 'image', images: [{ path: originalPath }] })
  await rm(originalPath)
  const bridge = await service.receiveCallBridge({ event: 'session.message', session_id: 'call-1', target_id: 'bot-b', source_system: 'bridge', source_id: 'caller', source_label: 'Caller', message: 'hello', reply_required: false })
  let dispatched = 0
  const restored = new DurableMessageReceipts({ ...f.options, assets, dispatch: async ({ record, images, queue }) => {
    dispatched++
    if (record.delivery_id === receipt.delivery_id) { assert.equal(record.from, 'user'); assert.equal(images.length, 1); await readFile(images[0].path) }
    else { assert.equal(record.delivery_id, bridge.delivery_id); assert.equal(record.call_reply_required, false); assert.equal(queue.call.sessionId, 'call-1') }
    return { delivery: 'running' }
  } })
  await restored.drain(); assert.equal(dispatched, 2)
  const preview = { ...service.record({ deliveryId: 'preview', from: 'bot-a', target: 'bot-b', message: 'uncommitted', delivery: 'queued' }), durable_receipt: true }
  await appendFile(service.logPath, JSON.stringify(preview))
  assert.deepEqual(await restored.pending(), [])
  await assert.rejects(restored.dispatchSaved('preview'), { code: 'DURABLE_RECEIPT_NOT_FOUND' })
})

test('child append effect uses the sole parent writer and denies malformed records without fallback', async t => {
  const f = await fixture(t)
  const effect = createConversationParentEffects({ getServices: () => ({ directReceipts: f.service }) })
  const context = { generation: 'gen-1', operationId: 'op-1', actor: { kind: 'owner' }, continuation: false }
  const record = f.service.record({ deliveryId: 'child-id', from: 'bot-a', target: 'bot-b', message: 'child', delivery: 'running' })
  assert.deepEqual(await effect('direct.log.append', { record }, context), { applied: true })
  assert.equal((await f.service.store.records())[0].delivery_id, 'child-id')
  assert.equal(f.notices.length, 0)
  assert.throws(() => validateConversationEffect('direct.log.append', { record: { ...record, private: 'no' } }, context))
  const missing = createConversationParentEffects({ getServices: () => ({}) })
  await assert.rejects(missing('direct.log.append', { record }, context), { code: 'CONVERSATION_EFFECT_UNAVAILABLE' })
})


test('actual dispatcher sends direct append through the parent writer and emits one saved notification', async t => {
  const f = await fixture(t), fixtureData = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  for (const [relative, value] of Object.entries(fixtureData.files)) {
    const path = join(f.root, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value) + '\n')
  }
  const events = [], methods = []
  const parent = createConversationParentEffects({ getServices: () => ({ directReceipts: f.service }) })
  const dispatcher = createConversationDispatcher({ root: f.root, event: async event => events.push(event), trackBackground: () => assert.fail('unexpected background'),
    effect: async (method, params, context) => {
      methods.push(method)
      if (method === 'members.profiles.read') return { bots: fixtureData.bots }
      if (method === 'execution.assertAccess') return { allowed: true }
      if (method === 'usage.notify.direct') return { accepted: true }
      return parent(method, params, context)
    } })
  const generation = 'receipt-test', control = { generation, operationId: null }
  await dispatcher.control('initialize', { generation, mode: 'restore', bots: fixtureData.bots }, control)
  await dispatcher.control('resume', {}, control)
  const input = { from: fixtureData.bots[0].id, target: 'user', message: 'child saved', images: [] }
  const result = await dispatcher.dispatch('direct.post', input, { generation, operationId: 'receipt-child', actor: { kind: 'owner' }, continuation: false })
  assert.equal((await f.service.store.records()).find(row => row.delivery_id === result.delivery_id).message, input.message)
  assert.equal(methods.filter(method => method === 'direct.log.append').length, 1)
  assert.equal(events.length, 1); assert.equal(f.notices.length, 0)
})
