import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { harnessCliWait } from '../src/harness-cli-wait.mjs'
import { LiveModelCatalog } from '../src/model-catalog.mjs'
import { createBackgroundSummaryRunner } from '../src/background-summary-runner.mjs'

// a451 (docs/architecture/modules/execution/cli-not-installed.md): usage's harnessCli window, faked.
const window = (state = 'not_installed') => {
  const listeners = new Set()
  return { state: value => { state = value }, installed: () => ({ claude: { state }, codex: { state }, grok: { state }, cursor: { state } }),
    watch: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    fire: harness => { for (const listener of listeners) listener({ harness, state }) } }
}

test('N1: only a known not-ready state waits; an absent or unknown window is ready', () => {
  assert.equal(harnessCliWait(null, 'claude'), null)
  assert.equal(harnessCliWait({}, 'claude'), null)
  assert.equal(harnessCliWait({ installed: () => { throw new Error('x') } }, 'claude'), null)
  assert.equal(harnessCliWait(window('installed'), 'claude'), null)
  assert.equal(harnessCliWait(window('something_new'), 'claude'), null)
  assert.equal(harnessCliWait(window('not_installed'), 'claude').notice, 'Claudeがまだ入っていません。AIの認証から入れてください')
  assert.equal(harnessCliWait(window('installing'), 'codex').notice, 'Codexを入れています。終わるまでお待ちください')
  assert.equal(harnessCliWait(window('failed'), 'grok').notice, 'Grokを入れられませんでした。AIの認証からもう一度入れてください')
  assert.deepEqual(harnessCliWait(window('checking'), 'cursor'), { state: 'checking', notice: null })
})

test('N2-N4: a local seat waits queued with a notice, no launch and no filing, and drains by itself after the install', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-cli-wait-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name }) {
    calls.push(name)
    if (name === 'pty_send') return { isError: true, content: [{ type: 'text', text: "aiterm: AGENT_SESSION_REQUIRED: agent session 'bot-a' がありません。文字列は送信していません。" }] }
    if (name === 'pty_list') return { content: [{ type: 'text', text: '' }] }
    if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: 'bot-a', exists: false } }
    if (name === 'agent_launch') return { isError: true, content: [{ type: 'text', text: 'aiterm: PTY_BACKEND_FAILED' }] }
    throw new Error(`unexpected tool: ${name}`)
  } }
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
  const bots = new Map([[bot.id, bot]])
  const cli = window('not_installed')
  const transport = new AitermTransport({ client, harnessCli: cli, resolveBot: id => bots.get(id) })
  const edges = []
  transport.watchQueue(change => edges.push(change))
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
  const diagnostics = []
  const server = createBellTeamServer({ bots, transport, messenger, store: messenger.store, authorize: async () => true,
    diagnostics: { async record(value) { diagnostics.push(value) } } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const send = () => fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '本文' }) })

  const waiting = await send()
  assert.equal(waiting.status, 409)
  assert.equal((await waiting.json()).error, 'BOT_AWAITING_USER')
  assert.equal(calls.includes('agent_launch'), false)
  assert.equal(diagnostics.length, 0)
  assert.deepEqual({ ...transport.seatLaunch('bot-a'), at: null }, { code: 'HARNESS_NOT_INSTALLED', action: 'Codexがまだ入っていません。AIの認証から入れてください', terminalId: null, at: null })

  // installing -> failed only rewrites the notice
  await new Promise(resolve => setTimeout(resolve, 100)) // the refused job's own queue events settle first
  // the drain edge is a queue change naming the Bot (emitQueue); the notice's own change names none
  const queueEdges = () => edges.filter(edge => edge.topics.includes('queue') && edge.botIds.length).length
  const before = queueEdges()
  cli.state('failed'); cli.fire('codex')
  assert.equal(transport.seatLaunch('bot-a').action, 'Codexを入れられませんでした。AIの認証からもう一度入れてください')
  assert.equal(queueEdges(), before)

  // another harness changing leaves it waiting; the install of its own drains the same ID
  cli.state('installed'); cli.fire('claude')
  assert.notEqual(transport.seatLaunch('bot-a'), null)
  cli.fire('codex')
  assert.equal(transport.seatLaunch('bot-a'), null)
  assert.equal(queueEdges(), before + 1)
  assert.deepEqual(edges.at(-1).botIds, ['bot-a'])

  // installed: the launch is attempted now (here it fails for its own reason, which is reported as a launch failure again)
  await send()
  assert.equal(calls.includes('agent_launch'), true)
})

test('N5: not started with no cause while usage says installed: one recheck, then the same wait', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-cli-recheck-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name }) {
    if (name === 'agent_launch') return { isError: true, content: [{ type: 'text', text: 'aiterm: AGENT_LAUNCH_NOT_STARTED' }] }
    throw new Error(`unexpected tool: ${name}`)
  } }
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }
  const cli = window('installed')
  let rechecked = 0
  cli.recheck = async () => { rechecked++; cli.state('not_installed') }
  const transport = new AitermTransport({ client, harnessCli: cli, resolveBot: () => bot })
  await assert.rejects(transport.wake(bot), error => error.code === 'BOT_AWAITING_USER' && error.awaitingReason === 'HARNESS_NOT_INSTALLED')
  assert.equal(rechecked, 1)
  assert.match(transport.seatLaunch('bot-a').action, /Claudeがまだ入っていません/u)
})

test('N6: the model catalog answers a plain notice for a CLI that is not installed, without calling Aiterm', async () => {
  let called = false
  const catalog = new LiveModelCatalog({ client: () => { called = true; throw new Error('no') }, harnessCli: () => window('not_installed') })
  const all = await catalog.list('claude')
  assert.equal(called, false)
  assert.deepEqual(all.claude, { efforts: [], models: [], error: { code: 'HARNESS_NOT_INSTALLED', message: 'Claudeがまだ入っていません。AIの認証から入れてください' } })
})

test('N7: the summary runner stops before the CLI when it is not installed', async () => {
  const run = createBackgroundSummaryRunner({ project: '/nonexistent', models: { forHarness: async () => { throw new Error('no') } }, harnessCli: window('installing'),
    runner: async () => { throw new Error('no') } })
  await assert.rejects(run({ harness: 'claude', model: 'm', reasoningEffort: '' }, '{}'), { code: 'BACKGROUND_SUMMARY_CLI_NOT_INSTALLED' })
})
