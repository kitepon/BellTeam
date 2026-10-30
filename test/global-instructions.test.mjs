import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGlobalInstructionsRefresher } from '../src/global-instructions.mjs'

test('Antigravityのglobal AGENTSにも同じ最新規範を書き、既存4種と分岐させない', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-global-instructions-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directories = ['.claude', '.codex', '.grok', '.cursor', '.gemini']
  await Promise.all(directories.map(name => mkdir(join(home, name))))
  let rules = 'fixture owner rule'
  const refresh = createGlobalInstructionsRefresher({ home,
    ownerProfile: { get: async () => ({ name: 'fixture', profile: '', xUrl: '', githubUrl: '', links: [] }) },
    userRules: { get: async () => rules },
  })
  for (const value of ['fixture owner rule', 'updated fixture owner rule']) {
    rules = value
    await refresh()
    const expected = await readFile(join(home, '.codex/AGENTS.md'), 'utf8')
    assert.ok(expected.includes(value))
    assert.ok(Buffer.byteLength(expected) <= 24000, 'current common rules must fit the documented Antigravity file budget')
    for (const directory of directories) {
      const path = join(home, directory, 'AGENTS.md')
      assert.equal(await readFile(path, 'utf8'), expected)
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }
  }
})
