import { spawn } from 'node:child_process'
import { loadBotEnvironment } from './bot-environment.mjs'

import { completedThroughlineTurns, NIGHTLY_RESTART_TURNS } from './aiterm-transport.mjs'

const MAINTENANCE_HOUR = 3
const TOKYO_TIME_ZONE = 'Asia/Tokyo'

export class BotScheduler {
  constructor({ registry, messenger, transport = null, rooms = null, roomMessenger = null, intervalMs = 15_000, completedTurns = completedThroughlineTurns, runCommand = runShellCommand }) {
    this.registry = registry
    this.messenger = messenger
    this.runCommand = runCommand
    this.transport = transport
    this.intervalMs = intervalMs
    this.rooms = rooms
    this.roomMessenger = roomMessenger
    this.timer = null
    this.running = false
    this.completedTurns = completedTurns
    this.maintenanceDate = null
  }

  start() {
    if (this.timer) return
    this.runDue().catch(reportError)
    this.timer = setInterval(() => this.runDue().catch(reportError), this.intervalMs)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  async runDue(now = new Date()) {
    if (this.running) return
    this.running = true
    try {
      await this.registry.refresh()
      await this.restartLongSessions(now)
      for (const bot of this.registry.values()) {
        for (const schedule of await this.registry.listSchedules(bot.id)) {
          if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) continue
          await this.dispatchBotSchedule(bot, schedule)
          await this.registry.markScheduleRun(bot.id, schedule.id, now)
        }
      }
      if (this.rooms && this.roomMessenger) {
        await this.rooms.refresh()
        for (const room of this.rooms.values()) {
          for (const schedule of await this.rooms.listSchedules(room.id)) {
            if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) continue
            await this.dispatchRoomSchedule(room, schedule)
            await this.rooms.markScheduleRun(room.id, schedule.id, now)
          }
        }
      }
    } finally {
      this.running = false
    }
  }

  async dispatchBotSchedule(bot, schedule) {
    if (schedule.command) {
      // AIを起こす必要のない予定はAIを起こさない（オーナー裁定 2026-09-04）。完了を待たず、失敗だけをユーザーへ知らせる。
      this.runCommandSchedule(bot, schedule).catch(reportError)
      return
    }
    await this.messenger.sendmessage({
      from: 'scheduler',
      target: bot.id,
      message: `[BellTeam schedule ${schedule.id}] ${schedule.prompt}`,
    })
  }

  async runCommandSchedule(bot, schedule) {
    let result
    try {
      result = await this.runCommand({ command: schedule.command, cwd: bot.project })
    } catch (error) {
      result = { code: null, signal: null, stdout: '', stderr: error.message }
    }
    if (result.code === 0) return
    const outcome = result.code === null ? `シグナル${result.signal ?? '不明'}` : `終了コード${result.code}`
    const tail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n')
    await this.messenger.sendmessage({
      from: bot.id,
      target: 'user',
      message: `[BellTeam schedule ${schedule.id}] 予定「${schedule.name || schedule.command}」のコマンドが${outcome}で失敗した。\n${tail}`,
    })
  }

  async dispatchRoomSchedule(room, schedule) {
    await this.roomMessenger.sendroommessage({
      from: 'scheduler', room: room.id, message: schedule.prompt, targets: schedule.targets,
      kind: 'schedule', schedule: { id: schedule.id, name: schedule.name },
    })
  }

  // 手動の「今すぐ実行」。予定の次回時刻と有効状態は動かさない。
  async runBotSchedule(botId, scheduleId) {
    await this.registry.refresh()
    const bot = this.registry.get(botId)
    if (!bot) throw new Error(`BOT_NOT_FOUND: ${botId}`)
    const schedule = (await this.registry.listSchedules(botId)).find(item => item.id === scheduleId)
    if (!schedule) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
    await this.dispatchBotSchedule(bot, schedule)
    return { id: schedule.id }
  }

  async runRoomSchedule(roomId, scheduleId) {
    await this.rooms.refresh()
    const room = this.rooms.get(roomId)
    if (!room) throw new Error(`ROOM_NOT_FOUND: ${roomId}`)
    const schedule = (await this.rooms.listSchedules(roomId)).find(item => item.id === scheduleId)
    if (!schedule) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
    await this.dispatchRoomSchedule(room, schedule)
    return { id: schedule.id }
  }

  async restartLongSessions(now) {
    const maintenanceDate = tokyoMaintenanceDate(now)
    if (!this.transport || !maintenanceDate || maintenanceDate === this.maintenanceDate) return
    this.maintenanceDate = maintenanceDate
    const results = await Promise.allSettled(
      [...this.registry.values()].map(bot => this.restartLongSession(bot)),
    )
    for (const result of results) {
      if (result.status === 'rejected') reportError(result.reason)
    }
  }

  async restartLongSession(bot) {
    if (!this.transport.isIdle(bot.id) || !await this.transport.isRunning(bot)) return
    if (await this.completedTurns(bot.project) < NIGHTLY_RESTART_TURNS) return
    await this.transport.restartIfIdle(bot)
  }
}

export function tokyoMaintenanceDate(now) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]))
  if (Number(values.hour) !== MAINTENANCE_HOUR || Number(values.minute) !== 0) return null
  return `${values.year}-${values.month}-${values.day}`
}

export async function runShellCommand({ command, cwd }) {
  const env = await loadBotEnvironment(cwd)
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function reportError(error) {
  process.stderr.write(`BellTeam scheduler error: ${error.stack ?? error.message}\n`)
}
