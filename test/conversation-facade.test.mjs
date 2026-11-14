import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationFacade } from '../src/conversation-facade.mjs'
import { validateConversationRequest } from '../src/conversation/requests.mjs'
const room = { id: 'room-a', name: 'A', purpose: '', memberIds: ['bot-a'], representativeId: 'bot-a', avatar: '' }
const task = value => { const p = Promise.resolve(value); p.completion = Promise.resolve('actual'); return p }

test('facade keeps original options, controller selection and user turn Promise metadata', async () => {
  const accepted = Promise.resolve({ delivery: 'running' }), actual = Promise.withResolvers(), reply = Promise.withResolvers()
  reply.promise.accepted = accepted; reply.promise.completion = actual.promise
  const options = Object.freeze({ opaque: {} }), captured = { operationContext: options }, calls = []
  let selected = { request: (...args) => { calls.push(args); return reply.promise } }
  const f = createConversationFacade({ getController: () => selected, context: (method, value) => { assert.equal(value, options); return captured } })
  const result = f.messenger.userTurn({ target: 'bot-a', message: 'Q', image: { path: '/image' } }, options)
  assert.equal(result, reply.promise); assert.equal(result.accepted, accepted); assert.equal(result.completion, actual.promise)
  assert.equal(calls[0][2], captured); assert.deepEqual(calls[0].slice(0, 2), ['user.turn', { target: 'bot-a', message: 'Q', images: [{ path: '/image' }] }])
  selected = { request: (method, params, value) => { assert.equal(method, 'direct.post'); assert.equal(value, captured); return task(params) } }
  assert.deepEqual(await f.messenger.sendmessage({ from: 'scheduler', target: 'bot-a', message: 'next' }, options), { from: 'scheduler', target: 'bot-a', message: 'next', images: [] })
  reply.resolve({ delivery: 'delivered' }); actual.resolve(); await result
})

test('Room projection is synchronous and immutable; fresh reads and mutations retain real completion', async () => {
  let answer = { rooms: [room] }, attempt
  const f = createConversationFacade({ getController: () => ({ request: () => (attempt = task(answer)) }), context: () => ({}) })
  assert.equal(f.rooms.get(room.id), undefined); assert.equal(f.rooms.has(room.id), false)
  const refreshed = f.rooms.refresh()
  assert.equal(refreshed.completion, attempt.completion); assert.equal(await refreshed, f.rooms)
  assert.equal(f.rooms.size, 1); assert.equal(f.rooms.get(room.id) instanceof Promise, false)
  assert.deepEqual([...f.rooms.values()], [room]); assert.throws(() => f.rooms.get(room.id).memberIds.push('bot-b'))
  const previous = f.rooms.get(room.id)
  answer = { room: { ...room, name: 'new' } }; assert.equal((await f.rooms.read(room.id)).name, 'new'); assert.equal(previous.name, 'A')
  answer = { removed: room.id }; await f.rooms.remove(room.id); assert.equal(f.rooms.has(room.id), false)
})

test('facade gathers one history stream, preserves UTF8 and maps existing TimelineIndex', async () => {
  const rows = [{ id: 'row-a', at: '2026-11-04T01:00:00+09:00', text: '日本語' }]
  const encoded = Buffer.from(JSON.stringify(rows)), captured = [], options = { opaque: {} }
  const f = createConversationFacade({ context: (method, value) => { assert.equal(value, options); const c = {}; captured.push(c); return c },
    getController: () => ({ request: (method, params, c) => {
      assert.equal(c, captured.at(-1)); assert(['history.listMessages', 'history.listRoomMessages'].includes(method))
      return task((async () => { for (const byte of encoded) await c.onChunk(Buffer.from([byte])); return { streamed: true } })())
    } }) })
  assert.deepEqual(await f.store.timeline('bot-a', options), rows)
  const view = await f.rooms.messageView('room-a', options); assert.equal(view.length, 1); assert.equal(view.at(0).text, '日本語')
})

test('facade normalizes fixed callbacks, onboarding flag, room replies and schedule ports without fake delivery', async () => {
  const calls = [], controller = { request: (...args) => { calls.push(['root', ...args]); return task({}) },
    callback: (...args) => { calls.push(['callback', ...args]); return task({ applied: true }) } }
  const options = {}, captured = {}
  const f = createConversationFacade({ getController: () => controller, context: (method, value) => { assert.equal(value, options); return captured } })
  await f.messenger.appendInterimWords('bot-a', 'group-a', [{ text: 'hello' }], options)
  assert.deepEqual(calls[0], ['callback', 'display.words', { botId: 'bot-a', groupId: 'group-a', words: [{ text: 'hello' }] }, captured])
  await f.messenger.enqueueUserTurn({ target: 'bot-a', message: 'guide', recordUser: false }, options)
  assert.equal(calls[1][2].recordUser, false)
  await f.roomMessenger.sendroommessage({ from: 'bot-a', room: 'room-a', responseTo: 'message-a', message: 'reply' }, options)
  assert.deepEqual(calls[2].slice(0, 3), ['root', 'room.reply', { roomId: 'room-a', messageId: 'message-a', message: 'reply', images: [] }])
  const claim = { roomId: 'room-a', scheduleId: 'schedule-a' }; await f.rooms.claimDue(claim, options)
  assert.equal(calls[3][2], claim); assert.equal(calls[3][3], captured)
  assert.equal(f.assets.open, undefined); assert.equal(f.selfTurns.start, undefined)
})

test('only captured onboarding can omit the user record and display callback rejects public actors and malformed words', () => {
  const context = actor => ({ generation: 'generation-a', operationId: 'operation-a', actor, continuation: false })
  const params = { target: 'bot-a', message: 'guide', images: [], recordUser: false }
  for (const method of ['user.post', 'user.turn']) {
    validateConversationRequest(method, params, context({ kind: 'onboarding', botId: 'bot-a' }))
    assert.throws(() => validateConversationRequest(method, params, context({ kind: 'owner' })))
  }
  const words = { botId: 'bot-a', groupId: 'group-a', words: [{ text: 'hello' }] }
  validateConversationRequest('display.words', words, context({ kind: 'observer' }))
  assert.throws(() => validateConversationRequest('display.words', words, context({ kind: 'owner' })))
  assert.throws(() => validateConversationRequest('display.words', { ...words, deliveryId: 'fake' }, context({ kind: 'observer' })))
  assert.throws(() => validateConversationRequest('display.words', { ...words, words: [{ text: 42 }] }, context({ kind: 'observer' })))
})

test('a Bot-scoped rooms.list answer upserts but never shrinks the Owner-wide Room projection', async () => {
  const other = { ...room, id: 'room-b', memberIds: ['bot-b'], representativeId: 'bot-b' }
  let answer, scoped = false
  const f = createConversationFacade({ getController: () => ({ request: () => task(answer) }), context: () => ({}), memberScoped: () => scoped })
  answer = { rooms: [room, other] }; await f.rooms.refresh()
  scoped = true; answer = { rooms: [{ ...room, name: 'renamed' }] }; await f.rooms.refresh()
  assert.deepEqual([...f.rooms.keys()], ['room-a', 'room-b']); assert.equal(f.rooms.get('room-a').name, 'renamed')
  answer = { rooms: [] }; await f.rooms.refresh(); assert.equal(f.rooms.size, 2)
  scoped = false; answer = { rooms: [other] }; await f.rooms.refresh(); assert.deepEqual([...f.rooms.keys()], ['room-b'])
})
