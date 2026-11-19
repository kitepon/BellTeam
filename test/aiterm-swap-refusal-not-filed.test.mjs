import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermTransport } from '../src/aiterm-transport.mjs'
import { updateHoldError } from '../src/update-hold.mjs'

// a465 (BugHub 7681ba25, Z122): a launch the swap refuses before any input (update-hold.md H2) is a designed hold that the
// durable receipt requeues; the transport must not file it as a delivery failure. Any other launch failure still files.
for (const [label, error, filed] of [
  ['入れ替えの保留による起動の拒否', updateHoldError(), 0],
  ['それ以外の起動の失敗', Object.assign(new Error('boom'), { code: 'PTY_BACKEND_FAILED' }), 1],
]) test(`${label}は、配送失敗として ${filed ? '記録する' : '記録しない'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-swap-refusal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reports = []
  const client = { async call(name) {
    if (name === 'pty_list') return { content: [{ type: 'text', text: '' }] }
    if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: 'bot-a', exists: false, launch_id: null } }
    if (name === 'pty_close') return { content: [{ type: 'text', text: 'closed' }] }
    if (name === 'agent_launch') throw error
    throw new Error(`unexpected tool: ${name}`)
  } }
  const transport = new AitermTransport({ client, handoffContext: async () => '', reportError: async value => { reports.push(value) } })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  await assert.rejects(transport.turn(bot, '再現用の本文'))
  assert.equal(reports.filter(value => value.code === 'SERVER_TURN_TRACKING_FAILED').length, filed)
})
