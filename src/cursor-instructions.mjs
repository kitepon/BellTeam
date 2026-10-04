// Cursor CLIはグローバルの ~/.cursor/AGENTS.md を読まない（実測 2026-10-03、cursor-agent 2026.10.01）。
// BellTeamの起動時指示をCursorの席へ届けるため、sessionStartに指示を渡すhookを登録する。
// BellTeamが足すのは自分の項目だけで、他のhook（Throughline、Approval Boxなど）の位置と中身は変えない。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOK_SCRIPT = 'integrations/cursor/instructions-hook.mjs'

export function cursorInstructionsCommand(root = appRoot, node = process.execPath) {
  return `'${node}' '${join(root, HOOK_SCRIPT)}'`
}

export function addCursorInstructionsHook(current, command = cursorInstructionsCommand()) {
  if (!isObject(current) || (current.hooks !== undefined && !isObject(current.hooks))) throw new Error('CURSOR_HOOK_CONFIG_INVALID')
  const hooks = current.hooks ?? {}
  if (hooks.sessionStart !== undefined && !Array.isArray(hooks.sessionStart)) throw new Error('CURSOR_HOOK_CONFIG_INVALID')
  const entries = hooks.sessionStart ?? []
  if (entries.some(entry => entry?.command === command)) return current
  // 置き場が変わった古い自分の項目だけを外す。
  const others = entries.filter(entry => !String(entry?.command ?? '').includes(HOOK_SCRIPT))
  return { version: 1, ...current, hooks: { ...hooks, sessionStart: [...others, { command, timeout: 10 }] } }
}

export async function configureCursorInstructions(home, { command } = {}) {
  const path = join(home, '.cursor/hooks.json')
  let text = null
  try { text = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  let current = {}
  if (text !== null) {
    try { current = JSON.parse(text.replace(/^﻿/u, '')) } catch { throw new Error(`CURSOR_HOOK_CONFIG_INVALID: ${path}`) }
  }
  const next = addCursorInstructionsHook(current, command)
  if (text !== null && next === current) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
