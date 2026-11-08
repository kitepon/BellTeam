import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { createExecutionFacade } from '../src/execution-facade.mjs'

// after_turn contract (current-work.md): currentTurn read + watchCurrentTurn change stream over the parent queue stream.
test('currentTurn follows the native observation; watchCurrentTurn emits every change including unknown exits', async t => {
  let clock = 0, seats = []
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude' }
  const transport = new AitermTransport({ client: { async call(name) {
    assert.equal(name, 'pty_list')
    return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats } } }
  } } })
  transport.workState.monotonic = () => clock
  t.after(() => transport.close())
  const row = turn => ({ session_id: 'bot-a', launch_id: 'a'.repeat(32), harness: 'claude-code', turn })
  const running = id => row({ state: 'running', turn_id: id, started_at: new Date(0).toISOString(),
    event_cursor: null, interim_from: null, wait_process: null })
  const listeners = new Set()
  transport.watchQueue(change => { for (const listener of listeners) listener(change) })
  let refuse = false
  const facade = createExecutionFacade({ client: {}, membersAdmission: {}, requestStop() {},
    watchQueue: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    getController: () => ({ dispatch() {}, close() {}, project: ({ method, args }) => {
      if (refuse) throw Object.assign(new Error('EXECUTION_NOT_ACCEPTING'), { code: 'EXECUTION_NOT_ACCEPTING' })
      return transport[method.split('.')[1]](...args)
    } }) })
  const events = []
  const stop = facade.transport.watchCurrentTurn(event => events.push(event))
  const poll = () => transport.seatTurns([bot])

  assert.deepEqual(transport.currentTurn('bot-a'), { state: 'unknown', turnId: null })
  seats = [running('one')]; await poll()
  const one = transport.currentTurn('bot-a')
  assert.equal(one.state, 'working'); assert.match(one.turnId, /^[0-9a-f]{64}$/u)
  // startedAt only on request; the default stays {state,turnId} for the members after_turn validators.
  assert.deepEqual(Object.keys(one), ['state', 'turnId'])
  assert.deepEqual(transport.currentTurn('bot-a', { startedAt: true }), { ...one, startedAt: new Date(0).toISOString() })
  seats = [running('two')]; await poll()
  const two = transport.currentTurn('bot-a')
  assert.notEqual(two.turnId, one.turnId)
  seats = [row({ state: 'idle' })]; await poll()
  assert.deepEqual(transport.currentTurn('bot-a'), { state: 'idle', turnId: null })
  assert.deepEqual(transport.currentTurn('bot-a', { startedAt: true }), { state: 'idle', turnId: null, startedAt: null })
  // Stale observation is unknown (not idle); the next valid read leaves it on its own.
  clock = 20_000
  assert.deepEqual(transport.currentTurn('bot-a'), { state: 'unknown', turnId: null })
  // No live seat in a valid read: idle for after_turn, while the Bot list keeps unknown.
  seats = []; await poll()
  assert.deepEqual(transport.currentTurn('bot-a'), { state: 'idle', turnId: null })
  assert.equal(transport.currentWork(bot).state, 'unknown')
  // A read refused during an exchange is retried on the next change.
  refuse = true; seats = [running('three')]; await poll()
  refuse = false; transport.emitQueue({ bot: { id: 'bot-other' } })
  const own = events.filter(event => event.botId === 'bot-a')
  assert.deepEqual(own.map(event => event.state), ['working', 'working', 'idle', 'unknown', 'idle', 'working'])
  assert.equal(own[0].turnId, one.turnId); assert.equal(own[1].turnId, two.turnId)
  assert.deepEqual(own.map(event => event.startedAt), [0, 0, null, null, null, 0].map(value => value === null ? null : new Date(value).toISOString()))
  assert.deepEqual(events.filter(event => event.botId === 'bot-other'), [{ botId: 'bot-other', state: 'unknown', turnId: null, startedAt: null }])
  stop()
  const count = events.length
  seats = [row({ state: 'idle' })]; await poll()
  assert.equal(events.length, count)
})

test('the managed transport path exposes the same watchCurrentTurn stream', async t => {
  let seats = []
  const transport = new AitermTransport({ client: { async call() {
    return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats } } }
  } } })
  t.after(() => transport.close())
  const events = [], stop = transport.watchCurrentTurn(event => events.push(event))
  seats = [{ session_id: 'bot-a', launch_id: 'a'.repeat(32), harness: 'claude-code', turn: { state: 'idle' } }]
  await transport.seatTurns([{ id: 'bot-a', session: 'bot-a', harness: 'claude' }])
  assert.deepEqual(events, [{ botId: 'bot-a', state: 'idle', turnId: null, startedAt: null }])
  stop()
})
