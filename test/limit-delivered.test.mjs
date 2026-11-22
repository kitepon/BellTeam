import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'

// a526 (harness-accounts.md "A delivery whose turn ends at the usage limit"): the seat took the text, the turn stopped at the limit: delivered, not failed.
function transportWith(root, waitResult) {
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name }) {
    if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'ok' } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  return new AitermTransport({ client, tempRoot: root, handoffContext: async () => '', waitProcess: async () => waitResult })
}

async function statusesFor(t, waitResult) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const statuses = []
  t.mock.method(process.stderr, 'write', () => true)
  const transport = transportWith(root, waitResult)
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }
  await transport.notify(bot, 'お願い', { onStatus: status => { statuses.push(status) } })
  await transport.idle(bot.id)
  return statuses
}

test('input accepted, then the turn ends rate_limited (screen line): running -> delivered, never failed', async t => {
  assert.deepEqual(await statusesFor(t, { outcome: 'rate_limited', rate_limit: "You've hit your weekly limit · resets Nov 25, 7pm (UTC)" }), ['running', 'delivered'])
})

test('input accepted, then the transcript 429 (failure.category rate_limited): delivered', async t => {
  assert.deepEqual(await statusesFor(t, { outcome: 'error', error: "You've hit your usage limit", failure: { category: 'rate_limited' } }), ['running', 'delivered'])
})

test('input accepted, then any other turn error: failed as before', async t => {
  assert.deepEqual(await statusesFor(t, { outcome: 'error', error: 'API Error: 500' }), ['running', 'failed'])
})
