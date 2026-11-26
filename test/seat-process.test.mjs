import test from 'node:test'
import assert from 'node:assert/strict'
import { createSeatProcessRunner } from '../src/seat-process.mjs'
import { runShellCommand } from '../src/scheduler.mjs'
import { restoreBotEnvironments } from '../src/bot-environment.mjs'
import { runWaitProcess } from '../src/aiterm-transport.mjs'
import { seatCommandSpec, validateSecretEnv } from '../src/seat-command.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

test('O2: a secret environment is validated before any process starts and is never in argv', () => {
  const run = createSeatProcessRunner('/synthetic-project')
  for (const bad of [null, [], 'x', { lower: 'a' }, { '1A': 'a' }, { A: 1 }, { PATH: 'x' }, { HOME: 'x' }, { NODE_OPTIONS: 'x' }, { LD_PRELOAD: 'x' }, { BELLTEAM_X: 'x' },
    { A: 'a\0b' }, { A: 'x'.repeat(64 * 1024 + 1) }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, 'a'])), Object.create({ A: 'a' })])
    assert.throws(() => run('true', [], { secretEnv: bad }), { code: 'SEAT_SECRET_ENV_INVALID' })
  assert.throws(() => validateSecretEnv({ GH_TOKEN: 'a' }, { GH_TOKEN: 'already' }), { code: 'SEAT_SECRET_ENV_INVALID' })
  assert.deepEqual(validateSecretEnv({ GH_TOKEN: 'a', DB_PASSWORD_2: 'b' }), { GH_TOKEN: 'a', DB_PASSWORD_2: 'b' })
  const spec = seatCommandSpec('true', [], { project: '/synthetic-project', environment: 'base', secretEnv: true })
  assert.ok(spec.args.includes('--env-stdin'))
  assert.ok(!spec.args.some(value => value.includes('super-secret')))
  assert.ok(!seatCommandSpec('true', [], { project: '/synthetic-project' }).args.includes('--env-stdin'))
})

test('O2: run-seat-command reads exactly one stdin line, merges it for the command only, and leaves the rest of stdin to the command', { skip: process.getuid?.() !== 1000 }, () => {
  const entry = fileURLToPath(new URL('../src/run-seat-command.mjs', import.meta.url))
  const run = (line, rest, script = 'printf "%s|" "$SYNTH_SECRET"; cat') => spawnSync(process.execPath, [entry, '/tmp', '--base-environment', '--env-stdin', '--', 'sh', '-c', script],
    { input: line + '\n' + rest, encoding: 'utf8', env: { PATH: process.env.PATH } })
  const ok = run(JSON.stringify({ SYNTH_SECRET: 'value-123' }), 'rest-of-stdin')
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, 'value-123|rest-of-stdin')
  for (const bad of [JSON.stringify({ PATH: 'x' }), JSON.stringify({ SYNTH_SECRET: 1 }), 'not json', JSON.stringify([])]) {
    const refused = run(bad, 'rest', 'echo started')
    assert.notEqual(refused.status, 0)
    assert.ok(!refused.stdout.includes('started'))
    assert.ok(!refused.stderr.includes('value-123'))
  }
  const eof = spawnSync(process.execPath, [entry, '/tmp', '--base-environment', '--env-stdin', '--', 'sh', '-c', 'echo started'], { input: '{"A":"b"}', encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.notEqual(eof.status, 0)
  assert.ok(!eof.stdout.includes('started'))
})
