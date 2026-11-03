import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BellTeamMemory } from '../src/memory-service.mjs'
import { MEMORY_SEARCH_INDEX_VERSION } from '../src/memory-search.mjs'
import { MEMORY_STATE_COMPATIBILITY, assertMemoryStateCompatibility } from '../src/memory/state-compatibility.mjs'
import { MEMORY_STATE_COMPATIBILITY as dispatcherCompatibility, createMemoryDispatcher } from '../src/memory/dispatcher.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'memory-compatibility-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'bots/bot-synthetic')
  const service = new BellTeamMemory({ root, registry: new Map([['bot-synthetic', { id: 'bot-synthetic', project }]]) })
  await service.initialize()
  const db = await service.openMemory('bot-synthetic', 'personal')
  db.close()
  return { root, project, service }
}

test('互換宣言のuser_versionと必須DDL指紋が現serviceの人工DBに一致する', async t => {
  const { project } = await fixture(t)
  for (const [name, path] of [['memory', 'memory/memory.db'], ['knowledge', 'rag/index.db']]) {
    const db = new DatabaseSync(join(project, path))
    try {
      const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
        .all().map(row => [row.type, row.name, row.tbl_name, row.sql])
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, MEMORY_STATE_COMPATIBILITY[`${name}UserVersion`])
      assert.equal(createHash('sha256').update(JSON.stringify(schema)).digest('hex'), MEMORY_STATE_COMPATIBILITY[`${name}RequiredSchemaSha256`])
    } finally { db.close() }
  }
})

test('UTF-8とfrontmatter保存項目・両DBに保存した索引版を実ファイルで確認する', async t => {
  const { project, service } = await fixture(t)
  const note = await service.recordKnowledge({ botId: 'bot-synthetic', title: '形式の確認', content: '同じ保存形式を使います', tags: ['人工データ'] })
  const bytes = await readFile(join(project, 'rag', note.path))
  const markdown = bytes.toString(MEMORY_STATE_COMPATIBILITY.knowledgeEncoding)
  assert.deepEqual(Buffer.from(markdown, MEMORY_STATE_COMPATIBILITY.knowledgeEncoding), bytes)
  assert.match(markdown, /形式の確認/u)
  const header = markdown.match(/^---\n([\s\S]*?)\n---\n/u)[1]
  assert.equal(header.split('\n').map(line => line.slice(0, line.indexOf(':'))).join(','), MEMORY_STATE_COMPATIBILITY.knowledgeFrontmatterFields)
  for (const line of header.split('\n')) JSON.parse(line.slice(line.indexOf(':') + 1))
  assert.match(await readFile(join(project, 'rag/INDEX.md'), MEMORY_STATE_COMPATIBILITY.knowledgeEncoding), /形式の確認/u)
  await service.remember({ botId: 'bot-synthetic', content: '保存形式の索引' })
  await service.searchKnowledge({ botId: 'bot-synthetic', query: '保存形式' })
  assert.equal(MEMORY_STATE_COMPATIBILITY.searchIndexVersion, MEMORY_SEARCH_INDEX_VERSION)
  assert.equal(MEMORY_SEARCH_INDEX_VERSION, `1:${process.versions.icu}`)
  for (const path of ['memory/memory.db', 'rag/index.db']) {
    const db = new DatabaseSync(join(project, path))
    try {
      assert.equal(db.prepare("SELECT value FROM index_state WHERE key = 'version'").get().value, MEMORY_STATE_COMPATIBILITY.searchIndexVersion)
    } finally { db.close() }
  }
})

test('members方式の完全一致で追加/欠落/別形式を拒否し、dispatcherから同じ宣言を公開する', () => {
  assert.ok(Object.isFrozen(MEMORY_STATE_COMPATIBILITY))
  assert.equal(dispatcherCompatibility, MEMORY_STATE_COMPATIBILITY)
  assertMemoryStateCompatibility(structuredClone(MEMORY_STATE_COMPATIBILITY))
  for (const key of Object.keys(MEMORY_STATE_COMPATIBILITY)) {
    const missing = { ...MEMORY_STATE_COMPATIBILITY }
    delete missing[key]
    for (const value of [missing, { ...MEMORY_STATE_COMPATIBILITY, [key]: 'incompatible' }])
      assert.throws(() => assertMemoryStateCompatibility(value), { code: 'MEMORY_STATE_INCOMPATIBLE' })
  }
  for (const value of [null, {}, { ...MEMORY_STATE_COMPATIBILITY, stateSchema: 1 }])
    assert.throws(() => assertMemoryStateCompatibility(value), { code: 'MEMORY_STATE_INCOMPATIBLE' })
})

test('互換情報の追加で交換時initializeの無作用restore応答を変えない', async () => {
  const dispatcher = createMemoryDispatcher({ root: '/synthetic-not-opened' })
  assert.deepEqual(await dispatcher.control('initialize', {}), { restored: true })
  await dispatcher.disconnect()
})
