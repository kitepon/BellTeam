import assert from 'node:assert/strict'
import test from 'node:test'

import { LaunchLine } from '../src/launch-line.mjs'

const GiB = 2 ** 30
function line(readings, opts = {}) {
  let time = 0
  const order = []
  const l = new LaunchLine({ pressure: async () => readings(time), hold: 0.7, seatBytes: GiB, pollMs: 1000, maxWaitMs: 45_000, settleMs: 30_000,
    now: () => time, sleep: async ms => { time += ms }, ...opts })
  return { l, order, at: () => time }
}
const reading = anon => ({ anon: anon * GiB, max: 20 * GiB, ratio: anon / 20 })

test('below HOLD a launch goes at once; no reading goes too', async () => {
  const a = line(() => reading(8))
  await a.l.enter('bot-a'); assert.equal(a.at(), 0)
  const b = line(() => null)
  await b.l.enter('bot-a'); assert.equal(b.at(), 0)
})

test('above HOLD it waits until memory frees, never failing', async () => {
  const a = line(time => reading(time < 12_000 ? 15 : 9))
  await a.l.enter('bot-a')
  assert.equal(a.at(), 12_000)
})

test('a stuck high reading ends at maxWaitMs and the launch goes (under the 60 s IPC deadline)', async () => {
  const a = line(() => reading(19))
  await a.l.enter('bot-a')
  assert.equal(a.at(), 45_000)
})

test('FIFO, and one entry per seat: a second delivery for a waiting seat shares it', async () => {
  const a = line(time => reading(time < 3000 ? 15 : 6))
  const first = a.l.enter('bot-a'), again = a.l.enter('bot-a'), other = a.l.enter('bot-b')
  assert.equal(first, again)
  assert.equal(a.l.has('bot-a'), true)
  const done = []
  first.then(() => done.push('a')); other.then(() => done.push('b'))
  await Promise.all([first, other])
  assert.deepEqual(done, ['a', 'b'])
  assert.equal(a.l.has('bot-a'), false)
})

test('seats admitted in the last settleMs count as already there (a launch shows in memory only later)', async () => {
  // 11 GiB read, hold 14 GiB, 1 GiB each: 3 admissions fit, the 4th waits until the first ones age out of settleMs.
  const a = line(() => reading(11))
  for (const id of ['a', 'b', 'c']) await a.l.enter(id)
  assert.equal(a.at(), 0)
  await a.l.enter('d')
  assert.equal(a.at(), 30_000)
})
