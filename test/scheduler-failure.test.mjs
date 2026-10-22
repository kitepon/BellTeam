import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'
import { RoomRegistry } from '../src/room-registry.mjs'
import { BotScheduler } from '../src/scheduler.mjs'

const now = new Date('2026-10-22T08:00:01Z')
const once = { kind: 'once', at: '2026-10-22T08:00:00Z', prompt: 'scheduled work' }
const uncertain = () => Object.assign(new Error('EXECUTION_UNCONFIRMED'), { code: 'EXECUTION_UNCONFIRMED', effect: 'possible' })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-schedule-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: ['a', 'b'].map(id => ({
    id: `bot-${id}`, displayName: id, harness: 'codex', session: `bot-${id}`, project: root,
  })) }))
  let sequence = 0
  const options = { seedPath, botsRoot: join(root, 'bots'), id: () => `schedule-${++sequence}`,
    now: () => new Date('2026-10-22T07:59:00Z') }
  const registry = new BotRegistry(options)
  await registry.initialize()
  return { root, registry, reload: async () => {
    const reloaded = new BotRegistry(options)
    await reloaded.initialize()
    return reloaded
  } }
}

test('結果不明の一回予定を再送せず、他Botの期限は処理し、再起動後も完了状態を保つ', async t => {
  const f = await fixture(t)
  await f.registry.setSchedule('bot-a', once)
  await f.registry.setSchedule('bot-b', once)
  const sent = []
  const messenger = { async sendmessage(value) {
    sent.push(value.target)
    if (value.target === 'bot-a') throw uncertain()
  } }
  const scheduler = new BotScheduler({ registry: f.registry, messenger })
  await assert.doesNotReject(() => scheduler.runDue(now))
  await scheduler.runDue(new Date('2026-10-22T08:00:16Z'))
  const reloaded = await f.reload()
  await new BotScheduler({ registry: reloaded, messenger }).runDue(new Date('2026-10-22T08:00:31Z'))
  assert.deepEqual(sent, ['bot-a', 'bot-b'])
  const [schedule] = await reloaded.listSchedules('bot-a')
  assert.equal(schedule.enabled, false)
  assert.equal(schedule.nextRunAt, null)
  assert.equal(schedule.lastRunAt, now.toISOString())
})

test('cron配送失敗は同じ回を繰り返さず、次に指定された時刻だけ実行する', async t => {
  const f = await fixture(t)
  await f.registry.setSchedule('bot-a', { kind: 'cron', expression: '* * * * *', timezone: 'UTC', prompt: 'work' })
  let sent = 0
  const scheduler = new BotScheduler({ registry: f.registry, messenger: { async sendmessage() { sent++; throw uncertain() } } })
  await assert.doesNotReject(() => scheduler.runDue(now))
  await scheduler.runDue(new Date('2026-10-22T08:00:16Z'))
  assert.equal(sent, 1)
  assert.equal((await f.registry.listSchedules('bot-a'))[0].nextRunAt, '2026-10-22T08:01:00.000Z')
  await assert.doesNotReject(() => scheduler.runDue(new Date('2026-10-22T08:01:01Z')))
  assert.equal(sent, 2)
})

test('ルーム予定の部分失敗でも発言全体を再送せず、別ルームの予定を妨げない', async t => {
  const f = await fixture(t)
  let roomId = 0, scheduleId = 0
  const rooms = new RoomRegistry({ roomsRoot: join(f.root, 'rooms'), bots: f.registry,
    roomId: () => `room-${++roomId}`, id: () => `room-schedule-${++scheduleId}` })
  await rooms.initialize()
  await rooms.create({ name: 'first', memberIds: ['bot-a'] })
  await rooms.create({ name: 'second', memberIds: ['bot-b'] })
  for (const room of rooms.values()) await rooms.setSchedule(room.id, once)
  const sent = []
  const scheduler = new BotScheduler({ registry: f.registry, messenger: {}, rooms,
    roomMessenger: { async sendroommessage(value) { sent.push(value.room); if (value.room === 'room-1') throw uncertain() } } })
  await assert.doesNotReject(() => scheduler.runDue(now))
  await scheduler.runDue(new Date('2026-10-22T08:00:16Z'))
  assert.deepEqual(sent, ['room-1', 'room-2'])
  const [schedule] = await rooms.listSchedules('room-1')
  assert.equal(schedule.enabled, false)
  assert.equal(schedule.lastRunAt, now.toISOString())
})

test('全体停止による発行前拒否は期限を消費せず、後続予定も発行しない', async t => {
  const f = await fixture(t)
  await f.registry.setSchedule('bot-a', once)
  await f.registry.setSchedule('bot-b', once)
  let paused = true
  const sent = []
  const scheduler = new BotScheduler({ registry: f.registry, messenger: { async sendmessage(value) {
    if (paused) throw Object.assign(new Error('paused'), { code: 'AI_GLOBAL_PAUSED' })
    sent.push(value.target)
  } } })
  await scheduler.runDue(now)
  assert.deepEqual(sent, [])
  assert.equal((await f.registry.listSchedules('bot-a'))[0].enabled, true)
  assert.equal((await f.registry.listSchedules('bot-b'))[0].lastRunAt, null)
  paused = false
  await scheduler.runDue(new Date('2026-10-22T08:00:16Z'))
  assert.deepEqual(sent, ['bot-a', 'bot-b'])
})
