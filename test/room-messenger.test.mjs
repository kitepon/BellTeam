import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RoomMessenger } from '../src/room-messenger.mjs'

test('自動振り分けOFFでも手動指定したBotの回答をルームへ投稿できる', async () => {
  const bots = new Map([['bot-a', { id: 'bot-a', name: '担当' }]])
  const room = { id: 'room-a', name: '相談', memberIds: ['bot-a'] }
  const rooms = new Map([[room.id, room]])
  const records = [], notified = []
  rooms.messages = async () => records
  rooms.appendMessage = async (_id, record) => records.push(record)
  const messenger = new RoomMessenger({ bots, rooms, automaticRouting: () => false,
    roomTurns: async () => [], chooseResponder: async () => { throw new Error('Jevを呼ばない') },
    transport: { async notify(bot, text) { notified.push(text); return { delivery: 'running' } } },
  })
  await assert.rejects(messenger.sendroommessage({ from: 'user', room: room.id, message: 'お願い' }), { code: 'ROOM_AUTOMATIC_ROUTING_DISABLED' })
  await messenger.sendroommessage({ from: 'user', room: room.id, message: 'お願い', targets: ['bot-a'] })
  const reply = await messenger.sendroommessage({ from: 'bot-a', room: room.id, responseTo: records[0].id, message: '答えです' })
  assert.deepEqual(reply.targets, [])
  assert.match(notified.at(-1), /action="silent"/u)
  assert.equal(records.find(record => record.responseTo)?.message, '答えです')
})

test('ルーム発言は現在の文脈を付けて対象メンバーへ並列配送する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-room-message-'))
  const bots = new Map([
    ['bot-a', { id: 'bot-a', name: 'あかり', position: '調査主任', role: '調査', project: '/bots/a' }],
    ['bot-b', { id: 'bot-b', name: 'ゆず', position: '開発主任', role: '開発', project: '/bots/b' }],
    ['bot-c', { id: 'bot-c', name: 'りん', position: '広報主任', role: '広報', project: '/bots/c' }],
  ])
  bots.refresh = async () => bots
  const room = {
    id: 'room-work', name: '開発室', purpose: '仕事の共有', representativeId: 'bot-a',
    memberIds: ['bot-a', 'bot-b', 'bot-c'],
  }
  const records = []
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async (_id, record) => records.push(record)
  rooms.messages = async () => records
  const calls = []
  const interimWords = []
  const messenger = new RoomMessenger({
    rooms, bots,
    transport: { async notify(bot, text, options) { calls.push([bot.id, text, options]); return { delivery: 'running' } } },
    onInterimWords: async (botId, groupId, words) => interimWords.push([botId, groupId, words]),
    now: () => '2026-08-31T03:00:00.000Z', messageId: () => 'room-message-1',
    roomTurns: async () => [{ speaker: 'あかり', text: 'bot-bだけ確認して' }],
    chooseResponder: async () => { throw new Error('手動指定でJevを呼ばない') },
  })

  const result = await messenger.sendroommessage({
    from: 'bot-a', room: room.id, message: 'bot-bだけ確認して', targets: ['bot-b'],
  })

  assert.deepEqual(result.targets, ['bot-b'])
  assert.equal(result.delivery, 'running')
  assert.deepEqual(calls.map(call => call[0]), ['bot-a', 'bot-b', 'bot-c'])
  assert.equal(calls[1][1], '「オーナー」、「あかり」、「ゆず」、「りん」が参加する「開発室」です。\n\nこの部屋の目的は、\n「仕事の共有」\nです。\n\nメッセージID: room-message-1\n「あかり」からあなたへ次のメッセージが届いています。\n\nbot-bだけ確認して')
  assert.match(calls[0][1], /respond_to_room\(action="silent"/u)
  assert.match(calls[2][1], /respond_to_room\(action="silent"/u)
  assert.doesNotMatch(calls[1][1].split('\n\nbot-bだけ確認して')[0], /room-work|bot-a|bot-b|respond_to_room/u)
  assert.deepEqual(calls[1][2].queue, {
    context: 'room', contextId: 'room-work', groupId: 'room-message-1',
    from: 'bot-a', fromName: 'あかり', target: 'bot-b', message: 'bot-bだけ確認して',
  })
  assert.equal(typeof calls[1][2].onStatus, 'function')
  assert.deepEqual(records[0].deliveries.map(item => item.target), ['bot-a', 'bot-b', 'bot-c'])
  assert.deepEqual(records[1].routing, { status: 'ready', responders: ['bot-b'] })
  await calls[1][2].onStatus('running')
  await calls[1][2].onStatus('delivered')
  assert.deepEqual(records.slice(2).map(item => [item.target, item.delivery]), [
    ['bot-b', 'running'], ['bot-b', 'delivered'],
  ])
  assert.equal(records[0].sender.name, 'あかり')
  assert.equal(records[0].room.name, '開発室')
  const roomRecords = records.length
  await calls[1][2].onInterim([{ text: 'ログを見るね' }])
  await calls[2][2].onAnswer('黙って流れを把握した')
  assert.deepEqual(interimWords, [
    ['bot-b', 'room-message-1', [{ text: 'ログを見るね' }]],
    ['bot-c', 'room-message-1', [{ text: '黙って流れを把握した', kind: 'answer' }]],
  ])
  assert.equal(records.length, roomRecords)
})

test('ユーザーの宛先省略はJevが一人を選び全員が読む', async () => {
  const bots = new Map([
    ['bot-a', { id: 'bot-a', name: '代表', role: '統括' }],
    ['bot-b', { id: 'bot-b', name: '開発', role: '実装' }],
  ])
  bots.refresh = async () => bots
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: 'bot-a', memberIds: ['bot-a', 'bot-b'] }
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async () => {}
  const calls = []
  let selectionInput
  const messenger = new RoomMessenger({
    rooms, bots,
    transport: { async notify(bot, text) { calls.push([bot.id, text]); return { delivery: 'running' } } },
    messageId: () => 'room-message-1',
    roomTurns: async () => [{ speaker: 'クオ', text: '相談です' }],
    chooseResponder: async input => { selectionInput = input; return ['bot-b'] },
  })

  const result = await messenger.sendroommessage({ from: 'user', room: room.id, message: '相談です' })

  assert.deepEqual(calls.map(call => call[0]), ['bot-a', 'bot-b'])
  assert.equal(selectionInput.room, room)
  assert.deepEqual(selectionInput.members.map(({ id, name, position, role }) => ({ id, name, position, role })), [
    { id: 'bot-a', name: '代表', position: '', role: '統括' },
    { id: 'bot-b', name: '開発', position: '', role: '実装' },
  ])
  assert.match(calls[0][1], /respond_to_room\(action="silent"/u)
  assert.doesNotMatch(calls[1][1], /respond_to_room\(action="silent"/u)
  assert.deepEqual(result.targets, ['bot-b'])
  assert.equal(result.delivery, 'running')
})

test('Botの宛先省略も全員が読み、継続不要なら全員沈黙する', async () => {
  const bots = new Map([
    ['bot-a', { id: 'bot-a', name: '代表', role: '統括' }],
    ['bot-b', { id: 'bot-b', name: '開発', role: '実装' }],
  ])
  bots.refresh = async () => bots
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: 'bot-a', memberIds: ['bot-a', 'bot-b'] }
  const records = []
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async (_id, record) => records.push(record)
  const calls = []
  const messenger = new RoomMessenger({
    rooms, bots,
    transport: { async notify(bot, text) { calls.push([bot.id, text]); return { delivery: 'running' } } },
    messageId: () => 'room-message-1',
    roomTurns: async () => [{ speaker: '代表', text: '回答です' }],
    chooseResponder: async () => [],
  })

  const result = await messenger.sendroommessage({ from: 'bot-a', room: room.id, message: '回答です' })

  assert.deepEqual(calls.map(call => call[0]), ['bot-a', 'bot-b'])
  assert.ok(calls.every(call => call[1].includes('respond_to_room(action="silent"')))
  assert.deepEqual(result, { id: 'room-message-1', room: 'room-work', targets: [], delivery: 'running' })
  assert.equal(records[0].message, '回答です')
})

test('手動で複数人を指定すると全員が読み指定者全員が返答する', async () => {
  const bots = new Map([
    ['bot-a', { id: 'bot-a', name: '一人目', role: '' }],
    ['bot-b', { id: 'bot-b', name: '二人目', role: '' }],
  ])
  bots.refresh = async () => bots
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: null, memberIds: ['bot-a', 'bot-b'] }
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async () => {}
  const notified = []
  const transport = { async notify(bot, text) { notified.push([bot.id, text]); return { delivery: 'running' } } }
  const messenger = new RoomMessenger({ rooms, bots, transport, messageId: () => 'room-message-2',
    roomTurns: async () => [{ speaker: 'クオ', text: '相談です' }],
    chooseResponder: async () => { throw new Error('手動指定でJevを呼ばない') },
  })

  const result = await messenger.sendroommessage({ from: 'user', room: room.id, message: '相談です', targets: ['bot-a', 'bot-b'] })

  assert.deepEqual(result.targets, ['bot-a', 'bot-b'])
  assert.deepEqual(notified.map(item => item[0]), ['bot-a', 'bot-b'])
  assert.ok(notified.every(item => !item[1].includes('respond_to_room(action="silent"')))
})

test('共通規範は沈黙を内部制御にし、個別連絡で無関係なBotを起こさない', async () => {
  const rules = await readFile(new URL('../config/common-agents.md', import.meta.url), 'utf8')
  assert.match(rules, /respond_to_room\(action="silent", messageId\)/u)
  assert.match(rules, /沈黙宣言をルームへ投稿しない/u)
  assert.match(rules, /特定の一人だけに必要な依頼、回答、連絡は、ルームではなく`sendmessage`/u)
  assert.doesNotMatch(rules, /`targets` を省略すると全メンバーへ届く/u)
})

test('Botがルームへ提示した画像を会話資産として記録する', async () => {
  const bot = { id: 'bot-a', name: 'あかり', role: '画像担当', project: '/bots/a' }
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: 'bot-a', memberIds: ['bot-a'] }
  const records = []
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async (_id, record) => records.push(record)
  const assets = { async save(value) { return { owner: value.owner, file: `${value.id}.png`, mime: 'image/png' } } }
  const messenger = new RoomMessenger({
    rooms, bots: new Map([[bot.id, bot]]), transport: { notify: async () => ({ delivery: 'running' }) }, assets, messageId: () => 'room-message-1',
    roomTurns: async () => [{ speaker: 'あかり', text: '画像です' }], chooseResponder: async () => [],
  })

  await messenger.sendroommessage({ from: bot.id, room: room.id, message: '画像です', image: { path: '/tmp/image.png' } })

  assert.deepEqual(records[0].image_asset, { owner: 'bot-a', file: 'room-message-1.png', mime: 'image/png' })
})

test('ユーザーがルームへ送った複数の画像を全メンバーの配達へ渡し、枚数だけを記録する', async () => {
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'あかり', role: '画像担当' }], ['bot-b', { id: 'bot-b', name: 'ゆず', role: '開発' }]])
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: null, memberIds: ['bot-a', 'bot-b'] }
  const records = []
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async (_id, record) => records.push(record)
  const notified = []
  const messenger = new RoomMessenger({
    rooms, bots, transport: { notify: async (bot, _message, options) => { notified.push([bot.id, options.images]); return { delivery: 'running' } } },
    messageId: () => 'room-message-1',
    roomTurns: async () => [{ speaker: 'オーナー', text: '2枚見て' }], chooseResponder: async () => ['bot-a'],
  })
  const images = [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/jpeg', data: '/9j/4A==' }]

  await messenger.sendroommessage({ from: 'user', room: room.id, message: '2枚見て', images })

  assert.deepEqual(notified, [['bot-a', images], ['bot-b', images]])
  assert.equal(records[0].image, true)
  assert.equal(records[0].image_count, 2)
  assert.doesNotMatch(JSON.stringify(records), /iVBORw0KGgo|\/9j\/4A/u)
})

test('ユーザーがルームへ送った画像は全部オーナーの場所へ残して記録から参照する', async () => {
  const bot = { id: 'bot-a', name: 'あかり', role: '画像担当' }
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: null, memberIds: [bot.id] }
  const records = []
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async (_id, record) => records.push(record)
  const saved = []
  const assets = { async saveAll(value) { saved.push(value); return value.images.map((_image, index) => ({ owner: value.owner, file: `${value.id}-${index + 1}.png`, mime: 'image/png' })) } }
  const messenger = new RoomMessenger({
    rooms, bots: new Map([[bot.id, bot]]), transport: { notify: async () => ({ delivery: 'running' }) }, assets, messageId: () => 'room-message-1',
    roomTurns: async () => [{ speaker: 'オーナー', text: '2枚' }], chooseResponder: async () => [],
  })
  const images = [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/png', data: 'iVBORw0KGgo=' }]

  await messenger.sendroommessage({ from: 'user', room: room.id, message: '2枚', images })

  assert.deepEqual(saved, [{ owner: 'user', id: 'room-message-1', images }])
  assert.deepEqual(records[0].image_assets.map(asset => asset.file), ['room-message-1-1.png', 'room-message-1-2.png'])
  assert.equal(records[0].image_asset, undefined)
})

test('同じ部屋の連続発言はThroughline記録と判定の順序を保つ', async () => {
  const bot = { id: 'bot-a', name: 'あかり', role: '担当' }
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: null, memberIds: [bot.id] }
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async () => {}
  const seen = []
  let releaseFirst
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve })
  const messenger = new RoomMessenger({
    rooms, bots: new Map([[bot.id, bot]]),
    transport: { async notify() { return { delivery: 'running' } } },
    roomTurns: async ({ text }) => {
      seen.push(text)
      if (text === '一通目') await firstBlocked
      return [{ speaker: 'ユーザー', text }]
    },
    chooseResponder: async () => [],
  })

  const first = messenger.sendroommessage({ from: 'user', room: room.id, message: '一通目' })
  const second = messenger.sendroommessage({ from: 'user', room: room.id, message: '二通目' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen, ['一通目'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(seen, ['一通目', '二通目'])
})

test('返信の一部配送が失敗しても投稿済みを返し、同じ発言への再送を重複投稿しない', async () => {
  const bot = { id: 'bot-a', name: 'あかり', role: '担当' }
  const room = { id: 'room-work', name: '開発室', purpose: '', representativeId: null, memberIds: [bot.id] }
  const records = []
  const rooms = new Map([[room.id, room]])
  rooms.refresh = async () => rooms
  rooms.appendMessage = async (_id, record) => records.push(record)
  rooms.messages = async () => records.filter(record => record.schema === 'bellteam.room-message.v1')
  let deliveries = 0
  const messenger = new RoomMessenger({
    rooms, bots: new Map([[bot.id, bot]]), messageId: () => 'reply-1',
    transport: { async notify() { deliveries += 1; throw new Error('AITERM_UNRESOLVED_TURN') } },
    roomTurns: async () => [{ speaker: 'あかり', text: '返答です' }], chooseResponder: async () => [],
  })

  const input = { from: bot.id, room: room.id, responseTo: 'question-1', message: '返答です' }
  const first = await messenger.sendroommessage(input)
  const second = await messenger.sendroommessage(input)

  assert.deepEqual(first, {
    id: 'reply-1', room: room.id, targets: [], delivery: 'posted_with_failed_deliveries',
    failedTargets: [{ id: bot.id, error: 'AITERM_UNRESOLVED_TURN' }],
  })
  assert.deepEqual(second, { id: 'reply-1', room: room.id, targets: [], delivery: 'already_posted' })
  assert.equal(deliveries, 1)
  assert.equal(records.filter(record => record.schema === 'bellteam.room-message.v1').length, 1)
})
