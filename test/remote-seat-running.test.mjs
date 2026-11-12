import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'

// remote-seat.md "Seat liveness" (Trony 2026-11-13: every terminal seat showed online:false while working).
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'remote-running-')); t.after(() => rm(root, { recursive: true, force: true }))
  const state = { local: ['bot-l'], seats: ['bot-a'], unread: ['bot-b'], meta: true }
  const calls = []
  const client = { async call(name, args, options) {
    if (name !== 'pty_list') throw Error(`unexpected ${name}`)
    calls.push(options?.meta ? 'turns' : 'list')
    const turns = { schema: 'aiterm.seat-turns.v1', unread: state.unread,
      seats: state.seats.map(session_id => ({ session_id, launch_id: 'a'.repeat(32), harness: 'claude-code', turn: { state: 'idle' } })) }
    return { content: [{ type: 'text', text: state.local.map(id => `${id}\tclaude`).join('\n') }],
      ...(options?.meta && state.meta ? { _meta: { 'aiterm/seat_turns': turns } } : {}) }
  } }
  const transport = new AitermTransport({ client, runtimeLaunchesPath: join(root, 'launches.json'), handoffContext: async () => '' })
  const bot = (id, terminalId = '') => ({ id, session: id, harness: 'claude', terminalId, projectRoot: terminalId ? '/Users/o/p' : '' })
  const bots = [bot('bot-l'), bot('bot-m'), bot('bot-a', 'mac'), bot('bot-b', 'mac'), bot('bot-c', 'win')]
  return { transport, bots, state, calls }
}

test('remote seats: running from the seat-turns read (row or unread); local seats from pty_list as before', async t => {
  const { transport, bots, state, calls } = await fixture(t)
  assert.deepEqual([...await transport.runningBots(bots)].sort(), ['bot-a', 'bot-b', 'bot-l'])
  assert.deepEqual(calls.sort(), ['list', 'turns'], 'first call: one seat-turns read for the not-yet-read remote seats')
  calls.length = 0
  assert.equal(await transport.isRunning(bots[2]), true)
  assert.deepEqual(calls, [], 'remote isRunning is answered from the latest read, no Aiterm call')
  // The poll's next read no longer has bot-a (closed on its terminal).
  state.seats = []; state.unread = []
  await transport.seatTurns(bots)
  assert.deepEqual([...await transport.runningBots(bots)], ['bot-l'])
})

test('remote seats: a read without seat_turns leaves them not running for this call, and the next answered read settles them', async t => {
  const { transport, bots, state } = await fixture(t)
  state.meta = false
  assert.deepEqual([...await transport.runningBots(bots)], ['bot-l'])
  state.meta = true
  assert.deepEqual([...await transport.runningBots(bots)].sort(), ['bot-a', 'bot-b', 'bot-l'])
})
