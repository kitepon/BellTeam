import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedTransport } from '../src/aiterm-transport.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { ConfigurationRequests } from '../src/configuration-requests.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { configurationDigest } from '../src/configuration-request.mjs'

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
        exists: f.exists, launch_id: f.exists ? f.launch : null } }
    }
    if (name === 'agent_configure') {
      if (f.applyError) throw f.applyError
      return { structuredContent: { schema: 'aiterm.agent-configure-request-result.v1',
        binding: { ...args.request, session_id: args.session_id }, request_state: 'terminal', outcome: 'applied',
        later_effect: 'unconfirmed', terminal_at: '2026-11-06T15:00:00.000Z', observed_at: '2026-11-06T15:00:00.000Z',
        current: { availability: 'unsupported' }, result: { schema: 'aiterm.agent-configure-result.v1',
          session_id: args.session_id, provider: 'codex', harness: 'codex-cli', model: args.model,
          reasoning_effort: args.reasoning_effort, fast: args.fast } } }
    }
    if (name === 'agent_launch') {
      f.exists = true
      return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name,
        launch_id: f.launch, fast: false, startup: { status: 'ready' }, initial_prompt: { status: 'not_requested' } } }
    }
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
    handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }), reportError: value => f.diagnostics.push(value) })
  const logPath = join(root, 'messages.jsonl')
  const messenger = new BellTeamMessenger({ bots: new Map([[bot.id, bot]]), transport, logPath })
  return Object.assign(f, { root, bot, client, intents, requests, transport, messenger, logPath })
}

test('present generation applies desired with fresh UUID, audit uncertainty never fences, and failed input is visible before acceptance rejects', async t => {
  const f = await fixture(t, true)
  const turn = () => f.messenger.userTurn({ target: f.bot.id, message: 'new owner input' })
  await turn()
  assert.deepEqual(f.calls.filter(c => c.name !== 'pty_read').map(c => c.name).slice(0, 3), ['pty_observe', 'agent_configure', 'pty_send'])
  const first = f.calls.find(c => c.name === 'agent_configure').args
  assert.equal(first.request.launch_id, f.launch)
  assert.equal(first.request.digest, configurationDigest({ model: f.bot.model, reasoning_effort: 'high', fast: false }))
  assert.equal((await f.intents.terminal(f.bot.id, { ...first.request, session_id: f.bot.session })).receipt.outcome, 'applied')
  await turn()
  assert.equal(f.calls.filter(c => c.name === 'agent_configure').length, 1, 'last same-generation/digest applied receipt avoids a redundant apply')

  f.bot.model = 'new-desired'
  f.applyError = Object.assign(Error('lost configure response'), { code: 'CONFIGURATION_RESULT_UNCONFIRMED', effect: 'possible' })
  await turn()
  f.applyError = null
  await turn()
  const ids = f.calls.filter(c => c.name === 'agent_configure').map(c => c.args.request.id)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3, 'next input re-applies by content using a fresh UUID')
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 4)
  assert.equal((await readdir(join(f.root, 'configuration-intents', f.bot.id))).filter(name => name.endsWith('.intent.json')).length, 3)

  const publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async () => { throw Object.assign(Error('audit unavailable'), { code: 'CONFIGURATION_STORAGE_INVALID' }) }
  f.bot.model = 'next-desired'
  await turn()
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 5, 'audit storage failure never gates apply/send')
  f.intents.publish = publish

  f.observationError = Error('channel unavailable')
  const failed = turn()
  await assert.rejects(failed.accepted)
  await assert.rejects(failed)
  const records = (await readFile(f.logPath, 'utf8')).trim().split('\n').map(JSON.parse)
  const status = records.at(-1)
  assert.equal(status.delivery, 'failed')
  assert.deepEqual(status.delivery_error, { code: 'BOT_OBSERVATION_FAILED' })
  const queue = f.transport.queueItems({ botId: f.bot.id })
  assert.equal(queue.length, 1)
  assert.equal(queue[0].status, 'failed')
  assert.equal(queue[0].groupId, status.delivery_id)
  const view = (await f.messenger.store.timelineView(f.bot.id)).snapshot()
  assert.deepEqual(view.find(item => item.id === status.delivery_id).delivery_error, status.delivery_error)
  assert.equal(f.diagnostics.filter(d => JSON.parse(d.diagnostic_log).code === 'BOT_OBSERVATION_FAILED').length, 1)
  assert.equal(f.transport.activity.idle(f.bot.id), true)
  f.observationError = null
  await f.messenger.sendmessage({ from: 'scheduler', target: f.bot.id, message: 'independent next Bot input' })
  await Promise.all([...f.transport.jobs].map(job => job.completion))
  assert.equal(f.transport.queueItems({ botId: f.bot.id }).length, 0)
  assert.equal('uncertainChanges' in f.transport, false)
})

test('missing managed launch starts with desired settings before one send despite old unresolved audit', async t => {
  const f = await fixture(t, false)
  await f.intents.publish(f.bot.id, { schema: 'bellteam.configuration-intent.v1', botId: f.bot.id,
    binding: { id: '16d83be4-7708-4d79-85ba-7cd62d20b73a', session_id: f.bot.id, launch_id: 'b'.repeat(32),
      digest: configurationDigest({ model: 'old', reasoning_effort: null, fast: null }) },
    requested: { model: 'old', reasoning_effort: null, fast: null }, version: '0.63.11' })
  const turn = f.messenger.userTurn({ target: f.bot.id, message: 'first after restart' })
  await turn
  assert.deepEqual(f.calls.filter(c => c.name !== 'pty_read').map(c => c.name).slice(0, 3), ['pty_observe', 'agent_launch', 'pty_send'])
  const launch = f.calls.find(c => c.name === 'agent_launch').args
  assert.equal(launch.model, f.bot.model)
  assert.equal(launch.reasoning_effort, 'high')
  assert.equal(launch.fast, false)
  assert.equal(launch.session_name, f.bot.id)
  assert.equal(f.calls.some(c => c.args.action === 'reconcile'), false)
  await f.transport.restart(f.bot)
  assert.deepEqual(f.calls.slice(-2).map(c => c.name), ['pty_close', 'agent_launch'])
  assert.equal(f.transport.queueItems({ botId: f.bot.id }).length, 0)
})
