import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationWriter, deliveryFailureFields } from '../src/conversation-writer.mjs'
import { conversationTools, callConversationTool } from '../src/mcp-conversation-tools.mjs'
import { requireRoomMember, requireRepresentative } from '../src/room-access.mjs'

test('会話writerは保存後に通知し、失敗結果と表示用の言葉を発言に変えない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-writer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'history/messages.jsonl'), notified = []
  const writer = new ConversationWriter({ logPath, now: () => '2026-11-02T00:00:00Z', id: () => 'word-1', onMessage: record => {
    assert.deepEqual(JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1)), record)
    notified.push(record)
  } })
  const error = { message: 'raw private failure', mcp_error: { tool: 'pty_send', message: 'safe refusal', truncated: false } }
  await writer.appendDeliveryStatus('delivery-1', 'failed', error)
  await writer.appendInterimWords('bot-a', 'delivery-1', [{ text: 'answer', kind: 'answer', at: 'written' }])
  const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(notified, records)
  assert.equal((await stat(logPath)).mode & 0o777, 0o600)
  assert.deepEqual(records[0], { schema: 'bellteam.delivery-status.v1', delivery_id: 'delivery-1', at: '2026-11-02T00:00:00Z', delivery: 'failed', ...deliveryFailureFields(error) })
  assert.deepEqual(records[1], { schema: 'bellteam.interim-word.v1', id: 'word-1', at: '2026-11-02T00:00:00Z', bot: 'bot-a', group_id: 'delivery-1', text: 'answer', kind: 'answer', written_at: 'written' })
  assert.doesNotMatch(JSON.stringify(records), /raw private failure|"from"|"target"/u)
  const occupied = join(root, 'occupied')
  await writeFile(occupied, '')
  const broken = new ConversationWriter({ logPath: join(occupied, 'messages.jsonl'), now: () => '', id: () => '', onMessage: () => assert.fail('保存失敗の通知') })
  await assert.rejects(broken.append(records[0]))
})

test('会話専用MCPは共通入口を編集せず宛先解決と配送窓口を検証できる', async () => {
  const registry = new Map([['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  const calls = [], args = { target: 'B', message: 'fixture', image: '/fixture.png' }
  const context = { registry, from: 'bot-a', args, deliverMessage: async value => { calls.push(value); return { delivery: 'steered' } } }
  assert.deepEqual(await callConversationTool({ ...context, name: 'sendmessage' }), { delivery: 'steered' })
  assert.deepEqual(calls, [{ from: 'bot-a', target: 'bot-b', message: 'fixture', image: { path: '/fixture.png' } }])
  assert.ok(conversationTools.find(tool => tool.name === 'sendmessage').inputSchema.required.includes('message'))
  assert.ok(!conversationTools.some(tool => tool.name === 'set_room_schedule'))
  await assert.rejects(callConversationTool({ ...context, name: 'sendmessage', args: { target: 'missing', message: 'fixture' } }), /BOT_NOT_FOUND/u)
})

test('部屋予定も同じ公開資格検証を使える', () => {
  const room = { id: 'room-a', memberIds: ['bot-a', 'bot-b'], representativeId: 'bot-a' }
  const rooms = new Map([[room.id, room]])
  assert.equal(requireRoomMember(rooms, room.id, 'bot-b'), room)
  assert.equal(requireRepresentative(rooms, room.id, 'bot-a'), room)
  assert.throws(() => requireRepresentative(rooms, room.id, 'bot-b'), /ROOM_REPRESENTATIVE_REQUIRED/u)
  assert.throws(() => requireRoomMember(rooms, room.id, 'bot-c'), /ROOM_MEMBER_REQUIRED/u)
  assert.throws(() => requireRoomMember(rooms, 'missing', 'bot-a'), /ROOM_NOT_FOUND/u)
})
