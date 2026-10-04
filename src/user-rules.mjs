import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exists } from './bot-registry.mjs'

async function writeText(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, path)
}

// ユーザー規範: オーナーがBellTeamの利用者として、自分の全Botに課す規範。製品規範（config/common-agents.md）とは別のオーナーのデータ。
const MAX_LENGTH = 20_000

export class UserRules {
  constructor({ root }) {
    this.directory = join(root, 'owner')
    this.path = join(this.directory, 'user-rules.md')
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true })
    if (!await exists(this.path)) await writeText(this.path, '')
    return this.get()
  }

  async get() {
    if (!await exists(this.path)) return this.initialize()
    return readFile(this.path, 'utf8')
  }

  async update(text) {
    if (typeof text !== 'string' || text.length > MAX_LENGTH) throw new Error('USER_RULES_INVALID')
    const normalized = `${text.replace(/\r\n/g, '\n').trim()}\n`
    await writeText(this.path, normalized)
    return normalized
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
