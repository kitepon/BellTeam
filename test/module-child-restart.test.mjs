import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createModuleChildRestart, observeModuleChild } from '../src/module-child-restart.mjs'

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('restart timer backs off to thirty seconds and close cancels retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const recovery = createModuleChildRestart(async () => { calls++; throw new Error('failed startup') })
  recovery.lost(); t.mock.timers.tick(1000); await settle(); assert.equal(calls, 0)
  recovery.running(); recovery.lost()
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
