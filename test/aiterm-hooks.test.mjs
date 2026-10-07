import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { aitermRegistration, aitermRelay, configureAitermHooks } from '../src/aiterm-hooks.mjs'

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
