import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { BotRegistry, normalizeSchedule } from '../src/bot-registry.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
import { bellTeamTools } from '../src/mcp-tools.mjs'

const days = { id: 'days', kind: 'interval_days', prompt: '確認して', intervalDays: 3, startDate: '2026-08-30', time: '09:00', timezone: 'Asia/Tokyo' }
const hours = { id: 'hours', kind: 'interval_hours', prompt: '確認して', intervalHours: 3, startHour: 9, endHour: 18, minute: 0, timezone: 'Asia/Tokyo' }
const next = (schedule, at) => normalizeSchedule(schedule, new Date(at)).nextRunAt

test('日おきは開始日を基準に月末・年末・うるう日を越えて進む', () => {
  assert.equal(next(days, '2026-08-29T00:00:00Z'), '2026-08-30T00:00:00.000Z')
  assert.equal(next(days, '2026-08-30T00:00:00Z'), '2026-09-02T00:00:00.000Z')
  assert.equal(next(days, '2026-09-04T11:00:00Z'), '2026-09-05T00:00:00.000Z')
  assert.equal(next({ ...days, startDate: '2026-12-30' }, '2026-12-30T00:00:01Z'), '2027-01-02T00:00:00.000Z')
  assert.equal(next({ ...days, startDate: '2028-02-27', intervalDays: 2 }, '2028-02-27T00:00:01Z'), '2028-02-29T00:00:00.000Z')
  assert.equal(next({ ...days, startDate: '2028-02-27', intervalDays: 2 }, '2028-02-29T00:00:01Z'), '2028-03-02T00:00:00.000Z')
})

test('日おきは夏時間をまたいでも現地の指定時刻を保つ', () => {
  const schedule = { ...days, startDate: '2026-03-07', intervalDays: 2, timezone: 'America/New_York' }
  assert.equal(next(schedule, '2026-03-07T14:00:00Z'), '2026-03-09T13:00:00.000Z')
})

test('時間おきは開始から終了まで実行し、翌日は開始時刻へ戻る', () => {
  let now = '2026-09-04T23:59:59Z'
  const actual = []
  for (let i = 0; i < 5; i += 1) { now = next(hours, now); actual.push(now) }
  assert.deepEqual(actual, ['2026-09-05T00:00:00.000Z', '2026-09-05T03:00:00.000Z', '2026-09-05T06:00:00.000Z', '2026-09-05T09:00:00.000Z', '2026-09-06T00:00:00.000Z'])
  assert.equal(next({ ...hours, endHour: 17 }, '2026-09-05T06:00:00Z'), '2026-09-06T00:00:00.000Z')
  assert.equal(next({ ...hours, startHour: 22, endHour: 4 }, '2026-09-05T13:00:00Z'), '2026-09-05T16:00:00.000Z')
  assert.equal(next({ ...hours, startHour: 22, endHour: 4 }, '2026-09-05T19:00:00Z'), '2026-09-06T13:00:00.000Z')
  assert.equal(next({ ...hours, minute: 30 }, '2026-09-05T00:00:00Z'), '2026-09-05T00:30:00.000Z')
  assert.equal(next({ ...hours, endHour: 9 }, '2026-09-05T00:00:00Z'), '2026-09-06T00:00:00.000Z')
})

test('間隔と日付と時間帯の不正な入力を拒否する', () => {
  for (const intervalDays of [0, -1, 1.5, '2']) assert.throws(() => next({ ...days, intervalDays }, '2026-09-05'), /SCHEDULE_INTERVAL_DAYS_INVALID/)
  assert.throws(() => next({ ...days, startDate: '2026-02-30' }, '2026-09-05'), /SCHEDULE_START_DATE_INVALID/)
  assert.throws(() => next({ ...days, time: '24:00' }, '2026-09-05'), /SCHEDULE_TIME_INVALID/)
  for (const intervalHours of [0, -1, 1.5, 25]) assert.throws(() => next({ ...hours, intervalHours }, '2026-09-05'), /SCHEDULE_INTERVAL_HOURS_INVALID/)
  assert.throws(() => next({ ...hours, endHour: 24 }, '2026-09-05'), /SCHEDULE_HOUR_INVALID/)
  assert.throws(() => next({ ...hours, minute: 60 }, '2026-09-05'), /SCHEDULE_MINUTE_INVALID/)
  assert.equal(next({ ...days, enabled: false }, '2026-09-05'), null)
  assert.equal(next({ ...hours, enabled: false }, '2026-09-05'), null)
})

test('保存・読み直し・実行・編集で日おきの基準と時間帯を保つ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-intervals-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: '試験Bot', harness: 'grok', session: 'bot-a', project: '/unused' }] }))
  let id = 0
  const options = { seedPath, botsRoot: join(root, 'bots'), now: () => new Date('2026-09-01T23:00:00Z'), id: () => `schedule-${++id}` }
  const registry = new BotRegistry(options)
  await registry.initialize()
  const { id: _daysId, ...dayInput } = days
  const { id: _hoursId, ...hourInput } = hours
  await registry.setSchedule('bot-a', dayInput)
  await registry.setSchedule('bot-a', hourInput)
  const reloaded = new BotRegistry(options)
  await reloaded.initialize()
  const sent = []
  const scheduler = new BotScheduler({ registry: reloaded, messenger: { async sendmessage(value) { sent.push(value) } } })
  await scheduler.runDue(new Date('2026-09-02T00:00:01Z'))
  await scheduler.runDue(new Date('2026-09-02T00:00:02Z'))
  assert.equal(sent.length, 2)
  const [savedDays, savedHours] = await reloaded.listSchedules('bot-a')
  assert.equal(savedDays.startDate, days.startDate)
  assert.equal(savedDays.nextRunAt, '2026-09-05T00:00:00.000Z')
  assert.equal(savedHours.nextRunAt, '2026-09-02T03:00:00.000Z')
  const edited = await reloaded.setSchedule('bot-a', { ...savedHours, intervalHours: 4, endHour: 20 })
  assert.equal(edited.id, savedHours.id)
  assert.equal(edited.intervalHours, 4)
  assert.equal((await reloaded.markScheduleRun('bot-a', edited.id, new Date('2026-09-02T08:00:01Z'))).nextRunAt, '2026-09-03T00:00:00.000Z')
})

test('画面の編集・保存は両方の間隔設定と元のタイムゾーンを保持する', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const functions = ['scheduleFormValues', 'scheduleRequest', 'scheduleDescription'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n')
  for (const schedule of [days, hours]) {
    const values = { 'schedule-name': '', 'schedule-prompt': schedule.prompt, 'schedule-interval-days': schedule.intervalDays, 'schedule-start-date': schedule.startDate, 'schedule-time': schedule.time, 'schedule-interval-hours': schedule.intervalHours, 'schedule-start-hour': schedule.startHour, 'schedule-end-hour': schedule.endHour, 'schedule-minute': schedule.minute }
    const context = vm.createContext({ schedule, state: { selectedType: 'bot', editingSchedule: schedule }, scheduleKind: { value: schedule.kind }, scheduleAction: { value: 'prompt' }, document: { querySelector: id => ({ value: values[id.slice(1)] }) } })
    vm.runInContext(functions, context)
    const form = vm.runInContext('scheduleFormValues(schedule)', context)
    assert.equal(form.type, schedule.kind)
    const request = JSON.parse(JSON.stringify(vm.runInContext('scheduleRequest()', context)))
    const { id, ...input } = schedule
    assert.deepEqual(request, { ...input, name: '', enabled: true })
    assert.match(vm.runInContext('scheduleDescription(schedule)', context), /おき/)
  }
  for (const name of ['set_schedule', 'set_room_schedule']) {
    const schema = bellTeamTools.find(tool => tool.name === name).inputSchema
    assert.ok(schema.properties.kind.enum.includes('interval_days'))
    assert.ok(schema.properties.kind.enum.includes('interval_hours'))
    assert.equal(schema.properties.intervalHours.maximum, 24)
  }
})
