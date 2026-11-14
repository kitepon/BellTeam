import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { trustCodexHook } from '../src/rtk-hooks.mjs'

const command = 'node /x/testgate.mjs hook codex'

test('Codexのhandlerは、鍵とhashが示す未信頼の物だけを信頼し、信頼済みなら何も書かない', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-trust-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex/hooks.json'), '{}')
  const source = await realpath(join(home, '.codex/hooks.json'))
  const requests = []
  let trusted = false
  const appServer = async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    if (method === 'hooks/list') return { data: [{ hooks: [
      { key: 'other', command: 'other', sourcePath: source, enabled: false, trustStatus: 'untrusted', currentHash: 'sha256:o' },
      { key: `${source}:pre_tool_use:0:0`, command, sourcePath: source, enabled: trusted, trustStatus: trusted ? 'trusted' : 'untrusted', currentHash: 'sha256:r' },
    ] }] }
    if (method === 'config/batchWrite') { trusted = true; return {} }
    throw new Error(method)
  })
  await trustCodexHook(home, join(home, '.codex/hooks.json'), appServer, {}, command)
  assert.deepEqual(requests.filter(([method]) => method === 'config/batchWrite'), [['config/batchWrite', { filePath: join(home, '.codex/config.toml'), edits: [
    { keyPath: `hooks.state.${JSON.stringify(`${source}:pre_tool_use:0:0`)}.trusted_hash`, value: 'sha256:r', mergeStrategy: 'replace' },
    { keyPath: `hooks.state.${JSON.stringify(`${source}:pre_tool_use:0:0`)}.enabled`, value: true, mergeStrategy: 'replace' },
  ] }]])
  requests.length = 0
  await trustCodexHook(home, join(home, '.codex/hooks.json'), appServer, {}, command)
  assert.deepEqual(requests.map(([method]) => method), ['hooks/list'])
})

test('Codexの一覧にhandlerが無ければ失敗にする', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-trust-missing-'))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex/hooks.json'), '{}')
  await assert.rejects(trustCodexHook(home, join(home, '.codex/hooks.json'), async (_env, use) => use(async () => ({ data: [{ hooks: [] }] })), {}, command), /RTK_CODEX_HOOK_NOT_LISTED/u)
})
