import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermClient, createManagedTransport } from '../src/aiterm-transport.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { ConfigurationRequests } from '../src/configuration-requests.mjs'
import { CONFIGURATION_VERSION } from '../src/configuration-request.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function fixture(t, tracked = false) {
  const root = await mkdtemp(join(tmpdir(), 'configuration-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', session: 'existing', project: root, harness: 'codex', model: 'old', reasoningEffort: 'high', fastMode: false }
  const calls = [], diagnostics = [], logs = [], original = Object.freeze(Error('synthetic configuration reply lost'))
  const transportProcess = { pid: 123 }
  const sdk = { transport: transportProcess, getServerVersion: () => ({ name: 'aiterm', version: CONFIGURATION_VERSION }),
    listTools: async () => ({ tools: [{ name: 'agent_configure', inputSchema: { properties: {
      action: { enum: ['apply', 'reconcile'] }, request: { type: 'object', required: ['id', 'launch_id', 'digest'],
        properties: { id: { type: 'string' }, launch_id: { type: 'string' }, digest: { type: 'string' } } },
    } }, outputSchema: { properties: { schema: { const: 'aiterm.agent-configure-request-result.v1' } } } }] }),
    async callTool({ name, arguments: args }) {
      calls.push({ name, args })
      if (name === 'agent_configure') throw original
      if (name === 'pty_list') return { content: [{ type: 'text', text: bot.session }], structuredContent: { schema: 'aiterm.pty-list-result.v1', sessions: [{ session_id: bot.session, launch_id: 'a'.repeat(32) }] } }
      if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'fixture', args: [] } } }
      if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'reply' } }
      if (name === 'pty_observe') return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: bot.session, exists: true, launch_id: 'a'.repeat(32) } }
      throw Error(`unexpected native call ${name}`)
    } }
  const client = new AitermClient({ env: {} }); client.client = sdk; client.transport = transportProcess
  const requests = tracked ? new ConfigurationRequests({ client, intents: new ConfigurationIntents(join(root, 'configuration-intents'), { ownerUid: process.getuid() }) }) : null
  const transport = createManagedTransport({ client, configurationRequests: requests, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  const bots = new Map([[bot.id, bot]])
  bots.previewUpdate = async (id, value) => ({ ...bots.get(id), ...value })
  bots.update = async (id, value) => { const next = { ...bots.get(id), ...value }; bots.set(id, next); return next }
  const admin = new BotAdministration({ bots, transport, writeLog: line => logs.push(line), reportError: value => diagnostics.push(value) })
  let configuring
  const reconfigure = transport.reconfigure.bind(transport)
  transport.reconfigure = (...args) => (configuring = reconfigure(...args))
  await admin.update(bot.id, { model: 'desired' })
  await assert.rejects(configuring, error => error === original)
  await tick()
  assert.equal(transport.uncertainChanges.get(bot.id), 'agent_configure')
  assert.equal(admin.view(bots.get(bot.id)).configurationApplication.outcome, 'outcome_unknown')
  return { bot: bots.get(bot.id), transport, calls, admin, bots, diagnostics, logs }
}

for (const tracked of [false, true]) test(`${tracked ? 'tracked' : 'legacy null-binding'} unknown permits one existing-session delivery and preserves original settings evidence`, async t => {
  const f = await fixture(t, tracked), version = f.transport.uncertainChanges.version(f.bot.id)
  const before = structuredClone(f.admin.view(f.bot)), diagnostics = structuredClone(f.diagnostics), logs = [...f.logs]
  assert.equal(version.request === null, !tracked)
  assert.equal(await f.transport.ensure(f.bot), 'existing')
  await f.transport.memberOperation(f.bot, () => f.transport.awaitUnboundAdmission(f.bot, f.transport.captureStopVersion(f.bot)))
  const completion = f.transport.turn(f.bot, 'new synthetic ordinary message')
  assert.deepEqual(await completion.accepted, { delivery: 'running' })
  assert.equal(await completion, 'reply')
  assert.deepEqual(f.calls.filter(c => c.name === 'pty_send').map(c => c.args.session_id), ['existing'])
  assert.equal(f.calls.filter(c => c.name === 'agent_configure').length, 1, 'only the original failed configuration')
  assert.deepEqual(f.admin.view(f.bot), before)
  assert.deepEqual(f.diagnostics, diagnostics); assert.deepEqual(f.logs, logs)
  assert.equal(f.transport.uncertainChanges.version(f.bot.id), version)
  assert.throws(() => f.transport.requireSessionKnown(f.bot.id), { code: 'BOT_SESSION_UNCONFIRMED' })
  await assert.rejects(f.transport.reconfigure(f.bot, { ...f.bot, model: 'another' }), { code: 'BOT_SESSION_UNCONFIRMED' })
})

test('a retained rejected settings Promise does not poison notify admission or remove its uncertainty', async t => {
  const f = await fixture(t), failure = Promise.reject(Error('old settings failed')); failure.catch(() => {})
  f.transport.configurationChanges.set(f.bot.id, failure)
  const version = f.transport.uncertainChanges.version(f.bot.id), done = deferred()
  f.transport.waitProcess = () => done.promise
  assert.deepEqual(await f.transport.notify(f.bot, 'new notification', { queue: { context: 'room', contextId: 'room-a', groupId: 'room-message' } }), { delivery: 'running' })
  const job = [...f.transport.jobs][0]; done.resolve({ outcome: 'done' }); await job.completion
  assert.equal(f.transport.uncertainChanges.version(f.bot.id), version)
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
})

test('an in-flight settings failure is ordering only; delivery checks the target after it settles', async t => {
  const f = await fixture(t), settings = deferred()
  f.transport.configurationChanges.track(f.bot.id, settings.promise)
  const completion = f.transport.submit(f.bot, 'new after setting failure')
  await tick(); assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 0)
  settings.reject(Error('failed setting')); await completion.accepted; await completion
  assert.equal(f.transport.configurationChanges.has(f.bot.id), false)
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
})

for (const cause of ['agent_launch', 'pty_close', 'members_session_save', 'close_launch']) test(`${cause} uncertainty preserves evidence while ordinary existing-session delivery proceeds`, async t => {
  const f = await fixture(t); f.transport.uncertainChanges.set(f.bot.id, cause)
  const version = f.transport.uncertainChanges.version(f.bot.id)
  const completion = f.transport.submit(f.bot, 'fresh independent input')
  assert.deepEqual(await completion.accepted, { delivery: 'running' }); await completion
  assert.equal(await f.transport.ensure(f.bot), 'existing')
  assert.throws(() => f.transport.requireSessionKnown(f.bot.id), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
  assert.equal(f.transport.uncertainChanges.version(f.bot.id), version)
})

test('a peripheral close uncertainty while admission waits does not refuse fresh input', async t => {
  const f = await fixture(t), entered = deferred(), access = deferred()
  f.transport.requireAccess = async () => { entered.resolve(); await access.promise }
  const completion = f.transport.submit(f.bot, 'synthetic race')
  await entered.promise
  f.transport.uncertainChanges.set(f.bot.id, 'pty_close'); access.resolve()
  assert.deepEqual(await completion.accepted, { delivery: 'running' }); await completion
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
  assert.equal(f.transport.uncertainChanges.get(f.bot.id), 'pty_close')
})

test('ordinary global-stop and access denial still reject configuration-unknown delivery', async t => {
  for (const kind of ['stop', 'access']) {
    const f = await fixture(t)
    if (kind === 'stop') f.transport.assertWorkAllowed = () => { throw Object.assign(Error('paused'), { code: 'AI_GLOBAL_PAUSED' }) }
    else f.transport.requireAccess = async () => { throw Object.assign(Error('forbidden'), { code: 'BOT_FORBIDDEN' }) }
    const completion = f.transport.submit(f.bot, 'synthetic rejected')
    await assert.rejects(completion.accepted, { code: kind === 'stop' ? 'AI_GLOBAL_PAUSED' : 'BOT_FORBIDDEN' })
    await assert.rejects(completion)
    assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 0)
  }
})

test('configuration unknown does not authorize wake when ensure finds no existing session', async t => {
  const f = await fixture(t), original = f.transport.isRunning
  f.transport.isRunning = async () => false
  await assert.rejects(f.transport.ensure(f.bot), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.equal(f.calls.filter(c => ['agent_launch', 'pty_close'].includes(c.name)).length, 0)
  f.transport.isRunning = original
})

test('the existing execution bridge path keeps its native target and source metadata under configuration uncertainty', async t => {
  const f = await fixture(t), seen = []
  f.transport.executionBridge = { async reserve(input) {
    seen.push(input)
    return { issued: new Set(), invoke: (name, args) => f.transport.client.call(name, args) }
  } }
  const completion = f.transport.submit(f.bot, 'synthetic bridge', { info: { context: 'direct', groupId: 'bridge-delivery',
    call: { sessionId: 'call-existing', event: 'session.message', seq: 3 } } })
  assert.deepEqual(await completion.accepted, { delivery: 'running' }); await completion
  assert.equal(seen[0].targetSession, 'existing'); assert.equal(seen[0].expectedLaunch, 'a'.repeat(32))
  assert.equal(seen[0].request.call_session_id, 'call-existing')
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 1)
  assert.equal(f.calls.filter(c => c.name === 'agent_configure').length, 1)
})


test('direct ordered dispatch preserves peripheral uncertainty without refusing fresh input', async t => {
  const f = await fixture(t)
  assert.equal((await f.transport.dispatchInOrder(f.bot, 'direct synthetic', [])).session, 'existing')
  f.transport.uncertainChanges.set(f.bot.id, 'agent_launch')
  assert.equal((await f.transport.dispatchInOrder(f.bot, 'fresh synthetic', [])).session, 'existing')
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 2)
  assert.equal(f.transport.uncertainChanges.get(f.bot.id), 'agent_launch')
})

test('individual stop while a rejected configuration wait settles still cancels the queued delivery', async t => {
  const f = await fixture(t), access = deferred(), entered = deferred()
  f.transport.requireAccess = async () => { entered.resolve(); await access.promise }
  const previous = f.transport.client.call.bind(f.transport.client)
  f.transport.client.call = (name, args, options) => name === 'agent_stop'
    ? Promise.resolve({ structuredContent: { status: 'sent', targets: [{ session_id: 'existing', status: 'sent' }] } })
    : previous(name, args, options)
  const completion = f.transport.submit(f.bot, 'synthetic stopped')
  await entered.promise
  await f.transport.interrupt(f.bot)
  access.resolve()
  await assert.rejects(completion.accepted, { code: 'BOT_STOPPED' })
  await assert.rejects(completion, { code: 'BOT_STOPPED' })
  assert.equal(f.calls.filter(c => c.name === 'pty_send').length, 0)
})
