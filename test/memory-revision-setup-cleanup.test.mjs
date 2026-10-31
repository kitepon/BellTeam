import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import test from 'node:test'

async function fixture(t, fault, closeFails = false, scope = 'shared') {
  const root = await mkdtemp(join(tmpdir(), 'memory-revision-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = new Error('synthetic revision setup failure'), closeError = new Error('synthetic close failure')
  let armed = false, ids = 0, revisionIds = 0
  const opened = [], events = []
  class FaultDatabase extends DatabaseSync {
    constructor(path) { super(path); this.closes = 0; opened.push(this); if (armed) events.push('open') }
    close() { super.close(); this.closes++; if (armed && closeFails) throw closeError }
  }
  t.after(() => { for (const db of opened) if (!db.closes) DatabaseSync.prototype.close.call(db) })
  const source = process.env.MEMORY_SERVICE_UNDER_TEST ? pathToFileURL(resolve(process.env.MEMORY_SERVICE_UNDER_TEST))
    : new URL('../src/memory-service.mjs', import.meta.url)
  const key = 'revision-setup-fixture-' + root
  source.searchParams.set('fixture', key)
  globalThis[key] = FaultDatabase
  const sqlite = 'data:text/javascript,' + encodeURIComponent('export const DatabaseSync=globalThis[' + JSON.stringify(key) + ']')
  const hook = registerHooks({ resolve(name, context, next) {
    if (context.parentURL === source.href && name === 'node:sqlite') return { url: sqlite, shortCircuit: true }
    return next(name, context)
  } })
  let module
  try { module = await import(source.href) } finally { hook.deregister(); delete globalThis[key] }
  const project = join(root, 'bot-a'), common = { botId: 'bot-a', scope }, observedAt = '2026-10-27T11:55:00.000Z'
  const memory = new module.BellTeamMemory({ root, registry: new Map([['bot-a', { id: 'bot-a', project }]]),
    now: () => {
      if (armed) events.push('now')
      if (armed && fault === 'now') throw primary
      return new Date(armed && fault === 'date' ? NaN : observedAt)
    },
    id: () => {
      if (armed) { events.push('id'); revisionIds++ }
      if (armed && fault === 'id' + revisionIds) throw primary
      return String(++ids)
    },
  })
  const original = await memory.remember({ ...common, content: 'original value', kind: 'task', importance: 8, metadata: { retained: true } })
  const path = join(scope === 'shared' ? join(root, 'shared') : project, 'memory/memory.db')
  const rows = () => {
    const reader = new DatabaseSync(path, { readOnly: true })
    try { return ['raw_events', 'assertions', 'evidence'].map(table => reader.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) }
    finally { reader.close() }
  }
  const before = rows(); opened.length = 0; armed = true
  const closed = () => { assert.equal(opened.length, 1); assert.equal(opened[0].closes, 1) }
  return { run: () => memory.reviseMemory({ ...common, id: original.id, content: 'latest value' }),
    primary, closeError, events, closed, original, observedAt, scope,
    unchanged: () => { closed(); assert.deepEqual(rows(), before) },
    changed: () => {
      closed(); const data = rows(), old = data[1].find(row => row.id === original.id), latest = data[1].find(row => row.content === 'latest value')
      assert.equal(old.status, 'superseded'); assert.equal(latest.status, 'active'); assert.equal(latest.kind, 'task'); assert.equal(latest.importance, 8)
      assert.deepEqual(JSON.parse(latest.metadata_json), { retained: true, supersedesId: original.id })
      assert.equal(data[0].length, 2); assert.equal(data[2].length, 2)
    } }
}

test('revision closes the acquired database on clock or invalid-date failure and preserves original rows', async t => {
  for (const fault of ['now', 'date']) for (const closeFails of [false, true]) {
    const f = await fixture(t, fault, closeFails)
    await assert.rejects(f.run(), error => {
      const primary = closeFails ? error.errors?.[0] : error
      assert.ok(fault === 'now' ? primary === f.primary : primary instanceof RangeError)
      return !closeFails || error instanceof AggregateError && error.errors.length === 2 && error.errors[1] === f.closeError
    })
    assert.deepEqual(f.events, ['open', 'now']); f.unchanged()
  }
})

test('revision closes the acquired database on either ID callback failure while retaining exact errors', async t => {
  for (const fault of ['id1', 'id2']) for (const closeFails of [false, true]) {
    const f = await fixture(t, fault, closeFails)
    await assert.rejects(f.run(), error => !closeFails ? error === f.primary : error instanceof AggregateError
      && error.errors.length === 2 && error.errors[0] === f.primary && error.errors[1] === f.closeError)
    assert.deepEqual(f.events, ['open', 'now', ...Array(fault === 'id1' ? 1 : 2).fill('id')]); f.unchanged()
  }
})

test('revision preserves callback order, normal response and committed metadata in both scopes including close-only failure', async t => {
  for (const scope of ['shared', 'personal']) for (const closeFails of [false, true]) {
    const f = await fixture(t, 'normal', closeFails, scope)
    if (closeFails) await assert.rejects(f.run(), error => error === f.closeError)
    else assert.deepEqual(await f.run(), { id: 'memory-4', supersedesId: f.original.id, kind: 'task', content: 'latest value', scope, observedAt: f.observedAt })
    assert.deepEqual(f.events, ['open', 'now', 'id', 'id', 'id']); f.changed()
  }
})
