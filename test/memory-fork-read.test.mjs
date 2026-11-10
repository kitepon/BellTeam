// Fork reads (Owner 2026-11-10): recall/search with readOnly change nothing inside the project folder.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BellTeamMemory } from '../src/memory-service.mjs'

async function tree(root) {
  const out = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); out[path.slice(root.length)] = createHash('sha1').update(await readFile(path)).digest('hex') }
  return out
}

test('readOnly recall/search read the live stores without touching any project file; a missing store stays missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-fork-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'bots/bot-a'), b = join(root, 'bots/bot-b')
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true })
  const registry = new Map([['bot-a', { id: 'bot-a', project: a }], ['bot-b', { id: 'bot-b', project: b }]])
  const memory = new BellTeamMemory({ root, registry })
  await memory.remember({ botId: 'bot-a', content: 'ペンギンは南極にいる' })
  await memory.recordKnowledge({ botId: 'bot-a', title: 'ペンギン', content: 'ペンギンの手順' })
  const before = await tree(a)
  assert.ok(Object.keys(before).some(path => path.endsWith('memory.db')))
  const recalled = await memory.recallMemory({ botId: 'bot-a', query: 'ペンギン', readOnly: true })
  assert.equal(recalled.items.length, 1)
  const searched = await memory.searchKnowledge({ botId: 'bot-a', query: 'ペンギン', readOnly: true })
  assert.ok(searched.items.length >= 1)
  assert.deepEqual(await tree(a), before)
  assert.deepEqual((await memory.recallMemory({ botId: 'bot-b', query: 'x', readOnly: true })).items, [])
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-b', query: 'x', readOnly: true })).items, [])
  assert.deepEqual(await readdir(b), [])
})
