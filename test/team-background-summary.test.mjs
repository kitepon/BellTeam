import test from 'node:test'
import assert from 'node:assert/strict'
import { TeamBackgroundSummary, backgroundSummaryText } from '../src/team-background-summary.mjs'
import { createBackgroundSummaryRunner } from '../src/background-summary-runner.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { createConversationExecutionEffects } from '../src/conversation-execution-effects.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createExecutionAssembly } from '../src/execution-assembly.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const deferred = () => Promise.withResolvers()
// Z-b2: the runner spawns the captured absolute CLI path, never a PATH lookup.
const releaseRuntime = { generation: 'a'.repeat(64), components: {
  'runtime-claude-code': { origin: 'release', bin: { claude: '/rt/claude/bin/claude' } }, 'runtime-codex': { origin: 'release', bin: { codex: '/rt/codex/bin/codex' } } } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const first = { revision: '11111111-1111-4111-8111-111111111111', selection: { harness: 'claude', model: 'chosen', reasoningEffort: 'high' } }
const second = { revision: '22222222-2222-4222-8222-222222222222', selection: { ...first.selection, model: 'other' } }
const input = (botId = 'bot-a', inputRevision = 'input-a') => ({ botId, sessionId: botId, launchId: 'a'.repeat(32), inputRevision,
  deliveryId: 'delivery-a', context: 'direct', contextId: botId })
const authority = () => ({ context: { actor: { kind: 'owner' }, rootMethod: 'user.turn' }, assertCurrent: () => true })
const fallback = { state: 'unknown', summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, observedAt: null, source: null }
function fixture(t, options = {}) {
  let selected = first
  const events = [], calls = []
  const worker = new TeamBackgroundSummary({ configuration: async () => selected,
    readInput: async value => ({ ...value, text: value.inputRevision, progress: 'running' }),
    run: async (selection, prompt) => { calls.push({ selection, prompt }); return '修理を確認中' },
    notify: botId => events.push(botId), ...options })
  t.after(() => worker.close())
  return { worker, events, calls, select(value) { selected = value; worker.configure(value) }, view: botId => worker.snapshot(botId, botId, fallback) }
}

test('one actual run across bots; new queued input replaces only its earlier input', async t => {
  const held = deferred(), starts = []; let live = 0, maximum = 0
  const f = fixture(t, { run: async (_s, prompt) => {
    maximum = Math.max(maximum, ++live); const key = JSON.parse(prompt).text; starts.push(key)
    try { if (key === 'input-a') await held.promise; return `確認 ${key}` } finally { live-- }
  } })
  f.worker.accept(input(), authority()); await tick()
  f.worker.accept(input('bot-b', 'old-b'), authority()); f.worker.accept(input('bot-b', 'new-b'), authority())
  await tick(); assert.deepEqual(starts, ['input-a'])
  held.resolve(); await f.worker.draining
  assert.equal(maximum, 1); assert.deepEqual(starts, ['input-a', 'new-b'])
  assert.equal(f.view('bot-b').source, 'background_agent'); assert.equal(f.view('bot-b').summary, '確認 new-b')
})
test('new input cancels old result but holds the global slot until actual settlement', async t => {
  const held = deferred(), starts = []; let signal
  const f = fixture(t, { run: async (_s, prompt, options) => {
    const key = JSON.parse(prompt).text; starts.push(key)
    if (key === 'input-a') { signal = options.signal; await held.promise }
    return `作業 ${key}`
  } })
  f.worker.accept(input(), authority()); await tick()
  f.worker.accept(input('bot-a', 'new'), authority()); await tick()
  assert.equal(signal.aborted, true); assert.deepEqual(starts, ['input-a']); assert.equal(f.view('bot-a').summary, null)
  held.resolve(); await f.worker.draining
  assert.equal(f.view('bot-a').summary, '作業 new'); assert.deepEqual(starts, ['input-a', 'new'])
})
test('configuration change invalidates all summaries and rejects the late old-model result', async t => {
  const held = deferred(), starts = []
  const f = fixture(t, { run: async selection => { starts.push(selection.model); if (selection.model === 'chosen') await held.promise; return selection.model } })
  f.worker.accept(input(), authority()); await tick(); f.select(second)
  assert.equal(f.view('bot-a').summary, null); assert.deepEqual(starts, ['chosen'])
  held.resolve(); await f.worker.draining
  assert.deepEqual(starts, ['chosen', 'other']); assert.equal(f.view('bot-a').summary, 'other')
  f.select(second); await tick(); assert.equal(starts.length, 2)
})
test('secret actor, wrong reader identity, invalid output and failed runs do not retry on GET', async t => {
  let reads = 0, runs = 0
  const f = fixture(t, { readInput: async value => { reads++; return { ...value, inputRevision: 'wrong', text: 'x', progress: '' } },
    run: async () => { runs++; throw Error('unknown') } })
  f.worker.accept(input(), { context: { actor: { kind: 'usage', source: 'secret' }, rootMethod: 'user.post' }, assertCurrent: () => true })
  await tick(); assert.equal(reads, 0)
  f.worker.accept(input(), authority()); await f.worker.draining
  for (let i = 0; i < 3; i++) assert.equal(f.view('bot-a').summary, null)
  assert.equal(reads, 1); assert.equal(runs, 0)
  f.worker.readInput = async value => ({ ...value, text: 'x', progress: '' })
  f.worker.accept(input('bot-a', 'input-b'), authority()); await f.worker.draining
  await tick(); assert.equal(runs, 1); assert.equal(f.view('bot-a').summaryStatus, 'missing')
  assert.throws(() => backgroundSummaryText('line\nsecond')); assert.throws(() => backgroundSummaryText('😀'.repeat(161)))
  assert.equal(backgroundSummaryText(` ${'😀'.repeat(160)} `).length, 320)
})
test('TTL and summary remain independent of native state; unknown never invents working', async t => {
  let clock = 0, live = true
  const f = fixture(t, { monotonic: () => clock })
  f.worker.accept(input(), { ...authority(), assertCurrent: () => live }); await f.worker.draining
  const current = f.view('bot-a'); assert.equal(current.state, 'unknown'); assert.equal(current.summaryStatus, 'current')
  const observed = { ...fallback, state: 'working', observedAt: '2026-11-04T23:00:00Z' }
  assert.equal(f.worker.snapshot('bot-a', 'bot-a', observed).state, 'working')
  clock = 600_000
  assert.deepEqual(f.view('bot-a'), { ...current, summary: null, summaryStatus: 'stale' })
  live = false
  const invalid = f.worker.snapshot('bot-a', 'bot-a', observed)
  assert.equal(invalid.state, 'working'); assert.equal(invalid.observedAt, observed.observedAt)
  assert.equal(invalid.summaryStatus, 'missing'); assert.equal(invalid.source, null)
  assert.equal(f.calls.length, 1)
})
test('unconfigured/invalid input and unsupported harness never start a process or choose another model', async t => {
  const f = fixture(t, { configuration: async () => ({ revision: null, selection: null }) })
  assert.throws(() => f.worker.configure({ ...first, selection: null }), /BACKGROUND_SUMMARY_INVALID/)
  f.worker.accept(input(), authority()); await f.worker.draining
  assert.equal(f.calls.length, 0); assert.equal(f.view('bot-a').summaryStatus, 'missing')
  let processes = 0
  const run = createBackgroundSummaryRunner({ project: '/unused', models: { forHarness: async () => ({ models: [{ id: 'chosen', efforts: ['high'] }] }) }, runner: async () => { processes++ } })
  await assert.rejects(run({ ...first.selection, harness: 'grok' }, '{}'), { code: 'BACKGROUND_SUMMARY_HARNESS_UNSUPPORTED' })
  await assert.rejects(run({ ...first.selection, model: 'missing' }, '{}'), { code: 'BACKGROUND_SUMMARY_MODEL_INVALID' })
  assert.equal(processes, 0)
})
test('runner pins selected model/effort, disables tools and MCP, uses bounded stdin and rejects malformed results', async () => {
  let captured, response = { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '確認中' }) }
  const run = createBackgroundSummaryRunner({ project: '/unused', models: { forHarness: async () => ({ models: [{ id: 'chosen', efforts: ['high'] }] }) },
    runner: async (...args) => { captured = args; return response }, captureRuntime: async () => releaseRuntime })
  assert.equal(await run(first.selection, '{"text":"限定本文"}'), '確認中')
  const [command, args, options] = captured
  assert.equal(command, 'flock'); assert.deepEqual(args.slice(0, 5), ['--nonblock', '--conflict-exit-code', '75', '/unused/summary.lock', '/rt/claude/bin/claude'])
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--no-session-persistence'))
  assert.equal(args[args.indexOf('--model') + 1], 'chosen'); assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.equal(options.input, '{"text":"限定本文"}'); assert.equal(options.maxBuffer, 65_536)
  response = { stdout: 'bad json' }; await assert.rejects(run(first.selection, '{}'), { code: 'BACKGROUND_SUMMARY_RESULT_INVALID' })
})
test('codex runner uses exec JSONL without user config/MCP/rules, read-only sandbox, stdin input, and only a completed agent message', async () => {
  const lines = events => ({ stdout: events.map(event => JSON.stringify(event)).join('\n') + '\n' })
  const message = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '修正を実装中' } }
  let captured, response = lines([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, message, { type: 'turn.completed', usage: {} }])
  const run = createBackgroundSummaryRunner({ project: '/unused', models: { forHarness: async harness => {
    assert.equal(harness, 'codex'); return { models: [{ id: 'gpt-6-luna', efforts: ['low'] }] } } },
    runner: async (...args) => { captured = args; return response }, captureRuntime: async () => releaseRuntime })
  const selection = { harness: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' }
  assert.equal(await run(selection, '{"text":"限定本文"}'), '修正を実装中')
  const [command, args, options] = captured
  assert.equal(command, 'flock'); assert.deepEqual(args.slice(0, 6), ['--nonblock', '--conflict-exit-code', '75', '/unused/summary.lock', '/rt/codex/bin/codex', 'exec'])
  for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert.equal(args[args.indexOf('-C') + 1], '/unused')
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna'); assert.ok(args.includes('model_reasoning_effort="low"'))
  assert.equal(options.input, '{"text":"限定本文"}'); assert.equal(options.maxBuffer, 65_536)
  for (const bad of [lines([message]), lines([message, { type: 'turn.failed', error: {} }, { type: 'turn.completed' }]),
    lines([{ type: 'turn.completed' }]), { stdout: 'not jsonl' }]) {
    response = bad; await assert.rejects(run(selection, '{}'), { code: 'BACKGROUND_SUMMARY_RESULT_INVALID' })
  }
  await assert.rejects(run({ ...selection, reasoningEffort: 'high' }, '{}'), { code: 'BACKGROUND_SUMMARY_MODEL_INVALID' })
})
test('transport accepts real launch receipt only, shares parent worker and rejects old self writer', async t => {
  const accepted = [], invalidated = []
  const transport = new AitermTransport({ client: { close: async () => {} }, backgroundSummary: {
    accept: (...args) => accepted.push(args), invalidate: (...args) => invalidated.push(args), snapshot: (_id, _session, value) => value,
  } })
  t.after(() => transport.close())
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude' }
  const job = { bot, id: 'input-a', info: { groupId: 'delivery-a', context: 'direct', contextId: 'bot-a' } }
  const receipt = { schema: 'aiterm.pty-send-result.v1', session_id: 'bot-a', launch_id: 'a'.repeat(32) }
  transport.latestSummaryInputs.set(bot.id, job.id)
  const original = authority(); original.assertCurrent = () => true
  transport.startWorkSummary(job, { receipt, session: 'bot-a' }, original, undefined)
  assert.equal(accepted.length, 1); assert.equal(accepted[0][1].context, original.context)
  assert.equal(accepted[0][1].assertCurrent(accepted[0][0]), true)
  transport.latestSummaryInputs.set(bot.id, 'new'); assert.equal(accepted[0][1].assertCurrent(accepted[0][0]), false)
  assert.equal(transport.currentWorkBinding(bot), null); assert.throws(() => transport.updateWorkSummary(), { code: 'CURRENT_WORK_FORBIDDEN' })
  transport.startWorkSummary(job, { receipt: { ...receipt, launch_id: null }, session: 'bot-a' }, original, undefined)
  assert.equal(accepted.length, 1)
})
test('parent effect captures original normal authority and structurally excludes secret input', async () => {
  const bot = { id: 'bot-a' }, options = []
  const services = { aiControl: { assertEnabled() {} }, bots: { async refresh() {}, get: () => bot }, transport: { notify: async (_bot, _text, value) => { options.push(value); return { delivery: 'running' } } } }
  const effect = createConversationExecutionEffects({ getServices: () => services, getController: () => ({ callback() {} }), admission: { assertCurrentLease() {}, assertDelivery() {} } })
  const context = { actor: { kind: 'bot', botId: 'sender' }, rootMethod: 'direct.post', conversationLease: {}, conversationDelivery: {}, actualCompletion: Promise.resolve(), operationContext: {}, admissionCheck() {} }
  const params = { target: bot.id, deliveryId: 'delivery-a', message: 'normal', queue: {}, images: [] }
  await effect('execution.notify', params, context)
  assert.equal(options[0].summaryAuthority.context, context)
  await effect('execution.notify', params, { ...context, actor: { kind: 'usage', source: 'secret' } })
  assert.equal(options[1].summaryAuthority, null)
})

test('full transport acceptance starts a shared summary for Claude and completion invalidates it', async t => {
  const done = deferred(), f = fixture(t), bot = { id: 'bot-a', session: 'bot-a', harness: 'claude' }
  const transport = new AitermTransport({ client: { close: async () => {} }, backgroundSummary: f.worker })
  t.after(() => transport.close())
  transport.dispatchInOrder = async () => ({ session: bot.id, imageFiles: [], receipt: {
    schema: 'aiterm.pty-send-result.v1', mode: 'agent_dispatch', session_id: bot.id, launch_id: 'a'.repeat(32),
  } })
  transport.followAcceptedDelivery = () => ({ followed: true, steered: false })
  transport.waitForTurnCompletion = () => done.promise
  assert.deepEqual(await transport.notify(bot, 'synthetic', { queue: { groupId: 'delivery-a', context: 'direct', contextId: bot.id },
    summaryAuthority: authority() }), { delivery: 'running' })
  const job = [...transport.jobs][0]
  await f.worker.draining
  assert.equal(transport.currentWork(bot).summary, '修理を確認中')
  assert.equal(transport.currentWork(bot).state, 'unknown')
  assert.equal(transport.currentWork(bot).source, 'background_agent')
  done.resolve({ turn_id: 'main-turn' }); await job.completion
  assert.equal(transport.currentWork(bot).summaryStatus, 'missing')
})

test('shared process lock rejects a second process and becomes available only after actual exit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-summary-lock-')), lock = join(directory, 'summary.lock')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', lock, process.execPath, '-e',
    "process.stdout.write('ready');process.stdin.on('end',()=>process.exit(0));process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => first.kill())
  const exited = once(first, 'close')
  await once(first.stdout, 'data')
  const second = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', lock, process.execPath, '-e', "process.stdout.write('ran')"])
  let output = ''; second.stdout.on('data', value => { output += value })
  assert.equal((await once(second, 'close'))[0], 75); assert.equal(output, '')
  first.stdin.end(); assert.equal((await exited)[0], 0)
  const third = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', lock, process.execPath, '-e', 'process.exit(0)'])
  assert.equal((await once(third, 'close'))[0], 0)
})

test('real engine exchange keeps one parent worker and an old factory accepts unchanged closed ports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'summary-assembly-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude' }, seen = [], projections = []
  const shared = { invalidate() {}, snapshot: (_bot, _session, value) => { projections.push(value); return value } }
  const ports = { native: { call: async () => ({}), close: async () => {} }, membersAdmission: new MembersAdmission(),
    bots: new Map([[bot.id, bot]]), rooms: {}, configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} } }
  const assembly = createExecutionAssembly({ ports, backgroundSummary: shared, onAdopt: async () => {},
    loadFactory: async versionId => Object.freeze({ versionId, sourceCommit: 'c'.repeat(40), createExecutionDispatcher: params => {
      seen.push(params.backgroundSummary); assert.equal(Object.hasOwn(params.ports, 'backgroundSummary'), false)
      // The old selected factory ignores the additive top-level argument.
      return versionId === null ? createExecutionDispatcher({ generation: params.generation, ports: params.ports, handoff: params.handoff })
        : createExecutionDispatcher(params)
    } }), requestStop: async () => {}, watchQueue: () => () => {} })
  t.after(() => assembly.controller.close())
  await assembly.controller.start(); assembly.transport.currentWork(bot)
  assert.equal(projections.length, 0)
  await assembly.controller.replace('b'.repeat(64)); assembly.transport.currentWork(bot)
  assert.deepEqual(seen, [shared, shared]); assert.equal(projections.length, 1)
})
