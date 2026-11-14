import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// The CLI homes' AGENTS.md / CLAUDE.md have one writer: the members module (members-project-files.mjs; bd14 E4).

// 起動時の規範と各配送の見直し文を同じ正本から読む。
export async function taskSettingsReminder() {
  const commonRules = await readFile(join(appRoot, 'config/common-agents.md'), 'utf8')
  return commonRules.match(/(?:^|\n)(SECTION models\n[\s\S]*?)(?=\n\n|$)/)?.[1] ?? ''
}
