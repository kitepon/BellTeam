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

test('利用者の置き場の実行は、席と同じ特権入口へ、projectをHOMEにしたbase環境で渡す（a451）', async () => {
  const { createUserPlaceRunner, userPlace } = await import('../src/seat-process.mjs')
  const { seatCommandSpec } = await import('../src/seat-command.mjs')
  const { baseBotEnvironment } = await import('../src/bot-environment.mjs')
  assert.equal(userPlace({ BELLTEAM_HOME: '/home/bell' }), '/home/bell/.local')
  assert.throws(() => createUserPlaceRunner({ BELLTEAM_HOME: 'relative' }), /BELLTEAM_HOME_ABSOLUTE_REQUIRED/u)
  const run = createUserPlaceRunner({ BELLTEAM_HOME: '/home/bell' })
  assert.throws(() => run('true', [], { env: { X: '1' } }), { code: 'SEAT_DYNAMIC_ENV_UNWIRED' })
  const spec = seatCommandSpec('npm', ['ls'], { project: '/home/bell', environment: 'base' })
  assert.deepEqual(spec.args.slice(0, 3), ['-n', '--', '/usr/local/libexec/bellteam-seat-exec'])
  assert.equal(spec.args[spec.args.indexOf('/home/bell') + 1], '--base-environment')
  const env = baseBotEnvironment('/home/bell', { PATH: '/usr/local/bin:/usr/bin' })
  assert.equal(env.npm_config_prefix, '/home/bell/.local')
  assert.ok(env.PATH.startsWith('/home/bell/.local/bin:'))
  assert.equal(env.DISABLE_AUTOUPDATER, '1')
})
