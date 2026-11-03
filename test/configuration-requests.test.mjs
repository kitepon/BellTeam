import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, chmod, readFile, writeFile, lstat, mkdir, symlink, rename, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { AitermClient } from '../src/aiterm-client.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { ConfigurationRequests } from '../src/configuration-requests.mjs'
import { configurationReceipt, configurationDigest, configurationError, CONFIGURATION_VERSION } from '../src/configuration-request.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { executionFailureReport } from '../src/execution-failure-report.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const tool = () => ({ name: 'agent_configure', inputSchema: { properties: {
  action: { enum: ['apply', 'reconcile'] }, request: { type: 'object', required: ['id', 'launch_id', 'digest'],
    properties: { id: { type: 'string' }, launch_id: { type: 'string' }, digest: { type: 'string' } } },
} }, outputSchema: { properties: { schema: { enum: ['aiterm.agent-configure-request-result.v1'] } } } })
const receipt = (binding, change = {}) => ({ schema: 'aiterm.agent-configure-request-result.v1', binding,
  request_state: 'terminal', outcome: 'not_applied', later_effect: 'excluded', terminal_at: '2026-11-03T07:00:00.000Z',
  result: null, current: { availability: 'unsupported' }, observed_at: '2026-11-03T07:00:01.000Z', ...change })
const applied = binding => receipt(binding, { outcome: 'applied', later_effect: 'unconfirmed', result: {
  schema: 'aiterm.agent-configure-result.v1', session_id: binding.session_id, provider: 'codex', harness: 'codex-cli', model: 'next', reasoning_effort: 'high', fast: null,
} })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tracked-configuration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', session: 'original', project: root, harness: 'codex', model: 'old', reasoningEffort: 'high', fastMode: false }
  const transportProcess = { pid: 123 }, calls = []
  const f = { root, bot, calls, version: CONFIGURATION_VERSION, tool: tool(), onApply: applied, onReconcile: binding => receipt(binding) }
  const intents = new ConfigurationIntents(join(root, 'configuration-intents'), { ownerUid: process.getuid() })
  const sdk = { transport: transportProcess, getServerVersion: () => ({ name: 'aiterm', version: f.version }),
    listTools: async () => ({ tools: [f.tool] }), async callTool({ name, arguments: args }) {
      calls.push({ name, args })
      if (name === 'pty_list') return { structuredContent: { schema: 'aiterm.pty-list-result.v1', sessions: [{ session_id: bot.session, launch_id: '1'.repeat(32) }] } }
      const binding = { ...args.request, session_id: args.session_id }
      assert.deepEqual((await intents.read(bot.id, binding.id)).binding, { id: binding.id, session_id: binding.session_id, launch_id: binding.launch_id, digest: binding.digest }, 'durable intent must precede every tracked wire call')
      const value = await (args.action === 'apply' ? f.onApply(binding) : f.onReconcile(binding))
      return value?.structuredContent ? value : { structuredContent: value }
    } }
  const client = new AitermClient({ env: {} }); client.client = sdk; client.transport = transportProcess
  const requests = new ConfigurationRequests({ client, intents })
  const transport = new AitermTransport({ client, configurationRequests: requests })
  transport.isRunning = async () => true
  const bots = new Map([[bot.id, bot]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const admin = new BotAdministration({ bots, transport, writeLog() {} })
  return Object.assign(f, { intents, sdk, client, requests, transport, bots, admin })
}
const apply = f => f.transport.reconfigure(f.bot, { ...f.bot, model: 'next' })

test('new apply is persisted before one bound wire call and keeps unsupported/unconfirmed history', async t => {
  const f = await fixture(t), result = await apply(f)
  assert.equal(result.configurationRequest.outcome, 'applied')
  assert.equal(result.configurationRequest.later_effect, 'unconfirmed')
  assert.deepEqual(result.configurationRequest.current, { availability: 'unsupported' })
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 1)
  const binding = result.configurationRequest.binding
  assert.equal(binding.digest, configurationDigest({ model: 'next', reasoning_effort: 'high' }))
  assert.equal((await f.intents.terminal(f.bot.id, binding)).origin, 'apply')
  assert.equal((await f.intents.read(f.bot.id, binding.id)).version, '0.63.7')
  assert.deepEqual(await f.intents.pending(), [])
})

for (const missing of ['old-version', 'action', 'request', 'output']) test(`capability ${missing} is not-issued with apply zero`, async t => {
  const f = await fixture(t)
  if (missing === 'old-version') f.version = '0.63.5'
  if (missing === 'action') delete f.tool.inputSchema.properties.action
  if (missing === 'request') f.tool.inputSchema.properties.request.required = ['id']
  if (missing === 'output') f.tool.outputSchema.properties.schema.enum = ['legacy']
  await assert.rejects(apply(f), { effect: 'not_issued' })
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 0)
})

test('post-save connection replacement cannot reconnect or issue apply', async t => {
  const f = await fixture(t), publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async (...args) => { const saved = await publish(...args); f.client.client = { ...f.sdk }; return saved }
  await assert.rejects(apply(f), { effect: 'not_issued' })
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 0)
  const binding = f.requests.view(f.bot.id).binding
  assert.equal(await f.intents.notIssued(f.bot.id, binding), true)
  assert.deepEqual(await f.intents.pending(), [])
  assert.equal((await f.intents.read(f.bot.id, binding.id)).binding.id, binding.id)
})

test('frozen RPC error keeps its identity, original request and same-ID read-only reconciliation', async t => {
  const f = await fixture(t), original = Object.freeze(Error('synthetic lost result'))
  f.onApply = async () => { throw original }
  await assert.rejects(apply(f), error => error === original)
  const binding = f.requests.view(f.bot.id).binding
  const diagnostic = executionFailureReport(f.bot.id, 'configuration', original).diagnostic_log
  assert.deepEqual(JSON.parse(diagnostic).configuration_request, binding)
  assert.doesNotMatch(diagnostic, /synthetic lost result|next/)
  assert.equal(f.transport.uncertainChanges.get(f.bot.id), 'agent_configure')
  const result = await f.transport.reconcileConfiguration(f.bot, binding.id)
  assert.equal(result.fence, 'cleared')
  assert.deepEqual(f.calls.filter(call => call.name === 'agent_configure').map(call => call.args.action), ['apply', 'reconcile'])
  assert.ok(f.calls.filter(call => call.name === 'agent_configure').every(call => call.args.request.id === binding.id))
  assert.deepEqual(Object.keys(f.calls.at(-1).args).sort(), ['action', 'request', 'session_id'])
})

test('historical applied/unconfirmed from reconcile never clears a fence, including after restart', async t => {
  const f = await fixture(t); f.onApply = async () => { throw Error('lost') }
  await assert.rejects(apply(f)); const binding = f.requests.view(f.bot.id).binding
  f.onReconcile = applied
  assert.equal((await f.transport.reconcileConfiguration(f.bot, binding.id)).fence, 'retained')
  const next = new ConfigurationRequests({ client: f.client, intents: f.intents })
  const restarted = new AitermTransport({ client: f.client, configurationRequests: next })
  await restarted.restoreConfigurationRequests()
  assert.equal(restarted.uncertainChanges.get(f.bot.id), 'agent_configure')
  await assert.rejects(restarted.reconfigure(f.bot, { ...f.bot, model: 'another' }), { code: 'BOT_SESSION_UNCONFIRMED' })
})

for (const state of ['pending_or_unknown', 'not_recorded', 'unavailable']) test(`${state} retains the original fence`, async t => {
  const f = await fixture(t); f.onApply = async () => { throw Error('lost') }
  await assert.rejects(apply(f)); const binding = f.requests.view(f.bot.id).binding
  f.onReconcile = binding => receipt(binding, { request_state: state, outcome: 'outcome_unknown', later_effect: 'unconfirmed', terminal_at: null })
  assert.equal((await f.transport.reconcileConfiguration(f.bot, binding.id)).fence, 'retained')
})

test('isError tracked refusal preserves the strict receipt and known not-started application', async t => {
  const f = await fixture(t)
  f.onApply = binding => ({ isError: true, structuredContent: receipt(binding), content: [{ type: 'text', text: 'synthetic private text' }] })
  const reconfigure = f.transport.reconfigure.bind(f.transport)
  let completion
  f.transport.reconfigure = (...args) => { completion = reconfigure(...args); return completion }
  await f.admin.update(f.bot.id, { model: 'next' })
  await assert.rejects(completion, { code: 'CONFIGURATION_NOT_APPLIED' }); await tick()
  const view = f.admin.view(f.bots.get(f.bot.id))
  assert.equal(view.model, 'next')
  assert.equal(view.configurationApplication.outcome, 'not_applied')
  assert.equal(view.configurationApplication.effect, 'not_started')
  assert.equal(view.configurationRequest.receipt.later_effect, 'excluded')
  assert.doesNotMatch(JSON.stringify(view), /synthetic private text/)
})

test('changed uncertainty version or legacy unbound failure cannot be cleared', async t => {
  const f = await fixture(t); f.onApply = async () => { throw Error('lost') }
  await assert.rejects(apply(f)); const binding = f.requests.view(f.bot.id).binding
  f.onReconcile = binding => { f.transport.uncertainChanges.set(f.bot.id, 'agent_configure', binding); return receipt(binding) }
  assert.equal((await f.transport.reconcileConfiguration(f.bot, binding.id)).fence, 'retained')
  f.transport.uncertainChanges.set(f.bot.id, 'agent_configure', null)
  const before = f.calls.length
  await assert.rejects(f.transport.reconcileConfiguration(f.bot, binding.id), { code: 'CONFIGURATION_REQUEST_UNBOUND' })
  assert.equal(f.calls.length, before)
})

test('strict receipt rejects wrong binding and contradictory states', () => {
  const binding = { id: 'a1234567-1234-4123-8123-123456789abc', session_id: 'original', launch_id: '1'.repeat(32), digest: '2'.repeat(64) }
  for (const changed of [{ binding: { ...binding, launch_id: '3'.repeat(32) } }, { extra: true },
    { request_state: 'not_recorded' }, { outcome: 'applied' }, { terminal_at: '2026-02-31T00:00:00Z' },
    { current: { availability: 'available' } }, { request_state: 'pending_or_unknown', terminal_at: null, later_effect: 'excluded' }])
    assert.throws(() => configurationReceipt(receipt(binding, changed), binding), { code: 'CONFIGURATION_RESULT_UNCONFIRMED' })
})

test('published intent cannot be overwritten and corrupted storage cannot authorize a new UUID', async t => {
  const f = await fixture(t); f.onApply = async () => { throw Error('lost') }
  await assert.rejects(apply(f)); const binding = f.requests.view(f.bot.id).binding
  const original = await f.intents.read(f.bot.id, binding.id)
  await assert.rejects(f.intents.publish(f.bot.id, original), { code: 'EEXIST' })
  const file = join(f.intents.root, f.bot.id, `${binding.id}.intent.json`)
  const changed = JSON.parse(await readFile(file, 'utf8')); changed.requested.model = 'tampered'
  await writeFile(file, JSON.stringify(changed))
  await assert.rejects(f.intents.pending(), { code: 'CONFIGURATION_INTENT_INVALID' })
  await chmod(join(f.intents.root, f.bot.id), 0o755)
  await assert.rejects(f.intents.read(f.bot.id, binding.id), { code: 'CONFIGURATION_STORAGE_INVALID' })
})

test('final Client guard rejects replacement after prepare returns without marking a native change', async t => {
  const f = await fixture(t), prepare = f.requests.prepare.bind(f.requests)
  f.requests.prepare = async (...args) => { const prepared = await prepare(...args); f.client.client = { ...f.sdk }; return prepared }
  await assert.rejects(apply(f), { effect: 'not_issued' })
  assert.equal(f.transport.uncertainChanges.has(f.bot.id), false)
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 0)
})

test('publication error after link retains the original ID and never issues or replaces it', async t => {
  const f = await fixture(t), publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async (...args) => { await publish(...args); throw Object.assign(Error('synthetic directory sync reply lost'), { code: 'EIO' }) }
  await assert.rejects(apply(f), { code: 'CONFIGURATION_INTENT_SAVE_UNCONFIRMED' })
  const id = f.requests.view(f.bot.id).binding.id
  assert.equal((await f.intents.read(f.bot.id, id)).binding.id, id)
  await assert.rejects(apply(f), { code: 'CONFIGURATION_REQUEST_PENDING' })
  assert.equal(f.requests.view(f.bot.id).binding.id, id)
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 0)
})

test('a wrong-binding wire result cannot be saved or clear uncertainty', async t => {
  const f = await fixture(t)
  f.onApply = binding => applied({ ...binding, launch_id: '2'.repeat(32) })
  await assert.rejects(apply(f), { code: 'CONFIGURATION_RESULT_UNCONFIRMED' })
  assert.equal(f.transport.uncertainChanges.get(f.bot.id), 'agent_configure')
  const original = f.requests.view(f.bot.id).binding
  assert.equal(original.launch_id, '1'.repeat(32))
  assert.equal(await f.intents.terminal(f.bot.id, original), null)
})

for (const version of ['0.63.5', '0.63.6']) test(`old ${version} intent stays byte-identical while wire uses approved 0.63.7`, async t => {
  const f = await fixture(t)
  const binding = { id: 'a1234567-1234-4123-8123-123456789abc', session_id: f.bot.session, launch_id: '1'.repeat(32), digest: configurationDigest({ model: 'next' }) }
  await f.intents.publish(f.bot.id, { schema: 'bellteam.configuration-intent.v1', botId: f.bot.id, binding,
    requested: { model: 'next', reasoning_effort: null, fast: null }, version })
  const path = join(f.root, 'configuration-intents', f.bot.id, `${binding.id}.intent.json`)
  const before = await readFile(path)
  await f.transport.restoreConfigurationRequests()
  assert.equal((await f.transport.reconcileConfiguration(f.bot, binding.id)).fence, 'cleared')
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 0)
  assert.deepEqual(await readFile(path), before)
  assert.equal((await f.intents.read(f.bot.id, binding.id)).version, version)
})

test('authenticated reconcile route accepts only the stored request ID and cannot submit settings', async t => {
  const f = await fixture(t); f.onApply = async () => { throw Error('lost') }
  await assert.rejects(apply(f)); const id = f.requests.view(f.bot.id).binding.id
  const server = createBellTeamServer({ bots: f.bots, transport: f.transport, authorize: request => request.headers.authorization === 'Bearer synthetic' })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/bots/${f.bot.id}/configuration/reconcile`
  const send = (body, authorized = true) => fetch(url, { method: 'POST', headers: authorized ? { authorization: 'Bearer synthetic', 'content-type': 'application/json' } : {}, body: JSON.stringify(body) })
  assert.equal((await send({ request_id: id }, false)).status, 401)
  assert.equal((await send({ request_id: id, model: 'resend' })).status, 400)
  const response = await send({ request_id: id })
  assert.equal(response.status, 200); assert.equal((await response.json()).fence, 'cleared')
  assert.deepEqual(f.calls.filter(call => call.name === 'agent_configure').map(call => call.args.action), ['apply', 'reconcile'])
})

test('stop generation change during a read-only reconciliation retains its fence', async t => {
  const f = await fixture(t); f.onApply = async () => { throw Error('lost') }
  await assert.rejects(apply(f)); const id = f.requests.view(f.bot.id).binding.id
  f.onReconcile = binding => { f.transport.sessionState.invalidate(f.bot.id); return receipt(binding) }
  assert.equal((await f.transport.reconcileConfiguration(f.bot, id)).fence, 'retained')
})

test('local not-issued remains distinct from desired persistence and native acceptance', async t => {
  const f = await fixture(t); f.version = '0.63.5'
  const reconfigure = f.transport.reconfigure.bind(f.transport)
  let completion
  f.transport.reconfigure = (...args) => { completion = reconfigure(...args); return completion }
  await f.admin.update(f.bot.id, { model: 'next', fastMode: true })
  await assert.rejects(completion, { effect: 'not_issued' }); await tick()
  const view = f.admin.view(f.bots.get(f.bot.id))
  assert.equal(view.model, 'next'); assert.equal(view.fastMode, false)
  assert.equal(view.configurationApplication.outcome, 'not_applied')
  assert.equal(view.configurationApplication.effect, 'not_started')
  assert.equal(view.configurationRequest, undefined)
  assert.equal(f.calls.length, 0)
})

test('a successful no-native-effect result may be applied/excluded without inventing readback', async t => {
  const f = await fixture(t)
  f.onApply = binding => ({ ...applied(binding), later_effect: 'excluded' })
  const result = await apply(f)
  assert.equal(result.configurationRequest.outcome, 'applied')
  assert.equal(result.configurationRequest.later_effect, 'excluded')
  assert.equal(result.configurationRequest.current.availability, 'unsupported')
})

test('terminal unknown with native effects excluded preserves outcome and does not fabricate not-applied', async t => {
  const f = await fixture(t)
  f.onApply = binding => receipt(binding, { outcome: 'outcome_unknown' })
  await assert.rejects(apply(f), { code: 'CONFIGURATION_OUTCOME_UNKNOWN', effect: 'possible' })
  assert.equal(f.requests.view(f.bot.id).receipt.outcome, 'outcome_unknown')
  assert.equal(f.transport.uncertainChanges.has(f.bot.id), false)
})

test('storage failure after apply cannot be mistaken for a local pre-wire refusal', async t => {
  const f = await fixture(t)
  const saveTerminal = f.intents.saveTerminal.bind(f.intents)
  f.intents.saveTerminal = async () => { throw configurationError('CONFIGURATION_STORAGE_INVALID') }
  await assert.rejects(apply(f), { effect: 'possible' })
  const binding = f.requests.view(f.bot.id).binding
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 1)
  assert.equal(await f.intents.notIssued(f.bot.id, binding), false)
  assert.equal(f.requests.view(f.bot.id).receipt.outcome, 'applied')
  assert.equal(f.requests.view(f.bot.id).receipt_persisted, false)
  assert.equal(f.requests.pending.has(f.bot.id), true)
  assert.equal(f.transport.uncertainChanges.has(f.bot.id), false, 'a received applied result does not become an unknown RPC because its local history write failed')
  f.intents.saveTerminal = saveTerminal; f.onReconcile = applied
  assert.equal((await f.transport.reconcileConfiguration(f.bot, binding.id)).fence, 'absent')
  assert.equal(f.requests.pending.has(f.bot.id), false)
  assert.equal((await f.intents.terminal(f.bot.id, binding)).origin, 'apply')
  assert.equal((await f.intents.read(f.bot.id, binding.id)).version, '0.63.7')
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 1)
})

test('stop between durable prepare and issuance prevents the first apply and records local no-wire completion', async t => {
  const f = await fixture(t), prepare = f.requests.prepare.bind(f.requests)
  f.requests.prepare = async (...args) => { const prepared = await prepare(...args); f.transport.sessionState.invalidate(f.bot.id); return prepared }
  await assert.rejects(apply(f), { code: 'CONFIGURATION_STOPPED', effect: 'not_issued' })
  const binding = f.requests.view(f.bot.id).binding
  assert.equal(await f.intents.notIssued(f.bot.id, binding), true)
  assert.equal(f.calls.filter(call => call.args.action === 'apply').length, 0)
  assert.equal(f.transport.uncertainChanges.has(f.bot.id), false)
})

test('a shared SDK error object never attaches the other request binding to diagnostics', async t => {
  const f = await fixture(t), g = await fixture(t), shared = Object.freeze(Error('shared connection closed'))
  f.onApply = g.onApply = async () => { throw shared }
  await assert.rejects(apply(f), error => error === shared)
  await assert.rejects(apply(g), error => error === shared)
  assert.notEqual(f.requests.view(f.bot.id).binding.id, g.requests.view(g.bot.id).binding.id)
  assert.equal(JSON.parse(executionFailureReport(f.bot.id, 'configuration', shared).diagnostic_log).configuration_request, undefined)
  assert.equal(f.transport.uncertainChanges.version(f.bot.id).request.id, f.requests.view(f.bot.id).binding.id)
  assert.equal(g.transport.uncertainChanges.version(g.bot.id).request.id, g.requests.view(g.bot.id).binding.id)
})

test('prepare rejection before the intent writer keeps fixed codes and completes the same original locally', async t => {
  const f = await fixture(t), directory = f.intents.directory.bind(f.intents)
  f.intents.directory = async () => { throw configurationError('CONFIGURATION_STORAGE_INVALID') }
  let failure
  await assert.rejects(apply(f), error => { failure = error; return error.code === 'CONFIGURATION_INTENT_SAVE_UNCONFIRMED' })
  const before = f.requests.view(f.bot.id)
  assert.deepEqual(before.preparation, { state: 'not_returned', publication: 'not_started' })
  assert.equal(before.local_not_issued, undefined)
  const diagnostic = JSON.parse(executionFailureReport(f.bot.id, 'configuration', failure).diagnostic_log)
  assert.deepEqual(diagnostic.failure, { error_type: 'Error', error_code: 'CONFIGURATION_INTENT_SAVE_UNCONFIRMED', cause_code: 'CONFIGURATION_STORAGE_INVALID' })
  assert.deepEqual(diagnostic.preparation, before.preparation)
  assert.doesNotMatch(JSON.stringify(diagnostic), /next|reasoning_effort|requested/)
  await assert.rejects(apply(f), { code: 'CONFIGURATION_REQUEST_PENDING' })
  f.intents.directory = directory
  const result = await f.transport.reconcileConfiguration(f.bot, before.binding.id)
  assert.equal(result.localCompletion.schema, 'bellteam.configuration-local-completion.v1')
  assert.deepEqual(result.localCompletion.binding, before.binding)
  assert.equal(result.configurationRequest, undefined, 'no native receipt is fabricated')
  assert.equal(result.fence, 'absent')
  assert.equal(f.requests.view(f.bot.id).local_not_issued, true)
  assert.equal(f.requests.pending.has(f.bot.id), false)
  assert.equal(await f.intents.notIssued(f.bot.id, before.binding), true)
  assert.deepEqual((await f.intents.read(f.bot.id, before.binding.id)).requested, before.requested)
  assert.equal(f.calls.filter(call => call.name === 'agent_configure').length, 0)
  assert.equal((await f.intents.pending()).length, 0)
})

test('prepare not-returned evidence separates publish unknown and survives a failed local completion attempt', async t => {
  const f = await fixture(t), publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async (...args) => { await publish(...args); throw Object.assign(Error('synthetic sync failure'), { code: 'EIO' }) }
  await assert.rejects(apply(f), { code: 'CONFIGURATION_INTENT_SAVE_UNCONFIRMED' })
  const before = f.requests.view(f.bot.id), original = await f.intents.read(f.bot.id, before.binding.id)
  assert.deepEqual(before.preparation, { state: 'not_returned', publication: 'unknown' })
  const save = f.intents.saveNotIssued.bind(f.intents)
  f.intents.saveNotIssued = async () => { throw Object.assign(Error('synthetic save failure'), { code: 'EIO' }) }
  await assert.rejects(f.transport.reconcileConfiguration(f.bot, before.binding.id), { code: 'EIO' })
  assert.equal(f.requests.canRecoverPreparation(f.bot.id, before.binding.id), true)
  assert.equal(f.requests.view(f.bot.id).local_not_issued, undefined)
  f.intents.saveNotIssued = save
  await f.transport.reconcileConfiguration(f.bot, before.binding.id)
  assert.deepEqual(await f.intents.read(f.bot.id, before.binding.id), original)
  assert.equal(f.calls.filter(call => call.name === 'agent_configure').length, 0)
})

test('local prepare completion refuses temporary artifacts and original-request conflicts', async t => {
  const f = await fixture(t), publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async (...args) => { await publish(...args); throw Error('synthetic lost publication') }
  await assert.rejects(apply(f))
  const id = f.requests.view(f.bot.id).binding.id, dir = join(f.intents.root, f.bot.id)
  await writeFile(join(dir, '.crash.tmp'), 'incomplete', { mode: 0o600 })
  await assert.rejects(f.transport.reconcileConfiguration(f.bot, id), { code: 'CONFIGURATION_INTENTS_UNCONFIRMED' })
  await rm(join(dir, '.crash.tmp'))
  const original = await f.intents.read(f.bot.id, id)
  original.binding.launch_id = '2'.repeat(32)
  await writeFile(join(dir, `${id}.intent.json`), JSON.stringify(original))
  await assert.rejects(f.transport.reconcileConfiguration(f.bot, id), { code: 'CONFIGURATION_INTENT_INVALID' })
  assert.equal(f.requests.pending.has(f.bot.id), true)
  assert.equal(f.calls.filter(call => call.name === 'agent_configure').length, 0)
})

test('old missing-stage pending, active work and another uncertainty cannot authorize local completion', async t => {
  const f = await fixture(t)
  f.intents.publish = async () => { throw Error('synthetic storage refusal') }
  await assert.rejects(apply(f))
  const id = f.requests.view(f.bot.id).binding.id
  f.requests.active.add(f.bot.id)
  await assert.rejects(f.transport.reconcileConfiguration(f.bot, id), { code: 'CONFIGURATION_REQUEST_PENDING' })
  f.requests.active.delete(f.bot.id)
  f.transport.uncertainChanges.set(f.bot.id, 'agent_configure', null)
  const version = f.transport.uncertainChanges.version(f.bot.id)
  await assert.rejects(f.transport.reconcileConfiguration(f.bot, id), { code: 'CONFIGURATION_PREPARATION_UNCONFIRMED' })
  assert.equal(f.transport.uncertainChanges.version(f.bot.id), version)
  f.requests.rejectedPreparations.delete(f.bot.id)
  delete f.requests.latest.get(f.bot.id).preparation
  assert.equal(f.requests.canRecoverPreparation(f.bot.id, id), false)
  await assert.rejects(f.requests.recoverPreparation(f.bot.id, id), { code: 'CONFIGURATION_PREPARATION_UNCONFIRMED' })
  assert.equal(f.requests.pending.get(f.bot.id).binding.id, id)
  assert.equal(f.calls.filter(call => call.name === 'agent_configure').length, 0)
})

test('authenticated local prepare reconciliation preserves failed application and saved desired settings', async t => {
  const f = await fixture(t), publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async () => { throw configurationError('CONFIGURATION_STORAGE_INVALID') }
  let completion
  const reconfigure = f.transport.reconfigure.bind(f.transport)
  f.transport.reconfigure = (...args) => { completion = reconfigure(...args); return completion }
  await f.admin.update(f.bot.id, { model: 'next' }); await assert.rejects(completion); await tick()
  const before = f.admin.view(f.bots.get(f.bot.id)), id = before.configurationApplication.requestId
  f.intents.publish = publish
  const server = createBellTeamServer({ bots: f.bots, transport: f.transport, administration: f.admin,
    authorize: request => request.headers.authorization === 'Bearer synthetic' })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/bots/${f.bot.id}/configuration/reconcile`
  const send = (body, authorized = true) => fetch(url, { method: 'POST', headers: authorized ? { authorization: 'Bearer synthetic' } : {}, body: JSON.stringify(body) })
  assert.equal((await send({ request_id: id }, false)).status, 401)
  assert.equal((await send({ request_id: id, preparation: 'not_returned' })).status, 400)
  const response = await send({ request_id: id })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).localCompletion.effect, 'not_issued')
  const after = f.admin.view(f.bots.get(f.bot.id))
  assert.equal(after.model, 'next')
  assert.equal(after.configurationApplication.state, 'failed')
  assert.equal(after.configurationApplication.outcome, before.configurationApplication.outcome)
  assert.equal(after.configurationApplication.localCompletion.binding.id, id)
  assert.equal(f.calls.filter(call => call.name === 'agent_configure').length, 0)
})

test('trusted anchor is identity-bound while private descendants and strict fallback remain enforced', async t => {
  const f = await fixture(t), st = await lstat(f.root)
  const anchor = { path: f.root, uid: process.getuid(), dev: st.dev, ino: st.ino }
  const options = { ownerUid: process.getuid(), trustedAnchor: anchor }
  const intents = new ConfigurationIntents(join(f.root, 'anchored'), options)
  assert.equal(await intents.botDirectory(f.bot.id, true), join(f.root, 'anchored', f.bot.id))
  assert.equal((await lstat(intents.root)).mode & 0o777, 0o700)
  await chmod(join(intents.root, f.bot.id), 0o755)
  await assert.rejects(intents.botDirectory(f.bot.id), { code: 'CONFIGURATION_STORAGE_INVALID' })
  await chmod(join(intents.root, f.bot.id), 0o700)
  for (const changed of [{ ino: anchor.ino + 1 }, { dev: anchor.dev + 1 }, { uid: anchor.uid + 1 }]) {
    if (changed.uid) assert.throws(() => new ConfigurationIntents(intents.root, { ...options, trustedAnchor: { ...anchor, ...changed } }), { code: 'CONFIGURATION_STORAGE_INVALID' })
    else await assert.rejects(new ConfigurationIntents(intents.root, { ...options, trustedAnchor: { ...anchor, ...changed } }).botDirectory(f.bot.id), { code: 'CONFIGURATION_STORAGE_INVALID' })
  }
  await chmod(f.root, 0o777)
  await assert.rejects(intents.botDirectory(f.bot.id), { code: 'CONFIGURATION_STORAGE_INVALID' })
  await chmod(f.root, 0o700)
  await symlink(intents.root, join(f.root, 'alias'))
  await assert.rejects(new ConfigurationIntents(join(f.root, 'alias'), options).botDirectory(f.bot.id), { code: 'CONFIGURATION_STORAGE_INVALID' })
  assert.throws(() => new ConfigurationIntents(join(f.root, 'sibling'), { ...options, trustedAnchor: { ...anchor, path: join(f.root, 'another') } }), { code: 'CONFIGURATION_STORAGE_INVALID' })
  await rename(f.root, `${f.root}.old`); t.after(() => rm(`${f.root}.old`, { recursive: true, force: true }))
  await assert.rejects(intents.botDirectory(f.bot.id, true), { code: 'ENOENT' })
  await mkdir(f.root, { mode: 0o700 })
  await assert.rejects(intents.botDirectory(f.bot.id, true), { code: 'CONFIGURATION_STORAGE_INVALID' })
  assert.deepEqual(await readdir(f.root), [])
})

test('fixed storage rejection codes and preparation stage reach the existing saved diagnostic writer', async t => {
  const f = await fixture(t), path = join(f.root, 'diagnostics.json'), diagnostics = new Diagnostics(path)
  await diagnostics.initialize()
  f.admin.reportError = report => diagnostics.record(report)
  f.intents.directory = async () => { throw configurationError('CONFIGURATION_STORAGE_INVALID') }
  let completion
  const reconfigure = f.transport.reconfigure.bind(f.transport)
  f.transport.reconfigure = (...args) => { completion = reconfigure(...args); return completion }
  await f.admin.update(f.bot.id, { model: 'next' }); await assert.rejects(completion); await tick(); await diagnostics.pending
  const [row] = JSON.parse(await readFile(path, 'utf8')), detail = JSON.parse(row.diagnostic_log)
  assert.deepEqual(detail.failure, { error_type: 'Error', error_code: 'CONFIGURATION_INTENT_SAVE_UNCONFIRMED', cause_code: 'CONFIGURATION_STORAGE_INVALID' })
  assert.deepEqual(detail.preparation, { state: 'not_returned', publication: 'not_started' })
  assert.deepEqual(detail.configuration_request, f.requests.view(f.bot.id).binding)
  assert.equal(row.fingerprint, 'b5159a7976e0c5597ce53d6d12c387075b9699da00d27ea5086b6206e0d4f267')
  assert.equal(row.status, 'open'); assert.equal(row.severity, 'high')
  assert.doesNotMatch(JSON.stringify(row), /next|reasoning_effort|stack|requested/)
  assert.equal(f.calls.filter(call => call.name === 'agent_configure').length, 0)
})

for (const version of ['0.63.6', '0.63.8']) test(`unapproved native ${version} cannot issue a new configuration`, async t => {
  const f = await fixture(t); f.version = version
  await assert.rejects(apply(f), { code: 'CONFIGURATION_CONNECTION_UNCONFIRMED', effect: 'not_issued' })
  assert.deepEqual(f.calls, [])
})
