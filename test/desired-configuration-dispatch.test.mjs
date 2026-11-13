import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedTransport } from '../src/aiterm-transport.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { ConfigurationRequests } from '../src/configuration-requests.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

async function fixture(t, exists) {
  const root = await mkdtemp(join(tmpdir(), 'desired-dispatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-target', name: 'Target', session: exists ? 'bot-target' : null, project: root,
    harness: 'codex', model: 'desired-model', reasoningEffort: 'high', fastMode: false }
  const f = { exists, launch: 'a'.repeat(32), calls: [], diagnostics: [], observationError: null, applyError: null }
  const client = { async call(name, args) {
    f.calls.push({ name, args: structuredClone(args) })
    if (name === 'pty_observe') {
      if (f.observationError) throw f.observationError
      return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: bot.session ?? bot.id,
        exists: f.exists, launch_id: f.exists ? f.launch : null, state: f.state ?? 'idle' } }
    }
    if (name === 'agent_configure') {
      await f.onConfigure?.(args)
      if (f.applyError) throw f.applyError
      // Aiterm refuses a configure while a turn runs: terminal, never issued to the CLI (production 2026-11-13 06:33Z).
      if (f.refuseConfigure && f.refuseConfigure-- > 0) return { structuredContent: { schema: 'aiterm.agent-configure-request-result.v1',
        binding: { ...args.request, session_id: args.session_id }, request_state: 'terminal', outcome: 'not_applied',
        later_effect: 'excluded', terminal_at: '2026-11-13T06:33:29.063Z', observed_at: '2026-11-13T06:33:29.109Z',
        current: { availability: 'unsupported' }, result: null } }
      return { structuredContent: { schema: 'aiterm.agent-configure-request-result.v1',
        binding: { ...args.request, session_id: args.session_id }, request_state: 'terminal', outcome: 'applied',
        later_effect: 'unconfirmed', terminal_at: '2026-11-06T15:00:00.000Z', observed_at: '2026-11-06T15:00:00.000Z',
        current: { availability: 'unsupported' }, result: { schema: 'aiterm.agent-configure-result.v1',
          session_id: args.session_id, provider: 'codex', harness: 'codex-cli', model: args.model ?? bot.model,
          reasoning_effort: args.reasoning_effort ?? bot.reasoningEffort, fast: args.fast ?? bot.fastMode } } }
    }
    if (name === 'agent_launch') {
      f.exists = true
      return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name,
        launch_id: f.launch, fast: false, startup: { status: 'ready' }, initial_prompt: { status: 'not_requested' } } }
    }
    if (name === 'pty_send' && !f.exists) throw Object.assign(Error('agent missing, input not sent'), { code: 'AGENT_SESSION_REQUIRED' })
    if (name === 'pty_send' && f.onSend) return f.onSend(args)
    if (name === 'pty_send') return { structuredContent: { schema: 'aiterm.pty-send-result.v1', mode: 'agent_dispatch',
      session_id: bot.session ?? bot.id, launch_id: f.launch, event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } }
    if (name === 'pty_read') return { structuredContent: { mode: 'agent_transcript', text: 'reply' } }
    if (name === 'pty_close') { f.exists = false; return { structuredContent: { schema: 'aiterm.pty-close-result.v1', session_id: args.session_id, outcome: 'closed' } } }
    throw Error(`unexpected ${name}`)
  } }
  const intents = new ConfigurationIntents(join(root, 'configuration-intents'), { ownerUid: process.getuid() })
  const requests = new ConfigurationRequests({ client, intents })
  const bridge = { async reserve(input) {
    const issued = new Set()
    return { issued, reservation: { request: input.request, target: { session_id: input.targetSession, expected_launch_id: input.expectedLaunch } },
      binding: { target: { launch: { session_id: input.targetSession, launch_id: input.expectedLaunch }, boundary: null } },
      async invoke(name, args) { issued.add(name); return client.call(name, args) }, async finish() {} }
  } }
  const transport = createManagedTransport({ client, executionBridge: bridge, configurationRequests: requests,
    handoffContext: async () => '', waitProcess: async () => { await f.onWait?.(); return { outcome: 'done' } }, reportError: value => f.diagnostics.push(value) })
  const logPath = join(root, 'messages.jsonl')
  const messenger = new BellTeamMessenger({ bots: new Map([[bot.id, bot]]), transport, logPath })
  return Object.assign(f, { root, bot, client, intents, requests, transport, messenger, logPath })
}

test('Owner input to an existing busy Codex seat does not configure or require an applied audit', async t => {
  const f = await fixture(t, true)
  f.state = 'busy'
  f.onSend = () => ({ structuredContent: { mode: 'agent_steer' } })
  const input = f.messenger.userTurn({ target: f.bot.id, message: 'go' })
  assert.equal((await input.accepted).delivery, 'steered')
  await input
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
  assert.equal(f.calls.some(c => c.name === 'agent_configure'), false)
  assert.equal(f.calls.some(c => c.name === 'pty_observe'), false)
  assert.equal(f.requests.view(f.bot.id), null)
  const records = (await readFile(f.logPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records.some(row => row.delivery === 'failed' || row.delivery_error), false)
})

test('successful input never waits for observation, even if observation is unavailable', async t => {
  const f = await fixture(t, true)
  for (const observation of [null, { schema: 'wrong', exists: false }, { schema: 'aiterm.pty-observe-result.v1', session_id: 'wrong-seat', exists: false, launch_id: null }]) {
    f.transport.observe = async () => { if (observation === null) throw Error('observation unavailable'); return observation }
    await f.messenger.userTurn({ target: f.bot.id, message: 'independent new input' })
  }
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 3)
  assert.equal(f.calls.some(c => ['agent_configure', 'agent_launch', 'pty_close'].includes(c.name)), false)
})

test('saved settings wait for the captured turn, allow Owner steer, and persist before the next turn', { timeout: 3000 }, async t => {
  const f = await fixture(t, true)
  const done = Promise.withResolvers(), applying = Promise.withResolvers(), applied = Promise.withResolvers()
  f.onWait = () => done.promise
  let sends = 0
  f.onSend = () => ({ structuredContent: ++sends === 2 ? { mode: 'agent_steer' }
    : { mode: 'agent_dispatch', event_cursor: sends, wait_process: { executable: 'fixture', args: [] } } })
  const first = f.transport.turn(f.bot, 'first', { queue: { groupId: 'first' } })
  await first.accepted
  const old = { ...f.bot }
  f.bot.model = 'new-model'
  f.bot.reasoningEffort = 'medium'
  f.bot.fastMode = true
  f.onConfigure = async () => { applying.resolve(); await applied.promise }
  const change = f.transport.reconfigure(old, f.bot)
  const steer = f.messenger.userTurn({ target: f.bot.id, message: 'go' })
  assert.equal((await steer.accepted).delivery, 'steered')
  assert.equal(f.calls.some(c => c.name === 'agent_configure'), false)
  done.resolve()
  // Queue immediately at the boundary, before the earlier transcript/callback work finishes.
  const next = f.transport.turn(f.bot, 'next', { queue: { groupId: 'next' } })
  await applying.promise
  assert.equal(sends, 2, 'next turn waits for actual settings apply')
  applied.resolve()
  await change
  assert.equal(f.requests.view(f.bot.id).receipt_persisted, true)
  assert.equal(f.requests.view(f.bot.id).receipt.outcome, 'applied')
  assert.deepEqual(f.requests.view(f.bot.id).requested, { model: 'new-model', reasoning_effort: 'medium', fast: true })
  await Promise.all([first, steer, next])
  const names = f.calls.filter(c => ['agent_configure', 'pty_send'].includes(c.name)).map(c => c.name)
  assert.deepEqual(names, ['pty_send', 'pty_send', 'agent_configure', 'pty_send'])
  assert.equal(f.transport.queueItems().some(row => row.status === 'failed'), false)
})

test('a confirmed absent seat still launches once with saved settings', async t => {
  const f = await fixture(t, false)
  await f.messenger.userTurn({ target: f.bot.id, message: 'first after restart' })
  const launch = f.calls.find(c => c.name === 'agent_launch').args
  assert.equal(launch.model, f.bot.model)
  assert.equal(launch.reasoning_effort, 'high')
  assert.equal(launch.fast, false)
  assert.equal(f.calls.filter(c => c.name === 'agent_launch').length, 1)
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 2)
  assert.equal(f.calls.some(c => c.name === 'agent_configure'), false)
})


test('native completion rejection remains visible without blocking an independent next input', async t => {
  const f = await fixture(t, true)
  f.onWait = async () => { throw Error('native completion unavailable') }
  const first = f.transport.turn(f.bot, 'first', { onStatus: async () => { await new Promise(resolve => setImmediate(resolve)) } })
  await first.accepted
  await assert.rejects(first, /native completion unavailable/)
  f.onWait = null
  const next = f.transport.turn(f.bot, 'independent next input')
  await next.accepted
  await next
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 2)
})


test('refusal recovery never replaces a seat on uncertain input, and never closes on invalid identity evidence', async t => {
  const f = await fixture(t, true)
  f.transport.observe = async () => ({ schema: 'aiterm.pty-observe-result.v1', session_id: f.bot.id, exists: false, launch_id: null })
  f.onSend = () => { throw Object.assign(Error('BOT_SEND_OUTCOME_UNKNOWN'), { code: 'BOT_SEND_OUTCOME_UNKNOWN' }) }
  await assert.rejects(f.transport.turn(f.bot, 'independent input'), error => error.code === 'BOT_SEND_OUTCOME_UNKNOWN')
  assert.equal(f.calls.some(c => ['agent_launch', 'pty_close'].includes(c.name)), false)
  // An unreadable observation closes nothing; the seat's own launch is still attempted (wake-first).
  for (const observed of [{ schema: 'wrong', exists: false },
    { schema: 'aiterm.pty-observe-result.v1', session_id: 'other-seat', exists: false, launch_id: null }]) {
    f.transport.observe = async () => observed
    f.onSend = () => { throw Object.assign(Error('BOT_INPUT_NOT_READY'), { code: 'BOT_INPUT_NOT_READY' }) }
    await f.transport.turn(f.bot, 'independent input').catch(() => {})
  }
  assert.equal(f.calls.some(c => c.name === 'pty_close'), false)
  assert.equal(f.calls.filter(c => c.name === 'agent_launch').length, 2)
})

// a53 (production 2026-11-13 06:33Z): the after_turn delivery started the next turn before BellTeam saw the captured turn end.
// The apply then met a running turn, Aiterm refused it (not_applied, not issued), and nothing applied it later.
test('settings refused because a new turn already runs are applied again when that turn ends', { timeout: 3000 }, async t => {
  const f = await fixture(t, true)
  const waits = [Promise.withResolvers(), Promise.withResolvers()]
  let waitIndex = 0, sends = 0
  f.onWait = () => waits[waitIndex++].promise
  f.onSend = () => ({ structuredContent: { mode: 'agent_dispatch', event_cursor: ++sends, wait_process: { executable: 'fixture', args: [] } } })
  const first = f.transport.turn(f.bot, 'first', { queue: { groupId: 'first' } })
  await first.accepted
  const old = { ...f.bot }
  f.bot.model = 'opus'
  const change = f.transport.reconfigure(old, f.bot)
  // The CLI already ended 'first'; Aiterm takes the continuation as a new turn before BellTeam's completion wait returns.
  const next = f.transport.turn(f.bot, 'continue', { queue: { groupId: 'next' } })
  await next.accepted
  f.refuseConfigure = 1
  waits[0].resolve()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.calls.filter(c => c.name === 'agent_configure').length, 1, 'refused while the new turn runs')
  waits[1].resolve()
  await change
  assert.equal(f.calls.filter(c => c.name === 'agent_configure').length, 2)
  assert.equal(f.requests.view(f.bot.id).receipt.outcome, 'applied')
  assert.equal(f.requests.view(f.bot.id).requested.model, 'opus')
  await Promise.all([first, next])
})
