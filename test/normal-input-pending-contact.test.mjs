import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationPeer, normalInputPending } from '../src/conversation-channel.mjs'
import { createDirectReceiptAssembly } from '../src/direct-receipt-assembly.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

const pendingError = (deliveryId, botId = 'bot-target') => Object.assign(new Error('private raw failure'), {
  code: 'BOT_SESSION_UNCONFIRMED', effect: 'not_started',
  normalInputPending: { schema: 'bellteam.normal-input-pending.v1', deliveryId, botId,
    sessionId: botId, launchId: null, stage: 'before_execution_registration', effect: 'not_started', reason: 'session_absent' },
})

test('two error-frame hops preserve exact pending proof and existing sanitized failure fields', { timeout: 3000 }, async t => {
  const endpoints = [new EventEmitter(), new EventEmitter()]
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const copy = deserialize(serialize(frame))
      setImmediate(() => { endpoints[1 - index].emit('message', copy); callback?.() })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) if (peer.connected) { peer.connected = false; peer.emit('disconnect') } }
  }
  const error = pendingError('new-id')
  error.mcp_error = { tool: 'pty_observe', message: 'safe typed failure', truncated: false }
  error.native_launch = { harness: 'antigravity-cli', session_created: true,
    startup: { status: 'blocked', reason: 'vendor_action_required' },
    initial_prompt: { status: 'not_requested', reason: 'not_requested', turn_started: false } }
  const parent = createConversationPeer(endpoints[0], { side: 'parent', validateResult() {},
    accept: () => async () => { throw error } })
  const child = createConversationPeer(endpoints[1], { side: 'child', validateResult() {},
    accept: () => async () => child.call('effect', 'native.probe', {}) })
  t.after(() => { parent.close(); parent.reaped(); child.reaped() })
  const attempt = parent.call('root', 'new.input', {})
  await assert.rejects(attempt, received => {
    assert.equal(received.code, 'BOT_SESSION_UNCONFIRMED')
    assert.deepEqual(normalInputPending(received), error.normalInputPending)
    assert.deepEqual(received.mcp_error, error.mcp_error)
    assert.deepEqual(received.native_launch, error.native_launch)
    assert.equal(received.message, 'BOT_SESSION_UNCONFIRMED')
    return true
  })
  await Promise.allSettled([attempt.completion])
  assert.equal(normalInputPending({ ...error, normalInputPending: { ...error.normalInputPending, extra: true } }), null)
  assert.equal(normalInputPending({ code: error.code, effect: 'not_started' }), null)
  assert.equal(normalInputPending({ ...error, normalInputPending: { ...error.normalInputPending,
    reason: 'session_not_ready', launchId: ['a'.repeat(32)] } }), null)
})

test('parent requeues only matching new proof and resumes that saved ID on a later drain', { timeout: 3000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'normal-input-pending-'))
  const bots = new Map(['bot-source', 'bot-target'].map(id => [id, { id, name: id, position: '', role: '' }]))
  bots.refresh = async () => {}
  let mode = 'pending', calls = 0
  const transport = { membersAdmission: { withLease: run => run({}) },
    async notify(bot, _message, options) {
      calls++
      if (mode === 'ready') return { delivery: 'steered' }
      if (mode === 'pending') throw pendingError(options.queue.groupId, bot.id)
      if (mode === 'wrong-id') throw pendingError('another-id', bot.id)
      throw Object.assign(new Error('not a receipt'), { code: 'BOT_SESSION_UNCONFIRMED', effect: 'not_started' })
    } }
  const aiControl = { paused: false, admit: () => () => {}, watch: () => () => {} }
  const legacy = new BellTeamMessenger({ bots, transport, logPath: join(root, 'logs/direct-messages.jsonl') })
  const direct = createDirectReceiptAssembly({ root, bots, transport, aiControl, legacy,
    conversation: { captureReceipt() {} }, exchangeMutex: { waitForIdle: async () => {} }, onMessage() {}, onError: assert.fail })
  t.after(async () => { await direct.close(); await rm(root, { recursive: true, force: true }) })
  const first = await direct.messenger.sendmessage({ from: 'bot-source', target: 'bot-target', message: 'new input' })
  assert.equal((await direct.receipts.dispatchSaved(first.delivery_id)).delivery, 'queued')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  mode = 'ready'
  const resumed = await direct.receipts.drain()
  assert.equal(resumed[0].delivery_id, first.delivery_id)
  assert.equal(resumed[0].dispatched, true)
  await direct.receipts.drain()
  assert.equal(calls, 2)
  for (const nextMode of ['wrong-id', 'code-only']) {
    mode = nextMode
    const next = await direct.messenger.sendmessage({ from: 'bot-source', target: 'bot-target', message: nextMode })
    assert.equal((await direct.receipts.dispatchSaved(next.delivery_id)).delivery, 'unknown')
  }
  assert.equal(calls, 4)
  await direct.receipts.drain()
  assert.equal(calls, 4)
})
