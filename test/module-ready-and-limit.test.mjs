import test from 'node:test'
import assert from 'node:assert/strict'
import { probeModuleReady } from '../src/module-ready-probe.mjs'
import { createModuleChildRestart } from '../src/module-child-restart.mjs'
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

test('one public probe returns a validated read, rejects failure and has a thirty second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  assert.equal(await probeModuleReady(async () => { reads++; return 'read-response' }), 'read-response')
  assert.equal(reads, 1)
  await assert.rejects(probeModuleReady(() => { throw Error('private reason') }), { code: 'READY_PROBE_FAILED' })
  const timed = probeModuleReady(() => new Promise(() => {}))
  const rejected = assert.rejects(timed, { code: 'READY_TIMEOUT' })
  t.mock.timers.tick(30_000); await rejected
})

test('five real recovery attempts emit once, keep restarting, and clear only after a full healthy window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const problems = []; let restarts = 0
  const recovery = createModuleChildRestart(async () => { recovery.restarting(); restarts++; throw Object.assign(Error(), { code: 'READY_PROBE_FAILED' }) }, 'usage', dto => problems.push(dto))
  for (let i=0;i<6;i++) recovery.restarting()
  assert.equal(problems.length,0) // Initial/exchange launches are not recovery restarts.
  recovery.exited({ code: null, signal: 'SIGKILL' }); recovery.running(); recovery.lost()
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) { t.mock.timers.tick(delay); await settle() }
  assert.equal(restarts, 7); assert.equal(problems.length, 1)
  assert.deepEqual(problems[0], { kind: 'module_restart_limit', moduleId: 'usage', count: 5, windowSeconds: 1800,
    lastExit: { code: null, signal: 'SIGKILL' }, lastReason: 'ready_probe_failed' })
  recovery.running(); t.mock.timers.tick(1_799_999); await settle(); assert.equal(problems.length, 1)
  recovery.lost(); t.mock.timers.tick(1); await settle(); assert.equal(problems.length, 1)
  recovery.running(); t.mock.timers.tick(1_800_000); await settle()
  assert.deepEqual(problems[1], { kind: 'module_restart_limit', moduleId: 'usage', cleared: true })
  recovery.close()
})

