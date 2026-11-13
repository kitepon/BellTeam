import assert from 'node:assert/strict'
import test from 'node:test'

import { AitermTransport } from '../src/aiterm-transport.mjs'
import { IdleSessions } from '../src/idle-sessions.mjs'

// a48 (execution harness-accounts.md "Old seat exit").
const quiet = { exists: true, state: 'idle', reason: 'composer_ready', pending_child_deliveries: 0,
  activity: { post_startup_process_count: 0 } }

function fake({ rows = [], launches = {}, observations = {} } = {}) {
  const calls = []
  const client = { async call(name, args) {
    calls.push(args?.session_id ? `${name}:${args.session_id}` : name)
    if (name === 'pty_list') return { structuredContent: { sessions: rows } }
    if (name === 'pty_observe') {
      const observation = observations[args.session_id]
      if (observation instanceof Error) throw observation
      return { structuredContent: observation ?? { exists: false } }
    }
    if (name === 'pty_close') return { structuredContent: { outcome: 'closed' } }
    throw new Error(`unexpected ${name}`)
  } }
  const self = { client, session: bot => bot.session ?? bot.id, readRuntimeLaunches: async () => launches }
  return { calls, run: bots => AitermTransport.prototype.closeOldSeats.call(self, bots) }
}

test('closes only quiet seats an account move left; the current seat, forks, dormant rows and working seats stay', async () => {
  const bot = { id: 'bot-a', session: 'bot-a-2nd-mwc5' }
  const { calls, run } = fake({
    rows: [{ session_id: 'bot-a-2nd-mwc5' }, { session_id: 'bot-a-1st-old', current_command: 'claude' },
      { session_id: 'bot-a-1st-gone', current_command: 'hibernated' }, { session_id: 'bot-a-2nd-mwc5-fork-0123456789ab' },
      { session_id: 'bot-b' }, { session_id: 'bot-a-1st-busy' }],
    // a terminal seat has no pty_list row: it comes from the launch record (Rapi's bot-ed14f4f7 on the Mac, 11/11-11/13).
    launches: { 'bot-a': { botId: 'bot-a' }, 'bot-b-1st-x': { botId: 'bot-b' } },
    observations: { 'bot-a': quiet, 'bot-a-1st-old': quiet,
      'bot-a-1st-busy': { ...quiet, activity: { post_startup_process_count: 2 } } },
  })
  assert.deepEqual(await run([bot]), ['bot-a', 'bot-a-1st-old'])
  assert.deepEqual(calls.filter(call => call.startsWith('pty_close')), ['pty_close:bot-a', 'pty_close:bot-a-1st-old'])
  assert.ok(!calls.some(call => /bot-a-2nd-mwc5$|fork|gone|bot-b/u.test(call)), calls.join(' '))
})

test('an observe failure is logged and the other old seats are still closed', async () => {
  const { run } = fake({ rows: [{ session_id: 'bot-a-1st-x' }, { session_id: 'bot-a-1st-y' }],
    observations: { 'bot-a-1st-x': new Error('ssh down'), 'bot-a-1st-y': quiet } })
  assert.deepEqual(await run([{ id: 'bot-a', session: 'bot-a-2nd-z' }]), ['bot-a-1st-y'])
})

test('IdleSessions passes only Bots whose pending decisions are known 0, and not while closing is not allowed', async () => {
  const passed = [], reports = []
  let allow = true
  const transport = { isIdle: () => true, observeChain: async () => ({ observation: { exists: false }, generation: null }),
    closeOldSeats: async bots => { passed.push(bots.map(bot => bot.id)); return ['bot-a-1st-old'] } }
  const idle = new IdleSessions({ bots: new Map([['bot-a', { id: 'bot-a', harness: 'claude' }], ['bot-c', { id: 'bot-c', harness: 'codex' }]]),
    transport, allowClose: () => allow, report: line => reports.push(line) })
  await idle.check()
  assert.deepEqual(passed, [['bot-a']])
  assert.ok(reports.some(line => line.includes('bot-a-1st-old')))
  allow = false
  await idle.check()
  assert.equal(passed.length, 1)
})
