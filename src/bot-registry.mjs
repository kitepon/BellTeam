import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { normalizeSchedule, scheduleDocument, validateScheduleTurn } from './schedule-definition.mjs'
import { validateAvatar } from './avatar-value.mjs'
import { exists, writeAtomic } from './json-file.mjs'
export { normalizeSchedule, scheduleDocument } from './schedule-definition.mjs'
export { validateAvatar } from './avatar-value.mjs'
export { exists, writeAtomic } from './json-file.mjs'

import { loadBots } from './bots.mjs'
import { ProjectFiles } from './project-files.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { mutateSchedules, nextScheduleRevision, scheduleRevision } from './schedule-mutations.mjs'

const BOT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,199}$/u
const COLORS = new Set(['rose', 'indigo', 'violet'])
const HARNESSES = new Set(['claude', 'codex', 'grok', 'cursor', 'antigravity'])
const PROFILE_FIELDS = new Set(['name', 'harness', 'model', 'reasoningEffort', 'fastMode', 'profileText', 'personality', 'speechStyle', 'position', 'role', 'avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource', 'avatarCrop', 'avatarLargeCrop', 'color', 'terminalId', 'projectRoot'])
const TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const WINDOWS_ROOT = /^[A-Za-z]:\\/u

export class BotRegistry extends Map {
  #profileMutations = new Map()
  #refreshQueue = Promise.resolve()
  #profileCache = new Map()
  #previewBases = new WeakMap()
  #instructionWrites = new Map()
  #removalOperations = new Map()

  constructor(options) {
    const { seedPath, botsRoot, now = () => new Date(), id = randomUUID, botId = () => `bot-${randomUUID().slice(0, 8)}`, onChange = async () => {}, models = new LiveModelCatalog(), projectFiles = new ProjectFiles() } = options
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
    this.projectFiles = projectFiles
    this.currentTurn = options.currentTurn ?? (() => ({ state: 'idle', turnId: null }))
    this.assetRemoval = options.assetRemoval ?? null
    // S5 (remote-seat.md): members effects; null answers mean no terminals core, so no default and no check.
    this.terminals = options.terminals ?? { read: async () => null, folder: async () => null }
    this.watchers = new Set()
    this.deletionIntents = new Set()
  }

  // 一覧と設定の変更を、同じprocessの購読者へ知らせる（アプリが一覧を読み直すための知らせに使う）。
  watch(onChange) {
    this.watchers.add(onChange)
    return () => this.watchers.delete(onChange)
  }

  changed(id = null, topic = 'bots') {
    for (const watcher of this.watchers) watcher({ all: topic !== 'schedules', topics: [topic], botIds: id ? [id] : [], roomIds: [] })
  }

  async initialize() {
    await this.projectFiles.ensureRoot(this.botsRoot)
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
        await this.projectFiles.initialize(project)
        const profilePath = join(this.statePath(seed.id), 'bot.json')
        if (!await exists(profilePath)) await this.writeProfile(normalizeProfile({ ...seed, project }))
        const schedulePath = join(this.statePath(seed.id), 'schedule.json')
        if (!await exists(schedulePath)) await writeAtomic(schedulePath, scheduleDocument([]))
        const profile = await this.readProfile(seed.id)
        await this.writeInstructions(profile)
      }
      await writeFile(initialized, '', { mode: 0o600 })
    }
    if (this.separateState) await this.resumePendingRemovals()
    await this.migrateProfiles()
    await this.refresh()
    await Promise.all([...this.values()].map(profile => this.writeInstructions(profile)))
    return this.refresh()
  }

  // Swap readiness validates current state without bootstrap effects or repair.
  async restore() {
    if (!await exists(join(this.stateRoot, '.initialized'))) throw registryError('BOT_STATE_UNINITIALIZED')
    const entries = await readdir(this.stateRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !BOT_ID.test(entry.name)) continue
      const value = JSON.parse(await readFile(join(this.statePath(entry.name), 'bot.json'), 'utf8'))
      if (value?.schema !== 'bellteam.bot.v8' || value.id !== entry.name || Object.hasOwn(value, 'title'))
        throw registryError('BOT_PROFILE_INVALID')
      normalizeProfile({ ...value, project: this.projectPath(entry.name) })
      const document = JSON.parse(await readFile(join(this.statePath(entry.name), 'schedule.json'), 'utf8'))
      if (document?.schema !== 'bellteam.schedule.v1' || !Array.isArray(document.schedules))
        throw registryError('SCHEDULE_FILE_INVALID')
      for (const schedule of document.schedules) {
        scheduleRevision(schedule)
        normalizeSchedule(schedule, this.now())
      }
    }
    await this.refresh()
    await this.readRemovalStates()
    await this.listForClient()
    return this
  }

  refresh() {
    const result = this.#refreshQueue.then(() => this.#readProfiles())
    this.#refreshQueue = result.catch(() => {})
    return result
  }

  async #readProfiles() {
    const profiles = []
    const entries = (await readdir(this.stateRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && BOT_ID.test(entry.name))
    const identity = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
    const observed = await Promise.all(entries.map(async entry => {
      const path = join(this.stateRoot, entry.name, 'bot.json')
      try { return { id: entry.name, path, key: identity(await stat(path, { bigint: true })) } }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    }))
    // Large avatars stay in one parsed profile; only file metadata is read in parallel.
    for (const item of observed.filter(Boolean)) {
      const cached = this.#profileCache.get(item.id)
      if (cached?.key === item.key) { profiles.push(cached.profile); continue }
      const profile = await this.readProfile(item.id)
      if (identity(await stat(item.path, { bigint: true })) === item.key) this.#profileCache.set(item.id, { key: item.key, profile })
      else this.#profileCache.delete(item.id)
      profiles.push(profile)
    }
    const present = new Set(profiles.map(profile => profile.id))
    for (const id of this.#profileCache.keys()) if (!present.has(id)) this.#profileCache.delete(id)
    profiles.sort((a, b) => a.id.localeCompare(b.id))
    this.clear()
    for (const profile of profiles) {
      if (!this.deletionIntents.has(profile.id)) this.set(profile.id, Object.freeze(profile))
    }
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

  async create(input, { id = this.botId(), saved = {} } = {}) {
    await this.refresh()
    validateId(id)
    if (this.has(id)) throw new Error(`BOT_DUPLICATE: ${id}`)
    const createFolder = input.createFolder === true
    input = await this.#bindTerminal(input)
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
      avatarLarge: input.avatarLarge ?? '',
      avatarSource: input.avatarSource ?? '',
      avatarLargeSource: input.avatarLargeSource ?? '',
      avatarCrop: input.avatarCrop ?? null,
      avatarLargeCrop: input.avatarLargeCrop ?? null,
      terminalId: input.terminalId ?? '',
      projectRoot: input.projectRoot ?? '',
      session: id,
      project,
    })
    await this.validateEffort(profile)
    await this.validateFastMode(profile)
    if (this.separateState && (await pathExists(join(this.stateRoot, '.deleting', id))
      || await pathExists(join(this.stateRoot, '.deleting', `${id}.json`))))
      throw registryError('BOT_DELETE_PENDING')
    // After every input check, before any write: the only remote mutation (make_dir) needs a valid save.
    if (profile.terminalId) await this.#checkFolder(profile, createFolder, saved)
    if (this.separateState) {
      // Claim a fresh project atomically; never adopt an orphan, file or symlink.
      await this.projectFiles.claim(project)
    }
    await this.projectFiles.initialize(project)
    await this.writeProfile(profile)
    await writeAtomic(join(this.statePath(id), 'schedule.json'), scheduleDocument([]))
    await this.writeInstructions(profile)
    await this.refresh()
    await this.onChange(this)
    this.changed(id)
    return this.get(id)
  }

  async update(id, changes, saved = {}) {
    const candidate = await this.previewUpdate(id, changes)
    const before = this.#previewBases.get(candidate), createFolder = changes.createFolder === true
    if (candidate.terminalId && (createFolder || candidate.terminalId !== before.terminalId || candidate.projectRoot !== before.projectRoot))
      await this.#checkFolder(candidate, createFolder, saved)
    await this.#mutateProfile(id, async () => {
      await this.refresh()
      const current = this.get(id), base = this.#previewBases.get(candidate)
      if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
      if (Object.keys(base).some(key => key !== 'session' && JSON.stringify(base[key]) !== JSON.stringify(current[key])))
        throw Object.assign(registryError('BOT_UPDATE_CONFLICT'), { status: 409 })
      const profile = normalizeProfile({ ...candidate, session: current.session })
      await this.writeProfile(profile)
      await this.refresh()
    })
    const previous = this.#instructionWrites.get(id) ?? Promise.resolve()
    const writing = previous.catch(() => {}).then(async () => {
      await this.refresh()
      const current = this.get(id)
      if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
      await this.writeInstructions(current)
    })
    this.#instructionWrites.set(id, writing)
    try { await writing } finally { if (this.#instructionWrites.get(id) === writing) this.#instructionWrites.delete(id) }
    await this.refresh()
    this.changed(id)
    const updated = this.get(id)
    if (!updated) throw Object.assign(registryError('BOT_UPDATE_RETIRED'), { status: 409, outcome: 'unknown' })
    return updated
  }

  async updateFastMode(id, fastMode) {
    if (typeof fastMode !== 'boolean') throw registryError('BOT_FAST_MODE_INVALID')
    return this.#mutateProfile(id, async () => {
      await this.refresh()
      const current = this.get(id)
      if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
      await this.writeProfile(normalizeProfile({ ...current, fastMode }))
      await this.refresh()
      return this.get(id)
    })
  }

  async updateSession(id, session) {
    return this.#mutateProfile(id, async () => {
      await this.refresh()
      const current = this.get(id)
      if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
      const profile = normalizeProfile({ ...current, session })
      await this.writeProfile(profile)
      await this.refresh()
      return this.get(id)
    })
  }

  async #mutateProfile(id, change) {
    const previous = this.#profileMutations.get(id)
    let release
    const current = new Promise(resolve => { release = resolve })
    this.#profileMutations.set(id, current)
    await previous
    try {
      return await change()
    } finally {
      release()
      if (this.#profileMutations.get(id) === current) this.#profileMutations.delete(id)
    }
  }

  async previewUpdate(id, changes) {
    await this.refresh()
    const current = this.get(id)
    if (!current) throw new Error(`BOT_NOT_FOUND: ${id}`)
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('BOT_UPDATE_INVALID')
    for (const key of Object.keys(changes)) {
      if (!PROFILE_FIELDS.has(key) && key !== 'createFolder') throw new Error(`BOT_UPDATE_FIELD_INVALID: ${key}`)
    }
    const { createFolder, ...images } = changes
    for (const field of ['avatar', 'avatarLarge']) {
      const source = `${field}Source`, crop = `${field}Crop`
      if (Object.hasOwn(changes, source) || Object.hasOwn(changes, crop)) {
        if (![field, source, crop].every(key => Object.hasOwn(changes, key))) throw new Error('BOT_AVATAR_CROP_INVALID')
      } else if (Object.hasOwn(changes, field) && changes[field] !== current[field]) {
        images[source] = ''; images[crop] = null
      }
    }
    let profile = normalizeProfile(await this.#bindTerminal({ ...current, ...images }, current))
    if (['harness', 'model', 'reasoningEffort'].some(field => profile[field] !== current[field]))
      await this.validateEffort(profile)
    if (profile.fastMode && ['harness', 'model', 'fastMode'].some(field => profile[field] !== current[field])) {
      const problem = await this.fastModeProblem(profile)
      // 有効を指定した保存は断る。CLIやモデルだけを替えた先が切り替えられない時は、Claude Codeの動きと同じく無効へ戻す。
      if (problem && Object.hasOwn(changes, 'fastMode')) throw fastModeError(problem)
      if (problem) profile = { ...profile, fastMode: false }
    }
    const candidate = Object.freeze(profile)
    this.#previewBases.set(candidate, current)
    return candidate
  }

  // S5 + OS rule (remote-seat.md): the bound terminal's os picks the folder form and the default folder.
  async #bindTerminal(value, current) {
    if (typeof value.terminalId !== 'string' || !TERMINAL_ID.test(value.terminalId)) return value
    if (value.projectRoot && current && value.terminalId === current.terminalId && value.projectRoot === current.projectRoot) return value
    const terminal = await this.terminals.read(value.terminalId)
    if (terminal === null) throw Object.assign(registryError('TERMINAL_NOT_FOUND'), { status: 404 })
    // undefined = the body offers no terminals: no default (the pair rule refuses an empty folder) and POSIX only, as before.
    const os = terminal?.os ?? 'macos'
    if (!value.projectRoot) return terminal ? { ...value, projectRoot: defaultProjectRoot(os, terminal.user, memberFolderSlug(value.name)) } : value
    if (typeof value.projectRoot === 'string' && WINDOWS_ROOT.test(value.projectRoot) !== (os === 'windows')) throw registryError('BOT_PROJECT_ROOT_INVALID')
    return value
  }

  // S5: FOLDER_* and TERMINAL_NOT_FOUND refuse the save; any other reason saves the folder as unchecked.
  async #checkFolder(profile, create, saved) {
    const result = await this.terminals.folder({ terminalId: profile.terminalId, path: profile.projectRoot, create })
    if (!result) return
    const { reason, action, observedAt } = result
    if (reason === 'TERMINAL_NOT_FOUND' || reason?.startsWith('FOLDER_'))
      throw Object.assign(registryError(reason), { status: reason === 'TERMINAL_NOT_FOUND' ? 404 : 409, outcome: 'not_accepted' })
    saved.folderCheck = { checked: reason === null, reason, observedAt, ...(action ? { action } : {}) }
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
    validateId(id)
    const previous = this.#removalOperations.get(id) ?? Promise.resolve()
    const removing = previous.catch(() => {}).then(async () => {
      let lease
      if (this.assetRemoval) {
        await this.refresh()
        if (!this.has(id) && !await this.hasPendingRemoval(id)) throw new Error(`BOT_NOT_FOUND: ${id}`)
        lease = await this.assetRemoval.prepareBotAssetRemoval(id)
      }
      try { return await this.#remove(id) }
      catch (error) {
        if (lease && error.outcome !== 'unknown') {
          // Same deletion operation queue excludes another intent while the state lock stays available to callbacks.
          const state = await this.#mutateProfile(id, async () => {
            await this.refresh()
            return {
              active: this.has(id) && await pathExists(this.statePath(id)),
              hasIntent: this.deletionIntents.has(id) || await this.hasPendingRemoval(id),
              retired: this.separateState && await pathExists(join(this.stateRoot, '.deleting', id)),
            }
          }).catch(() => null)
          if (state?.active && !state.hasIntent && !state.retired) {
            try { await this.assetRemoval.cancelBotAssetRemoval(id, lease, state) }
            catch { /* Unknown cancellation never authorizes another attempt. */ }
          }
        }
        throw error
      }
    })
    this.#removalOperations.set(id, removing)
    try { return await removing } finally { if (this.#removalOperations.get(id) === removing) this.#removalOperations.delete(id) }
  }

  async hasPendingRemoval(id) {
    validateId(id)
    return this.separateState && (await pathExists(join(this.stateRoot, '.deleting', id))
      || await pathExists(join(this.stateRoot, '.deleting', `${id}.json`)))
  }

  // Fresh read for conversation's startup asset gate; never resumes cleanup.
  async readRemovalStates() {
    if (!this.separateState) return { removals: [] }
    const root = join(this.stateRoot, '.deleting')
    const ids = new Set(this.deletionIntents)
    if (await pathExists(root)) {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && BOT_ID.test(entry.name)) ids.add(entry.name)
        if (entry.isFile() && entry.name.endsWith('.json') && BOT_ID.test(entry.name.slice(0, -5))) {
          const id = entry.name.slice(0, -5)
          const value = JSON.parse(await readFile(join(root, entry.name), 'utf8'))
          if (value?.schema !== 'bellteam.bot-deletion.v1' || value.profile?.id !== id)
            throw registryError('BOT_DELETE_RECORD_INVALID')
          normalizeProfile(value.profile)
          ids.add(id)
        }
      }
    }
    const removals = []
    for (const botId of [...ids].sort()) {
      const active = await pathExists(this.statePath(botId))
      const retired = await pathExists(join(root, botId))
      if (active && retired) throw registryError('BOT_DELETE_CONFLICT')
      const hasIntent = this.deletionIntents.has(botId) || retired || await pathExists(join(root, `${botId}.json`))
      if (hasIntent) removals.push({ botId, active, hasIntent: true, retired })
    }
    return { removals }
  }

  async #remove(id) {
    let bot
    await this.#mutateProfile(id, async () => {
      await this.refresh()
      bot = this.get(id)
      if (!this.separateState) {
        if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
        this.deletionIntents.add(id)
        this.delete(id)
      } else {
        const pending = join(this.stateRoot, '.deleting', id)
        const record = join(this.stateRoot, '.deleting', `${id}.json`)
        const resuming = !bot && (await pathExists(pending) || await pathExists(record))
        if (bot && await pathExists(pending)) throw registryError('BOT_DELETE_CONFLICT')
        if (!resuming) {
          if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
          await mkdir(join(this.stateRoot, '.deleting'), { recursive: true, mode: 0o700 })
          // Keep a separate listing receipt until both roots are fully removed.
          // Its presence alone never permits deleting an active project on recovery.
          await writeAtomic(record, { schema: 'bellteam.bot-deletion.v1', profile: bot })
          // Mark synchronously before the first retirement filesystem await.
          this.deletionIntents.add(id)
          this.delete(id)
          try { await rename(this.statePath(id), pending) } catch (error) {
            this.deletionIntents.delete(id)
            this.set(id, bot)
            throw error
          }
        }
        this.deletionIntents.add(id)
        this.delete(id)
        await this.refresh()
        this.changed()
      }
    })
    // Accepted instruction effects finish before physical project cleanup, without holding the state lock.
    await this.#instructionWrites.get(id)?.catch(() => {})
    let cleanupError
    if (this.separateState) {
      try { await this.finishRemoval(id) } catch (error) { cleanupError = error }
    } else {
      try { await this.projectFiles.remove(bot.project) }
      finally { this.deletionIntents.delete(id) }
    }
    await this.refresh()
    let configurationSync
    try { await this.onChange(this) } catch (error) {
      configurationSync = { state: 'failed', name: error.name, message: error.message,
        ...(error.code ? { code: error.code } : {}), ...(error.status ? { status: error.status } : {}) }
    }
    this.changed(id)
    if (cleanupError) throw Object.assign(cleanupError, configurationSync ? { configurationSync } : {})
    return { id, ...(configurationSync ? { configurationSync } : {}) }
  }

  isDeleting(id) {
    return this.deletionIntents.has(id)
  }

  clientListingState(id) {
    validateId(id)
    if (this.isDeleting(id)) return 'pending'
    if (this.has(id)) return 'active'
    if (this.separateState) {
      try {
        if (lstatSync(join(this.stateRoot, '.deleting', `${id}.json`)).isFile()) return 'pending'
        throw registryError('BOT_DELETE_RECORD_INVALID')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return 'absent'
  }

  async finishRemoval(id) {
    try {
      await this.projectFiles.remove(this.projectPath(id))
      await rm(join(this.stateRoot, '.deleting', id), { recursive: true, force: true })
      await rm(join(this.stateRoot, '.deleting', `${id}.json`), { force: true })
      this.deletionIntents.delete(id)
    } catch {
      // Retry remove(id), or initialize a new registry to resume the same intent.
      // No profile needs to survive a partially removed pending directory.
      throw registryError('BOT_DELETE_PENDING')
    }
  }

  async resumePendingRemovals() {
    const pendingRoot = join(this.stateRoot, '.deleting')
    if (!await pathExists(pendingRoot)) return
    const ids = new Set()
    for (const entry of await readdir(pendingRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && BOT_ID.test(entry.name)) ids.add(entry.name)
      if (entry.isFile() && entry.name.endsWith('.json') && BOT_ID.test(entry.name.slice(0, -5)))
        ids.add(entry.name.slice(0, -5))
    }
    for (const id of ids) {
      if (await pathExists(this.statePath(id))) {
        if (await pathExists(join(pendingRoot, id))) throw registryError('BOT_DELETE_CONFLICT')
        // A prepared receipt whose retirement rename never committed.
        await rm(join(pendingRoot, `${id}.json`), { force: true })
        continue
      }
      await this.finishRemoval(id)
    }
  }

  // Active execution uses the Map only. Client listings additionally retain a
  // pending deletion receipt until BOTH project and state cleanup have succeeded.
  async listForClient() {
    const listed = new Map(this)
    const result = () => [...listed.values()].flatMap(bot => {
      const state = this.clientListingState(bot.id)
      return state === 'absent' ? [] : [{ ...bot, ...(state === 'pending' ? { deleting: true } : {}) }]
    })
    if (!this.separateState) return result()
    const pendingRoot = join(this.stateRoot, '.deleting')
    if (!await pathExists(pendingRoot)) return result()
    for (const entry of await readdir(pendingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      if (!BOT_ID.test(id) || listed.has(id)) continue
      let record
      try { record = JSON.parse(await readFile(join(pendingRoot, entry.name), 'utf8')) } catch (error) {
        if (error.code === 'ENOENT') continue // Cleanup committed during this read.
        throw error
      }
      if (record?.schema !== 'bellteam.bot-deletion.v1' || record.profile?.id !== id)
        throw registryError('BOT_DELETE_RECORD_INVALID')
      listed.set(id, { ...normalizeProfile(record.profile), project: this.projectPath(id), deleting: true })
    }
    return result().sort((a, b) => a.id.localeCompare(b.id))
  }

  async listSchedules(id) {
    if (!this.has(id)) throw new Error(`BOT_NOT_FOUND: ${id}`)
    const document = await this.readScheduleDocument(id)
    return document.schedules
  }

  async setSchedule(id, input) {
    await this.refresh()
    if (!this.has(id)) throw new Error(`BOT_NOT_FOUND: ${id}`)
    const afterTurn = input.kind === 'after_turn' ? await this.currentTurn(id) : undefined
    return this.#mutateProfile(id, () => mutateSchedules(this, id, schedules => {
      const existing = input.id ? schedules.find(item => item.id === input.id) : null
      if (input.id && !existing) throw new Error(`SCHEDULE_NOT_FOUND: ${input.id}`)
      if (existing?.kind === 'after_turn' && input.kind !== 'after_turn') throw registryError('SCHEDULE_AFTER_TURN_REPLACE_REQUIRED')
      const schedule = normalizeSchedule({
        ...input,
        // Released editors drop unknown fields; an update without notify keeps the stored command result delivery.
        ...(!Object.hasOwn(input, 'notify') && input.command && existing?.notify ? { notify: existing.notify } : {}),
        id: input.id ?? this.id(),
        lastRunAt: null,
        revision: nextScheduleRevision(existing),
        ...(input.kind === 'after_turn' ? { afterTurn } : {}),
      }, this.now())
      return { schedules: existing ? schedules.map(item => item.id === schedule.id ? schedule : item) : [...schedules, schedule], value: schedule }
    }))
  }

  async removeSchedule(id, scheduleId) {
    return this.#mutateProfile(id, () => mutateSchedules(this, id, schedules => {
      if (!schedules.some(item => item.id === scheduleId)) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
      return { schedules: schedules.filter(item => item.id !== scheduleId), value: true }
    }))
  }

  async markScheduleRun(id, scheduleId, ranAt, { skipped = false, expectedRevision } = {}) {
    return this.#mutateProfile(id, () => mutateSchedules(this, id, schedules => {
      const current = schedules.find(item => item.id === scheduleId)
      if (expectedRevision !== undefined && (!current || scheduleRevision(current) !== expectedRevision)) return { value: current ?? null }
      if (!current) throw new Error(`SCHEDULE_NOT_FOUND: ${scheduleId}`)
      const timestamp = new Date(ranAt).toISOString()
      const updated = normalizeSchedule({
        ...current,
        enabled: ['once', 'after_turn'].includes(current.kind) ? false : current.enabled,
        lastRunAt: skipped ? current.lastRunAt : timestamp,
      }, new Date(timestamp))
      return { schedules: schedules.map(item => item.id === scheduleId ? updated : item), value: updated }
    }))
  }

  async claimAfterTurn({ botId, scheduleId, expectedRevision, expectedAfterTurn, observedTurn, ranAt }) {
    validateId(botId)
    validateScheduleTurn(expectedAfterTurn)
    validateScheduleTurn(observedTurn)
    if (typeof scheduleId !== 'string' || !scheduleId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof ranAt !== 'string' || !Number.isFinite(Date.parse(ranAt))) throw registryError('SCHEDULE_CLAIM_INVALID')
    return this.#mutateProfile(botId, async () => {
      await this.refresh()
      if (!this.has(botId)) return null
      return mutateSchedules(this, botId, schedules => {
        const current = schedules.find(item => item.id === scheduleId)
        if (!current || current.kind !== 'after_turn' || !current.enabled || scheduleRevision(current) !== expectedRevision
          || current.afterTurn.state !== expectedAfterTurn.state || current.afterTurn.turnId !== expectedAfterTurn.turnId
          || observedTurn.state === 'unknown') return { value: null }
        if (current.afterTurn.state === 'working' && observedTurn.state === 'working' && current.afterTurn.turnId === observedTurn.turnId) return { value: null }
        const binding = current.afterTurn.state === 'unknown' && observedTurn.state === 'working'
        const updated = normalizeSchedule({ ...current,
          ...(binding ? { afterTurn: observedTurn } : { enabled: false, lastRunAt: ranAt }),
        }, new Date(ranAt))
        return { schedules: schedules.map(item => item.id === scheduleId ? updated : item), value: binding ? null : structuredClone(current) }
      })
    })
  }

  claimDue(input) { return this.#consumeDue(input, false) }

  skipDue(input) { return this.#consumeDue(input, true) }

  async #consumeDue({ botId, scheduleId, expectedRevision, expectedNextRunAt, ranAt }, skipped) {
    validateId(botId)
    if (typeof scheduleId !== 'string' || !scheduleId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof expectedNextRunAt !== 'string' || !Number.isFinite(Date.parse(expectedNextRunAt))
      || !(typeof ranAt === 'string' || ranAt instanceof Date) || !Number.isFinite(new Date(ranAt).getTime()))
      throw registryError('SCHEDULE_CLAIM_INVALID')
    const timestamp = new Date(ranAt).toISOString()
    return this.#mutateProfile(botId, async () => {
      await this.refresh()
      if (!this.has(botId)) return null
      return mutateSchedules(this, botId, schedules => {
        const current = schedules.find(item => item.id === scheduleId)
        if (!current || !current.enabled || scheduleRevision(current) !== expectedRevision
          || current.nextRunAt !== expectedNextRunAt || Date.parse(expectedNextRunAt) > Date.parse(timestamp)) return { value: null }
        const updated = normalizeSchedule({ ...current, enabled: ['once', 'after_turn'].includes(current.kind) ? false : current.enabled,
          lastRunAt: skipped ? current.lastRunAt : timestamp }, new Date(timestamp))
        return { schedules: schedules.map(item => item.id === scheduleId ? updated : item), value: structuredClone(current) }
      })
    })
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
      avatarLarge: profile.avatarLarge, avatarSource: profile.avatarSource, avatarLargeSource: profile.avatarLargeSource,
      avatarCrop: profile.avatarCrop, avatarLargeCrop: profile.avatarLargeCrop,
      harness: profile.harness, model: profile.model, reasoningEffort: profile.reasoningEffort, fastMode: profile.fastMode,
      terminalId: profile.terminalId, projectRoot: profile.projectRoot,
    }
    await mkdir(this.statePath(profile.id), { recursive: true, mode: 0o700 })
    await writeAtomic(join(this.statePath(profile.id), 'bot.json'), value)
  }

  async writeInstructions(profile) {
    await this.projectFiles.writeInstructions(profile)
  }

  async prepareStartupContext(id, shortTermMemory) {
    await this.refresh()
    const profile = this.get(id)
    if (!profile) throw new Error(`BOT_NOT_FOUND: ${id}`)
    await this.projectFiles.prepareStartupContext(profile, shortTermMemory)
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
    if (!await exists(path)) return scheduleDocument([])
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value?.schema !== 'bellteam.schedule.v1' || !Array.isArray(value.schedules))
      throw new Error(`SCHEDULE_FILE_INVALID: ${id}`)
    return value
  }

  async writeScheduleDocument(id, schedules) {
    await writeAtomic(join(this.statePath(id), 'schedule.json'), scheduleDocument(schedules))
    this.changed(id, 'schedules')
  }
}

export function memberFolderSlug(name) {
  const slug = String(name ?? '').trim().replace(/[/\\:\0]/gu, '-')
  return slug && slug !== '.' && slug !== '..' ? slug : 'member'
}

function registryError(code) {
  return Object.assign(new Error(code), { code })
}

async function pathExists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
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
  for (const field of ['avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource']) validateAvatar(value[field] ?? '')
  const { terminalId, projectRoot } = normalizeRemoteBinding(value)
  const avatarCrop = normalizeAvatarCrop(value.avatarCrop, value.avatarSource, value.avatar)
  const avatarLargeCrop = normalizeAvatarCrop(value.avatarLargeCrop, value.avatarLargeSource, value.avatarLarge)
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
    avatarLarge: value.avatarLarge ?? '',
    avatarSource: value.avatarSource ?? '',
    avatarLargeSource: value.avatarLargeSource ?? '',
    avatarCrop,
    avatarLargeCrop,
    terminalId,
    projectRoot,
    session,
    project: value.project,
  }
}

// C1 (remote-seat.md): a member is local ('', '') or bound to one terminal folder, POSIX or Windows `X:\` form.
function normalizeRemoteBinding(value) {
  const terminalId = value.terminalId ?? '', projectRoot = value.projectRoot ?? ''
  if (typeof terminalId !== 'string' || terminalId && !TERMINAL_ID.test(terminalId)) throw registryError('BOT_TERMINAL_ID_INVALID')
  if (typeof projectRoot !== 'string' || projectRoot && !validProjectRoot(projectRoot)) throw registryError('BOT_PROJECT_ROOT_INVALID')
  if (Boolean(terminalId) !== Boolean(projectRoot)) throw registryError('BOT_REMOTE_BINDING_INVALID')
  return { terminalId, projectRoot }
}

function validProjectRoot(path) {
  const windows = WINDOWS_ROOT.test(path), root = windows ? path.slice(0, 3) : '/', rest = path.slice(root.length)
  if (!windows && !path.startsWith('/') || path.includes('\0') || windows && /[/:]/u.test(path.slice(2)) || Buffer.byteLength(path) > 4096) return false
  return !rest || rest.split(windows ? '\\' : '/').every(part => part && part !== '.' && part !== '..')
}

function defaultProjectRoot(os, user, slug) {
  if (os === 'windows') return `C:\\Users\\${user}\\BellTeam\\${slug}`
  return `${os === 'linux' ? '/home' : '/Users'}/${user}/BellTeam/${slug}`
}

export function remoteBindingRevision(profile) {
  return createHash('sha256').update(JSON.stringify([profile.terminalId, profile.projectRoot])).digest('hex').slice(0, 16)
}


function legacyIdentity(displayName) {
  if (typeof displayName !== 'string') return { name: '', role: '' }
  const match = displayName.trim().match(/^(.*?)【(.+)】$/u)
  return match ? { role: match[1], name: match[2] } : { role: '', name: displayName.trim() }
}

function validateId(id) {
  if (typeof id !== 'string' || !BOT_ID.test(id)) throw new Error('BOT_ID_INVALID')
}

function normalizeAvatarCrop(value, source, render) {
  if (!source && value == null) return null
  if (!source || !render || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || !['x', 'y', 'width', 'height'].every(key =>
      typeof value[key] === 'number' && Number.isFinite(value[key]))
    || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
    || value.x + value.width > 1 + 1e-9 || value.y + value.height > 1 + 1e-9)
    throw new Error('BOT_AVATAR_CROP_INVALID')
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}
