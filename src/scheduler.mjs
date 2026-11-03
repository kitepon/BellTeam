import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runtimeEnvironment } from './runtime-home.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'
import { scheduleRevision } from './schedule-mutations.mjs'

import { completedThroughlineTurns, NIGHTLY_RESTART_TURNS } from './throughline-context.mjs'

const MAINTENANCE_HOUR = 3
const TOKYO_TIME_ZONE = 'Asia/Tokyo'

export class BotScheduler {
  constructor({ registry, messenger, transport = null, rooms = null, roomMessenger = null, intervalMs = 15_000, completedTurns = completedThroughlineTurns, runCommand = runShellCommand, paused = () => false, assertWorkAllowed = () => {}, admitWork = null, membersAdmission = transport?.membersAdmission ?? null, moduleOperations = null }) {
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
    this.paused = paused
    this.assertWorkAllowed = assertWorkAllowed
    this.moduleOperations = moduleOperations
    this.membersAdmission = membersAdmission
    this.admitWork = admitWork ?? (() => () => this.assertWorkAllowed())
    this.unconfirmedClaims = new Map()
    this.commandJobs = new Set()
    this.currentRun = null
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
    if (this.running || this.paused()) return
    this.running = true
    let release
    this.currentRun = new Promise(resolve => { release = resolve })
    try {
      await this.restartLongSessions(now)
      await this.withOperationContext(async options => {
        await this.registry.refresh(options)
        const sources = [{ kind: 'bot', registry: this.registry }]
        if (this.rooms && this.roomMessenger) { await this.rooms.refresh(options); sources.push({ kind: 'room', registry: this.rooms }) }
        const observed = new Set()
        for (const { kind, registry } of sources) {
          for (const owner of [...registry.values()]) {
            for (const schedule of await registry.listSchedules(owner.id, options)) {
              const key = JSON.stringify([kind, owner.id, schedule.id])
              const tuple = JSON.stringify([scheduleRevision(schedule), schedule.nextRunAt])
              observed.add(key)
              if (this.unconfirmedClaims.has(key) && this.unconfirmedClaims.get(key) !== tuple) this.unconfirmedClaims.delete(key)
              if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now || this.unconfirmedClaims.has(key)) continue
              let claimed
              try {
                const check = this.admitWork()
                check()
                try {
                  claimed = await registry.claimDue({ [kind === 'bot' ? 'botId' : 'roomId']: owner.id,
                    scheduleId: schedule.id, expectedRevision: scheduleRevision(schedule), expectedNextRunAt: schedule.nextRunAt,
                    ranAt: now.toISOString() }, options)
                } catch (error) {
                  if (error.outcome !== 'not_accepted') this.unconfirmedClaims.set(key, tuple)
                  throw error
                }
                if (!claimed) continue
                check()
                if (kind === 'bot') await this.dispatchBotSchedule(owner, claimed, options)
                else await this.dispatchRoomSchedule(owner, claimed, options)
              } catch (error) {
                if (error.code === 'AI_GLOBAL_PAUSED' || error.code === 'MEMBERS_NOT_ACCEPTED') return
                // Consumption precedes dispatch; an unknown grant or dispatch is never replayed.
                reportError(error)
              }
            }
          }
        }
        for (const key of this.unconfirmedClaims.keys()) if (!observed.has(key)) this.unconfirmedClaims.delete(key)
      })
    } finally {
      this.running = false
      this.currentRun = null
      release()
    }
  }

  // Still paused: consume only schedules already overdue at this OFF request.
  // Later, newly created requests with past dates retain ordinary scheduler behavior.
  async prepareResume(at) {
    await this.currentRun
    return this.withOperationContext(async options => {
      for (const [kind, registry] of [['bot', this.registry], ['room', this.rooms]]) {
        if (!registry) continue
        await registry.refresh(options)
        for (const owner of [...registry.values()]) {
          for (const schedule of await registry.listSchedules(owner.id, options)) {
            if (schedule.enabled && schedule.nextRunAt && new Date(schedule.nextRunAt) <= at)
              await registry.skipDue({ [kind === 'bot' ? 'botId' : 'roomId']: owner.id, scheduleId: schedule.id,
                expectedRevision: scheduleRevision(schedule), expectedNextRunAt: schedule.nextRunAt, ranAt: at.toISOString() }, options)
          }
        }
      }
    })
  }

  withOperationContext(operation, context) {
    if (this.moduleOperations) return this.moduleOperations.withContext(operation, context)
    if (!this.membersAdmission) return operation(context ?? {})
    return this.membersAdmission.withLease(lease => operation({ membersLease: lease }), { lease: context?.membersLease })
  }

  async dispatchBotSchedule(bot, schedule, options = {}) {
    this.assertWorkAllowed()
    if (schedule.command) {
      // AIを起こす必要のない予定はAIを起こさない（オーナー裁定 2026-09-04）。完了を待たず、失敗だけをユーザーへ知らせる。
      this.runCommandSchedule(bot, schedule).catch(reportError)
      return
    }
    await this.messenger.sendmessage({
      from: 'scheduler',
      target: bot.id,
      message: `[BellTeam schedule ${schedule.id}] ${schedule.prompt}`,
    }, options)
  }

  runCommandSchedule(bot, schedule) {
    this.assertWorkAllowed()
    const job = { controller: new AbortController() }
    this.commandJobs.add(job)
    const operation = this.performCommandSchedule(bot, schedule, job)
    job.completion = operation
    operation.then(() => this.commandJobs.delete(job), () => this.commandJobs.delete(job))
    return operation
  }

  async performCommandSchedule(bot, schedule, job) {
    let result
    try {
      result = await this.runCommand({ command: schedule.command, cwd: bot.project, signal: job.controller.signal })
    } catch (error) {
      result = { code: null, signal: null, stdout: '', stderr: error.message }
    }
    if (job.controller.signal.aborted || result.code === 0) return result
    const outcome = result.code === null ? `シグナル${result.signal ?? '不明'}` : `終了コード${result.code}`
    const tail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n')
    await this.messenger.sendmessage({
      from: bot.id,
      target: 'user',
      message: `[BellTeam schedule ${schedule.id}] 予定「${schedule.name || schedule.command}」のコマンドが${outcome}で失敗した。\n${tail}`,
    })
    return result
  }

  async interruptCommands() {
    const jobs = [...this.commandJobs]
    for (const job of jobs) job.controller.abort()
    const results = await Promise.allSettled(jobs.map(job => job.completion))
    return results.every(result => result.status === 'fulfilled' && result.value?.stopConfirmed === true)
  }

  async dispatchRoomSchedule(room, schedule, options = {}) {
    this.assertWorkAllowed()
    await this.roomMessenger.sendroommessage({
      from: 'scheduler', room: room.id, message: schedule.prompt, targets: schedule.targets,
      kind: 'schedule', schedule: { id: schedule.id, name: schedule.name },
    }, options)
  }

  // 手動の「今すぐ実行」。予定の次回時刻と有効状態は動かさない。
  async runBotSchedule(botId, scheduleId, options) {
    return this.withOperationContext(async options => {
      await this.registry.refresh(options)
      const bot = this.registry.get(botId)
      if (!bot) throw new Error(`BOT_NOT_FOUND: ${botId}`)
      const schedule = (await this.registry.listSchedules(botId, options)).find(item => item.id === scheduleId)
      if (!schedule) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
      await this.dispatchBotSchedule(bot, schedule, options)
      return { id: schedule.id }
    }, options)
  }

  async runRoomSchedule(roomId, scheduleId, options) {
    return this.withOperationContext(async options => {
      await this.rooms.refresh(options)
      const room = this.rooms.get(roomId)
      if (!room) throw new Error(`ROOM_NOT_FOUND: ${roomId}`)
      const schedule = (await this.rooms.listSchedules(roomId, options)).find(item => item.id === scheduleId)
      if (!schedule) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
      await this.dispatchRoomSchedule(room, schedule, options)
      return { id: schedule.id }
    }, options)
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

export async function runShellCommand({ command, cwd, signal: commandSignal }, options = {}) {
  const signal = commandSignal ?? options.signal
  if (signal?.aborted) return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', stopConfirmed: true }
  if (Object.hasOwn(options, 'seatProject')) {
    if (options.seatProject !== cwd) throw Object.assign(new Error('SEAT_PROJECT_MISMATCH'), { code: 'SEAT_PROJECT_MISMATCH' })
    return createSeatProcessRunner(options.seatProject)('sh', ['-c', command], { signal, acceptNonzero: true })
  }
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32'
    // Environment loading belongs to the same cancellable process group as the command.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run-command.mjs', import.meta.url)), command], {
      cwd, env: runtimeEnvironment(), detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let cancellation = null
    const alive = () => {
      try { process.kill(grouped ? -child.pid : child.pid, 0); return true }
      catch (error) { return error.code !== 'ESRCH' }
    }
    const send = kind => {
      try { if (grouped) process.kill(-child.pid, kind); else child.kill(kind) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const cancel = () => {
      if (cancellation) return
      cancellation = (async () => {
        if (!child.pid) return false
        send('SIGTERM')
        await new Promise(r => setTimeout(r, 250))
        if (alive()) send('SIGKILL')
        for (let i = 0; i < 50 && alive(); i++) await new Promise(r => setTimeout(r, 20))
        return grouped && !alive()
      })().catch(() => false)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => { signal?.removeEventListener('abort', cancel); reject(error) })
    child.once('close', async (code, exitSignal) => {
      signal?.removeEventListener('abort', cancel)
      resolve({ code, signal: exitSignal, stdout, stderr, ...(cancellation ? { stopConfirmed: await cancellation } : {}) })
    })
  })
}

function reportError(error) {
  process.stderr.write(`BellTeam scheduler error: ${error.stack ?? error.message}\n`)
}
