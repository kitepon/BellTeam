import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { addCursorInstructionsHook, configureCursorInstructions, cursorInstructionsCommand } from '../src/cursor-instructions.mjs'

const execFileAsync = promisify(execFile)
const hookScript = new URL('../integrations/cursor/instructions-hook.mjs', import.meta.url).pathname

test('CursorのsessionStartへ起動時指示のhookを一度だけ足し、他のhookとversionは残す', () => {
  const command = cursorInstructionsCommand('/app', '/usr/local/bin/node')
  assert.equal(command, "'/usr/local/bin/node' '/app/integrations/cursor/instructions-hook.mjs'")
  assert.deepEqual(addCursorInstructionsHook({}, command), { version: 1, hooks: { sessionStart: [{ command, timeout: 10 }] } })
  const others = [{ command: 'throughline session-start', timeout: 10 }, { command: "'node' 'approval-box/cli.mjs' cursor-context", timeout: 10 }]
  const current = { version: 2, hooks: { sessionStart: others, preToolUse: [{ command: 'rtk hook cursor', matcher: 'Shell' }] } }
  const next = addCursorInstructionsHook(current, command)
  assert.deepEqual(next, { version: 2, hooks: { ...current.hooks, sessionStart: [...others, { command, timeout: 10 }] } })
  assert.equal(addCursorInstructionsHook(next, command), next)
})

test('置き場が変わった古い自分の項目だけを差し替える', () => {
  const old = { command: "'/old/node' '/old/app/integrations/cursor/instructions-hook.mjs'", timeout: 10 }
  const other = { command: 'throughline session-start', timeout: 10 }
  const command = cursorInstructionsCommand('/app', '/usr/local/bin/node')
  assert.deepEqual(addCursorInstructionsHook({ hooks: { sessionStart: [old, other] } }, command).hooks.sessionStart, [other, { command, timeout: 10 }])
})

test('形の壊れたhooks.jsonは書き換えずに失敗する', async () => {
  assert.throws(() => addCursorInstructionsHook({ hooks: { sessionStart: {} } }), /CURSOR_HOOK_CONFIG_INVALID/u)
  const home = await mkdtemp(join(tmpdir(), 'bellteam-cursor-invalid-'))
  await mkdir(join(home, '.cursor'))
  await writeFile(join(home, '.cursor/hooks.json'), '{')
  await assert.rejects(configureCursorInstructions(home), /CURSOR_HOOK_CONFIG_INVALID/u)
  assert.equal(await readFile(join(home, '.cursor/hooks.json'), 'utf8'), '{')
})

test('設定を書き、二度目は書き換えない', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-cursor-config-'))
  await configureCursorInstructions(home, { command: 'hook' })
  const first = await readFile(join(home, '.cursor/hooks.json'), 'utf8')
  assert.deepEqual(JSON.parse(first), { version: 1, hooks: { sessionStart: [{ command: 'hook', timeout: 10 }] } })
  await configureCursorInstructions(home, { command: 'hook' })
  assert.equal(await readFile(join(home, '.cursor/hooks.json'), 'utf8'), first)
})

test('hookは ~/.cursor/AGENTS.md の全文を追加の指示として返し、無ければ空で返す', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-cursor-hook-'))
  const run = () => execFileAsync(process.execPath, [hookScript], { env: { ...process.env, HOME: home } })
  assert.deepEqual(JSON.parse((await run()).stdout), {})
  await mkdir(join(home, '.cursor'))
  await writeFile(join(home, '.cursor/AGENTS.md'), '# BellTeam 共通規範\n\n- 規範\n')
  assert.deepEqual(JSON.parse((await run()).stdout), { additional_context: '# BellTeam 共通規範\n\n- 規範\n' })
})
