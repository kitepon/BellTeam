import assert from 'node:assert/strict'
import test from 'node:test'

import { LaunchGate } from '../src/launch-gate.mjs'

const GiB = 2 ** 30
const reading = anon => async () => ({ anon: anon * GiB, max: 20 * GiB, ratio: anon / 20 })
const gate = (pressure, time = { at: 0 }) => ({ time, g: new LaunchGate({ pressure, hold: 0.7, seatBytes: GiB, settleMs: 30_000, now: () => time.at }) })

test('below HOLD it is not tight; at or above it is', async () => {
  assert.equal(await gate(reading(13)).g.tight(), false)
  assert.equal(await gate(reading(14)).g.tight(), true)
})

test('no reading is no pressure', async () => {
  assert.equal(await gate(async () => null).g.tight(), false)
  assert.equal(await gate(async () => { throw new Error('EACCES') }).g.tight(), false)
})

test('a launch that failed is taken back and no longer counts', async () => {
  const { g } = gate(reading(11))
  const failed = g.launched(); g.launched()
  g.launched()
  assert.equal(await g.tight(), true, '11 + 3 = 14 GiB')
  g.abandon(failed)
  assert.equal(await g.tight(), false, '11 + 2 = 13 GiB')
})

test('seats launched in the last settleMs count as already there, then age out', async () => {
  const { g, time } = gate(reading(11))
  assert.equal(await g.tight(), false)
  g.launched(); g.launched()
  assert.equal(await g.tight(), false, '11 + 2 = 13 GiB')
  g.launched()
  assert.equal(await g.tight(), true, '11 + 3 = 14 GiB')
  time.at = 30_000
  assert.equal(await g.tight(), false, 'the three launches have settled into the reading')
})
