import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createUpdateCenter, updateNotificationCandidates } from '../src/update-center.mjs'
import { updateExamples, validateUpdates } from '../src/update-center-contract.mjs'

function inventory() {
  const value = structuredClone(updateExamples.no_update), component = value.components[0]
  component.published.version = 'b'.repeat(64)
  component.comparison = { state: 'update_available', reason: null }
  component.publication = { catalog: { sha256: 'd'.repeat(64), publishedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }, check: { status: 'verified', checkedAt: '2026-01-01T00:00:00Z', error: null } }
  return value
}

test('only verified unexpired server update candidates are projected through the optional closed schema', () => {
  const value = inventory()
  assert.deepEqual(updateNotificationCandidates(value), [{ componentId: 'container', id: 'b'.repeat(64) }])
  value.notificationCandidates = updateNotificationCandidates(value)
  assert.equal(validateUpdates(value).valid, true)
  for (const change of [c => { c.current = null }, c => { c.published = null }, c => { c.comparison.state = 'up_to_date' },
    c => { c.comparison.state = 'incompatible' }, c => { c.publication.check.status = 'failed' }, c => { c.publication = null },
    c => { c.publication.catalog.expiresAt = '2020-01-01T00:00:00Z' }, c => { c.published.version = 'invalid' }]) {
    const invalid = inventory(); change(invalid.components[0]); assert.deepEqual(updateNotificationCandidates(invalid), [])
  }
  value.notificationCandidates[0].extra = true
  assert.equal(validateUpdates(value).valid, false)
})

test('background catalog reads work with no clients, retain deduplication across failure, and drain on close without retrying unknown sends', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const sent = [], value = inventory()
  let reads = 0, events = 0, failRead = false, blocked = null, releaseRead, executorCloses = 0
  const center = createUpdateCenter({ notifications: { update({ id }) { sent.push(id); if (id === 'c'.repeat(64)) throw Error('unknown send') } },
    moduleCatalog: { async snapshot() { reads++; if (blocked) await blocked; if (failRead) throw Error('catalog unavailable'); return structuredClone(value) } },
    moduleExecutor: { snapshot: snapshot => snapshot, close() { executorCloses++ } },
  })
  center.watch(() => events++)
  center.startNotifications(); center.startNotifications()
  await setImmediate()
  assert.equal(reads, 1); assert.deepEqual(sent, ['b'.repeat(64)]); assert.equal(events, 1)
  failRead = true; t.mock.timers.tick(60000); await setImmediate()
  failRead = false; t.mock.timers.tick(60000); await setImmediate()
  assert.equal(sent.length, 1)
  value.components[0].published.version = 'c'.repeat(64)
  t.mock.timers.tick(60000); await setImmediate()
  t.mock.timers.tick(60000); await setImmediate()
  assert.deepEqual(sent, ['b'.repeat(64), 'c'.repeat(64)])
  value.components[0].comparison.state = 'up_to_date'
  t.mock.timers.tick(60000); await setImmediate()
  value.components[0].comparison.state = 'update_available'
  t.mock.timers.tick(60000); await setImmediate()
  assert.equal(sent.length, 2)
  blocked = new Promise(resolve => { releaseRead = resolve })
  t.mock.timers.tick(60000); await setImmediate()
  const before = reads
  t.mock.timers.tick(180000); await setImmediate()
  assert.equal(reads, before)
  const closing = center.close()
  value.components[0].published.version = 'e'.repeat(64)
  releaseRead(); await closing
  t.mock.timers.tick(180000); await setImmediate()
  assert.equal(reads, before); assert.equal(sent.length, 2); assert.equal(executorCloses, 1)
})
