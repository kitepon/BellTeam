import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionGeneration } from '../src/execution-generation.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, { legacy = false, shortDrain = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'execution-proof-'))
  const bot = { id: 'bot-synthetic', session: 'synthetic', harness: 'codex' }, read = deferred(), entered = deferred()
  let sharedCalls = 0, sharedHeld = false, nativeCloses = 0, shortenDrain = shortDrain
  const mutex = { async runExclusive(action) {
    assert.equal(sharedHeld, false, 'shared mutex must not be reacquired by the proof')
    sharedHeld = true; sharedCalls++
    try { return await action() } finally { sharedHeld = false }
  } }
  const ports = { bots: new Map([[bot.id, bot]]), rooms: {},
    configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    membersAdmission: new MembersAdmission(), access: { assertWorkAllowed() {} }, observer: { report() {} },
    native: { async call(name) { if (name === 'pty_observe') { entered.resolve(); return read.promise } return {} },
      async close() { nativeCloses++ } } }
  const controller = createExecutionGeneration({ ports, exchangeMutex: mutex, onAdopt: async () => {},
    loadFactory: async versionId => Object.freeze({ versionId, sourceCommit: 'a'.repeat(40), createExecutionDispatcher(params) {
      const actual = createExecutionDispatcher(params)
      return { ...actual, ...(legacy ? { assertQuiescent: undefined } : {}),
        control: (action, options) => actual.control(action, shortenDrain && action === 'quiesce' ? { timeoutMs: 0 } : options) }
    } }) })
  t.after(async () => { shortenDrain = false; read.resolve({ structuredContent: { exists: true } }); await controller.close(); await rm(root, { recursive: true, force: true }) })
  await controller.start()
  return { controller, bot, read, entered, mutex, sharedCalls: () => sharedCalls, nativeCloses: () => nativeCloses }
}

test('proof keeps the real engine fenced through actual callback completion under one outer shared mutex', async t => {
  const f = await fixture(t), entered = deferred(), durable = deferred()
  const before = f.controller.snapshot(), calls = f.sharedCalls()
  let proof, finished = false
  const attempt = f.mutex.runExclusive(() => f.controller.withInstallReconciliationProof(assertQuiescent => {
    proof = assertQuiescent; assert.equal(proof(), true); entered.resolve()
    return Object.assign(Promise.resolve('saved'), { completion: durable.promise })
  })).then(result => { finished = true; return result })
  await entered.promise; await tick()
  assert.equal(finished, false); assert.equal(f.controller.snapshot().available, false)
  assert.equal(f.controller.snapshot().generation, before.generation)
  await assert.rejects(f.controller.dispatch({ method: 'transport.observe', args: [f.bot] }), { code: 'EXECUTION_NOT_ACCEPTING' })
  // A second exclusive request takes its turn after the proof instead of being refused (Owner 2026-11-08).
  let second = false
  const queued = f.controller.withInstallReconciliationProof(() => { second = true; return 'second' })
  await tick(); assert.equal(second, false)
  durable.resolve(); assert.equal(await attempt, 'saved')
  assert.equal(f.sharedCalls(), calls + 1)
  assert.throws(proof, { code: 'EXECUTION_PROOF_UNAVAILABLE' }); assert.equal(f.nativeCloses(), 0)
  assert.equal(await queued, 'second'); assert.equal(f.controller.snapshot().available, true)
})

test('actual native work refuses the proof and resumes the same engine without releasing the work', async t => {
  const f = await fixture(t, { shortDrain: true }), generation = f.controller.snapshot().generation
  let called = 0, done = false
  const running = f.controller.dispatch({ method: 'transport.observe', args: [f.bot] }).then(value => { done = true; return value })
  await f.entered.promise
  await assert.rejects(f.controller.withInstallReconciliationProof(() => { called++ }), { code: 'EXECUTION_BUSY' })
  assert.equal(called, 0); assert.equal(done, false); assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.snapshot().generation, generation)
  f.read.resolve({ structuredContent: { exists: true } }); await running
  assert.equal(f.nativeCloses(), 0)
})

test('parent close invalidates the proof and waits for its actual callback completion', async t => {
  const f = await fixture(t), entered = deferred(), durable = deferred()
  let proof, closed = false
  const attempt = f.controller.withInstallReconciliationProof(assertQuiescent => {
    proof = assertQuiescent; entered.resolve(); return Object.assign(Promise.resolve(), { completion: durable.promise })
  })
  const rejected = assert.rejects(attempt, { code: 'EXECUTION_PROOF_UNAVAILABLE' })
  await entered.promise
  const closing = f.controller.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false); assert.throws(proof, { code: 'EXECUTION_PROOF_UNAVAILABLE' })
  durable.resolve(); await rejected; await closing
  assert.equal(f.controller.snapshot().phase, 'closed'); assert.equal(f.nativeCloses(), 0)
})

test('legacy engine has no proof and is refused before changing its admission', async t => {
  const f = await fixture(t, { legacy: true }), before = f.controller.snapshot()
  let called = false
  await assert.rejects(f.controller.withInstallReconciliationProof(() => { called = true }), { code: 'EXECUTION_PROOF_UNAVAILABLE' })
  assert.equal(called, false); assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.snapshot().generation, before.generation); assert.equal(f.controller.snapshot().phase, 'running')
})

test('callback rejection retains actual completion and returns the same error after resuming', async t => {
  const f = await fixture(t), entered = deferred(), durable = deferred(), error = new Error('synthetic claim failure')
  let proof, settled = false
  const attempt = f.controller.withInstallReconciliationProof(assertQuiescent => {
    proof = assertQuiescent; entered.resolve()
    return Object.assign(Promise.reject(error), { completion: durable.promise })
  })
  const rejected = assert.rejects(attempt, value => { settled = true; return value === error })
  await entered.promise; await tick()
  assert.equal(settled, false); assert.equal(proof(), true); assert.equal(f.controller.snapshot().available, false)
  durable.resolve(); await rejected
  assert.equal(f.controller.snapshot().available, true); assert.throws(proof, { code: 'EXECUTION_PROOF_UNAVAILABLE' })
})
