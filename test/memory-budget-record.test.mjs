import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBudgetRecord } from '../src/memory-budget-record.mjs'
import { LaunchGate } from '../src/launch-gate.mjs'

const GiB = 2 ** 30

test('counts, last time and the peak reach the file; a rise under one point does not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-budget-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'memory-budget.json')
  const record = new MemoryBudgetRecord({ path, now: () => new Date('2026-11-23T00:00:00Z') })
  record.earlySleep(); record.earlySleep(); record.refusal(); record.peak(0.62); record.peak(0.625); record.peak(0.5)
  await record.writing
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual([saved.early_sleep.count, saved.refusal.count, saved.peak.share], [2, 1, 0.62])
  assert.equal(saved.early_sleep.last_at, '2026-11-23T00:00:00.000Z')
  assert.equal(saved.schema, 'bellteam.memory-budget.v1')
})

test('an unwritable path drops the write and never throws', async () => {
  const record = new MemoryBudgetRecord({ path: '/nonexistent-dir/x.json' })
  record.refusal(); await record.writing
  assert.equal(record.data.refusal.count, 1)
})

test('LaunchGate.tight records the effective share as the peak', async () => {
  const record = new MemoryBudgetRecord()
  const gate = new LaunchGate({ pressure: async () => ({ anon: 11 * GiB, max: 20 * GiB, ratio: 0.55 }), seatBytes: GiB, record })
  gate.launched(); gate.launched()
  assert.equal(await gate.tight(), false)
  assert.equal(record.data.peak.share, 0.65)
})
