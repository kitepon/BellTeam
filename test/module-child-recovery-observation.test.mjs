import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleProcess } from '../src/module-process.mjs'
import { moduleRecoveryLog } from '../src/module-exchange-diagnostic.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

// Recovery rereads the adoption file (real fs I/O) before prepare, so one turn is not enough.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

async function fixture(t, { holdActual = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'module-recovery-'))
  await mkdir(join(root, 'state'))
  const admission = new ConversationLifetimes(), children = []
  let resolveActual, requests = 0
  const actual = new Promise(resolve => { resolveActual = resolve })
  const reap = child => {
    child.exitCode = 1; child.connected = false
    child.stdout.closed = child.stderr.closed = true
    child.stdout.emit('close'); child.stderr.emit('close')
    child.emit('exit', 1, null); child.emit('close', 1, null)
  }
  const controller = createModuleProcess({ component: 'conversation', root, admission,
    prepareRelease: async () => assert.fail('builtin recovery must not prepare another release'), validateReady: () => {},
    // Every start and recovery needs a passing ready probe (module-ready-probe, 7971c7a5); conversation has no default.
    probeCandidate: async () => {},
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null,
        stdout: Object.assign(new EventEmitter(), { closed: false, resume() {} }),
        stderr: Object.assign(new EventEmitter(), { closed: false, resume() {} }) })
      child.kill = () => { reap(child); return true }; child.disconnect = () => reap(child)
      children.push(child); return child
    },
    createChannel: child => ({ ready: Promise.resolve({ versionId: null, protocolVersion: 1 }),
      control: async method => { if (method === 'exit') queueMicrotask(() => reap(child)); return { resumed: true, quiesced: true } },
      request: () => { requests++; const caller = Promise.resolve(null); if (holdActual) caller.completion = actual; return caller },
      drainIncoming: async () => {}, reaped: async () => {},
    }),
  })
  await controller.start()
  t.after(async () => { resolveActual(); await controller.close(); await rm(root, { recursive: true, force: true }) })
  return { controller, admission, children, reap, resolveActual, requests: () => requests }
}

// Owner 2026-11-07 (module-process.md "Current conversation lifecycle"): pending actual work never gates conversation recovery.
test('recovery records each stage once and completes while actual work is pending, without replay', async t => {
  const logs = []
  t.mock.method(console, 'error', line => logs.push(JSON.parse(line)))
  const f = await fixture(t, { holdActual: true })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const native = f.admission.enter()
  await f.controller.request('synthetic', {})
  f.reap(f.children[0]); await settle()
  t.mock.timers.tick(1000); await settle()
  const evidence = logs.filter(value => value.code === 'MODULE_CHILD_RECOVERY')
  assert.equal(f.children.length, 2); assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.requests(), 1)
  assert.equal(evidence.at(-1).event, 'completed')
  assert.equal(evidence.at(-1).runnerActive, 1); assert.equal(evidence.at(-1).admissionActive, 1)
  assert.equal(evidence.filter(value => value.event === 'failed').length, 0)
  assert.equal(new Set(evidence.map(value => `${value.stage}:${value.event}`)).size, evidence.length, 'each stage is recorded once')
  assert.doesNotMatch(JSON.stringify(evidence), /generation|lease|correlation|synthetic|message|stack/)
  f.admission.finish(native)
})

test('recovery evidence is finite and refuses arbitrary codes, snapshot text and invalid stages', () => {
  const admission = { snapshot: () => ({ active: 2, closed: true, unconfirmed: false, generation: 'private', lease: 'private' }) }
  const value = moduleRecoveryLog('conversation', 'mutex', 'failed', 3, 0, admission, { code: 'MODULE_EXCHANGE_BUSY' })
  assert.equal(value.failureCode, 'MODULE_EXCHANGE_BUSY'); assert.equal(value.admissionActive, 2)
  const unknown = moduleRecoveryLog('conversation', 'restore', 'failed', 1, 0, admission, { code: 'private', message: 'private', stack: 'private' })
  assert.equal(unknown.failureCode, null)
  assert.doesNotMatch(JSON.stringify([value, unknown]), /private|generation|lease|message|stack/)
  assert.equal(moduleRecoveryLog('conversation', 'private', 'failed', 1, 0, admission), null)
  assert.equal(moduleRecoveryLog('private', 'runner', 'waiting', 1, 0, admission), null)
  const missing = moduleRecoveryLog('conversation', 'runner', 'waiting', Infinity, -1, { snapshot() { throw Error('private') } })
  assert.deepEqual([missing.attempt, missing.runnerActive, missing.admissionActive, missing.admissionClosed, missing.admissionUnconfirmed], [null, null, null, null, null])
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 1024)
})

test('console failure does not stop the same recovery or create extra work', async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The pre-existing child exit reporter is unchanged; fail only the new evidence sink.
  t.mock.method(console, 'error', line => { if (JSON.parse(line).code === 'MODULE_CHILD_RECOVERY') throw Error('sink unavailable') })
  f.reap(f.children[0]); await settle()
  t.mock.timers.tick(1000); await settle()
  assert.equal(f.children.length, 2); assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.requests(), 0)
})
