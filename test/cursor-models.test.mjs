import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { cursorBaseModels, cursorModelCatalog, parseCursorCatalog } from '../src/cursor-models.mjs'

test('完成形IDからエフォートと-fastを剥がし、素のmodel IDだけを順序と重複なしで返す', () => {
  const catalog = [
    'auto',
    'claude-opus-5-thinking-high',
    'claude-opus-5-thinking-high-fast',
    'gpt-5.6-sol-high',
    'claude-opus-5-low',
    'claude-opus-5-high-fast',
    'gpt-5.5-extra-high',
    'gpt-5.5-extra-high-fast',
    'gpt-5.5-none-fast',
    'gemini-3.6-flash-minimal',
    'gpt-5.2-fast',
    'gpt-5.2',
    'claude-4.6-sonnet-medium-thinking',
    'claude-4.6-opus-high-thinking',
    'kimi-k2.7-code',
  ]
  assert.deepEqual(cursorBaseModels(catalog), [
    'auto',
    'claude-opus-5-thinking',
    'gpt-5.6-sol',
    'claude-opus-5',
    'gpt-5.5',
    'gemini-3.6-flash',
    'gpt-5.2',
    'kimi-k2.7-code',
  ])
})

test('cursor-agent models の出力を解析し、ANSIと見出しを除いてIDだけを返す', () => {
  const text = '\x1b[1mAvailable models\x1b[0m\n\nauto - Auto (default)\ngpt-5.2 - GPT-5.2\n'
  assert.deepEqual(parseCursorCatalog(text), ['auto', 'gpt-5.2'])
  assert.throws(() => parseCursorCatalog('nothing here'), /CURSOR_CATALOG_INVALID/u)
})

test('素のmodel IDごとに、完成形があるエフォートだけを選べる順で並べる', () => {
  const catalog = [
    'auto',
    'gpt-5.5-extra-high-fast',
    'gpt-5.5-none',
    'gpt-5.5-low',
    'muse-spark-1.3-minimal',
    'muse-spark-1.3-max',
    'gpt-5.2',
    'gpt-5.2-high',
  ]
  assert.deepEqual(cursorModelCatalog(catalog), [
    { id: 'auto', efforts: [] },
    { id: 'gpt-5.5', efforts: ['none', 'low', 'extra-high'] },
    { id: 'muse-spark-1.3', efforts: ['max'] },
    { id: 'gpt-5.2', efforts: ['high'] },
  ])
})

test('config/models.json は全CLIで、モデルのエフォートがCLI全体の範囲に収まる', async () => {
  const catalog = JSON.parse(await readFile(new URL('../config/models.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(catalog).sort(), ['claude', 'codex', 'cursor', 'grok'])
  for (const [harness, entry] of Object.entries(catalog)) {
    assert.ok(entry.models.length > 0, harness)
    for (const model of entry.models)
      for (const effort of model.efforts) assert.ok(entry.efforts.includes(effort), `${harness} ${model.id} ${effort}`)
  }
  const cursorIds = catalog.cursor.models.map(model => model.id)
  assert.deepEqual(cursorBaseModels(cursorIds), cursorIds)
  assert.ok(cursorIds.includes('auto'))
})
