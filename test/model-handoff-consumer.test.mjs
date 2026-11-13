import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermClient } from '../src/aiterm-client.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { ConfigurationRequests } from '../src/configuration-requests.mjs'
import { ModelHandoff } from '../src/model-handoff.mjs'
import { CONFIGURATION_VERSION } from '../src/configuration-request.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

// The author dist is test input only; production keeps its installed adapter path.
if (process.env.HANDOFF_TEST_AITERM_DIST) registerHooks({ resolve(specifier, context, next) {
  const prefix = '/usr/local/lib/node_modules/aiterm-mcp/dist/'
  return next(specifier.startsWith(prefix) ? pathToFileURL(join(process.env.HANDOFF_TEST_AITERM_DIST, specifier.slice(prefix.length))).href : specifier, context)
} })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeCall = { server_instance: 'a'.repeat(32), thread_id: 'thread', turn_id: 'original-turn', call_id: 'call',
  call_token: 'c'.repeat(64), source: { kind: 'direct' } }
const tool = { name: 'agent_configure', inputSchema: { properties: { action: { enum: ['apply', 'reconcile'] },
  request: { type: 'object', required: ['id', 'launch_id', 'digest'], properties: { id: { type: 'string' }, launch_id: { type: 'string' }, digest: { type: 'string' } } } } },
  outputSchema: { properties: { schema: { const: 'aiterm.agent-configure-request-result.v1' } } } }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-consumer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-one', session: 'seat', project: root, harness: 'codex', model: 'old', reasoningEffort: 'high', fastMode: false }
  const launch = { session_id: bot.session, launch_id: 'b'.repeat(32) }
  const controller = new AbortController(), calls = [], regular = [], tracked = [], captureRequested = deferred()
  const f = { bot, launch, controller, calls, regular, tracked, captureRequested, snapshot: null, holdCapture: null,
    holdBind: null, bound: deferred(), losePhase: null, failTerminal: false,
    holdRevoke: null, revokeRequested: deferred() }
  const intents = new ConfigurationIntents(join(root, 'intents'), { ownerUid: process.getuid() })
  const sdkTransport = { pid: 123 }
  const sdk = { transport: sdkTransport, getServerVersion: () => ({ name: 'aiterm', version: CONFIGURATION_VERSION }),
    getServerCapabilities: () => ({ experimental: Object.fromEntries(['capture', 'control', 'full'].map(name => [`ai.aiterm/handoff.${name}.v1`, { version: 1 }])) }),
    request: async () => ({ tools: [tool] }),
    callTool: async ({ name }) => { assert.equal(name, 'pty_list'); return { structuredContent: { schema: 'aiterm.pty-list-result.v1', sessions: [launch] } } },
    request: async (input, schema) => {
      calls.push(structuredClone(input))
      if (input.method === 'ai.aiterm/handoff/capture') {
        captureRequested.resolve()
        if (f.holdCapture) await f.holdCapture.promise
        return schema.parse(f.capture)
      }
      const request = input.params.arguments
      if (request.action === 'bind') {
        assert.deepEqual((await intents.read(bot.id, request.context.operation.id)).binding, request.context.operation)
        f.context = request.context
        f.snapshot = { schema: 'aiterm.model-handoff.snapshot.v1', operation: request.context.operation,
          context_digest: hash(request.context), server_instance: request.context.native_call.server_instance, thread_id: request.context.native_call.thread_id, turn_id: request.context.native_call.turn_id,
          revision: '1', state: 'bound', response: { state: 'waiting', receipt: null }, ended_receipt: null, configuration_receipt: null, resumed: null,
          phases: Object.fromEntries(['interrupt', 'configure', 'resume'].map(name => [name, { state: 'not_started', effect: 'not_started' }])),
          revocation: 'not_requested', in_flight: [], later_effect: 'possible', error_code: null }
        f.bound.resolve()
        if (f.holdBind) await f.holdBind.promise
      }
      if (request.action === 'commit') {
        if (f.losePhase === request.phase) throw Error('lost frame')
        f.complete(request.phase)
      }
      if (request.action === 'revoke') {
        f.revokeRequested.resolve()
        if (f.holdRevoke) await f.holdRevoke.promise
        f.exclude()
      }
      const result = f.notRecorded ? { status: 'not_recorded', operation: request.context.operation, later_effect: 'unknown' }
        : { status: 'recorded', snapshot: structuredClone(f.snapshot) }
      return schema.parse({ content: [], structuredContent: result })
    } }
  const client = new AitermClient({ env: {} }); client.client = sdk; client.transport = sdkTransport
  const requests = new ConfigurationRequests({ client, intents })
  const transport = new AitermTransport({ client, configurationRequests: requests })
  transport.isRunning = async () => true
  transport.reconfigure = async (current, candidate, options) => { options.admissionCheck?.(); regular.push({ current, candidate, options }); return {} }
  const bots = new Map([[bot.id, bot]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const admin = new BotAdministration({ bots, transport, writeLog() {}, trackCompletion: promise => tracked.push(promise) })
  const handoff = new ModelHandoff({ transport, requests, readAnchor: anchor => Promise.resolve(structuredClone(anchor)),
    trackCompletion: promise => tracked.push(promise), records: admin.automaticConfigurationOperations })
  admin.handoff = handoff; transport.modelHandoff = handoff
  const job = { bot, receipt: { ...launch, mode: 'agent_dispatch', event_cursor: 42 },
    info: { groupId: 'original-delivery', context: 'direct', contextId: bot.id } }
  transport.jobs.add(job)
  f.capture = { schema: 'aiterm.model-handoff.capture.v1', status: 'captured', launch, native_call: nativeCall, input_revision: 1,
    point: { launch, boundary: { event_cursor: 42, operation_id: null, turn_id: nativeCall.turn_id, steer_id: null } },
    process: { harness: { pid: 100, start_identity: 'harness-birth' }, backend: { pid: 101, start_identity: 'backend-birth' } },
    anchor: { native_message_id: 'native-message', client_delivery_id: job.info.groupId } }
  const context = { schema: 'bellteam.mcp-configuration-ingress.v1', actor: { kind: 'bot', botId: bot.id }, toolName: 'update_self',
    originalMcpRequestId: 73, expectedLaunch: launch, nativeCall, signal: controller.signal, budget: null }
  f.bump = () => { f.snapshot.revision = String(BigInt(f.snapshot.revision) + 1n) }
  f.consume = () => { f.bump(); f.snapshot.response = { state: 'consumed', receipt: { operation_id: f.context.operation.id, kind: 'response', revision: f.snapshot.revision } } }
  f.complete = phase => {
    f.bump(); f.snapshot.phases[phase] = { state: 'completed', effect: 'observed' }
    const receipt = { operation_id: f.context.operation.id, kind: { interrupt: 'ended', configure: 'configured', resume: 'resumed' }[phase], revision: f.snapshot.revision }
    if (phase === 'interrupt') f.snapshot.ended_receipt = receipt
    if (phase === 'configure') f.snapshot.configuration_receipt = receipt
    if (phase === 'resume') { f.snapshot.resumed = { receipt, turn_id: 'actual-new-turn', delivery_id: job.info.groupId }; f.snapshot.state = 'terminal'; f.snapshot.later_effect = 'excluded' }
  }
  f.exclude = () => { f.bump(); f.snapshot.state = 'terminal'; f.snapshot.later_effect = 'excluded'; f.snapshot.revocation = 'durable' }
  f.controls = () => calls.filter(call => call.method === 'tools/call').map(call => call.params.arguments)
  f.start = () => admin.configureFromMcp(bot.id, { model: 'next' }, context)
  return Object.assign(f, { intents, sdk, client, requests, transport, bots, admin, handoff, job, context, ingress: context })
}

test('same response returns before held bind; GET reads without effects; receipts alone advance each phase and durable actual identity completes', async t => {
  const f = await fixture(t); f.holdBind = deferred()
  const response = await f.start()
  assert.deepEqual(Object.keys(response).sort(), ['handoffMetadata', 'value'])
  assert.deepEqual(Object.keys(response.handoffMetadata).sort(), ['call_token', 'operation', 'origin_digest'])
  const operation = f.handoff.current(f.bot.id)
  assert.equal(response.handoffMetadata.operation.id, operation.context.operation.id)
  assert.equal(JSON.parse(operation.originBytes)[2], 73)
  assert.equal(f.bots.get(f.bot.id).model, 'next')
  await tick(); assert.equal(f.controls()[0].action, 'bind')
  assert.equal(f.regular.length, 0)
  f.holdBind.resolve(); await f.bound.promise; await tick()
  await f.admin.readConfigurationOperation(f.bot.id, operation.context.operation.id)
  await f.handoff.poll()
  assert.equal(f.controls().filter(call => call.action === 'commit').length, 0)
  f.consume()
  for (let index = 0; index < 3; index++) await f.handoff.poll()
  await f.admin.applicationCompletions.get(f.bot.id)
  assert.deepEqual(f.controls().filter(call => call.action === 'commit').map(call => call.phase), ['interrupt', 'configure', 'resume'])
  assert.equal(operation.snapshot.resumed.turn_id, 'actual-new-turn')
  assert.equal(f.admin.view(f.bots.get(f.bot.id)).automaticConfigurationApplication.state, 'completed')
  assert.equal(f.handoff.current(f.bot.id), null)
  assert.ok(await f.intents.handoffTerminal(f.bot.id, operation.context.operation))
})

test('cancelled capture returns ordinary saved response and drops the late result without bind', async t => {
  const f = await fixture(t); f.holdCapture = deferred()
  const response = f.start()
  await f.captureRequested.promise
  f.controller.abort()
  assert.equal((await response).handoffMetadata, null)
  assert.equal(f.bots.get(f.bot.id).model, 'next')
  f.holdCapture.resolve(); await f.admin.applicationCompletions.get(f.bot.id)
  assert.equal(f.controls().length, 0)
  assert.equal(f.regular.length, 1)
})

test('late successful intent publication preserves the same unbound UUID and full settings for exactly one ordinary prepare', async t => {
  const f = await fixture(t)
  const publish = f.intents.publish.bind(f.intents); let publications = 0
  f.intents.publish = async (...args) => { publications++; const result = await publish(...args); f.controller.abort(); return result }
  f.transport.reconfigure = async (_current, _candidate, options) => {
    options.admissionCheck()
    const prepared = await f.requests.prepare(f.bot.id, f.bot.session, { model: 'next' }, options.requestId)
    f.regular.push(prepared)
  }
  const result = await f.start()
  await f.admin.applicationCompletions.get(f.bot.id)
  assert.equal(result.handoffMetadata, null)
  assert.equal(f.controls().length, 0)
  assert.equal(publications, 1)
  assert.equal(f.regular.length, 1)
  assert.deepEqual(f.regular[0].intent.requested, { model: 'next', reasoning_effort: 'high', fast: false })
  assert.equal(f.regular[0].intent.binding.id, result.value.bot.configurationApplication.requestId)
  assert.equal(f.regular[0].args.request.digest, f.regular[0].intent.binding.digest)
  await assert.rejects(f.requests.prepare(f.bot.id, f.bot.session, { model: 'next' }, f.regular[0].intent.binding.id), { code: 'CONFIGURATION_REQUEST_PENDING' })
})

for (const phase of ['interrupt', 'configure', 'resume']) test(`lost ${phase} reply retains the original gate and never resends the uncertain phase`, async t => {
  const f = await fixture(t); await f.start(); await f.bound.promise; await tick(); f.consume()
  for (const earlier of ['interrupt', 'configure', 'resume']) { if (earlier === phase) break; await f.handoff.poll() }
  f.losePhase = phase
  await f.handoff.poll()
  f.notRecorded = true
  await f.handoff.poll(); await f.handoff.poll()
  assert.equal(f.controls().filter(call => call.action === 'commit' && call.phase === phase).length, 1)
  assert.ok(f.handoff.current(f.bot.id))
  assert.equal(f.regular.length, 0)
})

test('B saves while A is uncertain; independent revoke resolves A before B acts; late A never changes B', async t => {
  const f = await fixture(t); await f.start(); await f.bound.promise; await tick(); f.consume(); f.losePhase = 'interrupt'
  await f.handoff.poll()
  const operation = f.handoff.current(f.bot.id)
  f.holdRevoke = deferred()
  const response = await f.admin.configureFromMcp(f.bot.id, { model: 'later' }, f.ingress)
  assert.equal(response.value.bot.model, 'later')
  assert.equal(response.handoffMetadata, null)
  await f.revokeRequested.promise
  assert.equal(f.regular.length, 0)
  assert.equal(f.admin.view(f.bots.get(f.bot.id)).configurationApplication.state, 'pending')
  const lateA = structuredClone(operation.snapshot)
  f.holdRevoke.resolve()
  await f.admin.applicationCompletions.get(f.bot.id)
  assert.equal(f.regular.length, 1)
  assert.notEqual(response.value.bot.configurationApplication.requestId, operation.context.operation.id)
  assert.equal(f.controls().find(call => call.action === 'revoke').superseding_request_id, response.value.bot.configurationApplication.requestId)
  assert.equal(f.bots.get(f.bot.id).model, 'later')
  assert.equal(f.admin.view(f.bots.get(f.bot.id)).configurationApplication.state, 'accepted')
  await f.handoff.accept(operation, { status: 'recorded', snapshot: lateA })
  assert.equal(f.admin.view(f.bots.get(f.bot.id)).configurationApplication.state, 'accepted')
})

test('unknown intent publication blocks replacement IDs and is restored only as the original unresolved intent', async t => {
  const f = await fixture(t), publish = f.intents.publish.bind(f.intents)
  f.intents.publish = async (...args) => { await publish(...args); throw Error('lost publication result') }
  f.transport.reconfigure = (_current, _candidate, options) => f.requests.prepare(f.bot.id, f.bot.session, { model: 'next' }, options.requestId)
  const response = await f.start()
  await f.admin.applicationCompletions.get(f.bot.id)
  assert.equal(response.handoffMetadata, null)
  assert.equal(f.controls().length, 0)
  assert.equal(f.requests.unboundHandoffs.size, 0)
  assert.equal(f.requests.pending.get(f.bot.id).binding.id, response.value.bot.configurationApplication.requestId)
  assert.equal(f.admin.view(f.bots.get(f.bot.id)).configurationApplication.state, 'failed')
  const restarted = new ConfigurationRequests({ client: f.client, intents: f.intents })
  await restarted.restore()
  assert.deepEqual(restarted.pending.get(f.bot.id), f.requests.pending.get(f.bot.id))
  await assert.rejects(restarted.prepare(f.bot.id, f.bot.session, { model: 'later' }), { code: 'CONFIGURATION_REQUEST_PENDING' })
})

test('wrong delivery or reused original resumed turn cannot complete the original operation', async t => {
  const f = await fixture(t); await f.start(); await f.bound.promise; await tick(); f.consume()
  await f.handoff.poll(); await f.handoff.poll()
  f.complete('resume')
  const operation = f.handoff.current(f.bot.id)
  f.snapshot.resumed.delivery_id = 'another-delivery'
  await assert.rejects(f.handoff.read(operation), { code: 'AUTOMATIC_CONFIGURATION_UNAVAILABLE' })
  f.snapshot.resumed.delivery_id = f.job.info.groupId; f.snapshot.resumed.turn_id = nativeCall.turn_id
  await assert.rejects(f.handoff.read(operation), { code: 'AUTOMATIC_CONFIGURATION_UNAVAILABLE' })
  assert.equal(f.handoff.current(f.bot.id), operation)
})

test('capture-only capability never creates metadata or a bound operation', async t => {
  const f = await fixture(t)
  f.sdk.getServerCapabilities = () => ({ experimental: { 'ai.aiterm/handoff.capture.v1': { version: 1 } } })
  const response = await f.start()
  await f.admin.applicationCompletions.get(f.bot.id)
  assert.equal(response.handoffMetadata, null)
  assert.equal(f.controls().length, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.regular.length, 1)
  assert.equal(f.handoff.current(f.bot.id), null)
})

test('fixed dispatcher exposes the MCP method and keeps the operation busy after the original delivery completes', async t => {
  const f = await fixture(t), waiting = deferred(), native = Object.create(f.client)
  native.call = async name => {
    if (name === 'pty_list') return { structuredContent: { schema: 'aiterm.pty-list-result.v1', sessions: [f.launch] }, content: [{ type: 'text', text: 'seat\tsynthetic' }] }
    if (name === 'pty_observe') return { structuredContent: { exists: true, state: 'idle' } }
    if (name === 'pty_send') return { structuredContent: { mode: 'agent_dispatch', ...f.launch, vendor: 'codex', event_cursor: 42,
      wait_process: { executable: 'synthetic', args: [] } } }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'synthetic answer', turn_id: nativeCall.turn_id } }
    throw Error(`unexpected native method ${name}`)
  }
  const ports = { native, membersAdmission: new MembersAdmission(), bots: f.bots, rooms: {},
    configurationStorage: { root: f.intents.root, ownerUid: process.getuid() }, access: { assertWorkAllowed() {} },
    storage: { deliveryAnchor: anchor => Promise.resolve(anchor) }, seat: { waitProcess: () => waiting.promise }, observer: { report() {} } }
  const engine = createExecutionDispatcher({ generation: 'handoff-test', ports })
  const invoke = (method, ...args) => engine.dispatch({ method, args })
  await engine.control('initialize')
  t.after(async () => { try { waiting.resolve({ outcome: 'done', turn_id: nativeCall.turn_id }); f.exclude(); await invoke('administration.readConfigurationOperation', f.bot.id, f.context.operation.id); await engine.control('quiesce', { timeoutMs: 200 }); await engine.disconnect() } catch {} })
  await invoke('transport.notify', f.bot, 'synthetic original message', { queue: { groupId: f.job.info.groupId, context: 'direct', contextId: f.bot.id } })
  const response = await invoke('administration.configureFromMcp', f.bot.id, { model: 'next' }, f.context)
  assert.ok(response.handoffMetadata)
  await f.bound.promise; await tick()
  waiting.resolve({ outcome: 'done', turn_id: nativeCall.turn_id })
  await tick(); await tick()
  assert.equal(engine.project({ method: 'transport.isIdle', args: [f.bot.id] }), true)
  await assert.rejects(engine.control('quiesce', { timeoutMs: 0 }), { code: 'EXECUTION_BUSY' })
  assert.throws(() => engine.exportState(), { code: 'EXECUTION_BUSY' })
  await engine.control('resume')
  f.exclude()
  await invoke('administration.readConfigurationOperation', f.bot.id, response.handoffMetadata.operation.id)
  await engine.control('quiesce', { timeoutMs: 200 })
  const exported = engine.exportState()
  assert.equal(exported.metadata.automaticConfigurationOperations.get(f.bot.id).currentRequestId, response.handoffMetadata.operation.id)
  await engine.disconnect()
  const waitingAgain = deferred()
  f.bound = deferred()
  ports.seat.waitProcess = () => waitingAgain.promise
  f.capture.native_call = { ...nativeCall, turn_id: 'second-original-turn', call_id: 'second-call' }
  f.capture.point.boundary.turn_id = 'second-original-turn'
  const next = createExecutionDispatcher({ generation: 'handoff-next', ports, handoff: exported })
  await next.control('initialize')
  const nextInvoke = (method, ...args) => next.dispatch({ method, args })
  await nextInvoke('transport.notify', f.bots.get(f.bot.id), 'synthetic next message', { queue: { groupId: f.job.info.groupId, context: 'direct', contextId: f.bot.id } })
  const second = await nextInvoke('administration.configureFromMcp', f.bot.id, { model: 'third' }, { ...f.ingress, nativeCall: f.capture.native_call })
  assert.ok(second.handoffMetadata)
  await f.bound.promise; await tick()
  const projected = next.project({ method: 'administration.view', args: [f.bots.get(f.bot.id)] })
  assert.equal(projected.automaticConfigurationApplication.requestId, second.handoffMetadata.operation.id)
  assert.notEqual(projected.automaticConfigurationApplication.requestId, response.handoffMetadata.operation.id)
  f.exclude()
  await nextInvoke('administration.readConfigurationOperation', f.bot.id, second.handoffMetadata.operation.id)
  waitingAgain.resolve({ outcome: 'done', turn_id: 'second-original-turn' })
  await next.control('quiesce', { timeoutMs: 200 }); await next.disconnect()
})

test('B saved between prepare and bind invalidates A before bind and waits for the original not-issued completion', async t => {
  const f = await fixture(t), prepared = deferred(), release = deferred()
  const prepare = f.handoff.prepare.bind(f.handoff)
  let original
  f.handoff.prepare = async options => { original = await prepare(options); prepared.resolve(); await release.promise; return original }
  const first = f.start()
  await prepared.promise
  const second = await f.admin.update(f.bot.id, { model: 'later' })
  assert.equal(second.bot.model, 'later')
  assert.equal(f.regular.length, 0)
  release.resolve()
  assert.equal((await first).handoffMetadata, null)
  await f.admin.applicationCompletions.get(f.bot.id)
  assert.equal(f.controls().length, 0)
  assert.equal(f.regular.length, 1)
  assert.equal(f.regular[0].candidate.model, 'later')
  assert.equal(f.regular[0].options.requestId, second.bot.configurationApplication.requestId)
  assert.equal(await f.intents.notIssued(f.bot.id, original.context.operation), true)
  assert.equal(f.requests.pending.size, 0)
})
