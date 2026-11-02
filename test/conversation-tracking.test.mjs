import assert from 'node:assert/strict'
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { ConversationStore } from '../src/conversation-store.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'
import { RoomHistory } from '../src/room-history.mjs'
import { createMessageViews } from '../src/http-messages.mjs'
import { callConversationTool } from '../src/mcp-conversation-tools.mjs'

const wire = JSON.parse(await readFile(new URL('./fixtures/delivery-tracking-wire.json', import.meta.url), 'utf8'))
const tracking = { schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }
const line = value => JSON.stringify(value) + '\n'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-tracking-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  const logPath = join(root, 'direct.jsonl'), store = new ConversationStore({ logPath })
  let callback
  const transport = { turn(_bot, _text, options) { callback = options; return Promise.resolve('') },
    async notify(_bot, _text, options) { callback = options; return { delivery: 'running' } } }
  let id = 0
  const messenger = new BellTeamMessenger({ bots, transport, store, logPath, deliveryId: () => `d${++id}`, now: () => '2026-11-02T00:00:00Z' })
  return { root, bots, messenger, store, logPath, callback: () => callback, transport }
}

test('user and notification callbacks persist only the accepted unknown tuple and expose HTTP/MCP wire', async t => {
  const f = await fixture(t)
  for (const from of ['user', 'bot-b']) {
    if (from === 'user') await f.messenger.userTurn({ target: 'bot-a', message: 'fixture' })
    else await f.messenger.sendmessage({ from, target: 'bot-a', message: 'fixture' })
    await f.callback().onStatus('failed', new Error('PRIVATE_ERROR_CANARY'), { ...tracking, private: 'PRIVATE_FIELD_CANARY' })
  }
  const raw = await readFile(f.logPath, 'utf8')
  assert.doesNotMatch(raw, /PRIVATE_|deliveryTracking/)
  const statuses = raw.trim().split('\n').map(JSON.parse).filter(x => x.schema === 'bellteam.delivery-status.v1')
  assert.deepEqual(statuses.map(x => x.delivery_tracking), [tracking, tracking])
  const views = createMessageViews({ store: f.store })
  const page = await views.messagePage('bots', 'bot-a', new URL('http://fixture/?limit=20'))
  assert.deepEqual(page, wire.direct)
  assert.equal(page.items.length, 2)
  for (const item of page.items) { assert.equal(item.delivery, 'failed'); assert.deepEqual(item.deliveryTracking, tracking); assert.equal('delivery_tracking' in item, false) }
  const result = await callConversationTool({ name: 'list_messages', args: { botId: 'bot-a' }, from: 'bot-a', registry: f.bots, store: f.store })
  assert.deepEqual(result.items.map(x => x.deliveryTracking), [tracking, tracking])
  await f.callback().onStatus('delivered')
  assert.equal((await f.store.timeline('bot-a')).at(-1).deliveryTracking, undefined)
})

test('old, malformed and non-failed statuses do not acquire or retain tracking evidence', async t => {
  const f = await fixture(t)
  await f.messenger.userTurn({ target: 'bot-a', message: 'fixture' })
  for (const value of [undefined, null, 'broken', [], { ...tracking, completion: 'done' }, { ...tracking, schema: 'future' }]) {
    await f.callback().onStatus('failed', null, value)
    assert.equal((await f.store.timeline('bot-a'))[0].deliveryTracking, undefined)
  }
  await f.callback().onStatus('failed', null, tracking)
  assert.deepEqual((await f.store.timeline('bot-a'))[0].deliveryTracking, tracking)
  for (const status of ['running', 'stopped', 'delivered']) {
    await f.callback().onStatus(status, null, tracking)
    assert.equal((await f.store.timeline('bot-a'))[0].deliveryTracking, undefined)
  }
  // Untrusted optional disk fields cannot break a page or leak arbitrary data.
  await appendFile(f.logPath, line({ schema: 'bellteam.delivery-status.v1', delivery_id: 'd1', delivery: 'failed', delivery_tracking: 'broken' }))
  assert.equal((await f.store.timeline('bot-a'))[0].deliveryTracking, undefined)
})

test('room callbacks persist per recipient evidence, preserve mixed failures, and clear a later status', async t => {
  const f = await fixture(t), path = join(f.root, 'room.jsonl'), history = new RoomHistory(path)
  const room = { id: 'room-a', name: 'fixture', memberIds: ['bot-a', 'bot-b'] }
  const rooms = new Map([[room.id, room]])
  rooms.messages = () => history.messages()
  rooms.appendMessage = (_id, value) => appendFile(path, line(value))
  const callbacks = []
  const messenger = new RoomMessenger({ bots: f.bots, rooms, automaticRouting: () => false, roomTurns: async () => [],
    transport: { async notify(bot, _text, options) { callbacks.push([bot.id, options]); return { delivery: 'running' } } },
    messageId: () => 'room-message', now: () => '2026-11-02T00:00:00Z' })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: 'fixture', targets: ['bot-a'] })
  await callbacks[0][1].onStatus('failed', null, tracking)
  await callbacks[1][1].onStatus('failed', null)
  const views = createMessageViews({ rooms })
  const page = await views.messagePage('rooms', room.id, new URL('http://fixture/?limit=20'))
  assert.deepEqual(page, wire.room)
  const item = page.items[0]
  assert.equal(item.deliveryTracking, undefined)
  assert.deepEqual(item.deliveries.map(x => x.deliveryTracking), [tracking, undefined])
  assert.deepEqual(item.deliveries.map(x => x.delivery), ['failed', 'failed'])
  assert.doesNotMatch(JSON.stringify(item), /delivery_tracking/)
  await callbacks[0][1].onStatus('delivered')
  assert.equal((await history.messages())[0].deliveries[0].deliveryTracking, undefined)
})


test('execution waiter failure crosses the real messenger writer and store without a second send', async t => {
  const f = await fixture(t), error = Object.assign(new Error('PRIVATE_WAITER'), { code: 'SEAT_PROCESS_FAILED' })
  const bot = f.bots.get('bot-a'); Object.assign(bot, { session: 'fixture-session', harness: 'codex', project: f.root })
  let sends = 0
  f.messenger.transport = new AitermTransport({ handoffContext: async () => '', waitProcess: async () => { throw error },
    client: { async call(name) {
      if (name === 'pty_send') { sends++; return { structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: { executable: 'unused', args: [] } } } }
      if (name === 'pty_observe') return {}
      assert.fail(name)
    } } })
  await assert.rejects(f.messenger.userTurn({ target: bot.id, message: 'fixture' }), value => value === error)
  assert.equal(sends, 1)
  const [item] = await f.store.timeline(bot.id)
  assert.equal(item.delivery, 'failed'); assert.deepEqual(item.deliveryTracking, tracking)
  assert.doesNotMatch(await readFile(f.logPath, 'utf8'), /PRIVATE_WAITER/)
})
