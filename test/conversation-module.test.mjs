import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationWriter, deliveryFailureFields } from '../src/conversation-writer.mjs'
import { conversationTools, callConversationTool } from '../src/mcp-conversation-tools.mjs'
import { resolveBotImagePath } from '../src/bot-image-path.mjs'
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

// a521: a remote seat's image path is passed unchanged (terminal's own form, e.g. Windows 'C:\x.png'); the terminal read judges it.
test('sendmessage keeps a remote seat image path as given', async () => {
  const registry = new Map([['bot-r', { id: 'bot-r', name: 'R', terminalId: 'win', projectRoot: 'C:\\p' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  const calls = []
  for (const image of ['C:\\Users\\x\\a.png', 'shot.png']) await callConversationTool({ name: 'sendmessage', from: 'bot-r', registry, args: { target: 'B', message: 'm', image }, deliverMessage: async value => { calls.push(value.image) } })
  assert.deepEqual(calls, [{ path: 'C:\\Users\\x\\a.png' }, { path: 'shot.png' }])
})

// a521b: the shared resolver (also set_avatar's) keeps refusing a remote seat's '..' path; only the conversation tools skip it.
test('resolveBotImagePath still guards a remote seat relative path', async () => {
  const bot = { id: 'bot-r', terminalId: 'win', projectRoot: 'C:\\p', project: '/srv/p' }
  await assert.rejects(resolveBotImagePath(bot, '../x.png'), /IMAGE_PATH_INVALID/)
})
