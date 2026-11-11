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

// harness-accounts.md: the switch starts a new seat on the selected slot and leaves the old one; no pty_close.
test('switchAccount launches a new seat for a running member and only renames a seat that is not running', async () => {
  const calls = [], seats = [], updates = []
  const client = { call: async (name, args) => { calls.push([name, args]); return {} } }
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: {} }, seatSlot: () => '1st',
    selection: async () => ({ slot: '2nd', configurationRoot: '/r/2nd' }), setSeat: async (botId, slot) => { seats.push([botId, slot]) } }
  const transport = new AitermTransport({ client, accounts, updateSession: async (id, session) => { updates.push([id, session]) } })
  transport.requireMember = async () => {}
  const woken = []
  transport.wakeNow = async (bot, options) => { woken.push(options.sessionName) }
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', model: 'fable', project: '/tmp' }
  transport.isRunning = async () => true
  const moved = await transport.switchAccount(bot)
  assert.match(moved.session, /^bot-a-2nd-[0-9a-z]+$/u); assert.equal(moved.slot, '2nd')
  assert.deepEqual(woken, [moved.session])
  assert.equal(calls.some(([name]) => name === 'pty_close'), false)
  transport.isRunning = async () => false
  const renamed = await transport.switchAccount({ ...bot, id: 'bot-b', session: 'bot-b' })
  assert.deepEqual(woken, [moved.session], 'a seat that is not running is not launched')
  assert.deepEqual(updates, [['bot-b', renamed.session]]); assert.equal(transport.session({ id: 'bot-b' }), renamed.session)
  assert.deepEqual(seats, [['bot-a', '2nd'], ['bot-b', '2nd']])
})

// Production 2026-11-09 07:37 JST: after a module exchange the session map is empty; recorded seats still move.
test('reviewAccounts moves a recorded seat the engine did not launch', async () => {
  const moved = []
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: { 'bot-a': '1st', 'bot-b': '1st' } },
    seatSlot: () => '1st', effectiveSlot: async () => '2nd' }
  const bots = { 'bot-a': { id: 'bot-a', harness: 'claude', model: 'fable' }, 'bot-b': { id: 'bot-b', harness: 'claude', model: 'fable' } }
  const transport = new AitermTransport({ client: { call: async () => ({}) }, accounts, resolveBot: id => bots[id] })
  transport.moveAtBoundary = botId => moved.push(botId)
  await transport.reviewAccounts()
  assert.deepEqual(moved, ['bot-a', 'bot-b'])
})
