import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { renderGlobalInstructions } from '../src/members/instructions.mjs'
import { operateMembersProject } from '../src/members-project-files.mjs'

const LIMIT = 24000
const frontmatter = /^---\ntrigger: always_on\ndescription: BellTeam global instructions \(part (\d+)\)\n---\n/u

// The CLI homes' AGENTS.md has one writer (members global.writeInstructions, bd14 E4). Antigravity truncates one file at
// 24,000 B, so its home gets the body split into rule files (a147); the other homes get the whole body.
test('the global instructions reach Antigravity whole in <=24,000 B files and the other homes unchanged', async t => {
  const common = await readFile(new URL('../config/common-agents.md', import.meta.url), 'utf8')
  // Room for the coming Owner rulings: the body must split, not just fit.
  const owner = 'fixture owner rule\n'.repeat(1500)
  const body = renderGlobalInstructions({ name: 'fixture', profile: '', xUrl: '', githubUrl: '', links: [] }, owner, common)
  assert.ok(body.includes('fixture owner rule') && Buffer.byteLength(body) > 2 * LIMIT)

  const root = await mkdtemp(join(process.cwd(), '.global-instructions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'); await mkdir(home)
  for (const cli of ['.claude', '.codex', '.grok', '.cursor', '.gemini']) await mkdir(join(home, cli))
  const write = text => operateMembersProject({ root, home }, 'global.writeInstructions', { body: text })
  const rules = join(home, '.gemini/config/rules')
  // A stale part from a longer earlier body must go.
  await write(body + 'x\n'.repeat(30000))
  const before = (await readdir(rules)).length
  await write(body)
  assert.ok((await readdir(rules)).length < before)

  for (const cli of ['.claude', '.codex', '.grok', '.cursor']) assert.equal(await readFile(join(home, cli, 'AGENTS.md'), 'utf8'), body)
  const files = [join(home, '.gemini/AGENTS.md'), ...(await readdir(rules)).sort((a, b) => parseInt(a.match(/\d+/u)) - parseInt(b.match(/\d+/u))).map(name => join(rules, name))]
  assert.ok(files.length >= 3)
  const parts = []
  for (const [index, path] of files.entries()) {
    const text = await readFile(path, 'utf8')
    assert.ok(Buffer.byteLength(text) <= LIMIT, `${path} is ${Buffer.byteLength(text)} B`)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    if (index === 0) { parts.push(text); continue }
    assert.equal(text.match(frontmatter)?.[1], String(index + 1))
    parts.push(text.replace(frontmatter, ''))
  }
  assert.equal(parts.join(''), body, 'the parts rejoin to the whole body, nothing dropped or reordered')
  assert.ok(parts.slice(0, -1).every(part => part.endsWith('\n')), 'every cut is at a line boundary')

  // A body that fits stays one file and removes every part.
  await write('short\n')
  assert.equal(await readFile(join(home, '.gemini/AGENTS.md'), 'utf8'), 'short\n')
  assert.deepEqual(await readdir(rules), [])
})
