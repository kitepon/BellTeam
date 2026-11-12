import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createChildStderrLog, createModuleChildRestart, maskStderrLine, observeModuleChild } from '../src/module-child-restart.mjs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('restart timer backs off to thirty seconds and close cancels retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const recovery = createModuleChildRestart(async () => { calls++; throw new Error('failed startup') })
  recovery.lost()
  for (const [i, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
    t.mock.timers.tick(delay - 1); await settle(); assert.equal(calls, i)
    t.mock.timers.tick(1); await settle(); assert.equal(calls, i + 1)
  }
  recovery.close(); t.mock.timers.tick(60000); await settle(); assert.equal(calls, 7)
})

test('healthy minute resets the interval and repeated loss never duplicates a timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let calls = 0, recovery
  recovery = createModuleChildRestart(async () => { calls++; recovery.running() })
  recovery.running(); recovery.lost(); recovery.lost()
  t.mock.timers.tick(1000); await settle(); assert.equal(calls, 1)
  t.mock.timers.tick(60000); recovery.lost(); recovery.lost()
  t.mock.timers.tick(999); await settle(); assert.equal(calls, 1)
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2)
  recovery.close()
})

test('stderr observation retains only a finite set of fixed codes', () => {
  const stderr = new EventEmitter(), stdout = { resume() {} }
  stderr.resume = () => {}
  const codes = observeModuleChild({ stderr, stdout })
  stderr.emit('data', Buffer.from('private token secret ERR_IPC_CHANNEL_'))
  stderr.emit('data', Buffer.from('CLOSED private body ' + 'x'.repeat(10000)))
  stderr.emit('data', Buffer.from('ERR_WORKER_OUT_OF_MEMORY secret'))
  assert.deepEqual(codes().stderrCodes, ['ERR_IPC_CHANNEL_CLOSED', 'ERR_WORKER_OUT_OF_MEMORY'])
  assert.doesNotMatch(JSON.stringify(codes()), /private|secret|token/)
})

test('hold waits for the next running and refuses when closed or never running', async () => {
  const { createModuleChildRestart } = await import('../src/module-child-restart.mjs')
  const recovery = createModuleChildRestart(async () => {})
  let runs = 0
  const held = recovery.hold(() => ++runs, () => Object.assign(new Error('X_NOT_ACCEPTING'), { code: 'X_NOT_ACCEPTING' }))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 0)
  recovery.running(); assert.equal(await held, 1)
  const closing = recovery.hold(() => 'late', () => Object.assign(new Error('X_NOT_ACCEPTING'), { code: 'X_NOT_ACCEPTING' }))
  recovery.close(); assert.equal(await closing, 'late')
  await assert.rejects(recovery.hold(() => 'never', () => Object.assign(new Error('X_NOT_ACCEPTING'), { code: 'X_NOT_ACCEPTING' })), { code: 'X_NOT_ACCEPTING' })
})

test('a hold that timed out never runs its retry on a later running', async t => {
  const { mock } = await import('node:test')
  const { createModuleChildRestart, MODULE_HOLD_MS } = await import('../src/module-child-restart.mjs')
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset())
  const recovery = createModuleChildRestart(async () => {})
  let runs = 0
  const held = recovery.hold(() => ++runs, () => Object.assign(new Error('X_NOT_ACCEPTING'), { code: 'X_NOT_ACCEPTING' }))
  mock.timers.tick(MODULE_HOLD_MS)
  await assert.rejects(held, { code: 'X_NOT_ACCEPTING' })
  recovery.running(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs, 0)
})

// module-process.md ML01-ML05
test('child stderr lines land masked and bounded in a readable per-component record', async () => {
  const token = 'sk-' + 'a'.repeat(48)
  assert.equal(maskStderrLine(`BellTeam fork relay error: Error: MEMBERS_LEASE_INVALID body "hello secret" key ${token}`),
    'BellTeam fork relay error: Error: MEMBERS_LEASE_INVALID body "…" key [redacted]')
  assert.equal(maskStderrLine('    at file:///app/src/members-facade.mjs:17:30 delivery 3b7c1d2e-0a4f-4c1e-9d3a-8b2f6e1a0c55').includes('3b7c1d2e-0a4f-4c1e-9d3a-8b2f6e1a0c55'), true)
  assert.equal(maskStderrLine('x'.repeat(39) + ' ' + 'y '.repeat(400)).length, 300)
  const file = join(await mkdtemp(join(tmpdir(), 'bellteam-stderr-')), 'logs/module-stderr/conversation.log')
  const log = createChildStderrLog(file, { now: () => new Date('2026-11-12T00:00:00Z'), delayMs: 60_000 })
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), stdout: new PassThrough() })
  observeModuleChild(child, line => log.append(3, line))
  child.stderr.write('BellTeam fork relay error: Error: X\n    at a (f.mjs:1:1)\n\npartial')
  await new Promise(resolve => setImmediate(resolve))
  await log.flush()
  assert.deepEqual((await readFile(file, 'utf8')).trim().split('\n').map(row => JSON.parse(row).line), ['BellTeam fork relay error: Error: X', '    at a (f.mjs:1:1)'])
  for (let i = 0; i < 205; i += 1) log.append(4, `line ${i}`)
  await log.flush()
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  assert.equal(rows.length, 200)
  assert.deepEqual(rows.at(-1), { at: '2026-11-12T00:00:00.000Z', child: 4, line: 'line 204' })
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  // An unwritable place never throws into the module.
  await createChildStderrLog('/proc/no/such/dir/x.log').flush()
})

// module-process.md ML02: escaped and unterminated quotes, and a line whose head was trimmed, never leak a body.
test('escaped quotes, unclosed quotes and truncated long quoted lines leave no body in the record', async () => {
  const body = 'private body words'
  for (const line of [`x "a \\" ${body} \\" b" y`, `x '${body} \\' more' y`, `x "${body}`, `x "${body}\\`])
    assert.equal(maskStderrLine(line).includes('body'), false, line)
  assert.equal(maskStderrLine('x "a \\" b" y'), 'x "…" y')
  const seen = []
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), stdout: new PassThrough() })
  observeModuleChild(child, line => seen.push(maskStderrLine(line)))
  child.stderr.write(`error "${'p'.repeat(9000)} ${body}" tail\nnext "${body}"\n`)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen, ['[line truncated]', 'next "…"'])
})
