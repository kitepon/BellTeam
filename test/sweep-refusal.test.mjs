import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'

const SWEEP = 'Lattice: you are not running, and you have tasks in progress or tasks that can start (every prerequisite is done). Start at least one now.'
const transport = tight => new AitermTransport({ client: { call: async () => ({}) }, launchGate: tight === undefined ? null : { tight: async () => tight, launched() {} } })
const job = (from, message) => ({ info: { from, message } })

// a505c (memory-budget.md): a Lattice sweep prompt that would start a cold seat is refused while memory is full; nothing else is.
test('under pressure the sweep prompt is refused as a designed not_started refusal', async () => {
  const j = job('scheduler', SWEEP)
  await assert.rejects(transport(true).refuseSweepUnderPressure(j), error => {
    assert.equal(error.code, 'BOT_MEMORY_PRESSURE')
    assert.equal(error.effect, 'not_started')
    assert.deepEqual(error.executionError, { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_BUSY', effect: 'not_started', follow_up: 'none' })
    return true
  })
  assert.equal(j.deliveryStage, 'BOT_MEMORY_PRESSURE')
})

test('the Owner, members, rooms, calls, other schedules and other Lattice notices are never refused', async () => {
  const t = transport(true)
  for (const j of [job('user', SWEEP), job('bot-7b140b27', SWEEP), job('scheduler', '[BellTeam schedule b305] Read the routine'),
    job('scheduler', 'Lattice: the Owner-lane task bellteam-dev-added/a492 can start now'), job('scheduler', undefined), { info: undefined }])
    await t.refuseSweepUnderPressure(j)
})

test('not tight, or no gate, refuses nothing', async () => {
  await transport(false).refuseSweepUnderPressure(job('scheduler', SWEEP))
  await transport(undefined).refuseSweepUnderPressure(job('scheduler', SWEEP))
})

test('both sweep heads count: the not-running prompt and the reassign prompt', async () => {
  const t = transport(true)
  for (const head of [SWEEP, 'Lattice: on charts you created, these tasks are in progress or can start, but their lane is not a BellTeam Bot or the Owner.'])
    await assert.rejects(t.refuseSweepUnderPressure(job('scheduler', head)), { code: 'BOT_MEMORY_PRESSURE' })
})

// The production path (createManagedTransport): send first, wake when the seat has no registration.
const unregistered = "aiterm: AGENT_SESSION_REQUIRED: session 'bot-a' のagent登録がありません。文字列は送信していません。"
function neverLaunchedClient() {
  const calls = []
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    calls.push(name)
    if (name === 'pty_send' && !calls.includes('agent_launch')) return { isError: true, content: [{ type: 'text', text: unregistered }] }
    if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
    if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: 'bot-a', exists: false, launch_id: null } }
    if (name === 'pty_list') return { content: [{ type: 'text', text: '' }] }
    if (name === 'pty_close') return { content: [{ type: 'text', text: 'closed' }] }
    if (name === 'agent_launch') return { structuredContent: { session_id: 'bot-a' } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'ok' } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  return { client, calls }
}

async function deliver(t, { from, message, tight }) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-sweep-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = neverLaunchedClient()
  const launched = []
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }),
    launchGate: { tight: async () => tight, launched: () => launched.push(1) } })
  t.mock.method(process.stderr, 'write', () => true)
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }
  const result = await transport.notify(bot, message, { queue: { context: 'direct', contextId: 'bot-a', groupId: 'g1', from, fromName: 'x', target: 'bot-a', message } }).then(() => null, error => error)
  return { calls, result, launched }
}

test('real path: a sweep prompt to a never-launched seat is refused under pressure and launches nothing', async t => {
  const { calls, result, launched } = await deliver(t, { from: 'scheduler', message: SWEEP, tight: true })
  assert.equal(result?.code, 'BOT_MEMORY_PRESSURE')
  assert.equal(calls.includes('agent_launch'), false)
  assert.equal(launched.length, 0)
})

test('real path: the same seat under the same pressure is woken for the Owner, a Bot and another schedule; the sweep goes through when not tight', async t => {
  for (const [from, message, tight] of [['user', 'hi', true], ['bot-7b140b27', SWEEP, true], ['scheduler', '[BellTeam schedule x] run', true], ['scheduler', SWEEP, false]]) {
    const { calls, result, launched } = await deliver(t, { from, message, tight })
    assert.equal(result, null, `${from} ${message.slice(0, 20)} tight=${tight}`)
    assert.equal(calls.includes('agent_launch'), true)
    assert.equal(launched.length, 1)
  }
})
