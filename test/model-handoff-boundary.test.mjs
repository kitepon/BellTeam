import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate as turn } from 'node:timers/promises'
import { ModelHandoff } from '../src/model-handoff.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { configurationBinding, configurationDigest, configurationSettings } from '../src/configuration-request.mjs'

// Fixed 16:05 input: manifest 97bd639ee5fa143f2e46087132f8bfa1dbc4d734401efea83cabb0f50642192a.
// Ports use synthetic validated wire shapes; no SDK/native/AI/Host call is made.
const clone = structuredClone
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const botId = 'bot-boundary'
const launch = { session_id: 'seat', launch_id: 'b'.repeat(32) }
const nativeCall = { server_instance: 'a'.repeat(32), thread_id: 'thread', turn_id: 'original-turn',
  call_id: 'call', call_token: 'c'.repeat(64), source: { kind: 'direct' } }
const deliveryId = 'original-delivery'
const receipt = (context, kind, revision) => ({ operation_id: context.operation.id, kind, revision: String(revision) })

function snapshot(context, { revision = 1, stage = 0, excluded = false } = {}) {
  return {
    schema: 'aiterm.model-handoff.snapshot.v1', operation: clone(context.operation), context_digest: hash(context),
    server_instance: context.native_call.server_instance, thread_id: context.native_call.thread_id,
    turn_id: context.native_call.turn_id, revision: String(revision),
    state: excluded ? 'terminal' : 'bound',
    response: { state: stage ? 'consumed' : 'waiting', receipt: stage ? receipt(context, 'response', 2) : null },
    ended_receipt: stage >= 2 ? receipt(context, 'ended', 3) : null,
    configuration_receipt: stage >= 3 ? receipt(context, 'configured', 4) : null,
    resumed: stage === 4 ? { receipt: receipt(context, 'resumed', 5), turn_id: 'actual-resumed-turn', delivery_id: deliveryId } : null,
    phases: Object.fromEntries(['interrupt', 'configure', 'resume'].map((phase, index) => [phase,
      index + 2 <= stage ? { state: 'completed', effect: 'observed' } : { state: 'not_started', effect: 'not_started' }])),
    revocation: excluded && stage !== 4 ? 'durable' : 'not_requested', in_flight: [], later_effect: excluded ? 'excluded' : 'possible', error_code: null,
  }
}

function fixture() {
  const calls = [], saves = [], tracks = [], durable = [], prepared = new Map()
  const current = { id: botId, harness: 'codex', model: 'old-model', reasoningEffort: 'high', fastMode: false }
  const bots = new Map([[botId, current]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => {
    saves.push({ id, changes: clone(changes) })
    const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next
  }
  const job = { bot: current, receipt: { mode: 'agent_dispatch', ...launch, event_cursor: 42 },
    info: { groupId: deliveryId, context: 'direct', contextId: botId } }
  const state = { context: null, response: null }
  const requests = {
    view: () => null,
    async prepareHandoff(id, targetLaunch, settings, requestId) {
      calls.push({ action: 'prepare', id, requestId })
      const requested = configurationSettings(settings)
      const original = { schema: 'bellteam.configuration-intent.v1', botId: id, requested, version: '0.63.7',
        binding: configurationBinding({ id: requestId, ...targetLaunch, digest: configurationDigest(requested) }) }
      prepared.set(id, original); return original
    },
    claimHandoff(id, binding) {
      assert.deepEqual(prepared.get(id)?.binding, binding)
      prepared.delete(id); calls.push({ action: 'claim', id })
    },
    async finishNotIssued(id, binding) { calls.push({ action: 'finishNotIssued', id, binding }) },
    async recordHandoff(id, value) { durable.push({ id, snapshot: clone(value) }); return clone(value) },
    intents: { async saveHandoffStop(id, binding) { calls.push({ action: 'saveStop', id, binding }) } },
  }
  const binding = {
    currentConnection: () => binding,
    async capture(input, signal) {
      calls.push({ action: 'capture', input: clone(input) })
      assert(signal instanceof AbortSignal)
      return { schema: 'aiterm.model-handoff.capture.v1', status: 'captured', launch: clone(launch), native_call: clone(nativeCall), input_revision: 1,
        point: { launch: clone(launch), boundary: { event_cursor: 42, operation_id: null, turn_id: nativeCall.turn_id, steer_id: null } },
        process: { harness: { pid: 100, start_identity: 'harness-birth' }, backend: { pid: 101, start_identity: 'backend-birth' } },
        anchor: { native_message_id: 'native-message', client_delivery_id: deliveryId } }
    },
    async control(input) {
      calls.push(clone(input)); return state.control(input)
    },
  }
  state.control = input => {
    if (input.action === 'bind') { state.context = input.context; state.response = snapshot(input.context) }
    return { status: 'recorded', snapshot: clone(state.response) }
  }
  const transport = {
    client: { captureHandoffConnection: () => binding }, jobs: new Set([job]), session: () => launch.session_id,
    configurationRequests: requests, isRunning: async () => true,
    async reconfigure(before, candidate, options) {
      options?.admissionCheck?.(); calls.push({ action: 'reconfigure', before: clone(before), candidate: clone(candidate), options })
      return {}
    },
    async interrupt(bot) { calls.push({ action: 'ordinaryStop', id: bot.id }); return { botId: bot.id, status: 'stop_sent' } },
  }
  const administration = new BotAdministration({ bots, rooms: new Map(), transport, writeLog: () => {},
    trackCompletion: value => tracks.push(value) })
  const anchor = { deliveryId, target: botId, context: 'direct', contextId: botId }
  const handoff = new ModelHandoff({ transport, requests,
    async readAnchor(input, options) {
      calls.push({ action: 'anchor', input: clone(input) }); assert.deepEqual(input, anchor)
      assert.deepEqual(options.actor, { kind: 'bot', botId }); assert(options.signal instanceof AbortSignal)
      return clone(anchor)
    }, trackCompletion: value => tracks.push(value), records: administration.automaticConfigurationOperations })
  administration.handoff = handoff
  const controller = new AbortController()
  const ingress = { schema: 'bellteam.mcp-configuration-ingress.v1', actor: { kind: 'bot', botId }, toolName: 'update_self',
    originalMcpRequestId: 37, expectedLaunch: clone(launch), nativeCall: clone(nativeCall), signal: controller.signal, budget: null }
  return { calls, saves, tracks, durable, current, bots, job, state, requests, binding, transport, administration, anchor, handoff, ingress,
    prepare: () => handoff.prepare({ botId, current, candidate: { ...current, model: 'new-model' }, ingress, assertCurrent() {}, requestId: randomUUID() }) }
}

const commits = f => f.calls.filter(call => call.action === 'commit')
const actions = (f, action) => f.calls.filter(call => call.action === action)
const readResult = value => ({ status: 'recorded', snapshot: clone(value) })

test('original response: save once, closed metadata, held bind cannot block read or response', { timeout: 3000 }, async () => {
  const f = fixture(), bind = deferred()
  f.state.control = input => {
    if (input.action === 'bind') {
      f.state.context = input.context; f.state.response = snapshot(input.context)
      return bind.promise
    }
    return readResult(f.state.response)
  }
  const result = await f.administration.configureFromMcp(botId, { model: 'new-model' }, f.ingress)
  assert.deepEqual(Object.keys(result).sort(), ['handoffMetadata', 'value'])
  assert.deepEqual(Object.keys(result.handoffMetadata).sort(), ['call_token', 'operation', 'origin_digest'])
  assert.equal(f.saves.length, 1)
  assert.equal(result.value.bot.model, 'new-model')
  assert.equal(result.handoffMetadata.call_token, nativeCall.call_token)
  assert.equal(result.handoffMetadata.operation.id, result.value.bot.configurationApplication.requestId)
  assert.equal(actions(f, 'bind').length, 1)
  const op = f.handoff.current(botId)
  assert.equal(result.handoffMetadata.origin_digest, createHash('sha256').update(op.originBytes).digest('hex'))
  assert.equal(JSON.parse(op.originBytes.toString('utf8'))[2], 37)
  assert.equal(f.tracks.includes(op.completion), true)
  const projection = await f.administration.readConfigurationOperation(botId, op.context.operation.id)
  assert.equal(projection.requestId, op.context.operation.id)
  assert.equal(JSON.stringify(projection).includes(nativeCall.call_token), false)
  assert.equal(commits(f).length, 0)
  assert.equal(actions(f, 'reconfigure').length, 0)
  f.state.response = snapshot(op.context, { revision: 2, stage: 1, excluded: true })
  await f.handoff.read(op)
  bind.resolve(readResult(snapshot(op.context)))
  await turn()
  assert.equal(f.handoff.current(botId), null)
  assert.equal(actions(f, 'bind').length, 1)
})

test('receipt ordering gates each phase; GET is read only; resume keeps the actual new identity', { timeout: 3000 }, async () => {
  const f = fixture(), prepared = await f.prepare(), op = f.handoff.begin(prepared)
  await turn()
  await f.handoff.poll()
  assert.equal(commits(f).length, 0)
  for (const [stage, phase] of [[1, 'interrupt'], [2, 'configure'], [3, 'resume']]) {
    f.state.response = snapshot(op.context, { revision: stage + 1, stage })
    await f.administration.readConfigurationOperation(botId, op.context.operation.id)
    assert.equal(commits(f).length, stage - 1)
    await f.handoff.poll()
    const call = commits(f).at(-1)
    assert.equal(call.phase, phase)
    assert.deepEqual(call.expected_receipt, receipt(op.context, ['response', 'ended', 'configured'][stage - 1], stage + 1))
    if (phase === 'resume') assert.equal(call.continuation.delivery_id, deliveryId)
    await f.handoff.poll()
    assert.equal(commits(f).length, stage)
  }
  f.state.response = snapshot(op.context, { revision: 5, stage: 4, excluded: true })
  await f.handoff.read(op)
  assert.equal((await op.completion).resumed.turn_id, 'actual-resumed-turn')
  assert.deepEqual(commits(f).map(call => call.phase), ['interrupt', 'configure', 'resume'])
  assert.equal(f.handoff.current(botId), null)
})

test('held phase RPC: GET/revoke and ordinary stop remain independent', { timeout: 3000 }, async () => {
  const f = fixture(), op = f.handoff.begin(await f.prepare())
  await turn()
  const held = deferred(), entered = deferred()
  f.state.response = snapshot(op.context, { revision: 2, stage: 1 })
  f.state.control = input => {
    if (input.action === 'commit') { entered.resolve(); return held.promise }
    return readResult(f.state.response)
  }
  const polling = f.handoff.poll(); await entered.promise
  await f.administration.readConfigurationOperation(botId, op.context.operation.id)
  assert.equal(commits(f).length, 1)
  const stop = f.handoff.ownerStop(botId)
  f.transport.interrupt = async bot => { f.calls.push({ action: 'ordinaryStop', id: bot.id }); throw new Error('synthetic missing ordinary adapter') }
  await assert.rejects(f.administration.stop(f.bots.get(botId)), { code: 'BOT_STOP_UNCONFIRMED' })
  await stop
  assert.equal(actions(f, 'ordinaryStop').length, 1)
  assert.equal(actions(f, 'saveStop').length, 1)
  assert.equal(actions(f, 'revoke').length, 1)
  assert.equal(actions(f, 'revoke')[0].reason, 'owner_stop')
  assert.equal(actions(f, 'revoke')[0].superseding_request_id, null)
  assert.equal(f.handoff.current(botId), op)
  held.reject(new Error('synthetic response lost'))
  await polling; await f.handoff.poll(); await f.handoff.poll()
  assert.equal(commits(f).length, 1)
  assert.equal(actions(f, 'bind').length, 1)
  f.state.response = snapshot(op.context, { revision: 3, stage: 1, excluded: true })
  await f.handoff.read(op)
})

test('lost phase response: the same original operation is read without replay or replacement', { timeout: 3000 }, async () => {
  const f = fixture(), op = f.handoff.begin(await f.prepare())
  await turn()
  f.state.response = snapshot(op.context, { revision: 2, stage: 1 })
  f.state.control = input => {
    if (input.action === 'commit') throw new Error('synthetic response loss after issue')
    return readResult(f.state.response)
  }
  await f.handoff.poll(); await f.handoff.poll(); await f.handoff.poll()
  assert.equal(op.invalidated, false)
  assert.equal(commits(f).length, 1)
  assert.equal(actions(f, 'bind').length, 1)
  assert.equal(actions(f, 'prepare').length, 1)
  assert.equal(f.handoff.current(botId), op)
  assert(actions(f, 'read').length >= 3)
  assert(f.calls.filter(call => ['read', 'commit'].includes(call.action)).every(call => call.context.operation.id === op.context.operation.id))
  f.state.response = snapshot(op.context, { revision: 3, stage: 1, excluded: true })
  await f.handoff.read(op)
})

test('A unknown: B is saved without waiting, B effects wait for durable A terminal, late A does not overwrite B', { timeout: 3000 }, async () => {
  const f = fixture()
  await f.administration.configureFromMcp(botId, { model: 'model-A' }, f.ingress)
  const op = f.handoff.current(botId), revoke = deferred()
  await turn()
  f.state.control = input => input.action === 'revoke' ? revoke.promise : readResult(f.state.response)
  const b = await f.administration.configureFromMcp(botId, { model: 'model-B' }, f.ingress)
  const applicationB = f.administration.applications.get(botId)
  assert.equal(b.handoffMetadata, null)
  assert.equal(b.value.bot.model, 'model-B')
  assert.equal(f.saves.length, 2)
  assert.equal(actions(f, 'reconfigure').length, 0)
  assert.equal(actions(f, 'bind').length, 1)
  assert.equal(commits(f).length, 0)
  assert.equal(actions(f, 'revoke')[0].superseding_request_id, applicationB.requestId)
  assert.notEqual(applicationB.requestId, op.context.operation.id)
  const terminal = snapshot(op.context, { revision: 2, excluded: true })
  f.requests.recordHandoff = async () => { throw new Error('synthetic durable save unavailable') }
  f.state.response = terminal
  await assert.rejects(f.handoff.read(op), /durable save unavailable/)
  await turn()
  assert.equal(f.handoff.current(botId), op)
  assert.equal(actions(f, 'reconfigure').length, 0)
  assert.equal(f.administration.applications.get(botId), applicationB)
  f.requests.recordHandoff = async (id, value) => { f.durable.push({ id, snapshot: clone(value) }); return clone(value) }
  await f.handoff.read(op)
  await f.administration.applicationCompletions.get(botId)
  revoke.resolve(readResult(terminal)); await turn()
  assert.equal(actions(f, 'reconfigure').length, 1)
  assert.equal(actions(f, 'reconfigure')[0].candidate.model, 'model-B')
  assert.equal(actions(f, 'reconfigure')[0].options.requestId, applicationB.requestId)
  assert.equal(f.administration.applications.get(botId), applicationB)
  assert.equal(applicationB.state, 'accepted')
  assert.equal(f.bots.get(botId).model, 'model-B')
  assert.equal(f.saves.length, 2)
  assert.equal(actions(f, 'prepare').length, 1)
  assert.equal(commits(f).length, 0)
})

test('ambiguous live job or missing/mismatched original anchor admits no handoff or durable intent', { timeout: 3000 }, async () => {
  for (const condition of ['duplicate', 'missing-anchor', 'wrong-anchor']) {
    const f = fixture()
    if (condition === 'duplicate') f.transport.jobs.add(clone(f.job))
    else f.handoff.readAnchor = async () => condition === 'missing-anchor' ? null : { ...f.anchor, target: 'other-bot' }
    assert.equal(await f.prepare(), null, condition)
    assert.equal(actions(f, 'prepare').length, 0, condition)
    assert.equal(actions(f, 'bind').length, 0, condition)
    assert.equal(commits(f).length, 0, condition)
    assert.equal(f.handoff.current(botId), null, condition)
  }
})

test('foreign snapshots and same revision divergence cannot replace the original; old revision cannot roll it back', { timeout: 3000 }, async () => {
  const f = fixture(), op = f.handoff.begin(await f.prepare())
  await turn()
  f.state.response = snapshot(op.context, { revision: 3, stage: 2 })
  await f.handoff.read(op)
  const accepted = clone(op.snapshot)
  for (const mutate of [
    value => { value.operation.id = randomUUID() },
    value => { value.context_digest = 'f'.repeat(64) },
    value => { value.server_instance = 'f'.repeat(32) },
    value => { value.thread_id = 'other-thread' },
    value => { value.turn_id = 'other-turn' },
    value => { value.revision = '3'; value.revocation = 'durable' },
  ]) {
    const foreign = snapshot(op.context, { revision: 4, stage: 2 }); mutate(foreign)
    f.state.response = foreign
    await assert.rejects(f.handoff.read(op), { code: 'AUTOMATIC_CONFIGURATION_UNAVAILABLE' })
    assert.deepEqual(op.snapshot, accepted)
  }
  for (const identity of [{ turn_id: nativeCall.turn_id }, { delivery_id: 'other-delivery' }]) {
    f.state.response = snapshot(op.context, { revision: 5, stage: 4, excluded: true })
    Object.assign(f.state.response.resumed, identity)
    await assert.rejects(f.handoff.read(op), { code: 'AUTOMATIC_CONFIGURATION_UNAVAILABLE' })
    assert.deepEqual(op.snapshot, accepted)
  }
  f.state.response = snapshot(op.context)
  await f.handoff.read(op)
  assert.deepEqual(op.snapshot, accepted)
  assert.equal(commits(f).length, 0)
  f.state.response = snapshot(op.context, { revision: 4, stage: 2, excluded: true })
  await f.handoff.read(op)
})

test('terminal persistence completion owns the fence, including failure and retry of the same snapshot', { timeout: 3000 }, async () => {
  const f = fixture(), op = f.handoff.begin(await f.prepare())
  await turn()
  let completed = false
  op.completion.then(() => { completed = true })
  f.state.response = snapshot(op.context, { revision: 2, excluded: true })
  f.requests.recordHandoff = async () => { throw new Error('synthetic persistence failure') }
  await assert.rejects(f.handoff.read(op), /synthetic persistence failure/)
  assert.equal(f.handoff.current(botId), op)
  assert.equal(completed, false)
  const saving = deferred(), entered = deferred()
  f.requests.recordHandoff = async () => { entered.resolve(); return saving.promise }
  const reading = f.handoff.read(op); await entered.promise
  assert.equal(f.handoff.current(botId), op)
  assert.equal(completed, false)
  const saved = clone(f.state.response)
  saving.resolve(saved); await reading; await op.completion
  assert.equal(op.snapshot, saved)
  assert.equal(completed, true)
  assert.equal(f.handoff.current(botId), null)
  assert.equal(actions(f, 'bind').length, 1)
  assert.equal(commits(f).length, 0)
})
