import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { writeHarnessConfig } from '../src/harness-config.mjs'

test('3共有JSONは旧読者へ完成文書を保ち、管理外項目を保持して新文書を公開する', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-atomic-registration-'))
  const readers = []
  t.after(async () => {
    await Promise.all(readers.map(({ reader }) => reader.close()))
    await rm(home, { recursive: true, force: true })
  })
  const initial = { custom: 'keep'.repeat(250000), mcpServers: { custom: { command: 'keep' }, bellteam: { command: 'old' } },
    projects: { '/synthetic/bot': { allowedTools: ['keep'], hasTrustDialogAccepted: false } } }
  for (const file of ['.claude.json', '.cursor/mcp.json', '.gemini/config/mcp_config.json']) {
    const path = join(home, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(initial))
    const reader = await open(path, 'r')
    readers.push({ path, reader })
  }
  await writeHarnessConfig(new Map([['bot', { id: 'bot', project: '/synthetic/bot' }]]), home, {
    aiterm: async () => ({ command: '/synthetic/node', args: ['/synthetic/native.js'] }), relay: async () => null,
  })
  for (const { path, reader } of readers) {
    assert.deepEqual(JSON.parse(await reader.readFile('utf8')), initial)
    const current = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(current.custom, initial.custom)
    assert.deepEqual(current.mcpServers.custom, initial.mcpServers.custom)
    assert.ok(current.mcpServers.bellteam.url || current.mcpServers.bellteam.args)
    assert.deepEqual(current.projects['/synthetic/bot'].allowedTools, ['keep'])
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    if (path.endsWith('.claude.json')) assert.equal(current.projects['/synthetic/bot'].hasTrustDialogAccepted, true)
  }
})
