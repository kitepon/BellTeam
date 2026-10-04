import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BotRegistry } from '../src/bot-registry.mjs'
import { BotScheduler, runShellCommand, tokyoMaintenanceDate } from '../src/scheduler.mjs'

test('日本時間03時だけ日次メンテナンス日を返す', () => {
  assert.equal(tokyoMaintenanceDate(new Date('2026-09-01T18:00:00.000Z')), '2026-09-02')
  assert.equal(tokyoMaintenanceDate(new Date('2026-09-01T17:59:59.000Z')), null)
  assert.equal(tokyoMaintenanceDate(new Date('2026-09-01T18:01:00.000Z')), null)
})

test('日本時間03時に20完了ターン以上の休止中Botだけを一度再起動する', async () => {
  const bots = [
    { id: 'bot-a', project: '/bots/bot-a' },
    { id: 'bot-b', project: '/bots/bot-b' },
    { id: 'bot-c', project: '/bots/bot-c' },
  ]
  const restarted = []
  const registry = {
    async refresh() {}, values() { return bots }, async listSchedules() { return [] },
  }
  const transport = {
    isIdle(id) { return id !== 'bot-c' },
    async isRunning() { return true },
    async restartIfIdle(bot) { restarted.push(bot.id); return { restarted: true } },
  }
  const scheduler = new BotScheduler({
    registry,
    messenger: {},
    transport,
    completedTurns: async project => project === '/bots/bot-b' ? 19 : 20,
  })
  const threeAm = new Date('2026-09-01T18:00:05.000Z')

  await scheduler.runDue(threeAm)
  await scheduler.runDue(new Date('2026-09-01T18:00:20.000Z'))

  assert.deepEqual(restarted, ['bot-a'])
})

test('停止中のBotは深夜再起動せず、次の起動時に通常の記憶復元へ任せる', async () => {
  const bot = { id: 'bot-a', project: '/bots/bot-a' }
  let counted = false
  let restarted = false
  const scheduler = new BotScheduler({
    registry: { async refresh() {}, values() { return [bot] }, async listSchedules() { return [] } },
    messenger: {},
    transport: {
      isIdle() { return true }, async isRunning() { return false },
      async restartIfIdle() { restarted = true },
    },
    completedTurns: async () => { counted = true; return 20 },
  })

  await scheduler.runDue(new Date('2026-09-01T18:00:00.000Z'))

  assert.equal(counted, false)
  assert.equal(restarted, false)
})

test('期限になった一回予定をAiterm配達経路へ渡し、完了済みにする', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-scheduler-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({
    schema: 'bellteam.bots.v1',
    bots: [{ id: 'bot-a', displayName: 'Bot A', harness: 'grok', session: 'bot-a', project: '/unused' }],
  }))
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), id: () => 'once-1' })
  await registry.initialize()
  await registry.setSchedule('bot-a', {
    kind: 'once', at: '2026-08-31T01:00:00.000Z', prompt: '巡回して', enabled: true,
  })
  const sent = []
  const scheduler = new BotScheduler({
    registry,
    messenger: { async sendmessage(value) { sent.push(value) } },
  })

  await scheduler.runDue(new Date('2026-08-31T01:00:01.000Z'))

  assert.deepEqual(sent, [{
    from: 'scheduler', target: 'bot-a',
    message: '[BellTeam schedule once-1] 巡回して',
  }])
  const [schedule] = await registry.listSchedules('bot-a')
  assert.equal(schedule.enabled, false)
  assert.equal(schedule.lastRunAt, '2026-08-31T01:00:01.000Z')
  assert.equal(schedule.nextRunAt, null)
})

test('同じ予定を同じ時刻に二重実行しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-scheduler-once-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({
    schema: 'bellteam.bots.v1',
    bots: [{ id: 'bot-a', displayName: 'Bot A', harness: 'grok', session: 'bot-a', project: '/unused' }],
  }))
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), id: () => 'once-2' })
  await registry.initialize()
  await registry.setSchedule('bot-a', { kind: 'once', at: '2026-08-31T01:00:00.000Z', prompt: '実行して' })
  let count = 0
  const scheduler = new BotScheduler({ registry, messenger: { async sendmessage() { count += 1 } } })
  const now = new Date('2026-08-31T01:00:01.000Z')

  await scheduler.runDue(now)
  await scheduler.runDue(now)

  assert.equal(count, 1)
})

test('cron予定は実行後に次回時刻へ進む', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-scheduler-cron-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({
    schema: 'bellteam.bots.v1',
    bots: [{ id: 'bot-a', displayName: 'Bot A', harness: 'grok', session: 'bot-a', project: '/unused' }],
  }))
  const registry = new BotRegistry({
    seedPath, botsRoot: join(root, 'bots'), id: () => 'cron-1',
    now: () => new Date('2026-08-31T00:00:00.000Z'),
  })
  await registry.initialize()
  await registry.setSchedule('bot-a', {
    kind: 'cron', expression: '0 * * * *', timezone: 'Asia/Tokyo', prompt: '毎時確認する',
  })
  let count = 0
  const scheduler = new BotScheduler({ registry, messenger: { async sendmessage() { count += 1 } } })

  await scheduler.runDue(new Date('2026-08-31T01:00:01.000Z'))

  const [schedule] = await registry.listSchedules('bot-a')
  assert.equal(count, 1)
  assert.equal(schedule.enabled, true)
  assert.equal(schedule.nextRunAt, '2026-08-31T02:00:00.000Z')
})

test('ルーム予定は指定メンバーへscheduled発言として配達する', async () => {
  const registry = { async refresh() {}, values() { return [] } }
  const room = { id: 'room-a' }
  const calls = []
  const rooms = {
    async refresh() {}, values() { return [room] },
    async listSchedules() { return [{ id: 'rs-1', name: '朝会', enabled: true, nextRunAt: '2026-08-31T01:00:00Z', prompt: '共有して', targets: ['bot-b'] }] },
    async markScheduleRun(...args) { calls.push(['mark', ...args]) },
  }
  const scheduler = new BotScheduler({
    registry, messenger: {}, rooms,
    roomMessenger: { async sendroommessage(value) { calls.push(['send', value]) } },
  })

  const now = new Date('2026-08-31T01:00:01Z')
  await scheduler.runDue(now)

  assert.deepEqual(calls[0], ['send', {
    from: 'scheduler', room: 'room-a', message: '共有して', targets: ['bot-b'],
    kind: 'schedule', schedule: { id: 'rs-1', name: '朝会' },
  }])
  assert.deepEqual(calls[1], ['mark', 'room-a', 'rs-1', now])
})

test('今すぐ実行は予定の次回時刻と有効状態を動かさずに配達する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-scheduler-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({
    schema: 'bellteam.bots.v1',
    bots: [{ id: 'bot-a', displayName: 'Bot A', harness: 'grok', session: 'bot-a', project: '/unused' }],
  }))
  const registry = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), id: () => 'cron-1' })
  await registry.initialize()
  await registry.setSchedule('bot-a', { kind: 'cron', expression: '0 6 * * *', timezone: 'Asia/Tokyo', prompt: '巡回して', enabled: true })
  const before = (await registry.listSchedules('bot-a'))[0]
  const sent = []
  const scheduler = new BotScheduler({ registry, messenger: { async sendmessage(value) { sent.push(value) } } })

  assert.deepEqual(await scheduler.runBotSchedule('bot-a', 'cron-1'), { id: 'cron-1' })

  assert.deepEqual(sent, [{ from: 'scheduler', target: 'bot-a', message: '[BellTeam schedule cron-1] 巡回して' }])
  const after = (await registry.listSchedules('bot-a'))[0]
  assert.equal(after.nextRunAt, before.nextRunAt)
  assert.equal(after.enabled, true)
  await assert.rejects(() => scheduler.runBotSchedule('bot-a', 'missing'), /SCHEDULE_NOT_FOUND/u)
})

test('command予定はAIへ配達せずコマンドを実行し、失敗した時だけユーザーへ知らせる', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-scheduler-command-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({
    schema: 'bellteam.bots.v1',
    bots: [{ id: 'bot-a', displayName: 'Bot A', harness: 'claude', session: 'bot-a', project: '/bots/bot-a' }],
  }))
  const registry = new BotRegistry({
    seedPath, botsRoot: join(root, 'bots'), id: () => 'cmd-1',
    now: () => new Date('2026-09-04T00:00:00.000Z'),
  })
  await registry.initialize()
  await registry.setSchedule('bot-a', {
    kind: 'cron', name: 'サイト更新', expression: '40 * * * *', timezone: 'Asia/Tokyo', command: 'python3 -m news.export',
  })
  const sent = []
  const commands = []
  let code = 0
  const scheduler = new BotScheduler({
    registry,
    messenger: { async sendmessage(value) { sent.push(value) } },
    runCommand: async request => { commands.push(request); return { code, signal: null, stdout: 'ok', stderr: code ? 'boom\nTraceback' : '' } },
  })

  await scheduler.runDue(new Date('2026-09-04T00:40:01.000Z'))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(commands, [{ command: 'python3 -m news.export', cwd: join(root, 'bots/bot-a') }])
  assert.deepEqual(sent, [])
  const [schedule] = await registry.listSchedules('bot-a')
  assert.equal(schedule.lastRunAt, '2026-09-04T00:40:01.000Z')
  assert.equal(schedule.nextRunAt, '2026-09-04T01:40:00.000Z')

  code = 1
  await scheduler.runDue(new Date('2026-09-04T01:40:01.000Z'))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent, [{
    from: 'bot-a', target: 'user',
    message: '[BellTeam schedule cmd-1] 予定「サイト更新」のコマンドが終了コード1で失敗した。\nboom\nTraceback',
  }])
})

test('runShellCommandはBotのフォルダでsh -cとして実行し、終了コードと出力を返す', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bellteam-shell-')))
  const ok = await runShellCommand({ command: 'pwd && echo err >&2', cwd: root })
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout.trim(), root)
  assert.equal(ok.stderr.trim(), 'err')
  const failed = await runShellCommand({ command: 'exit 3', cwd: root })
  assert.equal(failed.code, 3)
})
