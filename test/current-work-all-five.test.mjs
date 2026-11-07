import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'

// Contracted producer rows; these fixtures do not claim live native acceptance.
test('all five activity rows preserve parent waits and isolate the Codex watcher', async t => {
  let clock = 720_000
  const epoch = 1_800_000_000_000, calls = []
  const bots = ['codex', 'claude', 'grok', 'cursor', 'antigravity'].map(harness => ({
    id: `bot-${harness}`, session: `bot-${harness}`, harness,
  }))
  const rows = bots.map(bot => ({
    session_id: bot.id, launch_id: 'a'.repeat(32),
    harness: bot.harness === 'claude' ? 'claude-code' : `${bot.harness}-cli`,
    turn: { state: 'running', turn_id: `${bot.harness}-parent`, started_at: new Date(epoch).toISOString(),
      event_cursor: null, interim_from: null, wait_process: null },
  }))
  Object.assign(rows[0].turn, { event_cursor: 10, interim_from: 'native-boundary',
    wait_process: { executable: 'fixture-waiter', args: [], windows_start_process_argument_list: null } })
  const running = rows.map(row => structuredClone(row.turn))
  let seats = rows
  const transport = new AitermTransport({
    now: () => new Date(epoch + clock).toISOString(),
    client: { async call(name) {
      calls.push(name); assert.equal(name, 'pty_list')
      return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats } } }
    } },
    waitProcess: () => { assert.fail('observation-only rows must not invoke a waiter') },
  })
  transport.workState.monotonic = () => clock
  t.after(() => transport.close())
  const states = () => bots.map(bot => transport.currentWork(bot).state)
  const bindings = () => bots.map(bot => transport.workState.binding(bot.id, bot.id))
  const poll = () => transport.seatTurns(bots)

  const legacy = await poll()
  assert.deepEqual([...legacy.keys()], [bots[0].id])
  assert.strictEqual(legacy.get(bots[0].id), rows[0].turn)
  assert.deepEqual(states(), bots.map(() => 'working'))
  const first = bindings()
  assert.ok(first.every(Boolean))
  assert.ok(bots.every(bot => transport.currentWork(bot).summaryStatus === 'missing'))

  // The same positively occupied parent is twelve minutes old; fresh reads, not its start, set age.
  clock += 14_000
  await poll()
  assert.deepEqual(bindings(), first)
  assert.ok(bots.every(bot => transport.currentWork(bot).observedAt === new Date(epoch + clock).toISOString()))
  await transport.watchSeatTurns(bots.slice(1))
  assert.equal(transport.activity.watches.size, 0)
  assert.ok(calls.every(name => name === 'pty_list'))

  clock += 15_000
  assert.deepEqual(states(), bots.map(() => 'unknown'))
  await poll()
  assert.deepEqual(states(), bots.map(() => 'working'))

  // The producer positively settles the parent while its detached child still exists off-wire.
  const detachedChildren = new Set(['detached-child'])
  for (const row of rows) row.turn = { state: 'idle' }
  await poll()
  assert.deepEqual(states(), bots.map(() => 'idle'))
  assert.deepEqual(bindings(), bots.map(() => null))
  assert.equal(detachedChildren.size, 1)

  for (let i = 0; i < rows.length; i++) rows[i].turn = { ...running[i], turn_id: `next-${i}` }
  await poll()
  assert.deepEqual(bindings().map(value => value.turnId), bots.map((_, i) => `next-${i}`))
  seats = [...rows, rows[1]]
  await poll()
  assert.equal(transport.currentWork(bots[1]).state, 'unknown')
  seats = rows
  rows[1].turn = null
  await poll()
  assert.equal(transport.currentWork(bots[1]).state, 'unknown')
  rows[1].turn = { ...running[1], wait_process: {} }
  await poll()
  assert.equal(transport.currentWork(bots[1]).state, 'unknown')
  rows[1].turn = { ...running[1], started_at: 'not-a-date' }
  await poll()
  assert.equal(transport.currentWork(bots[1]).state, 'unknown')
  rows[1].turn = running[1]
  rows[1].harness = 'codex-cli'
  await poll()
  assert.equal(transport.currentWork(bots[1]).state, 'unknown')
})
