import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const bot = { id: 'bot-test', session: 'bot-test', harness: 'codex' }, launchId = 'a'.repeat(32)
const source = { sourceSession: bot.id, source: { launch: { session_id: bot.id, launch_id: launchId }, boundary: null } }
const seat = () => ({ session_id: bot.id, launch_id: launchId, harness: 'codex-cli', turn: {
  state: 'running', turn_id: 'turn-a', event_cursor: 10, wait_process: { executable: 'fake', args: [] },
} })
const response = (...seats) => ({ _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats } } })
const never = () => new Promise(() => {})
function fixture(t, options = {}) {
  const calls = [], transport = new AitermTransport({
    client: { async call(name, ...args) { calls.push(name); assert.equal(name, 'pty_list'); return response(seat()) } },
    waitProcess: never, ...options,
  })
  t.after(() => transport.close())
  return { calls, transport }
}

test('existing observer supplies status; removed self writer adds no RPC and queue SSE is reused', async t => {
  const f = fixture(t), { transport } = f, changes = []
  transport.watchQueue(value => changes.push(value))
  await transport.watchSeatTurns([bot])
  assert.equal(transport.currentWorkBinding(bot, source), null)
  assert.equal(transport.currentWork(bot).state, 'working')
  assert.throws(() => transport.updateWorkSummary(bot, {}, source), { code: 'CURRENT_WORK_FORBIDDEN' })
  assert.deepEqual(f.calls, ['pty_list'])
  assert.ok(changes.some(change => change.topics.includes('queue') && change.botIds.includes(bot.id)))
  assert.equal(transport.queueItems().length, 1)
  await transport.watchSeatTurns([bot]); assert.equal(transport.queueItems().length, 1)
  assert.equal(transport.currentWork(bot).summary, null)
})
test('normal stop acceptance invalidates synchronously and sent is not idle', async t => {
  const { transport } = fixture(t, { requestStop: async () => ({ status: 'sent', targets: [{ status: 'sent', session_id: bot.id }] }) })
  await transport.watchSeatTurns([bot])
  const stopping = transport.interrupt(bot)
  assert.equal(transport.currentWork(bot).state, 'unknown'); assert.equal(transport.currentWork(bot).summary, null)
  assert.equal((await stopping).status, 'stop_sent'); assert.equal(transport.currentWork(bot).state, 'unknown')
})
test('existing matching wait done invalidates the turn without inventing idle; uncertainty is retained', async t => {
  const { transport } = fixture(t, { waitProcess: async () => ({ schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: bot.id, launch_id: launchId, turn_id: 'turn-a' }) })
  await transport.seatTurns([bot]); assert.equal(transport.currentWork(bot).state, 'working')
  await transport.waitUntilDone({ wait_process: {} }); assert.equal(transport.currentWork(bot).state, 'unknown')
  await transport.seatTurns([bot]); assert.equal(transport.currentWork(bot).state, 'unknown')
})
test('an old in-flight observer cannot restore status after stop or a new launch', async t => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const { transport } = fixture(t, { client: { call: async () => { started(); return new Promise(resolve => { release = resolve }) } } })
  const poll = transport.seatTurns([bot]); await began
  transport.sessionState.invalidate(bot.id)
  release(response(seat())); await poll; assert.equal(transport.currentWork(bot).state, 'unknown')
})

test('session retirement clears summary at issuance and pending generation changes remain unknown', async t => {
  let finish
  const { transport } = fixture(t, { client: { async call(name) {
    if (name === 'pty_list') return response(seat())
    assert.equal(name, 'pty_close'); return new Promise(resolve => { finish = resolve })
  } } })
  await transport.seatTurns([bot])
  const closing = transport.changeSession(bot, 'pty_close', { session_id: bot.id })
  assert.equal(transport.currentWork(bot).state, 'unknown')
  await transport.seatTurns([bot]); assert.equal(transport.currentWorkBinding(bot, source), null)
  finish({ structuredContent: { schema: 'aiterm.pty-close-result.v1', outcome: 'closed', session_id: bot.id } }); await closing
})
