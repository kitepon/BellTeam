import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { aitermEntry, aitermExecutionRegistration, aitermRegistration, aitermRelay, configureAitermHooks } from '../src/aiterm-hooks.mjs'

// A package root whose exports table maps each public entry name to a file that is NOT <name>.js, so a hard-coded path cannot pass.
const ENTRIES = ['setup-node', 'setup-integrations', 'execution-parent-worker', 'execution-native-setup', 'execution-native-server', 'child-result', 'resume-state-cli']
async function aitermRoot(exports = Object.fromEntries(ENTRIES.map(name => [`./${name}`, `./build/${name}.public.js`]))) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-root-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'aiterm-mcp', exports }))
  return root
}
const at = (root, name) => join(root, `build/${name}.public.js`)

test('入口は選んだ根のexportsの値から引き、無い入口や根の外を指す値は使わない', async () => {
  const root = await aitermRoot()
  assert.equal(aitermEntry(root, 'child-result'), at(root, 'child-result'))
  const old = await aitermRoot(undefined)
  await writeFile(join(old, 'package.json'), JSON.stringify({ name: 'aiterm-mcp', version: '0.70.57' }))
  for (const [r, name] of [[old, 'setup-node'], [root, 'model-handoff-control'], [await aitermRoot({ './setup-node': '../outside.js' }), 'setup-node'],
    [await aitermRoot({ './setup-node': { import: './x.js' } }), 'setup-node']])
    assert.throws(() => aitermEntry(r, name), { code: 'AITERM_ENTRY_UNAVAILABLE' })
})

test('停止用登録はAiterm自身が選ぶscopeと同じ配布物のproviderを使う', async () => {
  const root = await aitermRoot()
  const registration = await aitermExecutionRegistration({
    root,
    load: async path => path === at(root, 'setup-node')
      ? { setupNodeExecutable: () => process.execPath }
      : { localParentWorkerRuntime: { scope: () => ({ state_root: '/isolated/state', multiplexer: { kind: 'socket', key: '/isolated/tmux.sock' } }) } },
    resolveProvider: file => { assert.equal(file, at(root, 'execution-native-server')); return '/candidate/steer/index.js' },
  })
  assert.deepEqual(registration, {
    command: process.execPath,
    args: [at(root, 'execution-native-server'), '--execution-interrupt',
      '--state-root', '/isolated/state', '--socket', '/isolated/tmux.sock', '--steer-provider', '/candidate/steer/index.js'],
  })
})

test('native hookは登録済みMCPと同じ入口をAitermのnative setupへ渡し旧hookを作らない', async () => {
  const root = await aitermRoot()
  const registration = { command: process.execPath, args: [at(root, 'execution-native-server'), '--execution-interrupt'] }
  const expectedScope = { state_root: '/isolated/state', multiplexer: { kind: 'socket', key: '/isolated/tmux.sock' } }
  const providerFile = '/candidate/steer/index.js'
  const calls = []
  const result = await configureAitermHooks('/isolated/home', {
    registration, root, codex: '/candidate/codex',
    load: async path => {
      if (path === at(root, 'execution-native-server')) return { parseNativeExecutionArguments: args => {
        assert.deepEqual(args, ['--execution-interrupt']); return { expectedScope, providerFile }
      } }
      assert.equal(path, at(root, 'execution-native-setup'))
      return { configureNativeExecutionHooks: async (...args) => { calls.push(args); return { results: { codex: { status: 'ready' } } } } }
    },
  })
  assert.deepEqual(calls, [['/isolated/home', { registration, expectedScope, providerFile, codexBinary: '/candidate/codex' }]])
  assert.equal(result.codex.status, 'ready')
})

test('Aitermの登録はsetup-nodeのmcpRegistration()が返す形そのままにする', async () => {
  const root = await aitermRoot(), shape = { command: '/usr/local/bin/node', args: ['/anywhere/index.js'] }
  assert.deepEqual(
    await aitermRegistration({ root, load: async path => { assert.equal(path, at(root, 'setup-node')); return { mcpRegistration: () => shape } } }),
    shape,
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
  const calls = [], root = await aitermRoot()
  const result = await configureAitermHooks(home, {
    root,
    load: async path => path === at(root, 'setup-node')
      ? { mcpRegistration: () => ({ command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] }) }
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
  const outcome = { status: 'ready', changed: true }, root = await aitermRoot()
  const result = await configureAitermHooks(home, {
    root,
    runtimeCapture: { components: { 'runtime-codex': { bin: { codex: '/selected/codex' } } } },
    load: async path => path === at(root, 'setup-node')
      ? { mcpRegistration: () => ({ command: '/usr/local/bin/node', args: ['/aiterm/dist/index.js'] }) }
      : {
          mergeClaudeParentHooks: () => calls.push(['claude']),
          mergeCursorParentHooks: () => calls.push(['cursor']),
          ensureCodexParentSteer: async (...args) => { calls.push(['codex', ...args]); return outcome },
        },
  })
  assert.deepEqual(calls, [['claude'], ['cursor'], ['codex', home, { binary: '/selected/codex' }]])
  assert.deepEqual(result, { codex: outcome })
})
