import assert from 'node:assert/strict'
import test from 'node:test'

import { AitermTransport } from '../src/aiterm-transport.mjs'
import { dispatchExecution } from '../src/execution-transport.mjs'

const SWEEP = 'Lattice: you are not running, and you have tasks in progress or tasks that can start (every prerequisite is done). Start at least one now.'
const transport = tight => new AitermTransport({ client: { call: async () => ({}) }, launchGate: tight === undefined ? null : { tight: async () => tight, launched() {} } })
const job = (from, message) => ({ info: { from, message } })

// a505c (memory-budget.md): a Lattice sweep prompt that would start a cold seat is refused while memory is full; nothing else is.
test('under pressure the sweep prompt is refused as a designed not_started refusal', async () => {
  const j = job('scheduler', SWEEP)
  await assert.rejects(transport(true).refuseSweepUnderPressure(j), error => {
    assert.equal(error.code, 'BOT_MEMORY_PRESSURE')
    assert.equal(error.effect, 'not_started')
    assert.deepEqual(error.executionError, { schema: 'aiterm.execution-error.v1', code: 'EXECUTION_BUSY', effect: 'not_started', follow_up: 'none' })
    return true
  })
  assert.equal(j.deliveryStage, 'BOT_MEMORY_PRESSURE')
})

test('the Owner, members, rooms, calls, other schedules and other Lattice notices are never refused', async () => {
  const t = transport(true)
  for (const j of [job('user', SWEEP), job('bot-7b140b27', SWEEP), job('scheduler', '[BellTeam schedule b305] Read the routine'),
    job('scheduler', 'Lattice: the Owner-lane task bellteam-dev-added/a492 can start now'), job('scheduler', undefined), { info: undefined }])
    await t.refuseSweepUnderPressure(j)
})

test('not tight, or no gate, refuses nothing', async () => {
  await transport(false).refuseSweepUnderPressure(job('scheduler', SWEEP))
  await transport(undefined).refuseSweepUnderPressure(job('scheduler', SWEEP))
})

test('dispatchExecution refuses before wake for a cold seat, and never asks for a warm one', async () => {
  const calls = []
  const seat = {
    imageFiles: async () => [], removeTemporaryImages: async () => calls.push('removed'), session: () => 's1',
    refuseSweepUnderPressure: async () => { calls.push('refuse'); throw Object.assign(new Error('BOT_MEMORY_PRESSURE'), { code: 'BOT_MEMORY_PRESSURE' }) },
    wake: async () => { calls.push('wake'); return 's1' },
  }
  await assert.rejects(dispatchExecution(seat, { executionWasPresent: false, execution: {} }, { id: 'b' }, 'm', [], { check() {} }), { code: 'BOT_MEMORY_PRESSURE' })
  assert.deepEqual(calls, ['refuse', 'removed'], 'refused before wake; temporary files cleaned')
  calls.length = 0
  const warm = { executionWasPresent: true, execution: { invoke: async () => ({ structuredContent: { mode: 'agent_dispatch', event_cursor: 1, wait_process: {} } }) } }
  await dispatchExecution(seat, warm, { id: 'b' }, 'm', [], { check() {} })
  assert.deepEqual(calls, [], 'a running seat is neither refused nor woken')
})
