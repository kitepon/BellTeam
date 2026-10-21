import test from 'node:test'
import assert from 'node:assert/strict'
import { createSeatProcessRunner } from '../src/seat-process.mjs'
import { runShellCommand } from '../src/scheduler.mjs'
import { restoreBotEnvironments } from '../src/bot-environment.mjs'
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


test('席予定/setupの明示した無効modeやprojectを既定経路へ落とさない', async () => {
  assert.throws(() => createSeatProcessRunner('/synthetic', { environment: '' }), { code: 'SEAT_ENVIRONMENT_MODE_INVALID' })
  assert.throws(() => createSeatProcessRunner('/synthetic')('true', [], { acceptNonzero: 'true' }), { code: 'SEAT_EXIT_MODE_INVALID' })
  for (const seatProject of [undefined, '', false, '/other'])
    await assert.rejects(runShellCommand({ command: 'touch /synthetic-must-not-start', cwd: '/synthetic' }, { seatProject }), { code: 'SEAT_PROJECT_MISMATCH' })
  await assert.rejects(restoreBotEnvironments(new Map(), { seatCommands: 'true' }), { code: 'SEAT_COMMAND_MODE_INVALID' })
})
