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
test('switchAccount only names the new seat, running or not; the next delivery launches it (11-26 OOM)', async () => {
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
  assert.deepEqual(woken, [], 'a live idle seat gets no second seat beside it')
  assert.equal(calls.length, 0)
  transport.isRunning = async () => false
  const renamed = await transport.switchAccount({ ...bot, id: 'bot-b', session: 'bot-b' })
  assert.deepEqual(woken, [])
  assert.deepEqual(updates, [['bot-a', moved.session], ['bot-b', renamed.session]]); assert.equal(transport.session({ id: 'bot-b' }), renamed.session)
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

// a496m (harness-accounts.md "Idle-boundary moves"): an unconfirmed move is retried by the shared timer, and the retry stops once the move works.
test('an unconfirmed seat move is reviewed again after moveRetryMs and stops once the move succeeds', async () => {
  const slots = { 'bot-a': '1st' }, attempts = []
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: slots }, seatSlot: id => slots[id] ?? null,
    effectiveSlot: async () => '2nd', freeSlot: async () => '2nd', renewDue: async () => false }
  const bot = { id: 'bot-a', harness: 'claude', model: 'fable' }
  const transport = new AitermTransport({ client: { call: async () => ({}) }, accounts, resolveBot: () => bot })
  transport.moveRetryMs = 10
  transport.isIdle = () => true
  transport.switchAccount = async () => {
    attempts.push(Date.now())
    if (attempts.length < 3) throw Object.assign(new Error('x'), { code: 'MEMBERS_NOT_ACCEPTED' })
    slots['bot-a'] = '2nd'
  }
  const stderr = process.stderr.write.bind(process.stderr); process.stderr.write = () => true
  try {
    transport.moveAtBoundary('bot-a')
    await new Promise(resolve => setTimeout(resolve, 300))
  } finally { process.stderr.write = stderr }
  assert.equal(attempts.length, 3, 'two failures, then one success, then no more attempts')
  assert.equal(transport.moveRetryTimer, null)
  await transport.close()
})

// 2026-11-26 OOM: a retry looks again only at the members whose move failed, waiting longer while it keeps failing.
test('an unconfirmed move retries only that member, on a doubling wait', async () => {
  const slots = { 'bot-a': '1st', 'bot-b': '1st' }, attempts = { 'bot-a': [], 'bot-b': [] }
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: slots }, seatSlot: id => slots[id] ?? null,
    effectiveSlot: async () => '2nd', freeSlot: async () => '2nd', renewDue: async () => false }
  const bots = { 'bot-a': { id: 'bot-a', harness: 'claude', model: 'fable' }, 'bot-b': { id: 'bot-b', harness: 'claude', model: 'fable' } }
  const transport = new AitermTransport({ client: { call: async () => ({}) }, accounts, resolveBot: id => bots[id] })
  transport.moveRetryMs = 20
  transport.isIdle = () => true
  transport.switchAccount = async bot => {
    attempts[bot.id].push(Date.now())
    if (bot.id === 'bot-a') throw Object.assign(new Error('x'), { code: 'CONVERSATION_SENDER_FORBIDDEN' })
    slots[bot.id] = '2nd'
  }
  const stderr = process.stderr.write.bind(process.stderr); process.stderr.write = () => true
  try {
    await transport.reviewAccounts()
    await new Promise(resolve => setTimeout(resolve, 230))
  } finally { process.stderr.write = stderr }
  assert.equal(attempts['bot-b'].length, 1, 'a member whose move succeeded is not reviewed by the retry')
  const gaps = attempts['bot-a'].slice(1).map((at, i) => at - attempts['bot-a'][i])
  assert.ok(gaps.length >= 3 && gaps[0] >= 15 && gaps[1] >= 35 && gaps[2] >= 75, `waits double: ${gaps}`)
  assert.equal(transport.moveFailures.get('bot-a'), attempts['bot-a'].length)
  await transport.close()
})

// 2026-11-26 OOM: inputs, intents, claims and seat records write the registry too; only limits or signedOut review every member.
test('a registry write reviews every member only when limits or signedOut changed', async () => {
  let listener = null, reviews = 0
  const state = { seats: {}, limits: [], signedOut: [], inputs: {} }
  const accounts = { watch: fn => { listener = fn; return () => {} }, close: () => {}, state }
  const transport = new AitermTransport({ client: { call: async () => ({}) }, accounts, resolveBot: () => null })
  transport.reviewAccounts = async () => { reviews++ }
  listener()
  state.inputs = { 'bot-a': '2026-11-26T00:00:00.000Z' }; listener()
  state.seats = { 'bot-a': '2nd' }; listener()
  assert.equal(reviews, 1)
  state.limits = [{ harness: 'claude', slot: '2nd', scope: 'all' }]; listener()
  state.signedOut = [{ harness: 'claude', slot: '1st' }]; listener()
  assert.equal(reviews, 3)
  await transport.close()
})

// 2026-11-26: the 1st slot's token is read through a seat process; a review of many seats asks once per model, not once per seat.
test('reviewAccounts asks the effective slot once per model', async () => {
  const asked = []
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: { 'bot-a': '1st', 'bot-b': '1st', 'bot-c': '1st' } },
    seatSlot: () => '1st', effectiveSlot: async (_harness, model) => { asked.push(model); return '1st' }, renewDue: async () => false }
  const bots = { 'bot-a': { id: 'bot-a', harness: 'claude', model: 'fable' }, 'bot-b': { id: 'bot-b', harness: 'claude', model: 'fable' },
    'bot-c': { id: 'bot-c', harness: 'claude', model: 'opus' } }
  const transport = new AitermTransport({ client: { call: async () => ({}) }, accounts, resolveBot: id => bots[id] })
  transport.moveAtBoundary = () => assert.fail('no seat moves')
  await transport.reviewAccounts()
  assert.deepEqual(asked, ['fable', 'opus'])
})