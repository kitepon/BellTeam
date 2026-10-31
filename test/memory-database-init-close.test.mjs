import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import test from 'node:test'
async function fixture(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'memory-db-close-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { memory: join(root, 'shared/memory/memory.db'), rag: join(root, 'shared/rag/index.db') }
  for (const path of Object.values(paths)) {
    await mkdir(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE preserved_data(value TEXT); INSERT INTO preserved_data VALUES ('latest retained value')")
    db.close()
  }
  const opened = [], counts = new Map()
  const primary = new Error('synthetic DDL failure'), searchError = new Error('synthetic search failure')
  const closeErrors = []
  class FaultDatabase extends DatabaseSync {
    constructor(path) { super(path); this.fixturePath = path; this.ordinal = (counts.get(path) ?? 0) + 1; counts.set(path, this.ordinal); this.closed = false; opened.push(this) }
    exec(sql) {
      if ((['memory-init', 'both', 'second-open'].includes(scenario) && this.fixturePath === paths.memory)
        || scenario === 'rag-init' && this.fixturePath === paths.rag) throw primary
      return super.exec(sql)
    }
    close() {
      super.close(); this.closed = true
      if (scenario === 'both' || scenario === 'search-close' && (this.fixturePath === paths.memory || this.ordinal === 2)) {
        const error = new Error('synthetic close failure'); closeErrors.push(error); throw error
      }
    }
  }
  t.after(() => { for (const db of opened) if (!db.closed) DatabaseSync.prototype.close.call(db) })
  const source = process.env.MEMORY_DB_UNDER_TEST
    ? pathToFileURL(resolve(process.env.MEMORY_DB_UNDER_TEST)) : new URL('../src/memory-service.mjs', import.meta.url)
  const key = 'memory-close-fixture-' + opened.length + '-' + root
  source.searchParams.set('fixture', key)
  globalThis[key] = { DatabaseSync: FaultDatabase, searchMemories: () => [], searchKnowledgeItems: () => { throw searchError } }
  const sqlite = 'data:text/javascript,' + encodeURIComponent('export const DatabaseSync = globalThis[' + JSON.stringify(key) + '].DatabaseSync')
  const search = 'data:text/javascript,' + encodeURIComponent('export const {searchMemories, searchKnowledgeItems} = globalThis[' + JSON.stringify(key) + ']')
  const hook = registerHooks({ resolve(name, context, nextResolve) {
    if (context.parentURL === source.href && name === 'node:sqlite') return { url: sqlite, shortCircuit: true }
    if (context.parentURL === source.href && name === './memory-search.mjs') return { url: search, shortCircuit: true }
    return nextResolve(name, context)
  } })
  let module
  try { module = await import(source.href) }
  finally { hook.deregister(); delete globalThis[key] }
  const memory = new module.BellTeamMemory({ root, registry: new Map() })
  const retained = () => {
    for (const path of Object.values(paths)) {
      const db = new DatabaseSync(path)
      try { assert.equal(db.prepare('SELECT value FROM preserved_data').get().value, 'latest retained value') }
      finally { db.close() }
    }
  }
  return { memory, paths, opened, primary, searchError, closeErrors, retained }
}
for (const scenario of ['memory-init', 'rag-init']) test(`${scenario} closes the failed initialization handle and preserves existing data`, async t => {
  const f = await fixture(t, scenario)
  await assert.rejects(scenario === 'memory-init' ? f.memory.openMemory(null, 'shared') : f.memory.initialize(), error => error === f.primary)
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].closed, true); f.retained()
})
test('initialization and close failures are both retained', async t => {
  const f = await fixture(t, 'both')
  const error = await f.memory.openMemory(null, 'shared').catch(error => error)
  assert.ok(error instanceof AggregateError); assert.equal(f.opened[0].closed, true)
  assert.deepEqual(error.errors, [f.primary, ...f.closeErrors]); assert.equal(f.closeErrors.length, 1); f.retained()
})
test('second database initialization failure closes the previously opened knowledge database', async t => {
  const f = await fixture(t, 'second-open')
  await assert.rejects(f.memory.searchKnowledge({ scope: 'shared', query: 'fixture' }), error => error === f.primary)
  assert.equal(f.opened.length, 3); assert.equal(f.opened.every(db => db.closed), true); f.retained()
})
test('search and both close failures preserve all errors and attempt every close', async t => {
  const f = await fixture(t, 'search-close')
  const error = await f.memory.searchKnowledge({ scope: 'shared', query: 'fixture' }).catch(error => error)
  assert.ok(error instanceof AggregateError); assert.equal(f.opened.every(db => db.closed), true)
  assert.equal(f.closeErrors.length, 2); assert.deepEqual(error.errors, [f.searchError, ...f.closeErrors]); f.retained()
})
test('normal initialization keeps both existing databases readable and closes returned handles normally', async t => {
  const f = await fixture(t, 'normal')
  await f.memory.initialize()
  const db = await f.memory.openMemory(null, 'shared')
  assert.equal(db.prepare('SELECT value FROM preserved_data').get().value, 'latest retained value')
  db.close(); assert.equal(f.opened.every(db => db.closed), true); f.retained()
})
