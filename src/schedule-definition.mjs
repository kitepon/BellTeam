import { Cron } from 'croner'
import { scheduleRevision } from './schedule-mutations.mjs'

export function normalizeSchedule(value, now) {
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error('SCHEDULE_ID_INVALID')
  if (!['once', 'cron', 'interval_days', 'interval_hours'].includes(value.kind)) throw new Error('SCHEDULE_KIND_INVALID')
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  // AIへの指示（prompt）か、AIを起こさないコマンド（command）のどちらか一方だけを持つ。
  if ((prompt.length === 0) === (command.length === 0)) throw new Error('SCHEDULE_ACTION_INVALID')
  if (prompt.length > 8_000) throw new Error('SCHEDULE_PROMPT_INVALID')
  if (command.length > 8_000) throw new Error('SCHEDULE_COMMAND_INVALID')
  const enabled = value.enabled !== false
  const base = {
    id: value.id,
    name: typeof value.name === 'string' ? value.name.slice(0, 100) : '',
    kind: value.kind,
    ...(command ? { command } : { prompt }),
    enabled,
    lastRunAt: value.lastRunAt ?? null,
    ...(Object.hasOwn(value, 'revision') ? { revision: scheduleRevision(value) } : {}),
  }
  if (value.kind === 'once') {
    const date = new Date(value.at)
    if (!Number.isFinite(date.getTime())) throw new Error('SCHEDULE_AT_INVALID')
    const at = date.toISOString()
    return { ...base, at, nextRunAt: enabled ? at : null }
  }
  const timezone = value.timezone || 'Asia/Tokyo'
  if (value.kind === 'interval_days') {
    if (!Number.isSafeInteger(value.intervalDays) || value.intervalDays < 1) throw new Error('SCHEDULE_INTERVAL_DAYS_INVALID')
    const start = Date.parse(`${value.startDate}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.startDate) || !Number.isFinite(start)
      || new Date(start).toISOString().slice(0, 10) !== value.startDate) throw new Error('SCHEDULE_START_DATE_INVALID')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('SCHEDULE_TIME_INVALID')
    const schedule = { ...base, timezone, intervalDays: value.intervalDays, startDate: value.startDate, time: value.time }
    return { ...schedule, nextRunAt: enabled ? intervalDaysNext(schedule, now) : null }
  }
  if (value.kind === 'interval_hours') {
    if (!Number.isInteger(value.intervalHours) || value.intervalHours < 1 || value.intervalHours > 24) throw new Error('SCHEDULE_INTERVAL_HOURS_INVALID')
    for (const hour of [value.startHour, value.endHour]) {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('SCHEDULE_HOUR_INVALID')
    }
    const minute = value.minute ?? 0
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('SCHEDULE_MINUTE_INVALID')
    const hours = []
    const span = (value.endHour - value.startHour + 24) % 24
    for (let offset = 0; offset <= span; offset += value.intervalHours) hours.push((value.startHour + offset) % 24)
    return {
      ...base, timezone, intervalHours: value.intervalHours, startHour: value.startHour, endHour: value.endHour, minute,
      nextRunAt: enabled ? cronNext(`${minute} ${hours.join(',')} * * *`, timezone, now) : null,
    }
  }
  const expression = value.expression
  const nextRunAt = enabled ? cronNext(expression, timezone, now) : null
  return { ...base, expression, timezone, nextRunAt }
}

function intervalDaysNext(schedule, now) {
  const { time, timezone, startDate, intervalDays } = schedule
  const [hour, minute] = time.split(':').map(Number)
  const candidate = new Date(cronNext(`${minute} ${hour} * * *`, timezone, now))
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(candidate).map(part => [part.type, part.value]))
  // 暦の日数で間隔を数える。月末や夏時間をまたいでも開始日からの周期を保つ。
  const dayMs = 86_400_000
  const candidateDay = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`)
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const periods = Math.max(0, Math.ceil((candidateDay - start) / dayMs / intervalDays))
  const nextDay = new Date(start + periods * intervalDays * dayMs)
  if (!Number.isFinite(nextDay.getTime())) throw new Error('SCHEDULE_INTERVAL_DAYS_INVALID')
  return cronNext(`${nextDay.toISOString().slice(0, 10)}T${time}:00`, timezone, now)
}

function cronNext(expression, timezone, from) {
  try {
    const run = new Cron(expression, { timezone, paused: true }).nextRun(from)
    if (!run) throw new Error('no next run')
    return run.toISOString()
  } catch (error) {
    throw new Error(`SCHEDULE_EXPRESSION_INVALID: ${error.message}`)
  }
}

export function scheduleDocument(schedules) {
  return { schema: 'bellteam.schedule.v1', schedules }
}

