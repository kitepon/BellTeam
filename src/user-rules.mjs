import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exists } from './json-file.mjs'

async function writeText(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, path)
}

// ユーザー規範: オーナーがBellTeamの利用者として、自分の全Botに課す規範。製品規範（config/common-agents.md）とは別のオーナーのデータ。
const MAX_LENGTH = 20_000
const HISTORY_LIMIT = 50

export class UserRules {
  constructor({ root }) {
    this.directory = join(root, 'owner')
    this.path = join(this.directory, 'user-rules.md')
    this.historyPath = join(this.directory, 'user-rules-history.jsonl')
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true })
    if (!await exists(this.path)) await writeText(this.path, '')
    return this.get()
  }

  async get() {
    if (!await exists(this.path)) return this.initialize()
    return this.restore()
  }

  async restore() {
    return readFile(this.path, 'utf8')
  }

  async update(text) {
    return (await this.change(text)).text
  }

  // Who changed what is appended before the text is replaced, only when the text actually changes (instructions.md).
  async change(text, { actor = { kind: 'owner' }, instruction, expectedBefore } = {}) {
    if (typeof text !== 'string' || text.length > MAX_LENGTH) throw new Error('USER_RULES_INVALID')
    const normalized = normalizeUserRules(text)
    const before = await this.get()
    // The Owner approved the diff from expectedBefore; never apply it over a different text (instructions.md).
    if (expectedBefore !== undefined && before !== expectedBefore) throw Object.assign(new Error('USER_RULES_CHANGED'), { code: 'USER_RULES_CHANGED', status: 409 })
    if (before !== normalized) {
      const entry = { schema: 'bellteam.user-rules-change.v1', at: new Date().toISOString(), actor, ...(instruction ? { instruction } : {}), before, after: normalized }
      await appendFile(this.historyPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    }
    await writeText(this.path, normalized)
    return { text: normalized, before }
  }

  // shortcut: reads the whole log for the newest entries; rotate the file when it grows past a few MB.
  async history() {
    if (!await exists(this.historyPath)) return []
    return (await readFile(this.historyPath, 'utf8')).split('\n').filter(Boolean).slice(-HISTORY_LIMIT).reverse().map(line => JSON.parse(line))
  }
}

export function userRulesInstructions(text) {
  return [
    '# ユーザー規範',
    '',
    text.trim() || '（未設定）',
    '',
    'これはオーナーがBellTeamの全Botに課す規範であり、製品規範と矛盾する場合はこちらを優先する。',
  ].join('\n')
}

export const normalizeUserRules = text => `${text.replace(/\r\n/g, '\n').trim()}\n`

const DIFF_CELLS = 1_000_000

// Line diff for the Owner-facing change notice: removed lines as "- ", added lines as "+ ".
// Common head/tail lines are skipped; the LCS runs only while the middle fits DIFF_CELLS (2 MB), else every
// middle line is listed as removed then added: still the complete change, in linear time and memory.
export function userRulesDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n')
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start, m = endB - start
  if (n * m > DIFF_CELLS) return [...a.slice(start, endA).map(line => `- ${line}`), ...b.slice(start, endB).map(line => `+ ${line}`)].join('\n')
  const width = m + 1, lcs = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i * width + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
  const lines = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { i++; j++ }
    else if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) lines.push(`- ${a[start + i++]}`)
    else lines.push(`+ ${b[start + j++]}`)
  }
  return lines.join('\n')
}
