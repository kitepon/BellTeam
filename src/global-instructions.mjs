import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// The CLI homes' AGENTS.md / CLAUDE.md have one writer: the members module (members-project-files.mjs; bd14 E4).

// shortcut: the model section moved to the user rules, so this reads '' from the common rules; delete it with the execution inventory gate.
export async function taskSettingsReminder() {
  const commonRules = await readFile(join(appRoot, 'config/common-agents.md'), 'utf8')
  return commonRules.match(/(?:^|\n)(SECTION models\n[\s\S]*?)(?=\n\n|$)/)?.[1] ?? ''
}
