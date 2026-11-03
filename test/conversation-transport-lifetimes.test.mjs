import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex' }, launch = 'a'.repeat(32)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const done = () => ({ schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: bot.id, launch_id: launch, turn_id: 'turn-a' })
function fixture(t, { kinds = ['delivery.status'], dispatch = async () => ({ applied: true }), interim = [], ...options } = {}) {
  const gate = new ConversationLifetimes('builtin:test'), wait = deferred(), calls = []
  let native = 0
  const transport = new AitermTransport({ conversationAdmission: gate, handoffContext: async () => '',
    client: { async call(name) {
      calls.push(name)
      if (name === 'pty_send') { native++; assert.ok(gate.snapshot().active >= 2); return { structuredContent: { mode: 'agent_dispatch', session_id: bot.id, launch_id: launch, event_cursor: 10, wait_process: { executable: 'fake', args: [] } } } }
      if (name === 'pty_observe') return { _meta: { 'aiterm/interim_words': { schema: 'aiterm.interim-words.v1', event_cursor: 10, words: interim } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', turn_id: 'turn-a', text: 'reply' } }
      if (name === 'pty_list') return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [{ session_id: bot.id, launch_id: launch, harness: 'codex-cli', turn: { state: 'running', turn_id: 'turn-a', event_cursor: 10, wait_process: { executable: 'fake', args: [] } } }] } } }
      throw Error('unexpected ' + name)
    } }, waitProcess: () => wait.promise, ...options,
  })
  t.after(async () => { wait.resolve(done()); await transport.close() })
  const root = gate.enter(undefined, 'root-a'), delivery = gate.registerDelivery(root, { deliveryId: 'delivery-a', target: bot.id, kinds, dispatch })
  return { gate, wait, calls, transport, root, delivery, get native() { return native } }
}

test('notify accepted releases caller only, long native job stays busy through 60 seconds without abort or resend', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t)
  assert.deepEqual(await f.transport.notify(bot, 'one input', { queue: { groupId: 'delivery-a' }, conversationDelivery: f.delivery }), { delivery: 'running' })
  f.gate.finish(f.root); const ticket = f.gate.close(), drain = f.gate.drain(ticket)
  t.mock.timers.tick(60_000); assert.deepEqual(await drain, { status: 'busy' }); assert.equal(f.native, 1)
  f.gate.assertLease(f.delivery); f.gate.resume(ticket); f.wait.resolve(done()); await f.transport.idle(bot.id); await tick()
  assert.deepEqual(await f.gate.drain(f.gate.close()), { status: 'drained' }); assert.equal(f.native, 1)
})
test('user.complete save ACK is tracked before native issuance and is separate from accepted', async t => {
  const ack = deferred(), began = deferred()
  const f = fixture(t, { kinds: ['delivery.status', 'user.complete'], dispatch: async (kind, params, binding) => {
    assert.equal(binding.deliveryId, 'delivery-a')
    if (kind === 'user.complete') { assert.deepEqual(params, { reply: 'reply' }); began.resolve(); return ack.promise }
    return { applied: true }
  } })
  const completion = f.transport.turn(bot, 'one input', { queue: { groupId: 'delivery-a' }, conversationDelivery: f.delivery })
  await completion.accepted; f.gate.finish(f.root); const ticket = f.gate.close()
  f.wait.resolve(done()); await began.promise
  assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  ack.resolve({ applied: true }); assert.equal(await completion, 'reply'); await tick()
  assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' }); assert.equal(f.native, 1)
})
test('nonawait turn.end holds old callback lifetime after native job idle without delaying accepted', async t => {
  const background = deferred(), began = deferred()
  const f = fixture(t, { kinds: ['turn.end'], dispatch: async (kind) => { assert.equal(kind, 'turn.end'); began.resolve(); return background.promise } })
  await f.transport.notify(bot, 'one', { queue: { groupId: 'delivery-a' }, conversationDelivery: f.delivery })
  f.gate.finish(f.root); const ticket = f.gate.close(); f.wait.resolve(done()); await began.promise; await f.transport.idle(bot.id)
  assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  background.resolve({ applied: true }); await tick(); assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' })
})
test('one registered delivery cannot issue native twice or switch its target', async t => {
  const f = fixture(t)
  await f.transport.notify(bot, 'one', { queue: { groupId: 'delivery-a' }, conversationDelivery: f.delivery })
  await assert.rejects(f.transport.notify(bot, 'duplicate', { queue: { groupId: 'delivery-a' }, conversationDelivery: f.delivery }), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  assert.equal(f.native, 1); f.gate.finish(f.root); f.wait.resolve(done()); await f.transport.idle(bot.id)
})
test('closing conversation admission prevents only new watches while currentWork and existing end detection continue', async t => {
  const f = fixture(t, { kinds: [] })
  f.gate.finish(f.delivery); f.gate.finish(f.root); await tick()
  const ticket = f.gate.close()
  await f.transport.watchSeatTurns([bot]); assert.equal(f.transport.watches.size, 0); assert.equal(f.transport.currentWork(bot).state, 'working')
  f.gate.resume(ticket); await f.transport.watchSeatTurns([bot]); assert.equal(f.transport.watches.size, 1)
  const waiting = f.gate.close(); f.wait.resolve(done()); await f.transport.idle(bot.id); await tick()
  assert.deepEqual(await f.gate.drain(waiting), { status: 'drained' })
  assert.equal(f.calls.filter(name => name === 'pty_list').length, 2); assert.equal(f.native, 0)
})
test('derived report uses the same old operation but still obeys global stop and never recursively reports', async t => {
  const f = fixture(t, { kinds: [], assertWorkAllowed: () => { throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) } })
  let report, status
  await f.gate.runBackground(f.delivery, async () => {
    report = f.gate.deriveReport(f.delivery, { deliveryId: 'report-a', reason: 'missing', dispatch: async (kind, params) => { status = params; return { applied: true } } })
    await assert.rejects(f.transport.notifyReport(bot, 'fixed report request', { queue: { groupId: 'report-a', context: 'report' }, conversationDelivery: report }), { code: 'AI_GLOBAL_PAUSED' })
    assert.equal(status.delivery, 'stopped'); assert.equal(status.error.code, 'AI_GLOBAL_PAUSED')
  })
  f.gate.finish(f.delivery); f.gate.finish(f.root); await tick()
  assert.equal(f.native, 0); assert.deepEqual(await f.gate.drain(f.gate.close()), { status: 'drained' })
})

test('followInterim final read and slow words ACK remain part of the real job after native done', async t => {
  const ack = deferred(), began = deferred()
  const f = fixture(t, { kinds: ['delivery.words'], interim: [{ seq: 1, text: 'last words', kind: 'interim' }], dispatch: async (kind, params) => {
    assert.equal(kind, 'delivery.words'); assert.equal(params.words[0].text, 'last words'); began.resolve(); return ack.promise
  } })
  await f.transport.notify(bot, 'one', { queue: { groupId: 'delivery-a' }, conversationDelivery: f.delivery })
  f.gate.finish(f.root); const ticket = f.gate.close(); f.wait.resolve(done()); await began.promise
  assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  ack.resolve({ applied: true }); await f.transport.idle(bot.id); await tick()
  assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' }); assert.equal(f.native, 1)
})
test('existing watch keeps its captured generation through final interim ACK while new watch admission is closed', async t => {
  const ack = deferred(), began = deferred()
  const f = fixture(t, { kinds: [], interim: [{ seq: 1, text: 'watch words' }] })
  f.gate.finish(f.delivery); f.gate.finish(f.root); await tick()
  await f.transport.watchSeatTurns([bot], { onInterim: async (botId, groupId, words, binding) => {
    assert.equal(binding.generation, 'builtin:test'); assert.equal(binding.target, bot.id); assert.equal(binding.callbackKind, 'delivery.words')
    assert.equal(words[0].text, 'watch words'); began.resolve(); return ack.promise
  } })
  const ticket = f.gate.close(); f.wait.resolve(done()); await began.promise
  assert.deepEqual(await f.gate.drain(ticket, { timeoutMs: 0 }), { status: 'busy' })
  ack.resolve({ applied: true }); await f.transport.idle(bot.id); await tick()
  assert.deepEqual(await f.gate.drain(ticket), { status: 'drained' }); assert.equal(f.native, 0)
  assert.equal(f.calls.filter(name => name === 'pty_list').length, 1)
})


test('shown prefix consumption preserves words appended after the snapshot and its original object', () => {
  const transport = new AitermTransport(), shown = { words: ['first', 'second'], endedAt: 42 }
  transport.activity.shownWords.set(bot.id, shown)
  const actual = transport.shownInSelfTurn(bot.id), prefix = [...actual.words]
  shown.words.push('later')
  assert.equal(transport.consumeShownWords(bot.id, actual, prefix), true)
  assert.equal(transport.shownInSelfTurn(bot.id), shown)
  assert.deepEqual(shown, { words: ['later'], endedAt: 42 })
})

test('shown prefix consumption cannot clear a new watch or a concurrently consumed prefix', () => {
  for (const kind of ['new-object', 'changed-prefix', 'wrong-bot']) {
    const transport = new AitermTransport(), shown = { words: ['first'], endedAt: null }, prefix = [...shown.words]
    transport.activity.shownWords.set(bot.id, shown)
    if (kind === 'new-object') transport.activity.shownWords.set(bot.id, { words: ['first', 'new'], endedAt: null })
    if (kind === 'changed-prefix') shown.words.splice(0, 1, 'new')
    const current = transport.shownInSelfTurn(bot.id), before = structuredClone(current)
    assert.equal(transport.consumeShownWords(kind === 'wrong-bot' ? 'other' : bot.id, shown, prefix), false)
    assert.deepEqual(current, before)
  }
})

test('shown prefix consumption rejects malformed input without changing displayed words', () => {
  const transport = new AitermTransport(), shown = { words: ['first'], endedAt: null }
  transport.activity.shownWords.set(bot.id, shown)
  assert.equal(transport.consumeShownWords(bot.id, shown, []), false)
  assert.throws(() => transport.consumeShownWords(bot.id, shown, [null]), { code: 'CONVERSATION_SHOWN_INVALID' })
  assert.deepEqual(shown.words, ['first'])
})
