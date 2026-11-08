import { lstat, mkdir, readdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './json-file.mjs'
import { MODEL_FAMILIES, modelScope, parseLimitText } from './claude-limit-text.mjs'

// harness-accounts.md: 1st/2nd slots per harness, limits per (slot, model scope), rules. No secrets are stored here.
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

// The usage endpoint Claude Code itself uses (scripts/claude-usage.py). The token stays in this function.
export async function readClaudeUsage(root, { fetch: request = fetch } = {}) {
  let token
  try { token = JSON.parse(await readFile(join(root, '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken } catch { token = null }
  if (typeof token !== 'string' || !token) throw fail('ACCOUNT_USAGE_UNAVAILABLE')
  let body
  try {
    const response = await request('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error()
    body = await response.json()
  } catch { throw fail('ACCOUNT_USAGE_UNAVAILABLE') }
  return (Array.isArray(body?.limits) ? body.limits : []).map(row => ({
    scope: row?.kind === 'weekly_scoped' ? modelScope(row?.scope?.model?.display_name) : 'all',
    percent: Number(row?.percent), resetsAt: iso(row?.resets_at) ? new Date(row.resets_at).toISOString() : null,
  })).filter(row => row.scope && Number.isFinite(row.percent))
}

export class HarnessAccounts {
  constructor({ home, statePath, readUsage = readClaudeUsage, now = () => Date.now(),
    timers = { set: setTimeout, clear: clearTimeout }, timeZone = process.env.TZ || 'UTC', log = line => process.stderr.write(`${line}\n`) }) {
    Object.assign(this, { home, statePath, readUsage, now, timers, timeZone, log })
    this.state = { schema: SCHEMA, rules: [], limits: [], seats: {} }
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
        rules: (value.rules ?? []).filter(rule => this.validRule(rule)),
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
    const root = this.root(harness, slot)
    if (slot === '1st') return { configurationRoot: root, history: 'shared' }
    const primary = this.root(harness, '1st')
    await mkdir(root, { recursive: true, mode: 0o700 })
    let history = 'shared'
    for (const name of SHARED) {
      const link = join(root, name), entry = await present(link)
      if (entry) { if (!entry.isSymbolicLink() && name === 'projects') history = 'separate'; continue }
      // Create-only: an existing entry is never replaced. A target that does not exist yet stays the CLI's own.
      if (await present(join(primary, name))) await symlink(join(primary, name), link)
    }
    await this.copyManagedMcp(join(this.home, `.${harness}.json`), join(root, `.${harness}.json`))
    return { configurationRoot: root, history }
  }

  async copyManagedMcp(from, to) {
    let source = {}, target = {}
    try { source = JSON.parse(await readFile(from, 'utf8')) } catch {}
    try { target = JSON.parse(await readFile(to, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') return }
    const servers = Object.fromEntries(Object.entries(source.mcpServers ?? {}).filter(([id]) => MANAGED_MCP.includes(id)))
    const projects = { ...(target.projects ?? {}) }
    for (const [path, value] of Object.entries(source.projects ?? {}))
      if (value?.hasTrustDialogAccepted) projects[path] = { ...(projects[path] ?? {}), hasTrustDialogAccepted: true }
    await writeAtomic(to, { ...target, mcpServers: { ...(target.mcpServers ?? {}), ...servers }, projects })
  }

  // The slot each Claude seat was last launched on (kept across restarts and engine exchanges).
  seatSlot(botId) { return this.state.seats[botId] ?? null }
  async setSeat(botId, slot) {
    if (this.state.seats[botId] === slot) return
    await this.save({ ...this.state, seats: { ...this.state.seats, [botId]: slot } })
  }

  // Display label: the e-mail the CLI recorded for its own login (not a credential).
  async label(harness, slot) {
    const path = slot === '1st' ? join(this.home, `.${harness}.json`) : join(this.root(harness, slot), `.${harness}.json`)
    try { const value = JSON.parse(await readFile(path, 'utf8'))?.oauthAccount?.emailAddress; return typeof value === 'string' && value ? value : null }
    catch { return null }
  }

  async loggedIn(harness, slot) {
    const entry = await present(join(this.root(harness, slot), '.credentials.json'))
    return Boolean(entry?.isFile())
  }

  validRule(rule) {
    return rule && ACCOUNT_HARNESSES.includes(rule.harness) && typeof rule.modelPrefix === 'string'
      && rule.modelPrefix.trim() === rule.modelPrefix && rule.modelPrefix.length > 0 && rule.modelPrefix.length <= 64
      && (rule.slot === null || ACCOUNT_SLOTS.includes(rule.slot))
  }

  // Upsert by (harness, modelPrefix); slot null removes exactly that rule.
  async setRule(rule) {
    if (!this.validRule(rule) || Object.keys(rule).some(key => !['harness', 'modelPrefix', 'slot'].includes(key))) throw fail('ACCOUNT_RULE_INVALID')
    const rules = this.state.rules.filter(value => value.harness !== rule.harness || value.modelPrefix !== rule.modelPrefix)
    if (rule.slot) rules.push({ harness: rule.harness, modelPrefix: rule.modelPrefix, slot: rule.slot })
    await this.save({ ...this.state, rules })
    return { rules: structuredClone(rules) }
  }

  preferredSlot(harness, model) {
    return this.state.rules.find(rule => rule.harness === harness && String(model ?? '').startsWith(rule.modelPrefix))?.slot ?? '1st'
  }

  limitFor(harness, slot, model) {
    const family = modelScope(model)
    return this.state.limits.filter(entry => entry.harness === harness && entry.slot === slot && (entry.scope === 'all' || entry.scope === family))
  }

  // Never refuses: with every slot limited for this scope, the earliest known reset wins.
  async effectiveSlot(harness, model) {
    const preferred = this.preferredSlot(harness, model)
    const order = [preferred, ...ACCOUNT_SLOTS.filter(slot => slot !== preferred)]
    const usable = []
    for (const slot of order) if (slot === '1st' || await this.loggedIn(harness, slot)) usable.push(slot)
    const free = usable.find(slot => !this.limitFor(harness, slot, model).length)
    if (free) return free
    const reset = slot => Math.max(...this.limitFor(harness, slot, model).map(entry => entry.resetAt ? Date.parse(entry.resetAt) : Infinity))
    return usable.sort((a, b) => reset(a) - reset(b))[0] ?? '1st'
  }

  async selection(harness, model) {
    const slot = await this.effectiveSlot(harness, model)
    return { slot, preferredSlot: this.preferredSlot(harness, model), configurationRoot: this.root(harness, slot) }
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
    return { harnesses, rules: structuredClone(this.state.rules) }
  }
}

// Slot roots that already exist; harness-config keeps their MCP registration in step with the 1st root.
export async function preparedAccountRoots(home, harness = 'claude') {
  const parent = join(home, '.bellteam-accounts', harness)
  try { return (await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory() && ACCOUNT_SLOTS.includes(entry.name)).map(entry => join(parent, entry.name)) }
  catch { return [] }
}
