import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermTransport } from '../src/aiterm-transport.mjs'

// current-work.md "Non-Codex word watch": synthetic Aiterm 0.70.5 rows, not live native acceptance.
test('a Claude span with a start token shows its words without a waiter and ends on idle', async t => {
  const bot = { id: 'bot-c', session: 'bot-c', harness: 'claude' }
  const launch = 'b'.repeat(32), observed = []
  let turn = { state: 'running', turn_id: 'managed:' + 'c'.repeat(32), started_at: new Date().toISOString(),
    event_cursor: null, interim_from: 'v1:7:b:120', wait_process: null }
  const words = [{ seq: 1, text: 'looking', kind: 'interim', at: null, turn_id: null }]
  const transport = new AitermTransport({
    interimInterval: 1,
    client: { async call(name, args, options) {
      if (name === 'pty_list') return { _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1',
        seats: [{ session_id: 'bot-c', launch_id: launch, harness: 'claude-code', turn }] } } }
      assert.equal(name, 'pty_observe')
      observed.push(options.meta['aiterm/interim_from'])
      return { _meta: { 'aiterm/interim_words': { schema: 'aiterm.interim-words.v1', event_cursor: 7, words } } }
    } },
    waitProcess: () => assert.fail('a non-Codex span has no waiter'),
  })
  t.after(() => transport.close())
  const shown = []
  const onInterim = async (botId, groupId, value) => { shown.push(...value.map(word => word.text)) }

  // A span holding a BellTeam-sent turn of this launch (sent cursor not below the token) is not watched.
  transport.activity.sentCursors.set(bot.id, { launchId: launch, cursor: 7 })
  await transport.watchSeatTurns([bot], { onInterim })
  assert.equal(transport.activity.watches.size, 0)

  transport.activity.sentCursors.set(bot.id, { launchId: launch, cursor: 6 })
  await transport.watchSeatTurns([bot], { onInterim })
  const watch = transport.activity.watches.get(bot.id)
  assert.ok(watch?.wordsOnly)
  while (!shown.length) await new Promise(resolve => setTimeout(resolve, 2))
  assert.deepEqual(shown, ['looking'])
  assert.ok(observed.every(from => from === 'v1:7:b:120'))

  turn = { state: 'idle' }
  await transport.watchSeatTurns([bot], { onInterim })
  await watch.completion
  assert.equal(transport.activity.watches.size, 0)
  assert.deepEqual(shown, ['looking'])
})
