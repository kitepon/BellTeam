import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

// このファイルだけをコピーし、BellTeamの起動・Bot台帳・外部パッケージなしで検索する。
test('検索判断は既存SQLite接続だけで単独動作し、literal検索とpartial上限を保つ', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-search-standalone-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await copyFile(new URL('../src/memory-search.mjs', import.meta.url), join(directory, 'memory-search.mjs'))
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { DatabaseSync } from 'node:sqlite'
    import { searchKnowledgeItems, searchMemories } from './memory-search.mjs'
    const memory = new DatabaseSync(':memory:')
    const knowledge = new DatabaseSync(':memory:')
    memory.exec(\`
      CREATE TABLE assertions (rowid INTEGER PRIMARY KEY, id, kind, content, importance, observed_at, metadata_json, status);
      CREATE VIRTUAL TABLE memory_index USING fts5(words, pairs, tokenize="unicode61 remove_diacritics 0");
      CREATE TABLE index_state (key TEXT PRIMARY KEY, value TEXT);
    \`)
    knowledge.exec(\`
      CREATE TABLE documents (rowid INTEGER PRIMARY KEY, id, path, title, source, tags, confidence, created_at, body);
      CREATE TABLE sections (rowid INTEGER PRIMARY KEY, document_id, heading, line, body);
      CREATE VIRTUAL TABLE section_index USING fts5(title_words, body_words, title_pairs, body_pairs, tokenize="unicode61 remove_diacritics 0");
      CREATE TABLE index_state (key TEXT PRIMARY KEY, value TEXT);
    \`)
    const insert = memory.prepare("INSERT INTO assertions VALUES (?, ?, 'fact', ?, 5, '2026-10-23', '{}', 'active')")
    insert.run(1, 'exact', 'K-EXACT standalone SQLite memory')
    for (let i = 2; i <= 8; i++) insert.run(i, 'near-' + i, 'K-OTHER standalone SQLite memory ' + i)
    knowledge.prepare("INSERT INTO documents VALUES (1, 'note', 'notes/note.md', 'Standalone', '', '[]', 'high', '2026-10-23', ?)").run('## 検索\\n\\nK-OTHER standalone SQLite knowledge')
    assert.deepEqual(searchMemories(memory, 'K-EXACT', 20).map(row => row.id), ['exact'])
    assert.equal(searchMemories(memory, 'SQLite missing', 20).length, 5)
    assert.ok(searchMemories(memory, 'SQLite missing', 20).every(row => row.near))
    assert.deepEqual(searchKnowledgeItems(knowledge, memory, 'K-EXACT', 20).map(item => item.id), ['exact'])
    const items = searchKnowledgeItems(knowledge, memory, 'SQLite', 20)
    assert.equal(items[0].id, 'note')
    assert.equal(items[0].line, 12)
    assert.equal(items[0].path, 'notes/note.md')
    assert.equal(items[0].excerpt, 'K-OTHER standalone SQLite knowledge')
    assert.equal(items.length, 9)
    assert.throws(() => searchMemories(memory, '', 20), /SEARCH_QUERY_INVALID/)
    assert.equal(memory.prepare('SELECT count(*) AS n FROM assertions').get().n, 8)
    assert.equal(knowledge.prepare('SELECT body FROM documents').get().body, '## 検索\\n\\nK-OTHER standalone SQLite knowledge')
    memory.close()
    knowledge.close()
    process.stdout.write('standalone-ok')
  `], { cwd: directory })
  assert.equal(stdout, 'standalone-ok')
})
