import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import test from 'node:test'

async function fixture(t, scenario, point = 'insert') {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-record-close-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = new Error('synthetic record failure'), closeError = new Error('synthetic close failure')
  let armed = false, ordinal = 0
  const opened = []
  class FaultDatabase extends DatabaseSync {
    constructor(path) { super(path); this.ordinal = ++ordinal; this.closes = 0; opened.push(this) }
    prepare(sql) {
      const statement = super.prepare(sql)
      const affected = point === 'insert' ? sql.trimStart().startsWith('INSERT INTO documents (') : sql.startsWith('DELETE FROM section_index')
      if (!(armed && this.ordinal === 2 && affected && ['both', 'primary'].includes(scenario))) return statement
      return new Proxy(statement, { get(target, name) {
        if (name === 'run') return () => { throw primary }
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    close() {
      super.close(); this.closes++
      if (armed && this.ordinal === 2 && ['both', 'close'].includes(scenario)) throw closeError
    }
  }
  t.after(() => { for (const db of opened) if (!db.closes) DatabaseSync.prototype.close.call(db) })
  const source = process.env.MEMORY_SERVICE_UNDER_TEST ? pathToFileURL(resolve(process.env.MEMORY_SERVICE_UNDER_TEST))
    : new URL('../src/memory-service.mjs', import.meta.url)
  const key = 'knowledge-record-fixture-' + root
  source.searchParams.set('fixture', key)
  globalThis[key] = FaultDatabase
  const sqlite = 'data:text/javascript,' + encodeURIComponent('export const DatabaseSync=globalThis[' + JSON.stringify(key) + ']')
  const hook = registerHooks({ resolve(name, context, next) {
    if (context.parentURL === source.href && name === 'node:sqlite') return { url: sqlite, shortCircuit: true }
    return next(name, context)
  } })
  let module
  try { module = await import(source.href) } finally { hook.deregister(); delete globalThis[key] }
  let id = 0
  const createdAt = '2026-10-27T10:00:00.000Z'
  const memory = new module.BellTeamMemory({ root, registry: new Map(), id: () => String(++id), now: () => new Date(createdAt) })
  await memory.recordKnowledge({ scope: 'shared', title: 'original', content: 'original note retained' })
  const rag = join(root, 'shared/rag'), originalNote = await readFile(join(rag, 'notes/knowledge-1.md'))
  const originalIndex = await readFile(join(rag, 'INDEX.md'), 'utf8')
  opened.length = 0; ordinal = 0; armed = true
  const input = { scope: 'shared', title: 'latest title', content: 'latest content', source: 'fixture', tags: ['latest'], confidence: 'high' }
  const retained = async () => {
    assert.equal(opened.length, 2)
    assert.deepEqual(opened.map(db => db.closes), [1, 1])
    assert.deepEqual(await readFile(join(rag, 'notes/knowledge-1.md')), originalNote)
    const note = await readFile(join(rag, 'notes/knowledge-2.md'), 'utf8')
    assert.ok(note.includes('latest content'))
    assert.equal(await readFile(join(rag, 'INDEX.md'), 'utf8'), originalIndex + '- [notes/knowledge-2.md](notes/knowledge-2.md) — latest title (2026-10-27・high)\n')
    const reader = new DatabaseSync(join(rag, 'index.db'), { readOnly: true })
    try {
      assert.equal(reader.prepare('SELECT body FROM documents WHERE id = ?').get('knowledge-1').body, 'original note retained')
      const latest = reader.prepare('SELECT title, body FROM documents WHERE id = ?').get('knowledge-2')
      if (['both', 'primary'].includes(scenario) && point === 'insert') assert.equal(latest, undefined)
      else assert.deepEqual({ ...latest }, { title: 'latest title', body: 'latest content' })
    } finally { reader.close() }
  }
  return { memory, primary, closeError, input, retained, createdAt }
}

test('record retains exact upsert and close errors and saved notes/index at either write boundary', async t => {
  for (const point of ['insert', 'cleanup']) {
    const f = await fixture(t, 'both', point)
    await assert.rejects(f.memory.recordKnowledge(f.input), error => error instanceof AggregateError
      && error.errors.length === 2 && error.errors[0] === f.primary && error.errors[1] === f.closeError)
    await f.retained()
  }
})

test('record returns the original upsert error unchanged and keeps earlier saved data when close succeeds', async t => {
  for (const point of ['insert', 'cleanup']) {
    const f = await fixture(t, 'primary', point)
    await assert.rejects(f.memory.recordKnowledge(f.input), error => error === f.primary)
    await f.retained()
  }
})

test('normal record response is unchanged and close-only failure preserves the committed note and row', async t => {
  for (const scenario of ['normal', 'close']) {
    const f = await fixture(t, scenario)
    const result = f.memory.recordKnowledge(f.input)
    if (scenario === 'close') await assert.rejects(result, error => error === f.closeError)
    else assert.deepEqual(await result, { id: 'knowledge-2', title: 'latest title', path: 'notes/knowledge-2.md', scope: 'shared', createdAt: f.createdAt })
    await f.retained()
  }
})
