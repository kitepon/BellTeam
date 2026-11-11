// Regression for the 2026-11-11 room-post conversation child deaths (body 608a7bae; process.md "呼び出し封筒idの順序").
// conversation-channel.mjs call() assigns the call id synchronously (line 255) but sends the 'call' control frame only
// after `await encodedLength(params)` (line 270), whose microtask count grows with the number of JSON parts in params.
// Two calls issued in one macrotask therefore leave in the order of their params size, not of their ids, and the
// receiver's `id > incoming` check (line 166) kills the channel with CONVERSATION_IPC_INVALID.
// One macrotask = e.g. one Aiterm stdio chunk carrying two seats' responses (MCP StdioClientTransport.processReadBuffer
// dispatches every message of a chunk synchronously), which a room fan-out makes routine and a single direct delivery cannot.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
const { setup, createConversationDispatcher } = await import('./conversation-callframe-order-setup.mjs')
const settle = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
const words = count => Array.from({ length: count }, (_, index) => ({ text: `word ${index}`, kind: 'text', at: new Date().toISOString() }))

async function fanout(t) {
  const bots = [{ id: 'bot-seat-a', name: 'A' }, { id: 'bot-seat-b', name: 'B' }]
  const fetcher = async () => ({ ok: true, json: async () => ({ answers: { continue: { noul: 0.9 }, responder: { choice: 'bot-seat-a' } } }) })
  const origins = [], write = process.stderr.write
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).includes('CONVERSATION_CHILD_EXIT_ORIGIN')) { origins.push(JSON.parse(chunk)); return true }
    return write.call(this, chunk, ...rest)
  }
  const h = await setup(t, { bots, dispatcher: options => createConversationDispatcher({ ...options, fetcher }),
    effect: method => method === 'usage.routing.read' ? { enabled: true, epoch: 1, apiKey: 'k' } : undefined })
  t.after(() => { process.stderr.write = write })
  const path = `${h.root}/rooms/room-conversation-probe/room.json`, room = JSON.parse(readFileSync(path, 'utf8'))
  room.memberIds = h.fixture.bots.map(bot => bot.id)
  writeFileSync(path, `${JSON.stringify(room)}\n`)
  const from = h.fixture.bots[0].id
  const posted = await h.request('room.post', { from, room: room.id, message: 'hello all', images: [], targets: null }, { kind: 'bot', botId: from })
  assert.equal(posted.delivery, 'running')
  // Exactly what AitermTransport.submit does with its conversationDelivery (aiterm-transport.mjs:868).
  const seat = id => h.admission.callbacks(h.native.find(entry => entry.params.target === id).delivery)
  const finish = () => { for (const entry of h.native) h.admission.finish(entry.delivery); h.admission.finish(h.lease) }
  return { h, origins, a: seat('bot-seat-a'), b: seat('bot-seat-b'), finish }
}
const outcome = results => results.map(result => result.status === 'fulfilled' ? result.value : result.reason.code)

test('control: the same two callbacks one macrotask apart keep the child', { timeout: 20000 }, async t => {
  const { h, origins, a, b, finish } = await fanout(t)
  const first = a.onInterim(words(3))
  await new Promise(resolve => setImmediate(resolve))
  const results = await Promise.allSettled([first, b.onInterim(words(1))])
  await settle()
  assert.deepEqual(outcome(results), [{ applied: true }, { applied: true }])
  assert.equal(h.endpoints[0].connected, true); assert.deepEqual(origins, [])
  finish()
})

for (const [name, second] of [
  ['delivery.words x3 (seat A) then delivery.words x1 (seat B)', b => b.onInterim(words(1))],
  ['delivery.words x3 (seat A) then delivery.status running (seat B)', b => b.onStatus('running')],
]) test(`room fan-out, one Aiterm chunk resolves two seats: ${name}`, { timeout: 20000 }, async t => {
  const { h, origins, a, b, finish } = await fanout(t)
  const chunk = Promise.withResolvers() // one stdio chunk: both seats' pending Aiterm reads resolve in the same macrotask
  const seatA = chunk.promise.then(() => a.onInterim(words(3)))
  const seatB = chunk.promise.then(() => second(b))
  chunk.resolve()
  const pending = Promise.allSettled([seatA, seatB])
  await settle()
  console.log('parent connected', h.endpoints[0].connected, 'child exit origin', JSON.stringify(origins))
  assert.deepEqual(origins, [], 'the conversation child must not fail its channel')
  assert.equal(h.endpoints[0].connected, true)
  assert.deepEqual(outcome(await pending), [{ applied: true }, { applied: true }])
  finish()
})

// Same trigger through the real execution code: AitermTransport.followInterim/readInterim (aiterm-transport.mjs:744-791)
// for two seats of one fan-out, whose pty_observe responses arrive in one Aiterm stdio chunk.
test('room fan-out, real followInterim for two seats, both pty_observe responses in one chunk', { timeout: 20000 }, async t => {
  const { AitermTransport } = await import('../src/aiterm-transport.mjs')
  const { h, origins, a, b, finish } = await fanout(t)
  const reads = []
  const client = { call: (name, args) => new Promise(resolve => reads.push({ name, session: args.session_id, resolve })) }
  const transport = { interimInterval: 5, client, readInterim: AitermTransport.prototype.readInterim }
  const follow = (session, callbacks) => AitermTransport.prototype.followInterim.call(transport, session, { event_cursor: 7 }, callbacks.onInterim)
  const followers = [follow('seat-a', a), follow('seat-b', b)]
  while (reads.length < 2) await settle(5)
  const response = count => ({ _meta: { 'aiterm/interim_words': { schema: 'aiterm.interim-words.v1', event_cursor: 7,
    words: words(count).map((word, index) => ({ ...word, seq: index + 1 })) } } })
  assert.deepEqual(reads.map(read => [read.name, read.session]), [['pty_observe', 'seat-a'], ['pty_observe', 'seat-b']])
  // StdioClientTransport.processReadBuffer: every message of one chunk is dispatched synchronously.
  reads[0].resolve(response(3)); reads[1].resolve(response(1))
  await settle()
  console.log('parent connected', h.endpoints[0].connected, 'child exit origin', JSON.stringify(origins))
  // Later polls and the final read of stop() find no fresh words.
  const drain = setInterval(() => { for (const read of reads.splice(2)) read.resolve({}) }, 5)
  t.after(() => clearInterval(drain))
  const stops = Promise.all(followers.map(follower => follower.stop()))
  assert.deepEqual(origins, [], 'the conversation child must not fail its channel')
  assert.equal(h.endpoints[0].connected, true)
  await stops
  finish()
})

// An old parent (sender before the ordering fix) still emits call ids out of order: the new child receiver survives it,
// while replays, wrong parity and ids below the window still fail the channel.
test('new child receiver accepts an old sender\'s inverted call ids and still refuses replays', { timeout: 20000 }, async () => {
  const { EventEmitter } = await import('node:events')
  const { createConversationPeer } = await import('../src/conversation-channel.mjs')
  const child = () => {
    const endpoint = new EventEmitter(), state = { failed: null }
    endpoint.connected = true; endpoint.send = (_frame, callback) => setImmediate(() => callback?.(null))
    endpoint.disconnect = () => { endpoint.connected = false; endpoint.emit('disconnect') }
    const write = process.stderr.write
    process.stderr.write = function (chunk, ...rest) { return String(chunk).includes('CONVERSATION_CHILD_EXIT_ORIGIN') ? true : write.call(this, chunk, ...rest) }
    createConversationPeer(endpoint, { side: 'child', validateResult: () => {},
      accept: () => { throw Object.assign(new Error('NOT_HERE'), { code: 'NOT_HERE', outcome: 'not_accepted', status: 409 }) },
      onDisconnect: error => { state.failed = error.code } })
    let seq = 0
    const call = id => endpoint.emit('message', { type: 'control', operation: id, seq: seq++,
      capability: { type: 'call', kind: 'event', method: 'changed', context: null, source: null, stream: null, params: {} } })
    return { call, state, restore: () => { process.stderr.write = write } }
  }
  const run = async ids => { const h = child(); for (const id of ids) h.call(id); await settle(50); h.restore(); return h.state.failed }
  assert.equal(await run([3, 1, 7, 5, 9]), null, 'inverted ids from an old sender keep the channel')
  assert.equal(await run([3, 1, 3]), 'CONVERSATION_IPC_INVALID', 'a replayed id fails')
  assert.equal(await run([1, 4]), 'CONVERSATION_IPC_INVALID', 'the peer\'s own parity fails')
  assert.equal(await run([5001, 1]), 'CONVERSATION_IPC_INVALID', 'an id below the window fails')
})
