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

// harness-accounts.md: the switch is hibernate + a resume-only launch on the selected root; no model, effort, cwd or env.
test('switchAccount hibernates, resumes the same session on the selected root only, and records the slot', async () => {
  const calls = [], seats = []
  const client = { call: async (name, args, options) => {
    calls.push([name, args, options ?? null])
    return name === 'agent_launch' ? { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name, startup: { status: 'ready' } } }
      : { structuredContent: { schema: 'aiterm.pty-close-result.v1', session_id: args.session_id } }
  } }
  const accounts = { watch: () => () => {}, close: () => {}, state: { seats: {} }, seatSlot: () => '1st',
    selection: async () => ({ slot: '2nd', configurationRoot: '/home/x/.bellteam-accounts/claude/2nd' }),
    setSeat: async (botId, slot) => { seats.push([botId, slot]) } }
  const transport = new AitermTransport({ client, accounts })
  transport.requireMember = async () => {}
  transport.removeRetainedImages = async () => {}
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', model: 'fable', reasoningEffort: 'high', project: '/tmp' }
  transport.sessions.set(bot.id, 'bot-a')
  assert.deepEqual(await transport.switchAccount(bot), { botId: 'bot-a', session: 'bot-a', slot: '2nd' })
  assert.deepEqual(calls.map(([name, args]) => [name, args]), [
    ['pty_close', { session_id: 'bot-a', hibernate: true }],
    ['agent_launch', { harness: 'claude-code', session_name: 'bot-a', require_existing_resume: true, configuration_root: '/home/x/.bellteam-accounts/claude/2nd' }],
  ])
  assert.equal(calls[1][2]?.env, undefined, 'no launch env, so no env_vars reach Aiterm')
  assert.deepEqual(seats, [['bot-a', '2nd']])
})
