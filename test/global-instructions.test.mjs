import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { renderGlobalInstructions } from '../src/members/instructions.mjs'
import { operateMembersProject } from '../src/members-project-files.mjs'

// The CLI homes' AGENTS.md has one writer (members global.writeInstructions, bd14 E4). Every home gets the whole body;
// Antigravity is no longer a BellTeam harness (a353), so its home is not written (the former 24,000 B split is gone).
test('the global instructions reach the four CLI homes whole and no Antigravity home is written', async t => {
  const common = await readFile(new URL('../config/common-agents.md', import.meta.url), 'utf8')
  const body = renderGlobalInstructions({ name: 'fixture', profile: '', xUrl: '', githubUrl: '', links: [] }, 'fixture owner rule\n'.repeat(1500), common)
  assert.ok(body.includes('fixture owner rule') && Buffer.byteLength(body) > 48000)

  const root = await mkdtemp(join(process.cwd(), '.global-instructions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'); await mkdir(home)
  for (const cli of ['.claude', '.codex', '.grok', '.cursor']) await mkdir(join(home, cli))
  await operateMembersProject({ root, home }, 'global.writeInstructions', { body })
  for (const cli of ['.claude', '.codex', '.grok', '.cursor']) assert.equal(await readFile(join(home, cli, 'AGENTS.md'), 'utf8'), body)
  assert.deepEqual((await readdir(home)).sort(), ['.claude', '.codex', '.cursor', '.grok'])
})
