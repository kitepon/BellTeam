import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderGlobalInstructions } from '../src/members/instructions.mjs'

// The CLI homes' AGENTS.md has one writer (members global.writeInstructions, bd14 E4); its text must fit Antigravity's budget.
test('the rendered global instructions fit the documented Antigravity file budget', async () => {
  const common = await readFile(new URL('../config/common-agents.md', import.meta.url), 'utf8')
  const text = renderGlobalInstructions({ name: 'fixture', profile: '', xUrl: '', githubUrl: '', links: [] }, 'fixture owner rule', common)
  assert.ok(text.includes('fixture owner rule'))
  assert.ok(Buffer.byteLength(text) <= 24000)
})
