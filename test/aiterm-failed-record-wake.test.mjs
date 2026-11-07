import { taskSettingsReminder } from '../src/global-instructions.mjs'
const reminderSuffix = `\n\n<bellteam_task_settings>\n${await taskSettingsReminder()}\n</bellteam_task_settings>`
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'

// Aiterm 0.63.xは復帰に失敗した席を一覧と観測に残す（exists=true, state=unknown, reason=agent_failed）。
const observation = reason => ({ schema: 'aiterm.pty-observe-result.v1', session_id: 'bot-a', exists: true,
  harness: 'codex-cli', launch_id: 'a'.repeat(32), state: reason === 'agent_failed' ? 'unknown' : 'idle', reason })

function seatClient(reason) {
  const calls = []
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    calls.push([name, args])
    if (name === 'pty_observe') return { structuredContent: observation(reason) }
    if (name === 'agent_configure') return { structuredContent: { schema: 'aiterm.agent-configure-result.v1', session_id: 'bot-a' } }
    if (name === 'pty_close') return { content: [{ type: 'text', text: 'closed' }] }
    if (name === 'agent_launch') return { structuredContent: { session_id: 'bot-a' } }
    if (name === 'pty_send') return { structuredContent: {
      mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] },
    } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: '了解' } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  return { client, calls }
}

test('復帰に失敗した記録の席は、設定を当てずに記録ごと閉じて起こし直し、同じ文を1回だけ送る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('agent_failed')
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  const written = []
  t.mock.method(process.stderr, 'write', text => { written.push(String(text)); return true })

  await transport.turn(bot, '再現用の本文')

  assert.deepEqual(calls.map(([name]) => name), ['pty_observe', 'pty_close', 'agent_launch', 'pty_send', 'pty_read'])
  assert.deepEqual(calls[1][1], { session_id: 'bot-a' })
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').map(([, args]) => args),
    [{ session_id: 'bot-a', text: '再現用の本文' + reminderSuffix, require_agent: true }])
  assert.equal(written.filter(text => text.includes('resume record failed')).length, 1)
})

test('休止して再開待ちの席は閉じず、従来どおりそのまま送る', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-failed-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { client, calls } = seatClient('idle_timeout')
  const transport = new AitermTransport({ client, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }

  await transport.turn(bot, '再現用の本文')

  assert.equal(calls.some(([name]) => ['pty_close', 'agent_launch'].includes(name)), false)
  assert.deepEqual(calls.filter(([name]) => name === 'pty_send').length, 1)
})
