import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { aitermExecutionRegistration, aitermRegistration, aitermRelay, configureAitermHooks } from '../src/aiterm-hooks.mjs'

test('停止用登録はAiterm自身が選ぶscopeと同じ配布物のproviderを使う', async () => {
  const registration = await aitermExecutionRegistration({
    dist: '/candidate/aiterm/dist',
    load: async path => path.endsWith('setup-node.js')
      ? { setupNodeExecutable: () => process.execPath }
      : { localParentWorkerRuntime: { scope: () => ({ state_root: '/isolated/state', multiplexer: { kind: 'socket', key: '/isolated/tmux.sock' } }) } },
    resolveProvider: file => { assert.equal(file, '/candidate/aiterm/dist/execution-native-server.js'); return '/candidate/steer/index.js' },
  })
  assert.deepEqual(registration, {
    command: process.execPath,
    args: ['/candidate/aiterm/dist/execution-native-server.js', '--execution-interrupt',
      '--state-root', '/isolated/state', '--socket', '/isolated/tmux.sock', '--steer-provider', '/candidate/steer/index.js'],
  })
})

test('native hookは登録済みMCPと同じ入口をAitermのnative setupへ渡し旧hookを作らない', async () => {
  const registration = { command: process.execPath, args: ['/candidate/aiterm/dist/execution-native-server.js', '--execution-interrupt'] }
  const expectedScope = { state_root: '/isolated/state', multiplexer: { kind: 'socket', key: '/isolated/tmux.sock' } }
  const providerFile = '/candidate/steer/index.js'
  const calls = []
  const result = await configureAitermHooks('/isolated/home', {
    registration, codex: '/candidate/codex',
    load: async path => {
      assert.ok(path.startsWith('/candidate/aiterm/dist/'))
      if (path.endsWith('/execution-native-server.js')) return { parseNativeExecutionArguments: args => {
        assert.deepEqual(args, ['--execution-interrupt']); return { expectedScope, providerFile }
      } }
      assert.ok(path.endsWith('/execution-native-setup.js'))
      return { configureNativeExecutionHooks: async (...args) => { calls.push(args); return { results: { codex: { status: 'ready' } } } } }
    },
  })
  assert.deepEqual(calls, [['/isolated/home', { registration, expectedScope, providerFile, codexBinary: '/candidate/codex' }]])
  assert.equal(result.codex.status, 'ready')
})

test('Aitermの登録はnodeの絶対pathと同梱のindex.jsにする', async () => {
  assert.deepEqual(
    await aitermRegistration({ dist: '/aiterm/dist', load: async () => ({ setupNodeExecutable: () => '/usr/local/bin/node' }) }),
    { command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] },
  )
})

test('中継は、実行できる実体がある時だけそのpathを返す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-relay-path-'))
  const path = join(directory, 'mcp-lazy')
  assert.equal(await aitermRelay({ path }), null)
  await writeFile(path, '#!/bin/sh\n')
  assert.equal(await aitermRelay({ path }), null)
  await chmod(path, 0o755)
  assert.equal(await aitermRelay({ path }), path)
})

test('Aitermの親配送hookだけをClaudeとCursorの共有設定へ登録する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-hooks-'))
  const calls = []
  const result = await configureAitermHooks(home, {
    dist: '/aiterm/dist',
    load: async path => path.endsWith('setup-node.js')
      ? { setupNodeExecutable: () => '/usr/local/bin/node' }
      : {
          mergeClaudeParentHooks: (file, registration) => calls.push(['claude', file, registration]),
          mergeCursorParentHooks: (file, registration) => calls.push(['cursor', file, registration]),
        },
  })
  const registration = { command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] }
  assert.deepEqual(calls, [
    ['claude', join(home, '.claude/settings.json'), registration],
    ['cursor', join(home, '.cursor/hooks.json'), registration],
  ])
  // Codexの入口が無いAiterm（0.56.0より前）では、Codexの分は登録しない。
  assert.deepEqual(result, { codex: null })
})

test('Codexの親配送hookは、Aitermに入口がある時に、コンテナのCodexを渡して登録する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-codex-hooks-'))
  const calls = []
  const outcome = { status: 'ready', changed: true }
  const result = await configureAitermHooks(home, {
    dist: '/aiterm/dist',
    load: async path => path.endsWith('setup-node.js')
      ? { setupNodeExecutable: () => '/usr/local/bin/node' }
      : {
          mergeClaudeParentHooks: () => calls.push(['claude']),
          mergeCursorParentHooks: () => calls.push(['cursor']),
          ensureCodexParentSteer: async (...args) => { calls.push(['codex', ...args]); return outcome },
        },
  })
  assert.deepEqual(calls, [['claude'], ['cursor'], ['codex', home, { binary: '/usr/local/bin/codex' }]])
  assert.deepEqual(result, { codex: outcome })
})
