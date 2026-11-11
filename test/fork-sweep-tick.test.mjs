import assert from 'node:assert/strict'
import test from 'node:test'
import { createForkSweepTick } from '../src/application-services.mjs'

test('fork.sweep tick: one in flight, released on the root result, old child silent, failures reported once per code', async () => {
  const results = [], reports = []
  let calls = 0
  const tick = createForkSweepTick(() => { calls++; return results.shift() }, code => reports.push(code))
  const held = Promise.withResolvers(), completion = Promise.withResolvers()
  results.push(Object.assign(held.promise, { completion: completion.promise }))
  const first = tick()
  assert.equal(tick(), first); assert.equal(calls, 1); assert.equal(tick.inFlight(), first)
  held.resolve({ relayed: 0, owed: 1 }); await first
  assert.equal(tick.inFlight(), null) // completion (the relayed delivery) is still open
  results.push(Promise.reject(Object.assign(new Error('CONVERSATION_METHOD_UNKNOWN'), { outcome: 'not_accepted' })))
  await tick()
  for (let i = 0; i < 2; i++) { results.push(Promise.reject(Object.assign(new Error('x'), { code: 'BOT_NOT_FOUND', outcome: 'unknown' }))); await tick() }
  results.push(Promise.reject(new Error('free text'))); await tick()
  results.push(Promise.resolve({ relayed: 1, owed: 0 })); await tick()
  results.push(Promise.reject(Object.assign(new Error('x'), { code: 'BOT_NOT_FOUND' }))); await tick()
  assert.deepEqual(reports, ['BOT_NOT_FOUND', 'FORK_SWEEP_FAILED', 'BOT_NOT_FOUND'])
  assert.equal(calls, 7)
  completion.resolve()
})
