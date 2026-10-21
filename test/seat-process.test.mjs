import test from 'node:test'
import assert from 'node:assert/strict'
import { createSeatProcessRunner } from '../src/seat-process.mjs'
import { runWaitProcess } from '../src/aiterm-transport.mjs'

test('席readerはserver評価envや不正入力を子起動前に拒否する', () => {
  assert.throws(() => createSeatProcessRunner('relative'), { code: 'SEAT_PROJECT_INVALID' })
  const run = createSeatProcessRunner('/synthetic-project')
  assert.throws(() => run('true', [], { env: { SYNTHETIC_SERVER: 'never-transfer' } }), { code: 'SEAT_DYNAMIC_ENV_UNWIRED' })
  assert.throws(() => run('true', [], { maxBuffer: 0 }), { code: 'SEAT_BUFFER_INVALID' })
  assert.throws(() => run('true', [], { input: {} }), { code: 'SEAT_INPUT_INVALID' })
  for (const seatProject of [undefined, '', false, 0])
    assert.throws(() => runWaitProcess({ executable: 'true', args: [] }, null, { seatProject }), { code: 'SEAT_PROJECT_INVALID' })
})
