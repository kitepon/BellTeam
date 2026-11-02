import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { botScheduleTools, roomScheduleTools, scheduleToolHandlers } from '../src/members/schedules-mcp.mjs'
import { createScheduleApi as compatibleApi } from '../src/http-schedule-api.mjs'
import { createScheduleApi } from '../src/members/schedules-http.mjs'
import { bellTeamTools, callBellTeamTool } from '../src/mcp-tools.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'

test('予定専用MCPはBot指定/省略とRegistry失敗を共通入口の編集なしで扱える', async () => {
  const calls = [], schedule = { id: 's-1', kind: 'interval_hours', intervalHours: 2, startHour: 9, endHour: 17, command: 'synthetic' }
  const registry = {
    async setSchedule(id, value) { calls.push(['set', id, value]); return value },
    async listSchedules(id) { calls.push(['list', id]); return [schedule] },
    async removeSchedule(id, scheduleId) { calls.push(['remove', id, scheduleId]) },
  }
  assert.deepEqual(await scheduleToolHandlers.set_schedule({ registry, from: 'bot-a', args: schedule }), { schedule })
  assert.deepEqual(await scheduleToolHandlers.list_schedules({ registry, from: 'bot-a', args: { botId: 'bot-b' } }), { schedules: [schedule] })
  assert.deepEqual(await scheduleToolHandlers.remove_schedule({ registry, from: 'bot-a', args: { id: 's-1' } }), { removed: 's-1' })
  assert.deepEqual(calls, [['set', 'bot-a', schedule], ['list', 'bot-b'], ['remove', 'bot-a', 's-1']])
  const failure = new Error('SCHEDULE_NOT_FOUND: s-1')
  registry.removeSchedule = async () => { throw failure }
  await assert.rejects(scheduleToolHandlers.remove_schedule({ registry, from: 'bot-a', args: { id: 's-1' } }), error => error === failure)
  for (const tool of [...botScheduleTools, ...roomScheduleTools]) {
    assert.equal(bellTeamTools.filter(item => item.name === tool.name).length, 1)
    assert.equal(bellTeamTools.find(item => item.name === tool.name), tool)
  }
  assert.equal(compatibleApi, createScheduleApi)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'member-schedules-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map(['bot-a', 'bot-b', 'bot-c'].map(id => [id, { id }]))
  bots.refresh = async () => bots
  bots.listSchedules = async () => []
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots, roomId: () => 'room-work', id: () => 'schedule-1' })
  await rooms.initialize()
  await rooms.create({ name: 'Synthetic', memberIds: ['bot-a', 'bot-b'], representativeId: 'bot-a' })
  return { bots, rooms }
}

const input = { roomId: 'room-work', kind: 'once', at: '2099-01-01T00:00:00Z', prompt: 'synthetic', targets: ['bot-b', 'bot-b'] }

test('部屋予定は公開資格helperと共通入力検証を保ち、拒否時は予定を保存しない', async t => {
  const { bots: registry, rooms } = await fixture(t)
  const call = (name, args, from = 'bot-a') => callBellTeamTool({ name, arguments: args, from, registry, rooms })
  await assert.rejects(call('set_room_schedule', input, 'bot-b'), /ROOM_REPRESENTATIVE_REQUIRED/u)
  await assert.rejects(call('set_room_schedule', input, 'bot-c'), /ROOM_MEMBER_REQUIRED/u)
  await assert.rejects(call('list_room_schedules', { roomId: 'absent' }), /ROOM_NOT_FOUND/u)
  await assert.rejects(call('list_room_schedules', { roomId: 'room-work' }, 'bot-c'), /ROOM_MEMBER_REQUIRED/u)
  await assert.rejects(call('set_room_schedule', { ...input, command: 'synthetic' }), /TOOL_ARGUMENT_INVALID: command/u)
  await assert.rejects(call('set_room_schedule', { ...input, targets: ['bot-c'] }), /ROOM_MEMBERS_INVALID/u)
  assert.deepEqual(await rooms.listSchedules('room-work'), [])
  const { schedule } = await call('set_room_schedule', input)
  assert.deepEqual(schedule.targets, ['bot-b'])
  assert.deepEqual(await call('list_room_schedules', { roomId: 'room-work' }, 'bot-b'), { schedules: [schedule] })
  await assert.rejects(call('remove_room_schedule', { roomId: 'room-work', id: schedule.id }, 'bot-b'), /ROOM_REPRESENTATIVE_REQUIRED/u)
  assert.deepEqual(await rooms.listSchedules('room-work'), [schedule])
  assert.deepEqual(await call('remove_room_schedule', { roomId: 'room-work', id: schedule.id }), { removed: schedule.id })
  await assert.rejects(call('remove_room_schedule', { roomId: 'room-work', id: schedule.id }), /SCHEDULE_NOT_FOUND/u)
})

test('部屋予定HTTPのURL/status/refresh/保存検証と手動発行を専用handlerへ保つ', async t => {
  const { bots, rooms } = await fixture(t), runs = []
  const refresh = rooms.refresh.bind(rooms)
  let refreshes = 0
  rooms.refresh = async () => { refreshes++; return refresh() }
  const server = createBellTeamServer({ bots, rooms, authorize: request => request.headers.authorization === 'synthetic',
    store: {}, transport: {}, writeLog: () => {},
    scheduler: { async runRoomSchedule(id, scheduleId) { runs.push([id, scheduleId]); return { id: scheduleId } } },
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: 'synthetic', 'content-type': 'application/json' }
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  const path = '/api/rooms/room-work/schedules'
  assert.equal((await fetch(base + path)).status, 401)
  assert.equal(refreshes, 0)
  const created = await request(path, 'POST', input)
  assert.equal(created.status, 201)
  const schedule = (await created.json()).schedule
  assert.deepEqual(schedule.targets, ['bot-b'])
  assert.deepEqual(await (await request(path)).json(), { schedules: [schedule] })
  const updated = await request(`${path}/${schedule.id}`, 'PUT', { ...input, id: 'body-id-is-overridden', prompt: 'edited' })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).schedule.id, schedule.id)
  const rejected = await request(path, 'POST', { ...input, command: 'synthetic' })
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error, 'SCHEDULE_COMMAND_ROOM_UNSUPPORTED')
  assert.equal((await request('/api/rooms/absent/schedules')).status, 404)
  assert.equal(refreshes, 5)
  const ran = await request(`${path}/${schedule.id}/run`, 'POST')
  assert.equal(ran.status, 202)
  assert.deepEqual(await ran.json(), { ran: schedule.id })
  assert.deepEqual(runs, [['room-work', schedule.id]])
  assert.equal(refreshes, 5)
  assert.equal((await request(`${path}/${schedule.id}`, 'DELETE')).status, 204)
  assert.equal(refreshes, 6)
  assert.deepEqual(await rooms.listSchedules('room-work'), [])
})
