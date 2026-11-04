import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fork } from 'node:child_process'
import { createConversationParentChannel, createConversationChildChannel, waitConversationChildClose } from '../src/conversation-ipc.mjs'
import { createConversationDispatcher } from '../src/conversation/dispatcher.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { createConversationObserverParentEffects } from '../src/conversation/observer-parent.mjs'
import { createConversationPeer } from '../src/conversation-channel.mjs'
import { createConversationParentEffects } from '../src/conversation-parent-effects.mjs'
import { validateConversationPageRows, validateConversationRecentRows } from '../src/conversation/results.mjs'
import { createConversationFacade } from '../src/conversation-facade.mjs'

function pair() {
  const endpoints = [new EventEmitter(), new EventEmitter()]
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const value = deserialize(serialize(frame))
      setImmediate(() => { if (endpoint.connected) endpoints[1 - index].emit('message', value); callback?.(endpoint.connected ? null : new Error('disconnected')) })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) { if (peer.connected) { peer.connected = false; peer.emit('disconnect') } } }
  }
  return endpoints
}
const settle = () => new Promise(resolve => setImmediate(resolve))
async function setup(t, { effect = () => {}, event = async () => {}, dispatcher: factory = createConversationDispatcher, forked = false } = {}) {
  const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'conversation-channel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(root, relative); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  }
  const processChild = forked ? fork(new URL('./fixtures/conversation-channel-child.mjs', import.meta.url), [root], {
    serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
  }) : null
  const closed = processChild ? waitConversationChildClose(processChild) : null
  let childErrors = ''
  processChild?.stderr.on('data', chunk => { childErrors += chunk })
  const endpoints = processChild ? [processChild] : pair(), generation = 'generation-a', admission = new ConversationLifetimes(generation), tokens = new WeakMap(), calls = [], native = [], diagnostics = []
  let child, parent
  const dispatcher = processChild ? null : factory({ root, effect: (...args) => child.effect(...args), event: (...args) => child.event(...args),
    trackBackground: (...args) => child.trackBackground(...args), diagnostic: report => child.diagnostic(report) })
  if (dispatcher) child = createConversationChildChannel({ dispatcher, endpoint: endpoints[1], versionId: null })
  parent = createConversationParentChannel(endpoints[0], { generation, admission,
    onDiagnostic: report => { diagnostics.push(report) },
    onEvent: event,
    authorizeActor: (method, token) => tokens.get(token)?.method === method ? tokens.get(token).actor : false,
    onEffect: async (method, params, context) => {
      calls.push({ method, params, context })
      const override = await effect(method, params, context)
      if (override !== undefined) return override
      if (method === 'members.profiles.read') return { bots: fixture.bots }
      if (method === 'execution.assertAccess') return { allowed: true }
      if (method === 'usage.routing.read') return { enabled: false, epoch: 1, apiKey: null }
      if (method.startsWith('usage.notify.')) return { accepted: true }
      if (method === 'runtime.observer.changed') return { changed: false }
      if (method === 'runtime.room.context') return { turns: [{ speaker: params.speaker, text: params.text }] }
      if (['execution.turn', 'execution.notify', 'execution.report'].includes(method)) {
        const delivery = context.conversationDelivery
        admission.claimNative(delivery, { deliveryId: params.deliveryId, target: params.target,
          kind: method === 'execution.turn' ? 'turn' : method === 'execution.report' ? 'report' : 'notify' })
        native.push({ delivery, context, params }); return { delivery: 'running' }
      }
      throw new Error(`Unexpected effect ${method}`)
    } })
  t.after(async () => {
    if (endpoints[0].connected) endpoints[0].disconnect()
    if (closed) { await closed; assert.equal(childErrors, '') }
    await parent.drainIncoming(); await parent.reaped()
  })
  await parent.control('initialize', { generation, mode: 'restore', bots: fixture.bots })
  assert.equal((await parent.ready).protocolVersion, 1)
  await parent.control('resume')
  const lease = admission.enter(), operationContext = { opaque: true }, admissionCheck = () => {}
  const request = (method, params, actor = { kind: 'owner' }, extra = {}) => {
    const token = {}; tokens.set(token, { method, actor })
    return parent.request(method, params, { conversationLease: lease, capturedAuthority: token, operationContext, admissionCheck, ...extra })
  }
  return { root, fixture, parent, child, dispatcher, admission, lease, request, calls, native, operationContext, admissionCheck, endpoints, closed, diagnostics }
}

test('native deadline hook is bound to the original RPC and delivery, not another RPC or caller options', async t => {
  const h = await setup(t), actual = Promise.withResolvers(), lookups = []
  let selected = null, pending = true, callerInjection = 0
  h.admission.getNativeContinuation = (delivery, binding) => {
    const original = h.native.find(entry => entry.delivery === delivery)
    assert(original)
    assert.deepEqual(binding, { generation: original.context.generation, operationId: original.context.operationId,
      deliveryId: original.params.deliveryId, target: original.params.target })
    lookups.push(delivery)
    return pending && delivery === selected ? actual.promise : null
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const input = { target: h.fixture.bots[0].id, message: 'native held', images: [] }
  const first = h.request('user.turn', input)
  await first.accepted; selected = h.native[0].delivery
  input.target = 'bot-other'
  const second = h.request('user.turn', { target: h.fixture.bots[0].id, message: 'no positive native proof', images: [] }, { kind: 'owner' },
    { getNativeContinuation: () => { callerInjection++; return actual.promise } })
  await second.accepted
  const refused = assert.rejects(second, { code: 'CONVERSATION_IPC_TIMEOUT' })
  let firstSettled = false, firstActualSettled = false, secondActualSettled = false
  first.then(() => { firstSettled = true }, () => { firstSettled = true })
  first.completion.then(() => { firstActualSettled = true })
  second.completion.then(() => { secondActualSettled = true })
  t.mock.timers.tick(60000); await refused; await settle()
  assert.equal(firstSettled, false); assert.equal(firstActualSettled, false); assert.equal(secondActualSettled, false)
  assert(lookups.includes(selected)); assert(lookups.includes(h.native[1].delivery)); assert.equal(callerInjection, 0)
  pending = false; actual.resolve(); await settle()
  for (const entry of h.native) {
    await h.admission.invoke(entry.delivery, 'user.complete', { reply: 'saved at actual completion' })
    h.admission.finish(entry.delivery)
  }
  await first; await first.completion; await second.completion
  h.admission.finish(h.lease)
})

test('parent save effect receives the same RPC actualCompletion before begin and retains it beyond requested end', { timeout: 4000 }, async t => {
  let adapter, request, h, ended = false, resultDone = false
  const notification = Promise.withResolvers(), gateDone = Promise.withResolvers(), endStarted = Promise.withResolvers(), tracked = [], opaque = {}
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y6xkAAAAASUVORK5CYII=', 'base64')
  h = await setup(t, { effect: (method, params, context) => adapter(method, params, context) })
  const services = {
    bots: { refresh: value => assert.equal(value, h.operationContext), values: () => h.fixture.bots },
    conversationCompletion: context => { assert.equal(context.actualCompletion, request.completion); return context.actualCompletion },
    conversationAssetGate: {
      beginSave: (owner, value) => { assert.equal(owner, h.fixture.bots[0].id); assert.equal(value, h.operationContext); return opaque },
      trackCompletion: (lease, actual) => { assert.equal(lease, opaque); tracked.push(actual) },
      assertSave: (lease, owner, value) => { assert.equal(lease, opaque); assert.equal(owner, h.fixture.bots[0].id); assert.equal(value, h.operationContext) },
      endSave: lease => { assert.equal(lease, opaque); ended = true; endStarted.resolve(); return gateDone.promise },
    },
    seatRuntime: { readImage: () => { assert.equal(tracked[0], request.completion); assert.equal(tracked.length, 2); return png } },
    conversationUsage: { dispatch: async method => { assert.equal(method, 'usage.notify.direct'); await notification.promise; return { accepted: true } } },
  }
  adapter = createConversationParentEffects({ getServices: () => services, onExecution: method => {
    assert.equal(method, 'execution.assertAccess'); return { allowed: true }
  } })
  request = h.request('direct.post', { from: h.fixture.bots[0].id, target: 'user', message: 'image', images: [{ mime: 'image/png', data: png.toString('base64') }] })
  request.completion.then(() => { resultDone = true })
  await endStarted.promise
  assert.equal(ended, true); assert.equal(resultDone, false)
  const calls = h.calls.filter(call => call.method.startsWith('assets.') || call.method === 'runtime.image.read')
  assert.equal(calls.length, 3)
  assert(calls.every(call => call.context === calls[0].context && call.context.actualCompletion === request.completion))
  notification.resolve(); await request; await request.completion
  assert.equal(resultDone, true); gateDone.resolve()
})

test('parent display callback saves through the child writer without a delivery and waits for its event', { timeout: 4000 }, async t => {
  const h = await setup(t), actor = { kind: 'observer' }
  const capturedAuthority = {}, rootAuthority = {}, rootsDone = Promise.withResolvers()
  // This independent parent only accepts its captured system token for the fixed display callback.
  const endpoints = pair(), admission = new ConversationLifetimes('generation-display')
  let child, dispatch
  const saved = Promise.withResolvers(), releaseEvent = Promise.withResolvers()
  const parent = createConversationParentChannel(endpoints[0], { generation: 'generation-display', admission,
    authorizeActor: (method, value) => method === 'display.words' && value === capturedAuthority ? actor
      : method === 'rooms.list' && value === rootAuthority ? { kind: 'owner' } : false,
    onEffect: method => { assert.equal(method, 'members.profiles.read'); return { bots: h.fixture.bots } },
    onEvent: async () => { saved.resolve(); await releaseEvent.promise } })
  dispatch = createConversationDispatcher({ root: h.root, effect: (...args) => child.effect(...args), event: (...args) => child.event(...args), trackBackground: (...args) => child.trackBackground(...args) })
  child = createConversationChildChannel({ dispatcher: { ...dispatch, dispatch: (method, ...args) => method === 'rooms.list'
    ? rootsDone.promise.then(() => dispatch.dispatch(method, ...args)) : dispatch.dispatch(method, ...args) }, endpoint: endpoints[1], versionId: null })
  t.after(async () => { releaseEvent.resolve(); if (endpoints[0].connected) endpoints[0].disconnect(); await parent.drainIncoming(); await parent.reaped() })
  await parent.control('initialize', { generation: 'generation-display', mode: 'restore', bots: h.fixture.bots }); await parent.ready; await parent.control('resume')
  const lease = admission.enter(), options = { conversationLease: lease, capturedAuthority, operationContext: {} }
  const roots = Array.from({ length: 8 }, () => parent.request('rooms.list', {}, { ...options, capturedAuthority: rootAuthority }))
  await settle(); assert.equal(parent.snapshot().root, 8)
  const params = { botId: h.fixture.bots[0].id, groupId: 'native-display-a', words: [{ text: 'hello', kind: 'answer' }] }
  await assert.rejects(parent.request('display.words', params, options))
  await assert.rejects(parent.callback('display.words', params, { ...options, capturedAuthority: {} }))
  let finished = false
  const attempt = parent.callback('display.words', params, options); attempt.completion.then(() => { finished = true })
  await saved.promise; assert.equal(finished, false); assert.equal(parent.snapshot().deliveries, 0)
  const rows = (await readFile(join(h.root, 'logs/direct-messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.at(-1).group_id, params.groupId); assert.equal(rows.at(-1).text, 'hello')
  releaseEvent.resolve(); assert.deepEqual(await attempt, { applied: true }); await attempt.completion
  assert.equal(finished, true)
  rootsDone.resolve(); await Promise.all(roots)
})

test('onboarding recordUser false reaches the real child turn without writing a user record', { timeout: 4000 }, async t => {
  const h = await setup(t), target = h.fixture.bots[0].id
  await assert.rejects(h.request('user.post', { target, message: 'guide', images: [], recordUser: false }))
  assert.equal(h.native.length, 0)
  const attempt = h.request('user.turn', { target, message: 'guide', images: [], recordUser: false }, { kind: 'onboarding', botId: target })
  await attempt.accepted
  await assert.rejects(readFile(join(h.root, 'logs/direct-messages.jsonl')), { code: 'ENOENT' })
  assert.equal(h.native.length, 1)
  const delivery = h.native[0].delivery
  await h.admission.invoke(delivery, 'user.complete', { reply: { delivery: 'steered' } })
  h.admission.finish(delivery)
  assert.equal((await attempt).delivery, 'steered')
  await h.parent.control('quiesce')
})

test('facade reaches real child Room projection, writer and complete history stream', { timeout: 4000 }, async t => {
  const h = await setup(t), options = { operationContext: h.operationContext }
  const facade = createConversationFacade({ getController: () => ({ request: (method, params, captured) => h.request(method, params, { kind: 'owner' }, captured) }),
    context: (method, value) => { assert.equal(value, options); return { operationContext: value.operationContext } } })
  await facade.rooms.refresh(options)
  assert.equal(facade.rooms.get('room-conversation-probe').id, 'room-conversation-probe')
  await facade.messenger.sendmessage({ from: h.fixture.bots[0].id, target: 'user', message: 'facade-history' }, options)
  const rows = await facade.store.timeline(h.fixture.bots[0].id, options)
  assert.equal(rows.at(-1).message, 'facade-history')
  assert.deepEqual(await facade.rooms.messages('room-conversation-probe', options), [])
  await h.parent.control('quiesce')
})

test('real channel envelopes keep parallel per-call authority and same opaque operation identities', { timeout: 4000 }, async t => {
  const h = await setup(t)
  const [list, room] = await Promise.all([h.request('rooms.list', {}), h.request('room.read', { roomId: 'room-conversation-probe' })])
  assert.equal(list.rooms[0].id, room.room.id)
  assert.equal(h.calls.length, 2)
  for (const call of h.calls) {
    assert.equal(call.context.conversationLease, h.lease)
    assert.equal(call.context.operationContext, h.operationContext)
    assert.equal(call.context.admissionCheck, h.admissionCheck)
    assert.equal(call.context.operationId, h.lease.correlation)
  }
  assert.deepEqual(new Set(h.calls.map(call => call.context.rootMethod)), new Set(['rooms.list', 'room.read']))
  await h.parent.control('quiesce'); await h.parent.control('resume')
  const schedules = await h.request('room.schedules.list', { roomId: room.room.id }, { kind: 'scheduler' })
  assert.deepEqual(schedules.schedules, [])
})

test('eight user accepted roots release their slots while final saves and native-release ACKs remain live', { timeout: 4000 }, async t => {
  const h = await setup(t), target = h.fixture.bots[0].id
  const attempts = Array.from({ length: 8 }, (_, i) => h.request('user.turn', { target, message: `question-${i}`, images: [] }))
  await Promise.all(attempts.map(attempt => attempt.accepted))
  assert.equal(h.parent.snapshot().root, 0)
  assert.equal(h.native.length, 8)
  assert.equal((await h.request('rooms.list', {})).rooms.length, 1)
  let drained = false
  const draining = h.parent.control('quiesce').then(value => { drained = true; return value })
  await settle(); assert.equal(drained, false)
  for (const info of h.native) {
    await h.admission.invoke(info.delivery, 'user.complete', { reply: `reply ${info.params.queue.message}` })
    h.admission.finish(info.delivery)
  }
  await Promise.all(attempts)
  assert.deepEqual(await draining, { quiesced: true })
  assert.equal(h.child.snapshot().contexts, 0)
  assert.deepEqual(h.diagnostics, [])
  h.admission.finish(h.lease)
  const ticket = h.admission.close()
  assert.deepEqual(await h.admission.drain(ticket), { status: 'drained' })
})

test('drainIncoming retains a parent effect after disconnect without waiting for outgoing reaped completion', { timeout: 4000 }, async t => {
  const entered = Promise.withResolvers(), commit = Promise.withResolvers()
  const h = await setup(t, { effect: async method => {
    if (method === 'members.profiles.read') { entered.resolve(); await commit.promise }
  } })
  const request = h.request('rooms.list', {})
  await entered.promise
  h.endpoints[0].disconnect()
  await assert.rejects(request)
  let completed = false, drained = false
  void request.completion.then(() => { completed = true }, () => { completed = true })
  const draining = h.parent.drainIncoming().then(() => { drained = true })
  await settle(); assert.equal(drained, false); assert.equal(completed, false)
  commit.resolve()
  await draining
  assert.equal(completed, false)
  await h.parent.reaped()
  await assert.rejects(request.completion)
})

test('drainIncoming retains an awaited history consumer commit after disconnect', { timeout: 4000 }, async t => {
  const h = await setup(t), entered = Promise.withResolvers(), commit = Promise.withResolvers()
  const request = h.request('history.listMessages', { botId: h.fixture.bots[0].id }, { kind: 'owner' }, {
    onChunk: async () => { entered.resolve(); await commit.promise },
  })
  await entered.promise
  h.endpoints[0].disconnect()
  await assert.rejects(request)
  let drained = false
  const draining = h.parent.drainIncoming().then(() => { drained = true })
  await settle(); assert.equal(drained, false)
  commit.resolve(); await draining
  await h.parent.reaped(); await assert.rejects(request.completion)
})

test('unknown authority, foreign lease, forged callback and per-call method escalation issue no native work', { timeout: 4000 }, async t => {
  const h = await setup(t)
  await assert.rejects(h.parent.request('rooms.list', {}, { conversationLease: h.lease, capturedAuthority: {} }))
  const refusedTurn = h.parent.request('user.turn', { target: h.fixture.bots[0].id, message: 'refused', images: [] }, { conversationLease: h.lease, capturedAuthority: {} })
  await assert.rejects(refusedTurn); await assert.rejects(refusedTurn.accepted); await assert.rejects(refusedTurn.completion)
  await assert.rejects(h.request('rooms.list', {}, { kind: 'owner' }, { conversationLease: new ConversationLifetimes('other').enter() }))
  assert.throws(() => h.parent.callback('user.complete', { reply: 'forged' }, { conversationDelivery: {} }))
  const denied = await setup(t, { dispatcher: options => {
    const dispatcher = createConversationDispatcher(options)
    return { ...dispatcher, dispatch: (method, params, context) => method === 'rooms.list'
      ? options.effect('runtime.room.context', { roomId: 'room-conversation-probe', messageId: 'message-a', speaker: 'bot', text: 'body' }, context)
      : dispatcher.dispatch(method, params, context) }
  } })
  await assert.rejects(denied.request('rooms.list', {}), { code: 'CONVERSATION_IPC_INVALID' })
  assert.equal(denied.calls.length, 0)
  assert.equal(h.native.length + denied.native.length, 0)
})

test('fork advanced IPC carries image-sized input and history, then exits after result and actual close', { timeout: 6000 }, async t => {
  const h = await setup(t, { forked: true }), from = h.fixture.bots[0].id
  const message = 'fork 日本語 '.repeat(120000)
  await h.request('direct.post', { from, target: 'user', message, images: [] })
  const chunks = []
  await h.request('history.listMessages', { botId: from }, { kind: 'owner' }, { onChunk: async chunk => {
    assert(Buffer.isBuffer(chunk)); chunks.push(chunk)
  } })
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8'))[0].message, message)
  await h.parent.control('quiesce')
  await h.parent.control('exit')
  const { code, signal } = await h.closed
  assert.equal(code, 0); assert.equal(signal, null)
  await h.parent.drainIncoming(); await h.parent.reaped()
})

test('large input singleton refuses a second large root while small roots and independent control continue', { timeout: 4000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = await setup(t, { dispatcher: options => {
    const dispatcher = createConversationDispatcher(options)
    return { ...dispatcher, dispatch: async (method, params, context) => {
      if (method === 'direct.post') { entered.resolve(); await release.promise }
      return dispatcher.dispatch(method, params, context)
    } }
  } })
  const input = { from: h.fixture.bots[0].id, target: 'user', message: 'x'.repeat(100000), images: [] }
  const first = h.request('direct.post', input)
  await entered.promise
  await assert.rejects(h.request('direct.post', input), { code: 'CONVERSATION_INPUT_BUSY', outcome: 'not_accepted' })
  assert.equal((await h.request('rooms.list', {})).rooms.length, 1)
  await h.parent.control('routing.changed', { enabled: false, epoch: 2 })
  release.resolve(); await first
})

test('four stalled ordinary history streams leave callback and control progress available', { timeout: 4000 }, async t => {
  const h = await setup(t), target = h.fixture.bots[0].id
  const turn = h.request('user.turn', { target, message: 'question', images: [] })
  await turn.accepted
  const release = Promise.withResolvers(), entered = Array.from({ length: 4 }, () => Promise.withResolvers())
  const histories = entered.map((ready, i) => h.request('history.listMessages', { botId: target }, { kind: 'owner' }, {
    onChunk: async () => { ready.resolve(); await release.promise },
  }))
  await Promise.all(entered.map(ready => ready.promise))
  await h.parent.control('routing.changed', { enabled: false, epoch: 2 })
  await h.admission.invoke(h.native[0].delivery, 'user.complete', { reply: 'saved under stream pressure' })
  h.admission.finish(h.native[0].delivery)
  release.resolve(); await Promise.all([turn, ...histories])
  await h.parent.control('quiesce')
})

test('real observer channel closes public check/read over parent scope and drains observation background ACK', { timeout: 4000 }, async t => {
  let h, serial = 0, currentToken = 0, reads = 0
  const liveBots = new Map()
  const observer = createConversationObserverParentEffects({ snapshot: () => [...liveBots.values()], current: id => liveBots.get(id),
    check: async request => ({ schema: 'throughline.observer_check_result.v1', status: 'complete', results: request.projects.map(p => ({ id: p.id, status: 'changed', token: `tloc1.${++currentToken}` })) }),
    read: async () => ({ schema: 'throughline.observer_read.v2', status: 'delta', throughCursor: `cursor-${++reads}`,
      turns: reads === 1 ? [] : [{ source_sha256: 'source-a', turn_start: 'self', assistant: 'answer from observer', completed_at: 123 }] }),
  })
  h = await setup(t, { effect: (method, params, context) => {
    if (method.startsWith('runtime.observer.')) return observer(method, params, context)
    if (method === 'execution.shown.read') return null
    if (method === 'execution.observation.source') return { deliveryId: `observed-${++serial}`, target: params.target }
  } })
  for (const bot of h.fixture.bots) liveBots.set(bot.id, { ...bot, project: '/parent/private/' + bot.id })
  await h.request('observation.poll', {}, { kind: 'observer' })
  await h.request('observation.poll', {}, { kind: 'observer' })
  await h.parent.control('quiesce')
  assert.equal(serial, 1)
  assert.equal(h.parent.snapshot().backgrounds, 0)
  assert.equal(h.child.snapshot().contexts, 0)
  const state = JSON.parse(await readFile(join(h.root, 'logs/self-turns.json'), 'utf8')).bots[h.fixture.bots[0].id]
  assert.equal(state.cursor, 'cursor-2'); assert.equal(state.checkToken, 'tloc1.2')
})

test('history is consumed through awaited Buffer chunks and final completion waits for consumer progress', { timeout: 4000 }, async t => {
  const h = await setup(t), from = h.fixture.bots[0].id
  await h.request('direct.post', { from, target: 'user', message: 'large 日本語 '.repeat(40000), images: [] })
  const wait = Promise.withResolvers(), entered = Promise.withResolvers(), chunks = []
  const history = h.request('history.listMessages', { botId: from }, { kind: 'owner' }, { onChunk: async chunk => {
    assert(Buffer.isBuffer(chunk)); chunks.push(chunk); entered.resolve(); await wait.promise
  } })
  await entered.promise
  let finished = false; history.completion.then(() => { finished = true })
  await settle(); assert.equal(finished, false)
  await h.parent.control('routing.changed', { enabled: false, epoch: 1 })
  wait.resolve()
  assert.deepEqual(await history, { streamed: true })
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8'))[0].message.length, 'large 日本語 '.repeat(40000).length)
})

test('caller deadline retains actual completion and the root slot until the actual handler finishes', { timeout: 4000 }, async t => {
  const endpoints = pair(), actual = Promise.withResolvers()
  const parent = createConversationPeer(endpoints[0], { side: 'parent', validateResult: () => {}, accept: () => { throw new Error('unexpected') } })
  const child = createConversationPeer(endpoints[1], { side: 'child', validateResult: () => {}, accept: () => () => actual.promise })
  t.after(() => { parent.close(); parent.reaped(); child.reaped() })
  const request = parent.call('root', 'work', {}, { timeout: 10 })
  let completed = false
  request.completion.then(() => { completed = true }, () => { completed = true })
  await Promise.all([assert.rejects(request, { code: 'CONVERSATION_IPC_TIMEOUT' }), new Promise(resolve => setTimeout(resolve, 20))])
  assert.equal(completed, false); assert.equal(parent.snapshot().root, 1)
  actual.resolve({ done: true })
  assert.deepEqual(await request.completion, { done: true })
  assert.equal(parent.snapshot().root, 0)
})

for (const rejects of [false, true]) test(`event ACK follows actual completion beyond caller deadline: ${rejects ? 'reject' : 'resolve'}`, { timeout: 4000 }, async t => {
  const entered = Promise.withResolvers(), ack = Promise.withResolvers()
  t.after(() => ack.resolve())
  const h = await setup(t, { event: async () => { entered.resolve(); await ack.promise }, effect: method => {
    if (method === 'assets.beginSave') return { leaseId: 'event-save-lease' }
    if (method === 'assets.endSave') return { requested: true }
  } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const attempt = h.request('direct.post', { from: h.fixture.bots[0].id, target: 'user', message: 'save ACK boundary', images: [] })
  const caller = assert.rejects(attempt, { code: 'CONVERSATION_IPC_TIMEOUT' })
  let actualSettled = false
  attempt.completion.then(() => { actualSettled = true }, () => { actualSettled = true })
  await Promise.race([entered.promise, attempt.then(() => { throw new Error('event was not emitted') })])
  t.mock.timers.tick(60000)
  await caller
  for (let i = 0; i < 8; i++) await settle()
  assert.equal(actualSettled, false)
  if (rejects) {
    const failed = assert.rejects(attempt.completion)
    ack.reject(Object.assign(new Error('event ACK failed'), { code: 'CONVERSATION_PROTOCOL_ERROR' }))
    await failed
  } else {
    ack.resolve()
    await attempt.completion
  }
  assert.equal(actualSettled, true)
  h.admission.finish(h.lease)
})

test('fork IPC streams selected page and ordered recent batch; actual completion waits for page consumer', { timeout: 10000 }, async t => {
  const h = await setup(t, { forked: true }), botId = h.fixture.bots[0].id
  const records = Array.from({ length: 40 }, (_, n) => ({ schema: 'bellteam.direct-message.v1', delivery_id: `row-${n}`, from: botId, target: 'user', message: `body-${n}`, at: `2026-11-04T00:00:${String(n).padStart(2, '0')}Z`, delivery: 'delivered' }))
  await writeFile(join(h.root, 'logs/direct-messages.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n')
  const chunks = [], entered = Promise.withResolvers(), release = Promise.withResolvers()
  const request = h.request('history.page', { kind: 'bots', id: botId, query: { limit: '10', before: null, after: null }, cards: [[], []] }, { kind: 'owner' }, {
    onChunk: async chunk => { chunks.push(chunk); entered.resolve(); await release.promise },
  })
  let done = false; request.completion.then(() => { done = true })
  await entered.promise; await settle(); assert.equal(done, false)
  release.resolve(); assert.deepEqual(await request, { streamed: true }); await request.completion
  const page = validateConversationPageRows(JSON.parse(Buffer.concat(chunks).toString('utf8')), [[], []])
  assert.equal(page.items.length, 10); assert.equal(page.remaining_before, 30)
  assert.deepEqual(page.items.map(ref => ref.item.message), records.slice(-10).map(row => row.message))
  const batch = []
  await h.request('history.recentBatch', { botIds: [botId, botId] }, { kind: 'owner' }, { onChunk: async chunk => { batch.push(chunk) } })
  assert.deepEqual(validateConversationRecentRows(JSON.parse(Buffer.concat(batch).toString('utf8')), [botId, botId]).map(row => [row.botId, row.message.message]), [[botId, 'body-39'], [botId, 'body-39']])
  h.admission.finish(h.lease)
})
