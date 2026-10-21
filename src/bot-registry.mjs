import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Cron } from 'croner'

import { loadBots } from './bots.mjs'
import { CHARACTER_SHEET_DIRECTORY } from './character-sheets.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'

const BOT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const COLORS = new Set(['rose', 'indigo', 'violet'])
const HARNESSES = new Set(['claude', 'codex', 'grok', 'cursor'])
const PROFILE_FIELDS = new Set(['name', 'harness', 'model', 'reasoningEffort', 'fastMode', 'profileText', 'personality', 'speechStyle', 'position', 'role', 'avatar', 'color'])
const exec = promisify(execFile)

export class BotRegistry extends Map {
  constructor(options) {
    const { seedPath, botsRoot, now = () => new Date(), id = randomUUID, botId = () => `bot-${randomUUID().slice(0, 8)}`, onChange = async () => {}, models = new LiveModelCatalog() } = options
    const stateRoot = Object.hasOwn(options, 'stateRoot') ? options.stateRoot : botsRoot
    super()
    this.seedPath = seedPath
    this.botsRoot = botsRoot
    if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || stateRoot.includes('\0'))
      throw Object.assign(new Error('BOT_STATE_ROOT_INVALID'), { code: 'BOT_STATE_ROOT_INVALID' })
    this.stateRoot = resolve(stateRoot)
    this.separateState = this.stateRoot !== resolve(botsRoot)
    const inside = relative(resolve(botsRoot), this.stateRoot)
    const enclosing = relative(this.stateRoot, resolve(botsRoot))
    if (this.separateState && (inside !== '..' && !inside.startsWith('../')
      || enclosing !== '..' && !enclosing.startsWith('../')))
      throw Object.assign(new Error('BOT_STATE_ROOT_INVALID'), { code: 'BOT_STATE_ROOT_INVALID' })
    this.now = now
    this.id = id
    this.botId = botId
    this.onChange = onChange
    this.models = models
    this.watchers = new Set()
  }

  // 一覧と設定の変更を、同じprocessの購読者へ知らせる（アプリが一覧を読み直すための知らせに使う）。
  watch(onChange) {
    this.watchers.add(onChange)
    return () => this.watchers.delete(onChange)
  }

  changed() {
    for (const watcher of this.watchers) watcher()
  }

  async initialize() {
    await mkdir(this.botsRoot, { recursive: true })
    const initialized = join(this.stateRoot, '.initialized')
    if (this.separateState && !await exists(initialized)) {
      // Existing seat records must be migrated explicitly, never silently
      // reseeded from config or adopted while a split migration is incomplete.
      for (const entry of await readdir(this.botsRoot, { withFileTypes: true })) {
        const legacy = entry.name === '.initialized' || entry.isDirectory() && BOT_ID.test(entry.name)
          && await exists(join(this.botsRoot, entry.name, 'bot.json'))
        if (legacy) throw Object.assign(new Error('BOT_STATE_MIGRATION_REQUIRED'), { code: 'BOT_STATE_MIGRATION_REQUIRED' })
      }
    }
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
    if (!await exists(initialized)) {
      const seeds = await loadBots(this.seedPath)
      for (const seed of seeds.values()) {
        const project = this.projectPath(seed.id)
        await ensureProjectFolders(project)
        await ensureGitProject(project)
        const profilePath = join(this.statePath(seed.id), 'bot.json')
        if (!await exists(profilePath)) await this.writeProfile(normalizeProfile({ ...seed, project }))
        const schedulePath = join(this.statePath(seed.id), 'schedule.json')
        if (!await exists(schedulePath)) await writeAtomic(schedulePath, scheduleDocument([]))
        const profile = await this.readProfile(seed.id)
        await this.writeInstructions(profile)
      }
      await writeFile(initialized, '', { mode: 0o600 })
    }
    await this.migrateProfiles()
    await this.refresh()
    await Promise.all([...this.values()].map(profile => this.writeInstructions(profile)))
    return this.refresh()
  }

  async refresh() {
    const profiles = []
    for (const entry of await readdir(this.stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !BOT_ID.test(entry.name)) continue
      const path = join(this.stateRoot, entry.name, 'bot.json')
      if (!await exists(path)) continue
      profiles.push(await this.readProfile(entry.name))
    }
    profiles.sort((a, b) => a.id.localeCompare(b.id))
    this.clear()
    for (const profile of profiles) this.set(profile.id, Object.freeze(profile))
    return this
  }

  projectPath(id) {
    validateId(id)
    return join(this.botsRoot, id)
  }

  statePath(id) {
    validateId(id)
    return join(this.stateRoot, id)
  }

  async create(input, { id = this.botId() } = {}) {
    await this.refresh()
    validateId(id)
    if (this.has(id)) throw new Error(`BOT_DUPLICATE: ${id}`)
    const project = this.projectPath(id)
    const profile = normalizeProfile({
      id,
      name: input.name,
      harness: input.harness ?? 'grok',
      model: input.model ?? '',
      reasoningEffort: input.reasoningEffort ?? '',
      fastMode: input.fastMode ?? false,
      color: input.color ?? 'violet',
      profileText: input.profileText ?? '',
      personality: input.personality ?? '',
      speechStyle: input.speechStyle ?? '',
      position: input.position ?? '',
      role: input.role ?? '',
      avatar: input.avatar ?? '',
      session: id,
      project,
    })
    await this.validateEffort(profile)
    await this.validateFastMode(profile)
    await ensureProjectFolders(project)
    await ensureGitProject(project)
    await this.writeProfile(profile)
    await writeAtomic(join(this.statePath(id), 'schedule.json'), scheduleDocument([]))
    await this.writeInstructions(profile)
    await this.refresh()
    await this.onChange(this)
    this.changed()
    return this.get(id)
  }

  async update(id, changes) {
    const profile = await this.previewUpdate(id, changes)
    await this.writeProfile(profile)
    await this.writeInstructions(profile)
    await this.refresh()
    this.changed()
    return this.get(id)
  }

  async updateSession(id, session) {
    await this.refresh()
    const current = this.get(id)
    if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
    const profile = normalizeProfile({ ...current, session })
    await this.writeProfile(profile)
    await this.refresh()
    return this.get(id)
  }

  async previewUpdate(id, changes) {
    await this.refresh()
    const current = this.get(id)
    if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('BOT_UPDATE_INVALID')
    for (const key of Object.keys(changes)) {
      if (!PROFILE_FIELDS.has(key)) throw new Error(`BOT_UPDATE_FIELD_INVALID: ${key}`)
    }
    let profile = normalizeProfile({ ...current, ...changes })
    if (['harness', 'model', 'reasoningEffort'].some(field => profile[field] !== current[field]))
      await this.validateEffort(profile)
    if (profile.fastMode && ['harness', 'model', 'fastMode'].some(field => profile[field] !== current[field])) {
      const problem = await this.fastModeProblem(profile)
      // 有効を指定した保存は断る。CLIやモデルだけを替えた先が切り替えられない時は、Claude Codeの動きと同じく無効へ戻す。
      if (problem && Object.hasOwn(changes, 'fastMode')) throw fastModeError(problem)
      if (problem) profile = { ...profile, fastMode: false }
    }
    return Object.freeze(profile)
  }

  async validateEffort(profile) {
    if (!profile.reasoningEffort) return
    const catalog = await this.models.forHarness(profile.harness)
    if (!catalog.efforts.includes(profile.reasoningEffort)) throw new Error('BOT_REASONING_EFFORT_INVALID')
  }

  // ファストモードの切り替え方はAitermが所有する。BellTeamは、Aitermの一覧がそのモデルで切り替えられると返す時だけ有効を保存する。
  // 一覧に無いモデル（別名など）は、適用する時のAitermの判定に任せる。
  async validateFastMode(profile) {
    const problem = profile.fastMode ? await this.fastModeProblem(profile) : null
    if (problem) throw fastModeError(problem)
  }

  async fastModeProblem(profile) {
    const catalog = await this.models.forHarness(profile.harness)
    const models = catalog.models ?? []
    if (!models.some(model => typeof model.fast === 'boolean')) return { code: 'BOT_FAST_MODE_UNAVAILABLE' }
    // アカウントの都合（Claudeの別払いが無効など）で使えない時は、Aitermが返した理由を添えて断る。
    if (catalog.fastUnavailable) return { code: 'BOT_FAST_MODE_ACCOUNT_UNAVAILABLE', detail: catalog.fastUnavailable.message }
    const model = models.find(candidate => candidate.id === (profile.model || catalog.defaultModel))
    return model && model.fast !== true ? { code: 'BOT_FAST_MODE_UNSUPPORTED' } : null
  }

  async remove(id) {
    await this.refresh()
    const bot = this.get(id)
    if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
    await rm(bot.project, { recursive: true, force: true })
    if (this.separateState) await rm(this.statePath(id), { recursive: true, force: true })
    await this.refresh()
    await this.onChange(this)
    this.changed()
    return { id }
  }

  async listSchedules(id) {
    if (!this.has(id)) throw new Error(`BOT_NOT_FOUND: ${id}`)
    const document = await this.readScheduleDocument(id)
    return document.schedules
  }

  async setSchedule(id, input) {
    await this.refresh()
    if (!this.has(id)) throw new Error(`BOT_NOT_FOUND: ${id}`)
    const document = await this.readScheduleDocument(id)
    const existing = input.id ? document.schedules.find(item => item.id === input.id) : null
    if (input.id && !existing) throw new Error(`SCHEDULE_NOT_FOUND: ${input.id}`)
    const schedule = normalizeSchedule({
      ...input,
      id: input.id ?? this.id(),
      lastRunAt: null,
    }, this.now())
    const schedules = existing
      ? document.schedules.map(item => item.id === schedule.id ? schedule : item)
      : [...document.schedules, schedule]
    await this.writeScheduleDocument(id, schedules)
    return schedule
  }

  async removeSchedule(id, scheduleId) {
    const schedules = await this.listSchedules(id)
    if (!schedules.some(item => item.id === scheduleId)) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
    await this.writeScheduleDocument(id, schedules.filter(item => item.id !== scheduleId))
    return true
  }

  async markScheduleRun(id, scheduleId, ranAt) {
    const schedules = await this.listSchedules(id)
    const current = schedules.find(item => item.id === scheduleId)
    if (!current) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
    const timestamp = new Date(ranAt).toISOString()
    const updated = normalizeSchedule({
      ...current,
      enabled: current.kind === 'once' ? false : current.enabled,
      lastRunAt: timestamp,
    }, new Date(timestamp))
    await this.writeScheduleDocument(id, schedules.map(item => item.id === scheduleId ? updated : item))
    return updated
  }

  async readProfile(id) {
    const value = JSON.parse(await readFile(join(this.statePath(id), 'bot.json'), 'utf8'))
    if (!['bellteam.bot.v1', 'bellteam.bot.v2', 'bellteam.bot.v3', 'bellteam.bot.v4', 'bellteam.bot.v5', 'bellteam.bot.v6', 'bellteam.bot.v7', 'bellteam.bot.v8'].includes(value?.schema)) throw new Error(`BOT_PROFILE_INVALID: ${id}`)
    return normalizeProfile({ ...value, id, project: this.projectPath(id) })
  }

  async writeProfile(profile) {
    const value = {
      schema: 'bellteam.bot.v8', id: profile.id, session: profile.session,
      name: profile.name, position: profile.position, role: profile.role,
      profileText: profile.profileText, personality: profile.personality, speechStyle: profile.speechStyle, avatar: profile.avatar, color: profile.color,
      harness: profile.harness, model: profile.model, reasoningEffort: profile.reasoningEffort, fastMode: profile.fastMode,
    }
    await mkdir(this.statePath(profile.id), { recursive: true, mode: 0o700 })
    await writeAtomic(join(this.statePath(profile.id), 'bot.json'), value)
  }

  async writeInstructions(profile) {
    const memoryPath = join(profile.project, 'memory', 'previous-session.md')
    const shortTermMemory = await exists(memoryPath) ? (await readFile(memoryPath, 'utf8')).trim() : ''
    const body = `# 自分のBot情報\n\nあなたのBellTeam Bot IDは \`${profile.id}\` である。\n\n## 名前\n\n「${profile.name}」\n\n## プロフィール\n\n「${profile.profileText || '指定なし'}」\n\n## 性格（考え方）\n\n「${profile.personality || '指定なし'}」\n\n## 口調\n\n「${profile.speechStyle || '指定なし'}」\n\n## 役職\n\n「${profile.position || '指定なし'}」\n\n## 役割\n\n「${profile.role || '指定なし'}」\n\n# 作業手順\n\n上の役割は、あなた自身が責任を持って進める担当の仕事である。役割欄は担当を短く記し、具体的な作業手順はここへ混ぜない。作業手順の詳細はこのプロジェクトの \`docs/\` に自分で置き、着手前に読む。\n\n# 前セッションの短期記憶\n\n${shortTermMemory || 'なし'}\n`
    await Promise.all([
      writeFile(join(profile.project, 'AGENTS.md'), body, { mode: 0o644 }),
      writeFile(join(profile.project, 'CLAUDE.md'), '@AGENTS.md\n', { mode: 0o644 }),
    ])
  }

  async prepareStartupContext(id, shortTermMemory) {
    await this.refresh()
    const profile = this.get(id)
    if (!profile) throw new Error(`BOT_NOT_FOUND: ${id}`)
    const directory = join(profile.project, 'memory')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'previous-session.md'), `${shortTermMemory.trim()}\n`, { mode: 0o600 })
    await this.writeInstructions(profile)
  }

  async migrateProfiles() {
    for (const entry of await readdir(this.stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !BOT_ID.test(entry.name)) continue
      const path = join(this.stateRoot, entry.name, 'bot.json')
      if (!await exists(path)) continue
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (value?.schema === 'bellteam.bot.v8' && !Object.hasOwn(value, 'title')) continue
      const profile = normalizeProfile({ ...value, id: entry.name, project: this.projectPath(entry.name) })
      await this.writeProfile(profile)
      await this.writeInstructions(profile)
    }
  }

  async readScheduleDocument(id) {
    const path = join(this.statePath(id), 'schedule.json')
    if (!await exists(path)) await writeAtomic(path, scheduleDocument([]))
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value?.schema !== 'bellteam.schedule.v1' || !Array.isArray(value.schedules))
      throw new Error(`SCHEDULE_FILE_INVALID: ${id}`)
    return value
  }

  async writeScheduleDocument(id, schedules) {
    await writeAtomic(join(this.statePath(id), 'schedule.json'), scheduleDocument(schedules))
  }
}

function fastModeError({ code, detail }) {
  return Object.assign(new Error(code), detail ? { detail } : {})
}

function normalizeProfile(value) {
  validateId(value.id)
  const legacy = legacyIdentity(value.displayName)
  const name = typeof value.name === 'string' ? value.name.trim() : legacy.name
  const position = typeof value.position === 'string' ? value.position.trim() : ''
  const role = typeof value.role === 'string' && value.role.length > 0 ? value.role : legacy.role
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  const session = typeof value.session === 'string' && value.session.trim() ? value.session.trim() : value.id
  if (!name || name.length > 100) throw new Error('BOT_NAME_INVALID')
  if (position.length > 100) throw new Error('BOT_POSITION_INVALID')
  if (!HARNESSES.has(value.harness)) throw new Error(`BOT_HARNESS_INVALID: ${value.id}`)
  if (model && !MODEL_ID.test(model)) throw new Error('BOT_MODEL_INVALID')
  if (value.harness === 'cursor' && reasoningEffort && !model) throw new Error('BOT_CURSOR_MODEL_REQUIRED_FOR_EFFORT')
  // 既定はファストモードを使わない（オーナー裁定 2026-10-12）。保存が無いプロフィールは false として読む。
  if (value.fastMode !== undefined && typeof value.fastMode !== 'boolean') throw new Error('BOT_FAST_MODE_INVALID')
  if (!COLORS.has(value.color ?? 'violet')) throw new Error('BOT_COLOR_INVALID')
  for (const [field, content] of [['profileText', value.profileText ?? ''], ['personality', value.personality ?? ''], ['speechStyle', value.speechStyle ?? ''], ['role', role]]) {
    if (typeof content !== 'string' || content.length > 8_000)
      throw new Error(`BOT_${field.toUpperCase()}_INVALID`)
  }
  validateAvatar(value.avatar ?? '')
  return {
    id: value.id,
    name,
    displayName: position ? `${name} ${position}` : name,
    harness: value.harness,
    model,
    reasoningEffort,
    fastMode: value.fastMode === true,
    color: value.color ?? 'violet',
    profileText: value.profileText ?? '',
    personality: value.personality ?? '',
    speechStyle: value.speechStyle ?? '',
    position,
    role,
    avatar: value.avatar ?? '',
    session,
    project: value.project,
  }
}

// Botプロジェクトの固定フォルダ: 手順書のdocs/、環境構築のenvironment/、キャラクターシート（設定画）のassets/character-sheet/。
async function ensureProjectFolders(project) {
  for (const folder of ['docs', 'environment', CHARACTER_SHEET_DIRECTORY]) await mkdir(join(project, folder), { recursive: true })
}

function legacyIdentity(displayName) {
  if (typeof displayName !== 'string') return { name: '', role: '' }
  const match = displayName.trim().match(/^(.*?)【(.+)】$/u)
  return match ? { role: match[1], name: match[2] } : { role: '', name: displayName.trim() }
}

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

function validateId(id) {
  if (typeof id !== 'string' || !BOT_ID.test(id)) throw new Error('BOT_ID_INVALID')
}

export function validateAvatar(value, code = 'BOT_AVATAR_INVALID') {
  if (typeof value !== 'string' || value.length > 3_000_000) throw new Error(code)
  if (value === '') return
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/iu.test(value)) return
  throw new Error(code)
}

export function scheduleDocument(schedules) {
  return { schema: 'bellteam.schedule.v1', schedules }
}

export async function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function ensureGitProject(project) {
  try {
    await access(join(project, '.git'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await exec('git', ['init', '-q'], { cwd: project })
  }
}
