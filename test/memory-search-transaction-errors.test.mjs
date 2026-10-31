import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const source = process.env.MEMORY_SEARCH_UNDER_TEST
  ? pathToFileURL(resolve(process.env.MEMORY_SEARCH_UNDER_TEST)) : new URL('../src/memory-search.mjs', import.meta.url)
const { searchMemories, searchKnowledgeItems } = await import(source.href)

async function fixture(t, kind, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'memory-index-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'index.db')
  const primary = new Error(`synthetic ${scenario} failure`), rollback = new Error('synthetic rollback failure')
  let armed = false, rollbacks = 0
  class FaultDatabase extends DatabaseSync {
    exec(sql) {
      if (armed && sql === 'ROLLBACK') {
        rollbacks++
        if (scenario === 'rollback') throw rollback
      }
      if (armed && sql === 'COMMIT' && scenario === 'commit') throw primary
      return super.exec(sql)
    }
    prepare(sql) {
      const statement = super.prepare(sql)
      const fail = armed && (scenario === 'version-write' && sql.startsWith('INSERT INTO index_state')
        || ['index-write', 'rollback'].includes(scenario) && sql.startsWith(`INSERT INTO ${kind === 'memory' ? 'memory_index' : 'section_index'}`))
      return fail ? new Proxy(statement, { get(target, name) {
        if (name === 'run') return () => { throw primary }
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      } }) : statement
    }
  }
  const db = new FaultDatabase(path), other = new DatabaseSync(':memory:')
  let closed = false
  t.after(() => { if (!closed) db.close(); other.close() })
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE index_state(key TEXT PRIMARY KEY, value TEXT); INSERT INTO index_state VALUES('version', 'old-icu')")
  if (kind === 'memory') db.exec(`
    CREATE TABLE assertions(rowid INTEGER PRIMARY KEY, id, kind, content, importance, observed_at, metadata_json, status);
    INSERT INTO assertions VALUES(1, 'retained', 'fact', 'latest retained memory', 5, '2026-10-27', '{}', 'active');
    CREATE VIRTUAL TABLE memory_index USING fts5(words, pairs);
    INSERT INTO memory_index(rowid, words, pairs) VALUES(1, 'old index tokens', 'old');
  `)
  else db.exec(`
    CREATE TABLE documents(rowid INTEGER PRIMARY KEY, id, path, title, source, tags, confidence, created_at, body);
    INSERT INTO documents VALUES(1, 'retained', 'notes/retained.md', 'retained', '', '[]', 'high', '2026-10-27', 'latest retained knowledge');
    CREATE TABLE sections(rowid INTEGER PRIMARY KEY, document_id, heading, line, body);
    INSERT INTO sections VALUES(1, 'retained', '', 1, 'old section');
    CREATE VIRTUAL TABLE section_index USING fts5(title_words, body_words, title_pairs, body_pairs);
    INSERT INTO section_index VALUES('old', 'index', 'old', 'index');
  `)
  const tables = kind === 'memory' ? ['assertions', 'memory_index', 'index_state'] : ['documents', 'sections', 'section_index', 'index_state']
  const snapshot = connection => tables.map(table => connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  const before = snapshot(db)
  const search = () => kind === 'memory' ? searchMemories(db, 'retained', 10)
    : searchKnowledgeItems(db, other, 'retained', 10)
  // The memory search runs after the knowledge search on the successful path.
  if (kind === 'knowledge') other.exec(`
    CREATE TABLE assertions(rowid INTEGER PRIMARY KEY, id, kind, content, importance, observed_at, metadata_json, status);
    CREATE VIRTUAL TABLE memory_index USING fts5(words, pairs);
    CREATE TABLE index_state(key TEXT PRIMARY KEY, value TEXT);
  `)
  armed = scenario !== 'normal'
  return { db, primary, rollback, before, search, rollbacks: () => rollbacks, snapshot: () => snapshot(db),
    durableSnapshot() { const reader = new DatabaseSync(path, { readOnly: true }); try { return snapshot(reader) } finally { reader.close() } },
    close() { db.close(); closed = true } }
}

for (const scenario of ['index-write', 'version-write', 'commit']) test(`${scenario} preserves source rows, previous index/version and the original error`, async t => {
  for (const kind of ['memory', 'knowledge']) {
    const f = await fixture(t, kind, scenario)
    assert.throws(f.search, error => error === f.primary)
    assert.equal(f.rollbacks(), 1)
    assert.equal(f.db.isTransaction, false)
    assert.deepEqual(f.snapshot(), f.before)
    assert.deepEqual(f.durableSnapshot(), f.before)
  }
})

test('rollback failure retains both errors and does not claim the transaction was reverted', async t => {
  for (const kind of ['memory', 'knowledge']) {
    const f = await fixture(t, kind, 'rollback')
    assert.throws(f.search, error => error instanceof AggregateError
      && error.errors.length === 2 && error.errors[0] === f.primary && error.errors[1] === f.rollback)
    assert.equal(f.rollbacks(), 1)
    assert.equal(f.db.isTransaction, true)
    assert.deepEqual(f.durableSnapshot(), f.before)
    f.close()
    assert.deepEqual(f.durableSnapshot(), f.before)
  }
})

test('normal rebuild commits current index/version and keeps source rows', async t => {
  for (const kind of ['memory', 'knowledge']) {
    const f = await fixture(t, kind, 'normal')
    assert.deepEqual(f.search().map(item => item.id), ['retained'])
    assert.equal(f.db.isTransaction, false)
    assert.equal(f.rollbacks(), 0)
    const after = f.snapshot()
    assert.deepEqual(after[0], f.before[0])
    assert.equal(after.at(-1)[0].value, `1:${process.versions.icu}`)
    assert.deepEqual(f.durableSnapshot(), after)
  }
})
