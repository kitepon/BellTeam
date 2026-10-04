import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { addCodexHook, addCursorHook, configureRtk, CODEX_RTK_COMMAND, grokHookConfig } from '../src/rtk-hooks.mjs'

const throughline = { type: 'command', command: 'node throughline.mjs codex-hook stop' }

test('CodexのPreToolUse末尾へRTKを一度だけ足し、他のhookの位置を変えない', () => {
  const current = { hooks: {
    Stop: [{ hooks: [throughline] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }],
  } }
  const next = addCodexHook(current)
  assert.deepEqual(next.hooks.Stop, current.hooks.Stop)
  assert.deepEqual(next.hooks.PreToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: CODEX_RTK_COMMAND }] },
  ])
  assert.equal(addCodexHook(next), next)
  assert.throws(() => addCodexHook({ hooks: { PreToolUse: {} } }), /RTK_HOOK_CONFIG_INVALID/u)
})

test('CursorのpreToolUseへRTKを一度だけ足し、versionは既存の値を残す', () => {
  assert.deepEqual(addCursorHook({}), { version: 1, hooks: { preToolUse: [{ command: 'rtk hook cursor', matcher: 'Shell' }] } })
  const current = { version: 2, hooks: { stop: [{ command: 'x' }], preToolUse: [{ command: 'y' }] } }
  const next = addCursorHook(current)
  assert.equal(next.version, 2)
  assert.deepEqual(next.hooks.stop, [{ command: 'x' }])
  assert.deepEqual(next.hooks.preToolUse, [{ command: 'y' }, { command: 'rtk hook cursor', matcher: 'Shell' }])
  assert.equal(addCursorHook(next), next)
})

test('RTKを4つのハーネスへ登録し、CodexはRTKのhandlerだけを信頼する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-rtk-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex/hooks.json'), `﻿${JSON.stringify({ hooks: { Stop: [{ hooks: [throughline] }] } })}`)
  const runs = []
  const requests = []
  const source = await realpath(join(home, '.codex/hooks.json')).catch(() => join(home, '.codex/hooks.json'))
  let trusted = false
  const withCodexAppServer = async (env, use) => {
    assert.equal(env.HOME, home)
    return use(async (method, params) => {
      requests.push([method, params])
      if (method === 'hooks/list') return { data: [{ hooks: [
        { key: `${source}:stop:0:0`, command: throughline.command, sourcePath: source, enabled: true, trustStatus: 'trusted', currentHash: 'sha256:t' },
        { key: `${source}:pre_tool_use:0:0`, command: CODEX_RTK_COMMAND, sourcePath: source,
          enabled: trusted, trustStatus: trusted ? 'trusted' : 'untrusted', currentHash: 'sha256:r' },
      ] }] }
      if (method === 'config/batchWrite') { trusted = true; return {} }
      throw new Error(method)
    })
  }

  await configureRtk(home, { run: async (...args) => runs.push(args), withCodexAppServer })

  assert.deepEqual(runs.map(([command, args]) => [command, args]), [['rtk', ['init', '-g', '--hook-only', '--auto-patch', '--no-trust-filters']]])
  assert.equal(runs[0][2].env.HOME, home)
  assert.equal(runs[0][2].env.RTK_TELEMETRY_DISABLED, '1')
  const codex = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [throughline] }])
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, CODEX_RTK_COMMAND)
  const writes = requests.filter(([method]) => method === 'config/batchWrite')
  assert.deepEqual(writes, [['config/batchWrite', { filePath: join(home, '.codex/config.toml'), edits: [
    { keyPath: `hooks.state.${JSON.stringify(`${source}:pre_tool_use:0:0`)}.trusted_hash`, value: 'sha256:r', mergeStrategy: 'replace' },
    { keyPath: `hooks.state.${JSON.stringify(`${source}:pre_tool_use:0:0`)}.enabled`, value: true, mergeStrategy: 'replace' },
  ] }]])
  assert.deepEqual(JSON.parse(await readFile(join(home, '.cursor/hooks.json'), 'utf8')).hooks.preToolUse,
    [{ command: 'rtk hook cursor', matcher: 'Shell' }])
  assert.deepEqual(JSON.parse(await readFile(join(home, '.grok/hooks/rtk.json'), 'utf8')), grokHookConfig())

  // 2回目は何も書き足さず、信頼済みなので承認も書かない。
  requests.length = 0
  await configureRtk(home, { run: async () => {}, withCodexAppServer })
  assert.equal(JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse.length, 1)
  assert.deepEqual(requests.map(([method]) => method), ['hooks/list'])
})

test('Codexの一覧にRTKのhandlerが無ければ登録失敗にする', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-rtk-missing-'))
  await assert.rejects(configureRtk(home, {
    run: async () => {},
    withCodexAppServer: async (_env, use) => use(async () => ({ data: [{ hooks: [] }] })),
  }), /RTK_CODEX_HOOK_NOT_LISTED/u)
})

test('GrokのhookはBellTeamに同梱したスクリプトを/usr/local/bin/rtkで動かす', () => {
  const [group] = grokHookConfig('/app').hooks.PreToolUse
  assert.equal(group.matcher, '^run_terminal_command$')
  assert.deepEqual(group.hooks, [{ type: 'command', command: 'node /app/integrations/rtk/grok-hook.mjs', timeout: 5, env: { RTK_BIN: '/usr/local/bin/rtk' } }])
})
