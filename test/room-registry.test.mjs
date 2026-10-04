import assert from 'node:assert/strict'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RoomRegistry } from '../src/room-registry.mjs'

test('ルーム設定と予定をルーム別ファイルへ保存し、退室した代表を未設定にする', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-rooms-'))
  const bots = new Map([['bot-a', { id: 'bot-a' }], ['bot-b', { id: 'bot-b' }]])
  const rooms = new RoomRegistry({
    roomsRoot: join(root, 'rooms'), bots,
    roomId: () => 'room-work', id: () => 'schedule-1',
    now: () => new Date('2026-08-31T00:00:00.000Z'),
  })
  await rooms.initialize()

  const room = await rooms.create({
    name: '開発室', purpose: '仕事を共有する', representativeId: 'bot-a', memberIds: ['bot-a', 'bot-b'],
  })
  assert.equal(room.id, 'room-work')
  const schedule = await rooms.setSchedule(room.id, {
    kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo', prompt: '朝会', targets: ['bot-b'],
  })
  assert.deepEqual(schedule.targets, ['bot-b'])

  const updated = await rooms.update(room.id, { memberIds: ['bot-b'] })
  assert.equal(updated.representativeId, null)
  const persisted = JSON.parse(await readFile(join(root, 'rooms/room-work/room.json'), 'utf8'))
  assert.equal(persisted.schema, 'bellteam.room.v1')
  assert.equal(JSON.parse(await readFile(join(root, 'rooms/room-work/schedule.json'), 'utf8')).schedules.length, 1)
})

test('代表Botはメンバー以外に設定できない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-rooms-invalid-'))
  const rooms = new RoomRegistry({
    roomsRoot: join(root, 'rooms'), bots: new Map([['bot-a', { id: 'bot-a' }], ['bot-b', { id: 'bot-b' }]]),
  })
  await rooms.initialize()
  await assert.rejects(
    rooms.create({ name: '部屋', purpose: '', representativeId: 'bot-b', memberIds: ['bot-a'] }),
    /ROOM_REPRESENTATIVE_INVALID/u,
  )
})

test('削除するBotをルームのメンバー・代表・予定宛先から外す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-rooms-remove-bot-'))
  const bots = new Map([['bot-a', { id: 'bot-a' }], ['bot-b', { id: 'bot-b' }]])
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots, roomId: () => 'room-work' })
  await rooms.initialize()
  await rooms.create({ name: '開発室', purpose: '', representativeId: 'bot-b', memberIds: ['bot-a', 'bot-b'] })
  await rooms.setSchedule('room-work', { kind: 'cron', expression: '0 9 * * *', prompt: '朝会', targets: ['bot-b'] })

  await rooms.removeBot('bot-b')

  assert.deepEqual(rooms.get('room-work').memberIds, ['bot-a'])
  assert.equal(rooms.get('room-work').representativeId, null)
  assert.deepEqual((await rooms.listSchedules('room-work'))[0].targets, [])
})

test('ルーム配送状態イベントをメッセージごとの宛先状態へ反映する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-room-delivery-'))
  const rooms = new RoomRegistry({
    roomsRoot: join(root, 'rooms'), bots: new Map([['bot-a', { id: 'bot-a' }]]), roomId: () => 'room-work',
  })
  await rooms.initialize()
  await rooms.create({ name: '開発室', purpose: '', representativeId: 'bot-a', memberIds: ['bot-a'] })
  await rooms.appendMessage('room-work', {
    schema: 'bellteam.room-message.v1', id: 'message-1', message: '確認して',
    deliveries: [{ target: 'bot-a', delivery: 'queued' }],
  })
  await rooms.appendMessage('room-work', {
    schema: 'bellteam.room-delivery-status.v1', message_id: 'message-1', target: 'bot-a', delivery: 'running',
  })
  await rooms.appendMessage('room-work', {
    schema: 'bellteam.room-delivery-status.v1', message_id: 'message-1', target: 'bot-a', delivery: 'failed',
  })
  await rooms.appendMessage('room-work', {
    schema: 'bellteam.room-routing-status.v1', message_id: 'message-1',
    routing: { status: 'ready', responders: ['bot-a'] },
  })

  const messages = await rooms.messages('room-work')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].deliveries, [{ target: 'bot-a', delivery: 'failed' }])
  assert.deepEqual(messages[0].routing, { status: 'ready', responders: ['bot-a'] })
})

test('ルームの設定・会話履歴・予定を保存領域ごと削除する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-rooms-remove-'))
  const rooms = new RoomRegistry({
    roomsRoot: join(root, 'rooms'), bots: new Map([['bot-a', { id: 'bot-a' }]]), roomId: () => 'room-work',
  })
  await rooms.initialize()
  await rooms.create({ name: '開発室', purpose: '', representativeId: 'bot-a', memberIds: ['bot-a'] })
  await rooms.appendMessage('room-work', { id: 'message-1', message: '進めよう' })
  await rooms.setSchedule('room-work', { kind: 'cron', expression: '0 9 * * *', prompt: '朝会' })

  assert.deepEqual(await rooms.remove('room-work'), { id: 'room-work' })
  assert.equal(rooms.has('room-work'), false)
  await assert.rejects(access(join(root, 'rooms/room-work')), /ENOENT/u)
  await assert.rejects(rooms.remove('room-work'), /ROOM_NOT_FOUND/u)
})

test('ルームはBotと同じ形式のアバターを持ち、不正な値は保存しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-room-avatar-'))
  const bots = new Map([['bot-a', { id: 'bot-a' }]])
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots, roomId: () => 'room-a' })
  await rooms.initialize()
  const created = await rooms.create({ name: '秘書室', memberIds: ['bot-a'] })
  assert.equal(created.avatar, '')
  const avatar = 'data:image/png;base64,iVBORw0KGgo='
  const updated = await rooms.update('room-a', { avatar })
  assert.equal(updated.avatar, avatar)
  assert.equal(JSON.parse(await readFile(join(root, 'rooms/room-a/room.json'), 'utf8')).avatar, avatar)
  await assert.rejects(rooms.update('room-a', { avatar: 'https://example.com/a.png' }), /ROOM_AVATAR_INVALID/u)
  await assert.rejects(rooms.update('room-a', { color: 'red' }), /ROOM_UPDATE_FIELD_INVALID/u)
})
