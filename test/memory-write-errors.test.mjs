import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import test from 'node:test'

async function fixture(t, method, scenario, scope = 'shared') {
  const root = await mkdtemp(join(tmpdir(), 'memory-write-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = new Error('synthetic write failure'), rollback = new Error('synthetic rollback failure'), closeError = new Error('synthetic close failure')
  const targetOrdinal = method === 'consolidateGrowth' ? 2 : 1
  const opened = []
  let armed = false, ordinal = 0, writes = 0, rollbackAttempts = 0
  class FaultDatabase extends DatabaseSync {
    constructor(path) { super(path); this.ordinal = ++ordinal; this.closes = 0; opened.push(this) }
    exec(sql) {
      if (armed && this.ordinal === targetOrdinal) {
        if (sql === 'BEGIN' && scenario === 'begin-close') throw primary
        if (sql === 'ROLLBACK') {
          rollbackAttempts++
          if (['rollback', 'all'].includes(scenario)) throw rollback
        }
      }
      return super.exec(sql)
    }
    prepare(sql) {
      const statement = super.prepare(sql)
      const match = method === 'pinMemory' ? sql.startsWith('UPDATE assertions SET metadata_json')
        : method === 'consolidateGrowth' ? sql.includes("SET status = 'consolidated'")
          : sql.trimStart().startsWith('INSERT INTO evidence')
      if (!(armed && this.ordinal === targetOrdinal && match && ['primary', 'rollback', 'both', 'all'].includes(scenario))) return statement
      return new Proxy(statement, { get(target, name) {
        if (name === 'run') return (...args) => {
          writes++
          if (method !== 'consolidateGrowth' || writes === 2) throw primary
          return target.run(...args)
        }
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    close() {
      this.transactionAtClose = this.isTransaction
      super.close(); this.closes++
      if (armed && this.ordinal === targetOrdinal && ['both', 'all', 'close', 'begin-close'].includes(scenario)) throw closeError
    }
  }
  t.after(() => { for (const db of opened) if (!db.closes) DatabaseSync.prototype.close.call(db) })
  const source = process.env.MEMORY_SERVICE_UNDER_TEST ? pathToFileURL(resolve(process.env.MEMORY_SERVICE_UNDER_TEST))
    : new URL('../src/memory-service.mjs', import.meta.url)
  const key = 'memory-write-fixture-' + root
  source.searchParams.set('fixture', key)
  globalThis[key] = FaultDatabase
  const sqlite = 'data:text/javascript,' + encodeURIComponent('export const DatabaseSync=globalThis[' + JSON.stringify(key) + ']')
  const hook = registerHooks({ resolve(name, context, next) {
    if (context.parentURL === source.href && name === 'node:sqlite') return { url: sqlite, shortCircuit: true }
    return next(name, context)
  } })
  let module
  try { module = await import(source.href) } finally { hook.deregister(); delete globalThis[key] }
  const project = join(root, 'bot-a'), common = { botId: 'bot-a', scope }
  let id = 0
  const memory = new module.BellTeamMemory({ root, registry: new Map([['bot-a', { id: 'bot-a', project }]]),
    id: () => String(++id), now: () => new Date('2026-10-27T11:45:00Z') })
  const a = await memory.remember({ ...common, content: 'original first' })
  const b = await memory.remember({ ...common, content: 'original second' })
  const pinned = await memory.remember({ ...common, content: 'original pinned' })
  await memory.pinMemory({ ...common, id: pinned.id })
  const path = join(scope === 'shared' ? join(root, 'shared') : project, 'memory/memory.db')
  const rows = () => {
    const reader = new DatabaseSync(path, { readOnly: true })
    try { return ['raw_events', 'assertions', 'evidence'].map(table => reader.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) }
    finally { reader.close() }
  }
  const before = rows()
  opened.length = 0; ordinal = 0; armed = true
  const run = () => method === 'remember' ? memory.remember({ ...common, content: 'latest value' })
    : method === 'reviseMemory' ? memory.reviseMemory({ ...common, id: a.id, content: 'latest value' })
      : method === 'pinMemory' ? memory.pinMemory({ ...common, id: a.id })
        : memory.consolidateGrowth({ ...common, memoryIds: [a.id, b.id, pinned.id], content: 'latest value' })
  const closed = () => { assert.equal(opened.length, targetOrdinal); assert.ok(opened.every(db => db.closes === 1)) }
  const oldData = () => { closed(); assert.deepEqual(rows(), before) }
  const changed = partial => {
    closed()
    const assertions = rows()[1], first = assertions.find(row => row.id === a.id), second = assertions.find(row => row.id === b.id)
    assert.equal(assertions.find(row => row.id === pinned.id).status, 'active')
    assert.equal(JSON.parse(assertions.find(row => row.id === pinned.id).metadata_json).pinned, true)
    if (method === 'pinMemory') assert.equal(JSON.parse(first.metadata_json).pinned, true)
    else {
      assert.equal(assertions.filter(row => row.content === 'latest value').length, 1)
      if (method === 'reviseMemory') assert.equal(first.status, 'superseded')
      if (method === 'consolidateGrowth') {
        assert.equal(first.status, 'consolidated')
        assert.equal(second.status, partial ? 'active' : 'consolidated')
      }
    }
  }
  return { run, primary, rollback, closeError, oldData, changed, closed, scope, rollbackAttempts: () => rollbackAttempts,
    transactionAtClose: () => opened.at(-1).transactionAtClose }
}

for (const method of ['remember', 'reviseMemory']) {
  test(method + ' preserves write, rollback and close errors while retaining the committed original rows', async t => {
    for (const scenario of ['primary', 'rollback', 'both', 'all']) {
      const f = await fixture(t, method, scenario)
      const errors = [f.primary, ...(['rollback', 'all'].includes(scenario) ? [f.rollback] : []), ...(['both', 'all'].includes(scenario) ? [f.closeError] : [])]
      await assert.rejects(f.run(), error => errors.length === 1 ? error === f.primary
        : error instanceof AggregateError && error.errors.length === errors.length && error.errors.every((value, index) => value === errors[index]))
      assert.equal(f.rollbackAttempts(), 1)
      assert.equal(f.transactionAtClose(), ['rollback', 'all'].includes(scenario))
      f.oldData()
    }
  })
}

test('pin preserves its write error with or without a close error and leaves original metadata intact', async t => {
  for (const scenario of ['primary', 'both']) {
    const f = await fixture(t, 'pinMemory', scenario)
    await assert.rejects(f.run(), error => scenario === 'primary' ? error === f.primary
      : error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === f.primary && error.errors[1] === f.closeError)
    f.oldData()
  }
})

test('growth retains both errors and already committed growth/first consolidation when its later update fails', async t => {
  for (const scenario of ['primary', 'both']) {
    const f = await fixture(t, 'consolidateGrowth', scenario)
    await assert.rejects(f.run(), error => scenario === 'primary' ? error === f.primary
      : error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === f.primary && error.errors[1] === f.closeError)
    f.changed(true)
  }
})

test('BEGIN failure is retained with close failure and never tries rollback without a transaction', async t => {
  for (const method of ['remember', 'reviseMemory']) {
    const f = await fixture(t, method, 'begin-close')
    await assert.rejects(f.run(), error => error instanceof AggregateError && error.errors.length === 2
      && error.errors[0] === f.primary && error.errors[1] === f.closeError)
    assert.equal(f.rollbackAttempts(), 0)
    f.oldData()
  }
})

test('all four writers retain normal responses and committed data in both scopes even when close alone fails', async t => {
  for (const method of ['remember', 'reviseMemory', 'pinMemory', 'consolidateGrowth']) {
    for (const scope of ['shared', 'personal']) {
      for (const scenario of ['normal', 'close']) {
        const f = await fixture(t, method, scenario, scope)
        if (scenario === 'close') await assert.rejects(f.run(), error => error === f.closeError)
        else {
          const result = await f.run()
          assert.equal(result.scope, scope)
          if (method === 'pinMemory') assert.equal(result.pinned, true)
          else assert.equal(result.content, 'latest value')
        }
        f.changed(false)
      }
    }
  }
})
