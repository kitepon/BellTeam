import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ConversationStore } from '../src/conversation-store.mjs'
import { RoomHistory } from '../src/room-history.mjs'
import { createConversationDispatcher } from '../src/conversation/dispatcher.mjs'
import { createConversationFacade } from '../src/conversation-facade.mjs'
import { createConversationParentChannel, createConversationChildChannel } from '../src/conversation-ipc.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { validateConversationRequest } from '../src/conversation/requests.mjs'
import { validateConversationResult } from '../src/conversation/results.mjs'

const input = { deliveryId: 'f30ba6d8-6f43-4837-9112-3e8126739ec7', target: 'bot-a', context: 'direct', contextId: 'bot-a' }
const direct = { schema: 'bellteam.direct-message.v1', delivery_id: input.deliveryId, from: 'user', target: input.target,
  at: '2026-11-04T12:00:00.000Z', message: 'private original content', image: false, delivery: 'running' }
const roomInput = { ...input, context: 'room', contextId: 'room-a' }
const room = { schema: 'bellteam.room-message.v1', id: input.deliveryId, room: { id: 'room-a' }, sender: { id: 'bot-b' },
  at: direct.at, message: direct.message, routing: { status: 'ready', responders: [] },
  deliveries: [{ target: 'bot-a', delivery: 'running' }, { target: 'bot-b', delivery: 'running' }] }
const line = value => `${JSON.stringify(value)}\n`
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'delivery-anchor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const generation = 'anchor-generation', control = { generation, operationId: null }
async function setup(t) {
  const root = await directory(t), fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(root, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, line(value))
  }
  const target = fixture.bots[0].id, bot = { kind: 'bot', botId: target }, roomId = 'room-conversation-probe'
  const directInput = { ...input, target, contextId: target }, roomRequest = { ...directInput, context: 'room', contextId: roomId }
  const directPath = join(root, 'logs/direct-messages.jsonl'), roomPath = join(root, 'rooms', roomId, 'messages.jsonl')
  await writeFile(directPath, line({ ...direct, target }))
  await writeFile(roomPath, line({ ...room, room: { id: roomId }, deliveries: [{ target, delivery: 'running' }] }))
  let bots = fixture.bots, child
  const effects = [], tokens = new WeakMap(), endpoints = [new EventEmitter(), new EventEmitter()]
  for (const [i, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const value = deserialize(serialize(frame))
      setImmediate(() => { if (endpoint.connected) endpoints[1 - i].emit('message', value); callback?.(endpoint.connected ? null : new Error('disconnected')) })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) if (peer.connected) { peer.connected = false; peer.emit('disconnect') } }
  }
  const dispatcher = createConversationDispatcher({ root, diagnostic: async () => {},
    effect: async (method, params, context) => {
      if (child) return child.effect(method, params, context)
      assert.equal(method, 'members.profiles.read'); effects.push(method); return { bots }
    }, event: async () => { throw new Error('unexpected write') }, trackBackground: () => { throw new Error('unexpected background') } })
  const gate = new ConversationLifetimes(generation)
  const parent = createConversationParentChannel(endpoints[0], { generation, admission: gate,
    authorizeActor: (_method, token) => tokens.get(token), onEffect: async method => {
      assert.equal(method, 'members.profiles.read'); effects.push(method); return { bots }
    } })
  t.after(async () => { endpoints[0].disconnect(); await parent.drainIncoming(); await parent.reaped() })
  return { root, fixture, bot, directInput, roomRequest, directPath, roomPath, dispatcher, parent, gate, effects,
    enableIpc() { child = createConversationChildChannel({ dispatcher, endpoint: endpoints[1], versionId: null }) },
    setBots(value) { bots = value },
    token() { const token = {}; tokens.set(token, bot); return token } }
}


const work = anchor => ({ botId: anchor.target, sessionId: 'session-original', launchId: 'launch-original',
  inputRevision: 'job-original', deliveryId: anchor.deliveryId, context: anchor.context, contextId: anchor.contextId })

test('work input reads only committed unique target originals and closed saved status', async t => {
  const root = await directory(t), path = join(root, 'direct.jsonl'), roomPath = join(root, 'room.jsonl')
  const store = new ConversationStore({ logPath: path, onCorruption: () => {} }), rooms = new RoomHistory(roomPath)
  const expected = work(input), roomExpected = work(roomInput)
  await writeFile(path, JSON.stringify(direct)); await writeFile(roomPath, JSON.stringify(room))
  assert.equal(await store.workInput(expected), null); assert.equal(await rooms.workInput(roomExpected), null)
  await appendFile(path, '\n'); await appendFile(roomPath, '\n')
  assert.deepEqual(await store.workInput(expected), { ...expected, text: direct.message, progress: 'running' })
  assert.deepEqual(await rooms.workInput(roomExpected), { ...roomExpected, text: room.message, progress: 'running' })
  assert.equal(await store.workInput({ ...expected, botId: 'bot-other', contextId: 'bot-other' }), null)
  assert.equal(await rooms.workInput({ ...roomExpected, contextId: 'room-other' }), null)
  await appendFile(path, line({ schema: 'bellteam.delivery-status.v1', delivery_id: input.deliveryId, delivery: 'failed', error: 'private error' }))
  await appendFile(roomPath, line({ schema: 'bellteam.room-delivery-status.v1', message_id: input.deliveryId, target: input.target, delivery: 'stopped', error: 'private error' }))
  assert.equal((await store.workInput(expected)).progress, 'failed')
  assert.equal((await rooms.workInput(roomExpected)).progress, 'stopped')
  await appendFile(path, line(direct)); await appendFile(roomPath, line(room))
  assert.equal(await store.workInput(expected), null); assert.equal(await rooms.workInput(roomExpected), null)
  await writeFile(path, line({ ...direct, message: '😀'.repeat(4001), delivery: 'private-status' }))
  const replaced = new ConversationStore({ logPath: path, onCorruption: () => {} })
  const bounded = await replaced.workInput(expected)
  assert.equal([...bounded.text].length, 4000); assert.equal(bounded.progress, '')
  await appendFile(path, '{broken}\n')
  assert.equal(await replaced.workInput(expected), null)
})

test('work-input dispatcher and real V8 IPC preserve closed binding and actual completion', async t => {
  const h = await setup(t); h.enableIpc()
  await h.parent.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }); await h.parent.ready; await h.parent.control('resume')
  const lease = h.gate.enter(), token = h.token()
  const facade = createConversationFacade({ getController: () => h.parent, context: method => {
    assert.equal(method, 'history.workInput'); return { conversationLease: lease, capturedAuthority: token }
  } })
  const expected = work(h.directInput), roomExpected = work(h.roomRequest)
  const before = await readFile(h.directPath), beforeStat = await stat(h.directPath, { bigint: true })
  for (const request of [expected, roomExpected]) {
    const attempt = facade.store.workInput(request)
    assert(attempt.completion instanceof Promise)
    assert.deepEqual(await attempt, { ...request, text: direct.message, progress: 'running' }); await attempt.completion
  }
  assert.deepEqual(await readFile(h.directPath), before)
  assert.equal((await stat(h.directPath, { bigint: true })).mtimeNs, beforeStat.mtimeNs)
  const context = { generation, operationId: 'schema', actor: h.bot, continuation: false }
  for (const actor of [{kind:'owner'}, h.bot, {kind:'scheduler'}])
    validateConversationRequest('history.workInput', expected, { ...context, actor })
  for (const actor of [{kind:'usage',botId:h.bot.botId,source:'secret'}, {kind:'onboarding',botId:h.bot.botId}, {kind:'observer'}, {kind:'bridge'}])
    assert.throws(() => validateConversationRequest('history.workInput', expected, { ...context, actor }))
  assert.throws(() => validateConversationRequest('history.workInput', { ...expected, authority: true }, context))
  assert.throws(() => validateConversationResult('history.workInput', { ...expected, text: 'x', progress: 'private error' }))
  h.gate.finish(lease)
})

test('facade refuses mismatched work input and preserves the real completion on rejection', async () => {
  const actual = Promise.withResolvers(), expected = work(input)
  const result = Promise.resolve({ ...expected, inputRevision: 'other', text: 'work', progress: '' })
  result.completion = actual.promise
  const facade = createConversationFacade({ getController: () => ({ request: () => result }), context: () => ({}) })
  const attempt = facade.store.workInput(expected)
  assert.equal(attempt.completion, actual.promise)
  await assert.rejects(attempt, { code: 'CONVERSATION_RESULT_INVALID' })
  actual.resolve(); await attempt.completion
})

test('work-input read freshly enforces room members and rejects oversized or non-closed output', async t => {
  const h = await setup(t), d = h.dispatcher
  await d.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }, control)
  await d.control('resume', {}, control)
  const request = work(h.roomRequest)
  const run = params => d.dispatch('history.workInput', params,
    { generation, operationId: 'fresh-room', actor: h.bot, continuation: false })
  assert.equal((await run(request)).text, direct.message)
  const path = join(h.root, 'rooms/room-conversation-probe/room.json')
  const definition = JSON.parse(await readFile(path))
  await writeFile(path, line({ ...definition, memberIds: definition.memberIds.filter(id => id !== h.bot.botId),
    representativeId: definition.representativeId === h.bot.botId ? null : definition.representativeId }))
  await assert.rejects(run(request), /ROOM_/)
  for (const value of [{ ...request, text: '😀'.repeat(4001), progress: '' },
    { ...request, text: 'work', progress: '', secret: 'no' }])
    assert.throws(() => validateConversationResult('history.workInput', value), { code: 'CONVERSATION_RESULT_INVALID' })
})
