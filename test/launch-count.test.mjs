import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'

// Z220 11/27: 18 terminal seats failed to launch (CREDENTIAL_UNAVAILABLE) every minute; each attempt counted 0.75 GB of the container for 30 s,
// the gate read "tight" at 26 % real use, and every Lattice nudge was refused with BOT_MEMORY_PRESSURE.
const unregistered = "aiterm: AGENT_SESSION_REQUIRED: session 'bot-a' のagent登録がありません。文字列は送信していません。"
async function attempt(t, { remote, launchFails }) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-count-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const classifier = new AitermClient()
  classifier.client = { async callTool({ name }) {
    if (name === 'pty_send') return { isError: true, content: [{ type: 'text', text: unregistered }] }
    if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: 'bot-a', exists: false, launch_id: null } }
    if (name === 'pty_list') return { content: [{ type: 'text', text: '' }] }
    if (name === 'agent_launch') { if (launchFails) return { isError: true, content: [{ type: 'text', text: 'aiterm: LAUNCH_FAILED' }] }; return { structuredContent: { session_id: 'bot-a' } } }
    return { content: [{ type: 'text', text: '' }] }
  } }
  const entries = [], abandoned = []
  const remoteSeats = remote ? { handoffContext: async () => '', prepare: async () => { throw Object.assign(new Error('CREDENTIAL_UNAVAILABLE'), { code: 'CREDENTIAL_UNAVAILABLE', effect: 'not_started' }) }, launchFailed() {} } : null
  const transport = new AitermTransport({ client: { call: (name, args) => classifier.call(name, args) }, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }), remoteSeats,
    launchGate: { tight: async () => false, launched: () => { const entry = {}; entries.push(entry); return entry }, abandon: entry => abandoned.push(entry) } })
  t.mock.method(process.stderr, 'write', () => true)
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root, ...(remote ? { terminalId: 'macbook', projectRoot: '/Users/x/p' } : {}) }
  const error = await transport.notify(bot, 'hi', { queue: { context: 'direct', contextId: 'bot-a', groupId: 'g1', from: 'user', fromName: 'x', target: 'bot-a', message: 'hi' } }).then(() => null, e => e)
  return { entries, abandoned, error }
}

test('a terminal seat runs on the terminal: its launch, failed or not, never counts as container memory', async t => {
  const { entries, error } = await attempt(t, { remote: true, launchFails: false })
  assert.equal(entries.length, 0)
  assert.ok(error)
})

test('a container seat launch that fails is taken back; one that starts keeps its count', async t => {
  const failed = await attempt(t, { remote: false, launchFails: true })
  assert.equal(failed.entries.length, 1)
  assert.deepEqual(failed.abandoned, failed.entries)
  const started = await attempt(t, { remote: false, launchFails: false })
  assert.equal(started.entries.length, 1)
  assert.equal(started.abandoned.length, 0)
})
