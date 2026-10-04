#!/usr/bin/env node
// CursorのsessionStart hook。Cursor CLIはグローバルの ~/.cursor/AGENTS.md を読まないため、
// BellTeamが書いた起動時指示（オーナー情報・ユーザー規範・製品規範）を追加の指示として渡す。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.stdin.resume()
process.stdin.on('data', () => {})
let instructions = ''
try {
  instructions = await readFile(join(homedir(), '.cursor/AGENTS.md'), 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') process.stderr.write(`BellTeam: ~/.cursor/AGENTS.md を読めませんでした（${error.message}）\n`)
}
process.stdout.write(`${JSON.stringify(instructions.trim() ? { additional_context: instructions } : {})}\n`)
process.exit(0)
