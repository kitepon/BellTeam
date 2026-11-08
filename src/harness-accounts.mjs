import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './json-file.mjs'
import { MODEL_FAMILIES, modelScope, parseLimitText } from './claude-limit-text.mjs'

// harness-accounts.md: 1st/2nd slots per harness, limits per (slot, model scope). No secrets are stored here.
// Selection is limit-driven only (Owner ruling 2026-11-09): 1st unless the model is limited there; no preference rules.
export const ACCOUNT_SLOTS = ['1st', '2nd']
export const ACCOUNT_HARNESSES = ['claude']
const SCHEMA = 'bellteam.harness-accounts.v1'
const REREAD_MS = 600_000
const MAX_TIMER_MS = 2_147_000_000
const CLEAR_RETRY_MS = 60_000
// Shared with the 1st root so a resume under either root finds the same conversation and the same user settings.
const SHARED = ['projects', 'history.jsonl', 'settings.json', 'CLAUDE.md', 'AGENTS.md', 'skills', 'commands', 'plugins',
  'agents', 'file-history', 'todos', 'session-env', 'shell-snapshots']
const MANAGED_MCP = ['bellteam', 'aiterm', 'call-bridge']
const SCOPES = new Set(['all', ...MODEL_FAMILIES])
const fail = code => Object.assign(new Error(code), { code, status: 400 })
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

async function present(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// Runs as the seat user (harness-accounts.md "Identity"): the engine is another user and cannot open the seat's files.
// Self-contained on purpose: it is stringified into `node -e` for the parent's seat runner. No module-scope names.
export async function seatFiles(op, ...args) {
  const { chmod, lstat, mkdir, readFile, rename, symlink, unlink, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const error = code => Object.assign(new Error(code), { code })
  const present = async path => { try { return await lstat(path) } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause } }
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
  if (op === 'prepare') {
    const [home, harness, slot, shared, managed] = args
    const parent = join(home, '.bellteam-accounts'), root = join(parent, harness, slot), primary = join(home, `.${harness}`)
    await mkdir(root, { recursive: true, mode: 0o711 })
    // Traverse only, for the engine's lstat (loggedIn, history); no listing, no reading.
    for (const directory of [parent, join(parent, harness), root]) await chmod(directory, 0o711)
    let history = 'shared'
    for (const name of shared) {
      const link = join(root, name), entry = await present(link)
      if (entry) { if (!entry.isSymbolicLink() && name === 'projects') history = 'separate'; continue }
      // Create-only: an existing entry is never replaced. A target that does not exist yet stays the CLI's own.
      if (await present(join(primary, name))) await symlink(join(primary, name), link)
    }
    const to = join(root, `.${harness}.json`)
    let source = {}, target = {}, readable = true
    try { source = await readJson(join(home, `.${harness}.json`)) } catch {}
    try { target = await readJson(to) } catch (cause) { if (cause.code !== 'ENOENT') readable = false }
    if (readable) {
      const servers = Object.fromEntries(Object.entries(source.mcpServers ?? {}).filter(([id]) => managed.includes(id)))
      const projects = { ...(target.projects ?? {}) }
      for (const [path, value] of Object.entries(source.projects ?? {}))
        if (value?.hasTrustDialogAccepted) projects[path] = { ...(projects[path] ?? {}), hasTrustDialogAccepted: true }
      const temporary = `${to}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify({ ...target, mcpServers: { ...(target.mcpServers ?? {}), ...servers }, projects }, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, to)
      } catch (cause) { await unlink(temporary).catch(() => {}); throw cause }
    }
    return { configurationRoot: root, history }
  }
  if (op === 'label') {
    try { const value = (await readJson(args[0]))?.oauthAccount?.emailAddress; return typeof value === 'string' && value ? value : null }
    catch { return null }
  }
  if (op === 'usage') {
    // The usage endpoint Claude Code itself uses (scripts/claude-usage.py). The token never leaves this process.
    let token
    try { token = (await readJson(join(args[0], '.credentials.json')))?.claudeAiOauth?.accessToken } catch { token = null }
    if (typeof token !== 'string' || !token) throw error('ACCOUNT_USAGE_UNAVAILABLE')
    let body
    try {
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw error('ACCOUNT_USAGE_UNAVAILABLE')
      body = await response.json()
    } catch { throw error('ACCOUNT_USAGE_UNAVAILABLE') }
    return (Array.isArray(body?.limits) ? body.limits : []).map(row => ({ kind: row?.kind ?? null,
      model: row?.scope?.model?.display_name ?? null, percent: row?.percent ?? null, resets_at: row?.resets_at ?? null }))
  }
  throw error('ACCOUNT_SEAT_OP_INVALID')
}

export const SEAT_FILES_SCRIPT = `(${seatFiles})(...JSON.parse(process.argv[1])).then(value => process.stdout.write(JSON.stringify({ ok: true, value: value ?? null })),
  error => process.stdout.write(JSON.stringify({ ok: false, code: typeof error?.code === 'string' && /^[A-Z_0-9]{1,100}$/.test(error.code) ? error.code : 'FAILED' })))`

// The parent's seat runner (ports.seat.waitProcess: sudo seat-exec as the seat user, stdout parsed as JSON).
export function seatFilesOver(waitProcess) {
  return async (op, ...args) => {
    const result = await waitProcess({ executable: process.execPath, args: ['-e', SEAT_FILES_SCRIPT, JSON.stringify([op, ...args])] }, null)
    if (result?.ok === true) return result.value
    const code = typeof result?.code === 'string' ? result.code : 'ACCOUNT_SEAT_FAILED'
    throw Object.assign(new Error(code), { code })
  }
}

export async function readClaudeUsage(root, { seat = seatFiles } = {}) {
  const rows = await seat('usage', root)
  return (Array.isArray(rows) ? rows : []).map(row => ({
    scope: row?.kind === 'weekly_scoped' ? modelScope(row?.model) : 'all',
    percent: Number(row?.percent), resetsAt: iso(row?.resets_at) ? new Date(row.resets_at).toISOString() : null,
  })).filter(row => row.scope && Number.isFinite(row.percent))
}

export class HarnessAccounts {
  constructor({ home, statePath, seat = seatFiles, readUsage = root => readClaudeUsage(root, { seat }), now = () => Date.now(),
    timers = { set: setTimeout, clear: clearTimeout }, timeZone = process.env.TZ || 'UTC', log = line => process.stderr.write(`${line}\n`) }) {
    Object.assign(this, { home, statePath, seat, readUsage, now, timers, timeZone, log })
    this.labels = new Map()
    this.state = { schema: SCHEMA, limits: [], seats: {} }
    this.listeners = new Set()
    this.resetTimers = new Map()
    this.reread = null
    this.writing = Promise.resolve()
  }

  root(harness, slot) {
    return slot === '1st' ? join(this.home, `.${harness}`) : join(this.home, '.bellteam-accounts', harness, slot)
  }

  // Aiterm E1 allows only direct children of this parent besides the default root.
  configRootsParent(harness = 'claude') { return join(this.home, '.bellteam-accounts', harness) }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (value?.schema === SCHEMA) this.state = {
        schema: SCHEMA,
        limits: (value.limits ?? []).filter(entry => ACCOUNT_HARNESSES.includes(entry?.harness) && ACCOUNT_SLOTS.includes(entry.slot) && SCOPES.has(entry.scope)),
        seats: Object.fromEntries(Object.entries(value.seats ?? {}).filter(([, slot]) => ACCOUNT_SLOTS.includes(slot))),
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log(`BellTeam accounts: registry unreadable, starting empty (${error.code ?? 'INVALID'})`) }
    // Re-arm after a restart or a body exchange; an entry whose time passed clears now.
    for (const entry of [...this.state.limits]) this.arm(entry)
    this.syncReread()
  }

  close() {
    for (const timer of this.resetTimers.values()) this.timers.clear(timer)
    this.resetTimers.clear()
    if (this.reread) this.timers.clear(this.reread)
    this.reread = null
  }

  watch(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit() { for (const listener of this.listeners) { try { listener() } catch {} } }

  // A failed write keeps the previous state in memory and on disk.
  save(next) {
    const run = this.writing.then(async () => {
      await writeAtomic(this.statePath, next)
      this.state = next
      this.emit()
    })
    this.writing = run.catch(() => {})
    return run
  }

  async prepare(harness, slot) {
    if (!ACCOUNT_HARNESSES.includes(harness) || !ACCOUNT_SLOTS.includes(slot)) throw fail('ACCOUNT_SLOT_INVALID')
    if (slot === '1st') return { configurationRoot: this.root(harness, slot), history: 'shared' }
    try {
      const prepared = await this.seat('prepare', this.home, harness, slot, SHARED, MANAGED_MCP)
      if (prepared?.configurationRoot !== this.root(harness, slot) || !['shared', 'separate'].includes(prepared.history)) throw Object.assign(new Error(), { code: 'ACCOUNT_SEAT_INVALID' })
      return prepared
    } catch (error) {
      this.log(`BellTeam accounts: prepare ${harness} ${slot} failed (${error?.code ?? 'FAILED'})`)
      throw Object.assign(new Error('ACCOUNT_ROOT_UNAVAILABLE'), { code: 'ACCOUNT_ROOT_UNAVAILABLE', status: 503 })
    }
  }

  // The slot each Claude seat was last launched on (kept across restarts and engine exchanges).
  seatSlot(botId) { return this.state.seats[botId] ?? null }
  async setSeat(botId, slot) {
    if (this.state.seats[botId] === slot) return
    await this.save({ ...this.state, seats: { ...this.state.seats, [botId]: slot } })
  }

  // Display label: the e-mail the CLI recorded for its own login (not a credential). Read as the seat user, cached until a new login.
  async label(harness, slot) {
    const stamp = (await present(join(this.root(harness, slot), '.credentials.json')).catch(() => null))?.mtimeMs ?? null
    const key = `${harness}:${slot}`, cached = this.labels.get(key)
    if (cached && cached.stamp === stamp) return cached.value
    const path = slot === '1st' ? join(this.home, `.${harness}.json`) : join(this.root(harness, slot), `.${harness}.json`)
    try { const read = await this.seat('label', path), value = typeof read === 'string' && read ? read : null; this.labels.set(key, { stamp, value }); return value }
    catch { return null }
  }

  async loggedIn(harness, slot) {
    const entry = await present(join(this.root(harness, slot), '.credentials.json'))
    return Boolean(entry?.isFile())
  }

  limitFor(harness, slot, model) {
    const family = modelScope(model)
    return this.state.limits.filter(entry => entry.harness === harness && entry.slot === slot && (entry.scope === 'all' || entry.scope === family))
  }

  // Never refuses: with every slot limited for this scope, the earliest known reset wins.
  async effectiveSlot(harness, model) {
    const usable = []
    for (const slot of ACCOUNT_SLOTS) if (slot === '1st' || await this.loggedIn(harness, slot)) usable.push(slot)
    const free = usable.find(slot => !this.limitFor(harness, slot, model).length)
    if (free) return free
    const reset = slot => Math.max(...this.limitFor(harness, slot, model).map(entry => entry.resetAt ? Date.parse(entry.resetAt) : Infinity))
    return usable.sort((a, b) => reset(a) - reset(b))[0] ?? '1st'
  }

  async selection(harness, model) {
    const slot = await this.effectiveSlot(harness, model)
    return { slot, configurationRoot: this.root(harness, slot) }
  }

  // A seat's own limit signal. The text decides scope and time first; the usage reading only fills what it lacks.
  async recordLimit({ harness, slot, model, text }) {
    const parsed = parseLimitText(text, { now: this.now(), timeZone: this.timeZone })
    let scope = parsed.scope, resetAt = parsed.resetAt, resetSource = resetAt ? 'message' : null
    if (!scope || !resetAt) {
      const rows = await this.readUsage(this.root(harness, slot)).catch(() => [])
      const family = modelScope(model)
      const full = rows.filter(row => row.percent >= 100 && (row.scope === 'all' || row.scope === family))
      scope ??= full.some(row => row.scope === family) ? family : full.length ? 'all' : null
      const row = full.find(value => value.scope === scope)
      if (!resetAt && row?.resetsAt && this.trusted(row.resetsAt)) { resetAt = row.resetsAt; resetSource = 'usage' }
    }
    scope ??= 'all'
    const entry = { harness, slot, scope, since: new Date(this.now()).toISOString(), resetAt, resetSource, text: String(text ?? '').slice(0, 300) }
    this.log(`BellTeam accounts: ${harness} ${slot} limited for ${scope} until ${resetAt ?? 'unknown'} (source ${resetSource ?? 'none'}, zone ${parsed.zone}, parsed ${parsed.parsedAt ?? 'none'}): ${entry.text}`)
    const limits = [...this.state.limits.filter(value => !(value.harness === harness && value.slot === slot && value.scope === scope)), entry]
    await this.save({ ...this.state, limits })
    this.arm(entry)
    this.syncReread()
    return structuredClone(entry)
  }

  trusted(value) {
    const at = Date.parse(value), now = this.now()
    return at > now && at - now <= 8 * 86_400_000
  }

  key(entry) { return `${entry.harness}:${entry.slot}:${entry.scope}` }

  // retryMs: after a failed clear write the entry stays limited and the clear is retried later, never in a hot loop.
  arm(entry, retryMs = null) {
    const key = this.key(entry)
    if (this.resetTimers.has(key)) this.timers.clear(this.resetTimers.get(key))
    this.resetTimers.delete(key)
    if (!entry.resetAt) return
    const delay = retryMs ?? Date.parse(entry.resetAt) - this.now()
    const fire = () => {
      this.resetTimers.delete(key)
      if (Date.parse(entry.resetAt) > this.now()) return this.arm(entry)
      void this.clear(entry).catch(error => {
        if (!retryMs) this.log(`BellTeam accounts: reset write failed, retrying every ${CLEAR_RETRY_MS / 1000}s: ${key} ${error?.code ?? 'UNKNOWN'}`)
        this.arm(entry, CLEAR_RETRY_MS)
      })
    }
    this.resetTimers.set(key, this.timers.set(fire, Math.max(0, Math.min(delay, MAX_TIMER_MS))))
  }

  async clear(entry) {
    const limits = this.state.limits.filter(value => this.key(value) !== this.key(entry) || value.since !== entry.since)
    if (limits.length === this.state.limits.length) return
    await this.save({ ...this.state, limits })
    this.syncReread()
  }

  // Only while some reset is unknown: re-read usage every 10 minutes.
  syncReread() {
    const unknown = this.state.limits.some(entry => !entry.resetAt)
    if (!unknown && this.reread) { this.timers.clear(this.reread); this.reread = null }
    if (unknown && !this.reread) this.reread = this.timers.set(() => { this.reread = null; void this.rereadUnknown().finally(() => this.syncReread()) }, REREAD_MS)
  }

  async rereadUnknown() {
    for (const entry of this.state.limits.filter(value => !value.resetAt)) {
      const rows = await this.readUsage(this.root(entry.harness, entry.slot)).catch(() => null)
      const row = rows?.find(value => value.scope === entry.scope)
      if (!row) continue
      if (row.percent < 100) await this.clear(entry).catch(() => {})
      else if (row.resetsAt && this.trusted(row.resetsAt)) {
        const next = { ...entry, resetAt: row.resetsAt, resetSource: 'usage' }
        await this.save({ ...this.state, limits: this.state.limits.map(value => value === entry ? next : value) }).then(() => this.arm(next), () => {})
      }
    }
  }

  // A turn in scope that ends done is an exit only for an entry whose reset time is unknown.
  async turnSucceeded(harness, slot, model) {
    for (const entry of this.limitFor(harness, slot, model).filter(value => !value.resetAt)) await this.clear(entry).catch(() => {})
  }

  async list() {
    const seats = Object.entries(this.state.seats).map(([botId, slot]) => ({ botId, harness: 'claude', slot }))
    const harnesses = []
    for (const harness of ACCOUNT_HARNESSES) {
      const slots = []
      for (const slot of ACCOUNT_SLOTS) {
        const loggedIn = await this.loggedIn(harness, slot).catch(() => null)
        const history = slot === '1st' ? 'shared' : await present(join(this.root(harness, slot), 'projects'))
          .then(entry => !entry || entry.isSymbolicLink() ? 'shared' : 'separate', () => 'shared')
        slots.push({ slot, loggedIn, label: loggedIn ? await this.label(harness, slot) : null, history,
          limits: this.state.limits.filter(entry => entry.harness === harness && entry.slot === slot)
            .map(({ scope, since, resetAt, resetSource }) => ({ scope, since, resetAt, resetSource })),
          seats: seats.filter(seat => seat.harness === harness && seat.slot === slot).map(seat => seat.botId) })
      }
      const scopes = [...new Set(this.state.limits.filter(entry => entry.harness === harness).map(entry => entry.scope))]
      const allLimited = scopes.flatMap(scope => {
        const model = scope === 'all' ? '' : scope
        const entries = ACCOUNT_SLOTS.map(slot => this.limitFor(harness, slot, model))
        if (entries.some(list => !list.length)) return []
        const known = entries.flat().map(entry => entry.resetAt).filter(Boolean).sort()
        return [{ scope, earliestResetAt: known[0] ?? null }]
      })
      harnesses.push({ harness, slots, allLimited })
    }
    // shortcut: `rules: []` stays for clients that still read it; drop it once Web, Apple and Windows remove the switch.
    return { harnesses, rules: [] }
  }
}

// Slot roots that already exist; harness-config keeps their MCP registration in step with the 1st root.
export async function preparedAccountRoots(home, harness = 'claude') {
  const parent = join(home, '.bellteam-accounts', harness)
  try { return (await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory() && ACCOUNT_SLOTS.includes(entry.name)).map(entry => join(parent, entry.name)) }
  catch { return [] }
}
