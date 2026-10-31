import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import test from 'node:test'

async function fixture(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'memory-recall-close-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'shared/memory/memory.db')
  await mkdir(dirname(path), { recursive: true })
  const original = new DatabaseSync(path)
  original.exec("CREATE TABLE retained_data(value TEXT); INSERT INTO retained_data VALUES('latest retained value')")
  original.close()
  const primary = new Error('synthetic recall failure'), closeError = new Error('synthetic close failure')
  const opened = []
  class FaultDatabase extends DatabaseSync {
    constructor(path) { super(path); this.closed = false; opened.push(this) }
    close() {
      super.close(); this.closed = true
      if (['both', 'close'].includes(scenario)) throw closeError
    }
  }
  t.after(() => { for (const db of opened) if (!db.closed) DatabaseSync.prototype.close.call(db) })
  const source = process.env.MEMORY_SERVICE_UNDER_TEST ? pathToFileURL(resolve(process.env.MEMORY_SERVICE_UNDER_TEST))
    : new URL('../src/memory-service.mjs', import.meta.url)
  const key = 'recall-fixture-' + root
  source.searchParams.set('fixture', key)
  globalThis[key] = { DatabaseSync: FaultDatabase,
    searchMemories(db) {
      if (['both', 'primary'].includes(scenario)) throw primary
      return db.prepare("SELECT 'retained' id, 'fact' kind, value content, 5 importance, '2026-10-27' observed_at, '{}' metadata_json FROM retained_data").all()
    } }
  const sqlite = 'data:text/javascript,' + encodeURIComponent('export const DatabaseSync=globalThis[' + JSON.stringify(key) + '].DatabaseSync')
  const search = 'data:text/javascript,' + encodeURIComponent('export const searchMemories=globalThis[' + JSON.stringify(key) + '].searchMemories;export const searchKnowledgeItems=()=>[]')
  const hook = registerHooks({ resolve(name, context, next) {
    if (context.parentURL === source.href && name === 'node:sqlite') return { url: sqlite, shortCircuit: true }
    if (context.parentURL === source.href && name === './memory-search.mjs') return { url: search, shortCircuit: true }
    return next(name, context)
  } })
  let module
  try { module = await import(source.href) } finally { hook.deregister(); delete globalThis[key] }
  const memory = new module.BellTeamMemory({ root, registry: new Map() })
  const retained = () => {
    assert.equal(opened.length, 1); assert.equal(opened[0].closed, true)
    const reader = new DatabaseSync(path, { readOnly: true })
    try { assert.equal(reader.prepare('SELECT value FROM retained_data').get().value, 'latest retained value') }
    finally { reader.close() }
  }
  return { memory, primary, closeError, retained }
}

test('recall retains the exact search and close errors together after closing the acquired handle', async t => {
  const f = await fixture(t, 'both')
  await assert.rejects(f.memory.recallMemory({ scope: 'shared', query: 'retained' }), error => error instanceof AggregateError
    && error.errors.length === 2 && error.errors[0] === f.primary && error.errors[1] === f.closeError)
  f.retained()
})

test('recall preserves the original search error unchanged when close succeeds', async t => {
  const f = await fixture(t, 'primary')
  await assert.rejects(f.memory.recallMemory({ scope: 'shared', query: 'retained' }), error => error === f.primary)
  f.retained()
})

test('successful recall returns existing rows, while a standalone close error still fails the request', async t => {
  for (const scenario of ['normal', 'close']) {
    const f = await fixture(t, scenario)
    const result = f.memory.recallMemory({ scope: 'shared', query: 'retained' })
    if (scenario === 'close') await assert.rejects(result, error => error === f.closeError)
    else assert.deepEqual((await result).items, [{ id: 'retained', kind: 'fact', content: 'latest retained value',
      importance: 5, observedAt: '2026-10-27', metadata: {} }])
    f.retained()
  }
})
