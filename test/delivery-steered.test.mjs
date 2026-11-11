import assert from 'node:assert/strict'
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { ConversationStore } from '../src/conversation-store.mjs'
import { RoomMessenger } from '../src/room-messenger.mjs'
import { RoomHistory } from '../src/room-history.mjs'
import { validateConversationCallback, normalizeConversationCallback } from '../src/conversation/callbacks.mjs'
import { validateDirectLogRecord } from '../src/direct-log-record.mjs'
import { callConversationTool } from '../src/mcp-conversation-tools.mjs'

// delivery.md "Steered input stays delivered".
test('delivery.status accepts steered only as true with delivered, and normalize keeps it', () => {
  assert.deepEqual(normalizeConversationCallback('delivery.status', { delivery: 'delivered', steered: true }),
    { delivery: 'delivered', error: null, tracking: null, steered: true })
  assert.equal('steered' in normalizeConversationCallback('delivery.status', { delivery: 'delivered' }), false)
  for (const params of [{ delivery: 'running', steered: true }, { delivery: 'delivered', steered: false }, { delivery: 'delivered', steered: 'yes' }])
    assert.throws(() => validateConversationCallback('delivery.status', params))
  const row = { schema: 'bellteam.delivery-status.v1', delivery_id: 'd1', at: '2026-11-12T00:00:00Z', delivery: 'delivered' }
  assert.equal(validateDirectLogRecord({ ...row, steered: true }), true)
  assert.throws(() => validateDirectLogRecord({ ...row, delivery: 'failed', steered: true }))
})

test('a steered delivered status is stored and exposed on direct list_messages and room deliveries; a later status clears it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-steered-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  const logPath = join(root, 'direct.jsonl'), store = new ConversationStore({ logPath })
  let callback
  const messenger = new BellTeamMessenger({ bots, store, logPath, deliveryId: () => 'd1', now: () => '2026-11-12T00:00:00Z',
    transport: { async notify(_bot, _text, options) { callback = options; return { delivery: 'running' } } } })
  await messenger.sendmessage({ from: 'bot-b', target: 'bot-a', message: 'hi' })
  await callback.onStatus('delivered', null, null, { steered: true })
  const status = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse).at(-1)
  assert.equal(status.steered, true)
  const listed = await callConversationTool({ name: 'list_messages', args: { botId: 'bot-a' }, from: 'bot-a', registry: bots, store })
  assert.deepEqual(listed.items.map(item => [item.delivery, item.steered]), [['delivered', true]])
  await callback.onStatus('failed')
  assert.equal((await store.timeline('bot-a')).at(-1).steered, undefined)

  const path = join(root, 'room.jsonl'), history = new RoomHistory(path)
  const room = { id: 'room-a', name: 'fixture', memberIds: ['bot-a', 'bot-b'] }
  const rooms = new Map([[room.id, room]])
  rooms.messages = () => history.messages()
  rooms.appendMessage = (_id, value) => appendFile(path, JSON.stringify(value) + '\n')
  const options = []
  const roomMessenger = new RoomMessenger({ bots, rooms, automaticRouting: () => false, roomTurns: async () => [],
    transport: { async notify(_bot, _text, value) { options.push(value); return { delivery: 'running' } } },
    messageId: () => 'room-message', now: () => '2026-11-12T00:00:00Z' })
  await roomMessenger.sendroommessage({ from: 'user', room: room.id, message: 'fixture', targets: ['bot-a'] })
  await options[0].onStatus('delivered', null, null, { steered: true })
  await options[1].onStatus('delivered')
  const [message] = await history.messages()
  assert.deepEqual(message.deliveries.map(item => item.steered), [true, undefined])
  assert.equal(message.steered, undefined)
})
