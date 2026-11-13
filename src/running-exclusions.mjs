import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeAtomic } from './json-file.mjs'

// a41 (execution current-work.md "Own work"): the Owner-approved list of what never counts as a Bot's own work.
// Execution state: the engine only reads it (readRunningExclusions); the body writes it only for an Owner-approved
// addition or removal (createRunningExclusions below).
export const RUNNING_EXCLUSIONS_SCHEMA = 'bellteam.running-exclusions.v1'
const MAX_ENTRIES = 256
const word = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f]/u.test(value)
const HARNESSES = new Set(['claude-code', 'codex-cli', 'grok-cli', 'cursor-cli', 'antigravity-cli'])

function valid(entry) {
  if (!entry || typeof entry !== 'object' || !word(entry.id)) return false
  const scope = entry.scope === 'all' || Array.isArray(entry.scope) && entry.scope.length > 0 && entry.scope.every(word)
  if (!scope) return false
  if (entry.kind === 'process') return word(entry.exe) && Array.isArray(entry.args) && entry.args.length <= 2 && entry.args.every(word)
  if (entry.kind === 'child') return HARNESSES.has(entry.harness) && (entry.session === null || word(entry.session))
  return false
}

// Absent file = empty list. An unreadable or invalid file = null: no list is sent, so processes are not counted
// (today's behaviour) instead of counting what the Owner excluded.
export async function readRunningExclusions(path) {
  if (!path) return []
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) { return error?.code === 'ENOENT' ? [] : null }
  if (value?.schema !== RUNNING_EXCLUSIONS_SCHEMA || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || !value.entries.every(valid) || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) return null
  return value.entries
}

// The request _meta value for one read: entries narrowed to the sessions of the Bots in scope, and its digest.
export function exclusionsMeta(entries, targets) {
  const sessions = scope => targets.filter(target => scope === 'all' || scope.includes(target.botId)).map(target => target.sessionId)
  const sent = entries.flatMap(entry => {
    const inScope = sessions(entry.scope)
    if (!inScope.length) return []
    return [entry.kind === 'process'
      ? { id: entry.id, kind: 'process', exe: entry.exe, args: entry.args, sessions: inScope }
      : { id: entry.id, kind: 'child', harness: entry.harness, session: entry.session, sessions: inScope }]
  })
  const digest = createHash('sha256').update(JSON.stringify(sent)).digest('hex')
  return { digest, entries: sent }
}

// ---- Body side (PR 2): proposals, Owner approval, the only writer of the file ----
const unavailable = () => Object.assign(new Error('RUNNING_EXCLUSIONS_UNAVAILABLE'), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE', status: 503 })
const invalid = message => Object.assign(new Error(`RUNNING_EXCLUSION_INVALID: ${message}`), { code: 'RUNNING_EXCLUSION_INVALID', status: 400 })
const keyOf = entry => JSON.stringify(entry.kind === 'process' ? [entry.kind, entry.exe, entry.args, entry.scope] : [entry.kind, entry.harness, entry.session, entry.scope])
const describe = entry => entry.kind === 'process' ? [entry.exe, ...entry.args].join(' ')
  : `${entry.harness} の子の席${entry.session ? `「${entry.session}」` : '（どの席でも）'}`
const OPTIONS = Object.freeze([{ id: 'approve', label: '承認' }, { id: 'reject', label: '却下' }])

function decisionText({ action, entry, requester, who, reason }) {
  const what = describe(entry)
  if (action === 'remove') return {
    title: `稼働中に数えない処理の一覧から「${what}」を外していいですか？`,
    context: `${requester}からの申請です。\n理由: ${reason}\n承認すると: ${who}で、「${what}」をまた稼働中に数えます。\n却下すると: 一覧はこのままです。` }
  const broad = entry.kind === 'process' && !entry.args.length ? `\nこの申請は「${entry.exe}」で動くすべての処理が対象です。` : ''
  return {
    title: `「${what}」を、${who}で稼働中に数えないようにしていいですか？`,
    context: `${requester}からの申請です。\n理由: ${reason}\n承認すると: ${who}で、「${what}」と、その下で動く処理・それを包むシェルを稼働中に数えなくなります。`
      + `${broad}\n気をつけること: 同じ形の処理が本当に何かを待っている時も、稼働中に数えなくなります。`
      + '\n取り消す時: Bot に頼めば取り消しの申請が出ます。取り消しも指揮官の承認で決まります。\n却下すると: 何も変わりません。' }
}

export function createRunningExclusions({ path, decisions, now = () => new Date().toISOString(), intervalMs = 60_000 }) {
  let queue = Promise.resolve(), timer = null
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next }
  async function load() {
    let value
    try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return { entries: [], pending: [] }; throw unavailable() }
    // Never rewrite a file this module cannot read: that would drop entries the Owner approved.
    if (value?.schema !== RUNNING_EXCLUSIONS_SCHEMA || !Array.isArray(value.entries) || !value.entries.every(valid)) throw unavailable()
    return { entries: value.entries, pending: Array.isArray(value.pending) ? value.pending : [] }
  }
  async function save(state) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeAtomic(path, { schema: RUNNING_EXCLUSIONS_SCHEMA, entries: state.entries, pending: state.pending })
  }
  // proposal: {action:'add', entry:{kind, exe, args | harness, session, scope}} or {action:'remove', id}; from/requester/who come from the tool layer.
  async function propose({ action, entry, id, reason, from, requester, who }) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw invalid('reason は1〜1000字で書く')
    if (action === 'add' && !valid({ ...entry, id: 'new' })) throw invalid('処理は exe と最大2つの args、子の席は harness と session（null可）、対象は scope')
    if (action !== 'add' && action !== 'remove') throw invalid('action')
    return serial(async () => {
      const state = await load()
      const target = action === 'add' ? entry : state.entries.find(item => item.id === id)
      if (!target) throw Object.assign(new Error('RUNNING_EXCLUSION_NOT_FOUND'), { code: 'RUNNING_EXCLUSION_NOT_FOUND', status: 404 })
      const listed = action === 'add' && state.entries.find(item => keyOf(item) === keyOf(entry))
      if (listed) return { status: 'listed', entry: listed }
      const label = `running-exclusions:${createHash('sha256').update(action === 'add' ? `add:${keyOf(entry)}` : `remove:${id}`).digest('hex').slice(0, 32)}`
      const open = state.pending.find(item => item.label === label)
      if (open) return { status: 'pending', decisionId: open.decisionId }
      const filed = await decisions.file({ ...decisionText({ action, entry: target, requester, who, reason: reason.trim() }), options: OPTIONS, requester, session_label: label })
      const stored = action === 'add' ? { ...entry, id: randomUUID() } : { id }
      state.pending.push({ label, action, ...(action === 'add' ? { entry: stored } : { id }), decisionId: filed.decisionId, from, reason: reason.trim(), filedAt: now() })
      await save(state)
      return { status: 'filed', decisionId: filed.decisionId }
    })
  }
  // Only the Owner's "approve" for that decision writes; any other answer or a cancel drops the proposal.
  function poll() {
    return serial(async () => {
      const state = await load()
      if (!state.pending.length) return 0
      let applied = 0
      const keep = []
      for (const [index, item] of state.pending.entries()) {
        let result
        try { result = await decisions.read({ decisionId: item.decisionId }) } catch { keep.push(...state.pending.slice(index)); break }
        if (result.status !== 'answered' && result.status !== 'cancelled') { keep.push(item); continue }
        if (result.status !== 'answered' || result.answer?.optionId !== 'approve') continue
        applied++
        if (item.action === 'remove') state.entries = state.entries.filter(entry => entry.id !== item.id)
        else if (!state.entries.some(entry => keyOf(entry) === keyOf(item.entry)))
          state.entries.push({ ...item.entry, decisionId: item.decisionId, approvedAt: now(), reason: item.reason })
      }
      const changed = keep.length !== state.pending.length
      state.pending = keep
      if (changed) await save(state)
      return applied
    })
  }
  return Object.freeze({
    propose, poll,
    list: () => serial(async () => {
      const { entries, pending } = await load()
      return { entries, pending: pending.map(({ action, entry, id, decisionId, from, filedAt }) => ({ action, ...(entry ? { entry } : { id }), decisionId, from, filedAt })) }
    }),
    start() { if (!timer) { timer = setInterval(() => { poll().catch(() => {}) }, intervalMs); timer.unref?.() } },
    stop() { clearInterval(timer); timer = null },
  })
}
