import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { addClaudeHook, addCodexHook, addCursorHook, configureRtk, CODEX_RTK_COMMAND, grokHookConfig, testgateCommand, testgateEntry, TESTGATE_ENTRY } from '../src/rtk-hooks.mjs'

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

  await configureRtk(home, { withCodexAppServer, testgate: async () => null })

  // Claudeの項目も本家の `rtk init` を通さずに直接書く。
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')),
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } })
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
  await configureRtk(home, { withCodexAppServer, testgate: async () => null })
  assert.equal(JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse.length, 1)
  assert.deepEqual(requests.map(([method]) => method), ['hooks/list'])
})

test('Codexの一覧にRTKのhandlerが無ければ登録失敗にする', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-rtk-missing-'))
  await assert.rejects(configureRtk(home, {
    testgate: async () => null,
    withCodexAppServer: async (_env, use) => use(async () => ({ data: [{ hooks: [] }] })),
  }), /RTK_CODEX_HOOK_NOT_LISTED/u)
})

test('GrokのhookはBellTeamに同梱したスクリプトを/usr/local/bin/rtkで動かす', () => {
  const [group] = grokHookConfig('/app').hooks.PreToolUse
  assert.equal(group.matcher, '^run_terminal_command$')
  assert.deepEqual(group.hooks, [{ type: 'command', command: 'node /app/integrations/rtk/grok-hook.mjs', timeout: 5, env: { RTK_BIN: '/usr/local/bin/rtk' } }])
})

test('関所の実体がある設置では同じ位置でcommandだけを関所へ替え、実体が無くなれば元へ戻す', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-rtk-gate-'))
  // 入口の道は決まった1つ。実体の有無だけを差し替えて試す。
  const entry = TESTGATE_ENTRY
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'other', timeout: 3 }] }
  const last = { matcher: '^mcp__x$', hooks: [{ type: 'command', command: 'last' }] }
  for (const name of ['.claude', '.codex', '.cursor']) await mkdir(join(home, name), { recursive: true })
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Read(x)'] }, hooks: {
    Stop: [{ hooks: [throughline] }],
    PreToolUse: [other, { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }, last],
  } }))
  await writeFile(join(home, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CODEX_RTK_COMMAND }] }] } }))
  await writeFile(join(home, '.cursor/hooks.json'), JSON.stringify({ version: 2, hooks: { preToolUse: [{ command: 'y' }, { command: 'rtk hook cursor', matcher: 'Shell' }, { command: 'z' }] } }))
  const source = await realpath(join(home, '.codex/hooks.json'))
  const key = `${source}:pre_tool_use:0:0`
  const trusted = new Set([CODEX_RTK_COMMAND])
  const writes = []
  const listed = async () => JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
  const withCodexAppServer = async (_env, use) => use(async (method, params) => {
    const command = await listed()
    if (method === 'hooks/list') return { data: [{ hooks: [{ key, command, sourcePath: source,
      enabled: true, trustStatus: trusted.has(command) ? 'trusted' : 'untrusted', currentHash: `sha256:${command}` }] }] }
    if (method === 'config/batchWrite') { writes.push(params.edits); trusted.add(command); return {} }
    throw new Error(method)
  })
  const json = async path => JSON.parse(await readFile(join(home, path), 'utf8'))

  await configureRtk(home, { withCodexAppServer, testgate: async () => entry })

  const claude = await json('.claude/settings.json')
  assert.deepEqual(claude.permissions, { deny: ['Read(x)'] })
  assert.deepEqual(claude.hooks.Stop, [{ hooks: [throughline] }])
  assert.deepEqual(claude.hooks.PreToolUse, [other, { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${entry} hook claude` }] }, last])
  assert.deepEqual((await json('.codex/hooks.json')).hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${entry} hook codex` }] }])
  // 鍵は位置で決まるので同じ鍵のまま、関所のcommandのhashを信頼する。
  assert.deepEqual(writes, [[
    { keyPath: `hooks.state.${JSON.stringify(key)}.trusted_hash`, value: `sha256:node ${entry} hook codex`, mergeStrategy: 'replace' },
    { keyPath: `hooks.state.${JSON.stringify(key)}.enabled`, value: true, mergeStrategy: 'replace' },
  ]])
  assert.deepEqual(await json('.cursor/hooks.json'), { version: 2, hooks: { preToolUse: [{ command: 'y' }, { command: `node ${entry} hook cursor`, matcher: 'Shell' }, { command: 'z' }] } })
  assert.deepEqual(await json('.grok/hooks/rtk.json'), grokHookConfig(undefined, entry))

  // 2回目は何も書かない。
  writes.length = 0
  const before = await readFile(join(home, '.claude/settings.json'), 'utf8')
  await configureRtk(home, { withCodexAppServer, testgate: async () => entry })
  assert.equal(await readFile(join(home, '.claude/settings.json'), 'utf8'), before)
  assert.deepEqual(writes, [])

  // 実体が無くなった設置では、同じ位置でRTKを直接呼ぶ形へ戻す。
  await configureRtk(home, { withCodexAppServer, testgate: async () => null })
  assert.deepEqual((await json('.claude/settings.json')).hooks.PreToolUse, [other, { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }, last])
  assert.equal((await json('.codex/hooks.json')).hooks.PreToolUse[0].hooks[0].command, CODEX_RTK_COMMAND)
  assert.deepEqual((await json('.cursor/hooks.json')).hooks.preToolUse, [{ command: 'y' }, { command: 'rtk hook cursor', matcher: 'Shell' }, { command: 'z' }])
  assert.deepEqual(await json('.grok/hooks/rtk.json'), grokHookConfig())
})

test('共通の置き場の関所の項目は、実体が無い設置でもBellTeamの項目として元へ戻す', () => {
  const gated = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: testgateCommand(TESTGATE_ENTRY, 'claude') }] }] } }
  assert.deepEqual(addClaudeHook(gated).hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }])
  assert.equal(addClaudeHook(gated, TESTGATE_ENTRY), gated)
})

test('RTKを直接呼ぶ項目と関所ごしの項目が両方ある設定は、どちらも消さずに登録の失敗にする', () => {
  const both = harness => [`rtk hook ${harness}`, testgateCommand(TESTGATE_ENTRY, harness)]
  const groups = harness => both(harness).map(command => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] }))
  assert.throws(() => addClaudeHook({ hooks: { PreToolUse: groups('claude') } }, TESTGATE_ENTRY), /RTK_HOOK_DUPLICATED: Claude/u)
  assert.throws(() => addCodexHook({ hooks: { PreToolUse: groups('codex') } }), /RTK_HOOK_DUPLICATED: Codex/u)
  assert.throws(() => addCursorHook({ hooks: { preToolUse: both('cursor').map(command => ({ command, matcher: 'Shell' })) } }, TESTGATE_ENTRY), /RTK_HOOK_DUPLICATED: Cursor/u)
})

test('関所の入口は、読める実体がある時だけpathを返す', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-rtk-entry-'))
  const path = join(home, 'testgate.mjs')
  assert.equal(await testgateEntry({ path }), null)
  await writeFile(path, '')
  assert.equal(await testgateEntry({ path }), path)
})

test('関所がある設置のGrokのhookは、同じtimeoutとRTK_BINのままcommandだけが関所になる', () => {
  const [group] = grokHookConfig('/app', TESTGATE_ENTRY).hooks.PreToolUse
  assert.equal(group.matcher, '^run_terminal_command$')
  assert.deepEqual(group.hooks, [{ type: 'command', command: 'node /srv/bellteam/shared/tools/testgate/current/bin/testgate.mjs hook grok', timeout: 5, env: { RTK_BIN: '/usr/local/bin/rtk' } }])
})
