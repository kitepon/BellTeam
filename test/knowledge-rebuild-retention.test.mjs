import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import test from 'node:test'

async function fixture(t, scenario) {
  const root = await fs.mkdtemp(join(tmpdir(), 'knowledge-rebuild-retention-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const rag = join(root, 'shared/rag'), notes = join(rag, 'notes'), dbPath = join(rag, 'index.db')
  const primary = new Error('synthetic rebuild failure'), rollback = new Error('synthetic rollback failure'), closeError = new Error('synthetic close failure')
  let armed = false, ordinal = 0, writes = 0
  const opened = [], notePaths = []
  class FaultDatabase extends DatabaseSync {
    constructor(path) { super(path); this.ordinal = ++ordinal; this.closed = false; opened.push(this) }
    exec(sql) {
      if (armed && this.ordinal === 2 && sql === 'COMMIT' && scenario === 'commit') throw primary
      if (armed && this.ordinal === 2 && sql === 'ROLLBACK' && scenario === 'rollback-close') throw rollback
      return super.exec(sql)
    }
    prepare(sql) {
      const statement = super.prepare(sql)
      if (!(armed && this.ordinal === 2 && sql.trimStart().startsWith('INSERT INTO documents ('))) return statement
      return new Proxy(statement, { get(target, name) {
        if (name === 'run') return (...args) => {
          writes++
          if (scenario === 'write' && writes === 2) throw primary
          return target.run(...args)
        }
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    close() {
      super.close(); this.closed = true
      if (armed && this.ordinal === 2 && ['rollback-close', 'close'].includes(scenario)) throw closeError
    }
  }
  t.after(() => { for (const db of opened) if (!db.closed) DatabaseSync.prototype.close.call(db) })
  const source = process.env.MEMORY_SERVICE_UNDER_TEST ? pathToFileURL(resolve(process.env.MEMORY_SERVICE_UNDER_TEST))
    : new URL('../src/memory-service.mjs', import.meta.url)
  const key = 'knowledge-rebuild-fixture-' + root
  source.searchParams.set('fixture', key)
  globalThis[key] = { DatabaseSync: FaultDatabase, fs: { ...fs,
    readdir: async path => armed && path === notes ? notePaths.map(path => basename(path)) : fs.readdir(path),
    readFile: async (path, ...args) => {
      if (armed && path === notePaths[1] && ['read', 'rollback-close'].includes(scenario)) throw primary
      return fs.readFile(path, ...args)
    },
  } }
  const sqlite = 'data:text/javascript,' + encodeURIComponent('export const DatabaseSync=globalThis[' + JSON.stringify(key) + '].DatabaseSync')
  const filesystem = 'data:text/javascript,' + encodeURIComponent('export const {mkdir,readFile,readdir,rm,writeFile}=globalThis[' + JSON.stringify(key) + '].fs')
  const hook = registerHooks({ resolve(name, context, next) {
    if (context.parentURL === source.href && name === 'node:sqlite') return { url: sqlite, shortCircuit: true }
    if (context.parentURL === source.href && name === 'node:fs/promises') return { url: filesystem, shortCircuit: true }
    return next(name, context)
  } })
  let module
  try { module = await import(source.href) } finally { hook.deregister(); delete globalThis[key] }
  let id = 0
  const memory = new module.BellTeamMemory({ root, registry: new Map(), id: () => String(++id) })
  for (const word of ['one', 'two']) {
    const note = await memory.recordKnowledge({ scope: 'shared', title: word, content: 'old ' + word })
    notePaths.push(join(notes, basename(note.path)))
  }
  await memory.searchKnowledge({ scope: 'shared', query: 'old' })
  for (const path of notePaths) await fs.writeFile(path, (await fs.readFile(path, 'utf8')).replace('old ', 'latest '))
  if (scenario === 'parse') await fs.writeFile(notePaths[1], 'invalid markdown retained verbatim')
  const snapshots = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try { return ['documents', 'sections', 'section_index', 'index_state'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) }
    finally { db.close() }
  }
  const oldIndex = snapshots(), originalNotes = await Promise.all(notePaths.map(path => fs.readFile(path)))
  const oldManifest = await fs.readFile(join(rag, 'INDEX.md'))
  opened.length = 0; ordinal = 0; armed = true
  const notesRetained = async () => {
    assert.deepEqual(await Promise.all(notePaths.map(path => fs.readFile(path))), originalNotes)
    assert.deepEqual(await fs.readFile(join(rag, 'INDEX.md')), oldManifest)
    assert.equal(opened.length, 2); assert.equal(opened.every(db => db.closed), true)
  }
  return { memory, primary, rollback, closeError, oldIndex, snapshots, notesRetained, writes: () => writes }
}

for (const scenario of ['read', 'parse', 'write', 'commit']) test(`${scenario} failure retains both old indexed documents, sections/version and source notes`, async t => {
  const f = await fixture(t, scenario)
  await assert.rejects(f.memory.rebuildKnowledgeIndex({ scope: 'shared' }), error => scenario === 'parse'
    ? error.message === 'KNOWLEDGE_FILE_INVALID' : error === f.primary)
  assert.ok(f.writes() >= 1)
  assert.deepEqual(f.snapshots(), f.oldIndex)
  await f.notesRetained()
})

test('rebuild, rollback and close failures retain all exact errors and committed old rows', async t => {
  const f = await fixture(t, 'rollback-close')
  await assert.rejects(f.memory.rebuildKnowledgeIndex({ scope: 'shared' }), error => error instanceof AggregateError
    && error.errors.length === 3 && error.errors[0] === f.primary && error.errors[1] === f.rollback && error.errors[2] === f.closeError)
  assert.deepEqual(f.snapshots(), f.oldIndex)
  await f.notesRetained()
})

test('successful rebuild commits latest notes and clears only derived sections/version', async t => {
  const f = await fixture(t, 'normal')
  assert.deepEqual(await f.memory.rebuildKnowledgeIndex({ scope: 'shared' }), { scope: 'shared', count: 2 })
  const after = f.snapshots()
  assert.deepEqual(after[0].map(row => row.body), ['latest one', 'latest two'])
  assert.deepEqual(after.slice(1), [[], [], []])
  await f.notesRetained()
  const found = await f.memory.searchKnowledge({ scope: 'shared', query: 'latest' })
  assert.deepEqual(found.items.map(item => item.id).sort(), ['knowledge-1', 'knowledge-2'])
  assert.ok(found.items.every(item => item.excerpt.startsWith('latest ')))
})

test('a close failure after commit fails the request without claiming committed latest rows were rolled back', async t => {
  const f = await fixture(t, 'close')
  await assert.rejects(f.memory.rebuildKnowledgeIndex({ scope: 'shared' }), error => error === f.closeError)
  assert.deepEqual(f.snapshots()[0].map(row => row.body), ['latest one', 'latest two'])
  await f.notesRetained()
})
