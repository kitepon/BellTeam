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

test('direct anchor uses committed unique originals without changing preview display or trusting status rows', async t => {
  const path = join(await directory(t), 'direct.jsonl'), store = new ConversationStore({ logPath: path, onCorruption: () => {} })
  await writeFile(path, JSON.stringify(direct))
  assert.equal((await store.records()).length, 1)
  assert.equal(await store.deliveryAnchor(input), null)
  await appendFile(path, '\n')
  assert.deepEqual(await store.deliveryAnchor(input), input)
  assert.equal(await store.deliveryAnchor({ ...input, target: 'bot-b' }), null)
  await appendFile(path, line({ schema: 'bellteam.delivery-status.v1', delivery_id: input.deliveryId, delivery: 'failed' }))
  assert.deepEqual(await store.deliveryAnchor(input), input)
  await appendFile(path, line({ ...direct }))
  assert.equal(await store.deliveryAnchor(input), null)
  await writeFile(path, line({ schema: 'bellteam.delivery-status.v1', delivery_id: input.deliveryId, delivery: 'running' }))
  assert.equal(await store.deliveryAnchor(input), null)
  await writeFile(path, line(direct) + '{broken}\n')
  const corrupt = new ConversationStore({ logPath: path, onCorruption: () => {} })
  assert.equal(await corrupt.deliveryAnchor(input), null)
  assert.equal((await corrupt.records()).length, 1)
  await writeFile(path, line({ ...direct, message: null }))
  assert.equal(await new ConversationStore({ logPath: path }).deliveryAnchor(input), null)
})

test('room anchor checks committed original deliveries, not responder selection or a status-only row', async t => {
  const path = join(await directory(t), 'room.jsonl'), history = new RoomHistory(path)
  await writeFile(path, JSON.stringify(room))
  assert.equal((await history.messages()).length, 1)
  assert.equal(await history.deliveryAnchor(roomInput), null)
  await appendFile(path, '\n')
  assert.deepEqual(await history.deliveryAnchor(roomInput), roomInput)
  assert.deepEqual(await history.deliveryAnchor({ ...roomInput, target: 'bot-b' }), { ...roomInput, target: 'bot-b' })
  assert.equal(await history.deliveryAnchor({ ...roomInput, target: 'bot-other' }), null)
  assert.equal(await history.deliveryAnchor({ ...roomInput, contextId: 'room-other' }), null)
  await appendFile(path, line(room))
  assert.equal(await history.deliveryAnchor(roomInput), null)
  await writeFile(path, line({ ...room, deliveries: [...room.deliveries, room.deliveries[0]] }))
  assert.equal(await history.deliveryAnchor(roomInput), null)
  await writeFile(path, line({ schema: 'bellteam.room-delivery-status.v1', message_id: input.deliveryId, target: 'bot-a', delivery: 'running' }))
  assert.equal(await history.deliveryAnchor(roomInput), null)
  await writeFile(path, line(room) + '{broken}\n')
  await assert.rejects(history.deliveryAnchor(roomInput), SyntaxError)
})

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

test('anchor request is bot-only, closed, self-targeted and freshly authorized for the existing room', async t => {
  const h = await setup(t), d = h.dispatcher
  await d.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }, control); await d.control('resume', {}, control)
  let n = 0
  const run = (params, actor = h.bot) => d.dispatch('history.deliveryAnchor', params, { generation, operationId: `anchor-${++n}`, actor, continuation: false })
  const context = { generation, operationId: 'schema', actor: h.bot, continuation: false }
  for (const params of [{ ...h.directInput, body: 'extra' }, { ...h.directInput, context: 'watch' }, { ...h.directInput, contextId: 'bot-other' }])
    assert.throws(() => validateConversationRequest('history.deliveryAnchor', params, context), { code: 'CONVERSATION_REQUEST_INVALID' })
  assert.throws(() => validateConversationResult('history.deliveryAnchor', { ...h.directInput, message: 'extra' }), { code: 'CONVERSATION_RESULT_INVALID' })
  assert.throws(() => run(h.directInput, { kind: 'owner' }), { code: 'CONVERSATION_METHOD_FORBIDDEN' })
  await assert.rejects(run({ ...h.directInput, target: 'bot-other', contextId: 'bot-other' }), { code: 'CONVERSATION_ACTOR_INVALID', status: 403 })
  const before = await Promise.all([h.directPath, h.roomPath].map(async path => ({ bytes: await readFile(path), stat: await stat(path, { bigint: true }) })))
  assert.deepEqual(await run(h.directInput), h.directInput)
  assert.deepEqual(await run(h.roomRequest), h.roomRequest)
  for (const [i, path] of [h.directPath, h.roomPath].entries()) {
    assert.deepEqual(await readFile(path), before[i].bytes); assert.equal((await stat(path, { bigint: true })).mtimeNs, before[i].stat.mtimeNs)
  }
  const roomPath = join(h.root, 'rooms/room-conversation-probe/room.json'), definition = JSON.parse(await readFile(roomPath))
  await writeFile(roomPath, line({ ...definition, memberIds: definition.memberIds.filter(id => id !== h.bot.botId),
    representativeId: definition.representativeId === h.bot.botId ? null : definition.representativeId }))
  await assert.rejects(run(h.roomRequest), /ROOM_/)
  h.setBots(h.fixture.bots.filter(bot => bot.id !== h.bot.botId))
  await assert.rejects(run(h.directInput), /BOT_NOT_FOUND/)
})

test('facade anchor uses captured actor and real V8 IPC without history transfer, preserving actual completion', async t => {
  const h = await setup(t); h.enableIpc()
  await h.parent.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }); await h.parent.ready; await h.parent.control('resume')
  const lease = h.gate.enter(), token = h.token(), options = { marker: true }
  const facade = createConversationFacade({ getController: () => h.parent, context: (method, captured) => {
    assert.equal(method, 'history.deliveryAnchor'); assert.equal(captured, options)
    return { conversationLease: lease, capturedAuthority: token }
  } })
  const read = facade.store.deliveryAnchor(h.roomRequest, options)
  assert(read.completion instanceof Promise)
  assert.deepEqual(await read, h.roomRequest); await read.completion
  assert.deepEqual(Object.keys(await read).sort(), ['context', 'contextId', 'deliveryId', 'target'])
  assert.equal(h.effects.length, 1); h.gate.finish(lease); assert.equal(h.gate.snapshot().active, 0)
})

test('facade rejects mismatched anchor and keeps the controller actual completion when caller result fails', async () => {
  const actual = Promise.withResolvers(), result = Promise.resolve({ ...input, deliveryId: 'wrong-delivery' })
  result.completion = actual.promise
  const facade = createConversationFacade({ getController: () => ({ request: () => result }), context: () => ({}) })
  const read = facade.store.deliveryAnchor(input)
  assert.equal(read.completion, actual.promise)
  await assert.rejects(read, { code: 'CONVERSATION_RESULT_INVALID' })
  let settled = false; actual.promise.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false)
  actual.resolve(); await read.completion
})
