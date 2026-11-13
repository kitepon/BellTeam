import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// a41 (execution current-work.md "Own work"): the Owner-approved list of what never counts as a Bot's own work.
// Execution state, written only by an Owner-approved proposal or the Owner's removal; this module only reads it.
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
