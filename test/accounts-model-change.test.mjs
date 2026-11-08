import assert from 'node:assert/strict'
import test from 'node:test'

import { AitermTransport } from '../src/aiterm-transport.mjs'

// harness-accounts.md "Selection, failover and return": a model change in place re-selects the seat's account.
test('a Claude model change in place moves the seat to the slot of the new model at the next boundary', async () => {
  const calls = []
  const client = { call: async (name, args) => { calls.push([name, args]); return { structuredContent: { schema: 'aiterm.agent-configure-result.v1', session_id: args.session_id } } } }
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: { 'bot-a': '1st' } }, seatSlot: () => '1st' }
  const transport = new AitermTransport({ client, accounts })
  const moved = []
  transport.moveAtBoundary = botId => moved.push(botId)
  const current = { id: 'bot-a', session: 'bot-a', harness: 'claude', model: 'opus', reasoningEffort: 'high', project: '/tmp' }
  await transport.reconfigure(current, { ...current, reasoningEffort: 'xhigh' })
  assert.deepEqual(moved, [], 'an effort-only change keeps the account')
  await transport.reconfigure(current, { ...current, model: 'fable' })
  assert.deepEqual(moved, ['bot-a'])
  assert.deepEqual(calls.at(-1), ['agent_configure', { session_id: 'bot-a', model: 'fable', reasoning_effort: 'high' }])
})
