import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
const done = { outcome: 'done', turn_id: 'old-turn' }
const bot = { id: 'bot-a', session: 'bot-a' }
function fixture({ dispatch = async () => ({ applied: true }), kinds = ['delivery.status'] } = {}) {
  const gate = new ConversationLifetimes('old'), native = Promise.withResolvers(), running = Promise.withResolvers()
  let sends = 0, waits = 0, clientClosed = 0
  const transport = new AitermTransport({ conversationAdmission: gate, handoffContext: async () => '',
    waitProcess: () => { waits++; return native.promise }, client: { async call(name) {
      if (name === 'pty_send') { sends++; return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'local-fixture', args: [] } } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: done.turn_id, text: 'answer' } }
      if (name === 'pty_observe') return {}
      throw Error('unexpected ' + name)
    }, async close() { clientClosed++ } } })
  const root = gate.enter(undefined, 'old-root'), delivery = gate.registerDelivery(root, {
    deliveryId: 'old-delivery', target: bot.id, kinds, dispatch: async (kind, params, binding) => {
      if (params.delivery === 'running') running.resolve()
      return dispatch(kind, params, binding)
    },
  })
  const turn = () => transport.turn(bot, 'one original input', { queue: { groupId: 'old-delivery' }, conversationDelivery: delivery })
  return { gate, native, running, root, delivery, transport, turn, sends: () => sends, waits: () => waits, clientClosed: () => clientClosed }
}

test('running callback failure settles original effect before native; fresh root and other Bot are allowed while original receipt owns same Bot', { timeout: 2000 }, async () => {
  const ack = Promise.withResolvers(), original = Object.assign(Error('dead original callback'), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED', status: 503, recoveryFailure: {} })
  let callbacks = 0, continuations = 0
  const f = fixture({ dispatch: async () => { callbacks++; return ack.promise } })
  f.transport.continuation = { failed() { continuations++ }, succeeded() {}, close: async () => {} }
  const result = f.turn()
  result.catch(() => {})
  await f.running.promise
  assert.equal(f.waits(), 1)
  const binding = { generation: 'old', operationId: f.root.correlation, deliveryId: 'old-delivery', target: bot.id }
  const actual = f.gate.getNativeContinuation(f.delivery, binding)
  assert.ok(actual instanceof Promise); assert.notEqual(actual, result)
  ack.reject(original)
  await assert.rejects(result.accepted, error => error === original)
  await assert.rejects(result, error => error === original)
  assert.equal(f.transport.isIdle(bot.id), false); assert.equal(continuations, 0)
  f.gate.finish(f.root)
  const ticket = f.gate.close(); f.gate.recoverFailedGeneration(ticket, 'old', 'new'); f.gate.resume(ticket)
  const fresh = f.gate.enter(undefined, 'new-root')
  const freshInput = f.transport.turn(bot, 'fresh independent input', { queue: { groupId: 'new-delivery' } })
  await freshInput.accepted; f.gate.finish(fresh)
  f.transport.assertConversationOccupation('bot-b')
  assert.equal(f.transport.watchTurn(bot, 'bot-a', { turn_id: 'old-turn' }, { groupId: () => 'fresh-watch' }), null)
  let idle = false; const waiting = f.transport.idle(bot.id).then(() => { idle = true })
  await tick(); assert.equal(idle, false); assert.equal(f.sends(), 2); assert.equal(f.waits(), 2)
  f.native.resolve(done); assert.equal(await actual, done); assert.equal(await freshInput, 'answer'); await waiting
  assert.equal(f.transport.isIdle(bot.id), true)
  await tick(); assert.equal(f.gate.snapshot().active, 0)
  await assert.rejects(f.gate.drainForClose(f.gate.close()), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.equal(callbacks, 1); assert.equal(continuations, 0); await f.transport.close()
})

test('current generation capacity continuation waits real resource cleanup and can still use its normal guard', { timeout: 2000 }, async () => {
  const f = fixture(), failure = Object.assign(Error('bound terminal capacity'), { turnCompleted: true, recoveryFailure: {} })
  const resumed = Promise.withResolvers()
  f.transport.continuation = { succeeded() {}, close: async () => {}, failed(context) {
    try { context.check(); assert.equal(f.transport.isIdle(bot.id), true); resumed.resolve() }
    catch (error) { resumed.reject(error) }
  } }
  const result = f.turn(); result.catch(() => {}); await result.accepted
  f.gate.finish(f.root); f.native.reject(failure)
  await assert.rejects(result, error => error === failure); await resumed.promise
  assert.equal(f.sends(), 1); await f.transport.close()
})

test('retired watch callback fails without aborting its native waiter; whole close waits that actual terminal', { timeout: 2000 }, async () => {
  const f = fixture()
  f.gate.finishUnclaimedDelivery(f.delivery); f.gate.finish(f.root)
  let say
  f.transport.followInterim = (_session, _receipt, callback) => { say = callback; return { stop: async () => ({ error: false }) } }
  const watch = f.transport.watchTurn(bot, bot.id, { turn_id: 'old-watch', event_cursor: 1, wait_process: { executable: 'local-fixture', args: [] } },
    { onInterim: async () => ({ applied: true }), groupId: () => 'watch-delivery' })
  await tick(); assert.equal(f.waits(), 1)
  const ticket = f.gate.close(); f.gate.recoverFailedGeneration(ticket, 'old', 'new'); f.gate.resume(ticket)
  await assert.rejects(say([{ text: 'old words' }]), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  const fresh = f.gate.enter(); f.gate.finish(fresh)
  let closed = false; const close = f.transport.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false); assert.equal(watch.stop.signal.aborted, false)
  assert.equal(f.transport.isIdle(bot.id), false); assert.equal(f.clientClosed(), 0)
  f.native.resolve(done); await close; await watch.completion; await tick()
  assert.equal(f.transport.isIdle(bot.id), true); assert.equal(f.gate.snapshot().active, 0)
  assert.equal(f.clientClosed(), 1); assert.equal(f.sends(), 0); assert.equal(f.waits(), 1)
  await assert.rejects(f.gate.drainForClose(f.gate.close()), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
})

test('real terminal native failure releases old physical occupation without changing original callback failure', { timeout: 2000 }, async () => {
  const original = Error('original writer gone'), f = fixture({ dispatch: async () => { throw original } }), result = f.turn()
  await assert.rejects(result, error => error === original)
  f.gate.finish(f.root)
  const ticket = f.gate.close(); f.gate.recoverFailedGeneration(ticket, 'old', 'new'); f.gate.resume(ticket)
  assert.equal(f.transport.isIdle(bot.id), false)
  f.native.resolve({ outcome: 'error', error: 'actual native terminal' })
  await f.transport.idle(bot.id); await tick()
  assert.equal(f.transport.isIdle(bot.id), true); assert.equal(f.gate.snapshot().active, 0)
  assert.equal(f.sends(), 1); await f.transport.close()
})

test('unknown native rejection stays the same rejected promise and an explicit occupation fence; close cannot report success', { timeout: 2000 }, async () => {
  const f = fixture(), result = f.turn(), original = Error('native observer lost')
  result.catch(() => {}); await result.accepted
  f.gate.finish(f.root)
  f.native.reject(original); await assert.rejects(result, error => error === original); await tick()
  assert.equal(f.transport.isIdle(bot.id), false); assert.equal(f.gate.snapshot().active, 2)
  await assert.rejects(f.transport.idle(bot.id), error => error === original)
  const ticket = f.gate.close(); f.gate.recoverFailedGeneration(ticket, 'old', 'new'); f.gate.resume(ticket)
  const fresh = f.gate.enter(); f.gate.finish(fresh)
  assert.deepEqual(await f.gate.drainForClose(f.gate.close(), { timeoutMs: 0 }), { status: 'busy' })
  assert.throws(() => f.transport.assertConversationOccupation(bot.id), { code: 'CONVERSATION_NOT_ACCEPTED' })
  await assert.rejects(f.transport.close(), error => error === original)
  assert.equal(f.clientClosed(), 0); assert.equal(f.sends(), 1); assert.equal(f.waits(), 1)
})

test('fresh submit bypasses retired tracking and still waits its normal resource cleanup', { timeout: 2000 }, async () => {
  const f = fixture(), result = f.turn(); await result.accepted
  f.gate.finish(f.root)
  const ticket = f.gate.close(); f.gate.recoverFailedGeneration(ticket, 'old', 'new'); f.gate.resume(ticket)
  const fresh = f.transport.turn(bot, 'fresh independent input'); await fresh.accepted
  f.native.resolve(done); await assert.rejects(result, { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' }); await f.transport.idle(bot.id)
  assert.equal(await fresh, 'answer'); assert.equal(f.sends(), 2); await f.transport.close()
  const cleanup = Promise.withResolvers(), entered = Promise.withResolvers()
  const transport = new AitermTransport({ waitProcess: async () => done, client: { async call(name) {
    if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'local-fixture', args: [] } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: done.turn_id, text: 'answer' } }
    throw Error('unexpected ' + name)
  }, async close() {} } })
  transport.removeTemporaryImages = async () => { entered.resolve(); await cleanup.promise }
  const legacy = transport.turn(bot, 'one normal input')
  let returned = false; legacy.then(() => { returned = true })
  await entered.promise; await tick(); assert.equal(returned, false)
  cleanup.resolve(); assert.equal(await legacy, 'answer'); await transport.close()
})
