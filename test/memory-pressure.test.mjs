import assert from 'node:assert/strict'
import test from 'node:test'

import { HOLD, SOFT, memoryPressure } from '../src/memory-pressure.mjs'

const files = (max, anon) => file => file.endsWith('memory.max') ? Promise.resolve(`${max}\n`) : Promise.resolve(`anon ${anon}\nfile 5\n`)

test('reads anon against the cgroup limit; SOFT < HOLD', async () => {
  assert.ok(SOFT < HOLD)
  assert.deepEqual(await memoryPressure({ read: files(20, 10) })(), { anon: 10, max: 20, ratio: 0.5 })
})

test('no limit or an unreadable file is no reading (unknown is not pressure)', async () => {
  assert.equal(await memoryPressure({ read: files('max', 10) })(), null)
  assert.equal(await memoryPressure({ read: () => Promise.reject(new Error('EACCES')) })(), null)
  assert.equal(await memoryPressure({ read: file => Promise.resolve(file.endsWith('memory.max') ? '20' : 'file 5\n') })(), null)
})

test('a reading is cached for ttlMs', async () => {
  let reads = 0, time = 0
  const read = file => { reads++; return files(20, 10)(file) }
  const sample = memoryPressure({ read, now: () => time, ttlMs: 2000 })
  await sample(); await sample(); time = 1999; await sample()
  assert.equal(reads, 2)
  time = 2000; await sample()
  assert.equal(reads, 4)
})
