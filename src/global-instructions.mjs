import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ownerInstructions } from './owner-profile.mjs'
import { userRulesInstructions } from './user-rules.mjs'
import { runtimeHome } from './runtime-home.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// 全Bot共通の起動時指示（オーナー情報 → ユーザー規範 → 製品規範）を各CLIのグローバル設定へ書く。bootstrapとMCPの両方が呼ぶ。
export function createGlobalInstructionsRefresher({ ownerProfile, userRules, home = runtimeHome() }) {
  return async function refreshGlobalInstructions() {
    const commonRules = await readFile(join(appRoot, 'config/common-agents.md'), 'utf8')
    const instructions = `${ownerInstructions(await ownerProfile.get())}\n\n${userRulesInstructions(await userRules.get())}\n\n${commonRules}`
    await Promise.all([
      writeFile(join(home, '.claude/AGENTS.md'), instructions, { mode: 0o600 }),
      writeFile(join(home, '.claude/CLAUDE.md'), '@AGENTS.md\n', { mode: 0o600 }),
      writeFile(join(home, '.codex/AGENTS.md'), instructions, { mode: 0o600 }),
      writeFile(join(home, '.grok/AGENTS.md'), instructions, { mode: 0o600 }),
      writeFile(join(home, '.cursor/AGENTS.md'), instructions, { mode: 0o600 }),
    ])
  }
}
