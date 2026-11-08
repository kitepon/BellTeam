import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionGeneration } from '../src/execution-generation.mjs'
import { createExecutionDispatcher, EXECUTION_STATE_COMPATIBILITY } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const version = 'a'.repeat(64), badVersion = 'b'.repeat(64), sourceCommit = 'c'.repeat(40)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const request = (method, ...args) => ({ method, args })
async function fixture(t, { save = async () => {}, failInitialize = false, failConstruct = false, cleanupUnknown = false, shortDrain = false, refuseHandover = false, autoStart = true, beforeLoad = async () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'execution-generation-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', session: 'synthetic', harness: 'codex' }, bots = new Map([[bot.id, bot]])
  const read = deferred(), created = [], selections = [], loads = [], nativeCalls = []
  let nativeCloses = 0, releaseCleanup = false
  const ports = { bots, rooms: {}, configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    membersAdmission: new MembersAdmission(), access: { assertWorkAllowed() {} }, observer: { report() {} },
    native: { async call(name) { nativeCalls.push(name); return name === 'pty_observe' ? read.promise : {} }, async close() { nativeCloses++ } } }
  const loadFactory = async (versionId, options) => {
    loads.push({ versionId, options }); await beforeLoad()
    return Object.freeze({ versionId, sourceCommit, createExecutionDispatcher(params) {
      if (failConstruct && versionId === badVersion) throw Error('synthetic constructor failure')
      const actual = createExecutionDispatcher(params), record = { versionId, actual, retired: false }; created.push(record)
      return { ...actual,
        project: input => input.method === 'administration.view'
          ? { ...actual.project(input), fixtureVersion: versionId } : actual.project(input),
        control: (action, options) => {
          if (action === 'initialize' && versionId === badVersion && failInitialize) return Promise.reject(Error('synthetic initialization failure'))
          // Pre-#543 installed code refused a handover while busy.
          if (refuseHandover && versionId === null && action === 'quiesce' && options?.handover) return actual.control('quiesce', { timeoutMs: 0 })
          return actual.control(action, shortDrain && action === 'quiesce' ? { timeoutMs: 0 } : options)
        },
        disconnect: async () => {
          if (versionId === badVersion && cleanupUnknown && !releaseCleanup) throw Error('synthetic cleanup unconfirmed')
          const result = await actual.disconnect(); record.retired = true; return result
        },
      }
    } })
  }
  const controller = createExecutionGeneration({ ports, loadFactory, onAdopt: selection => { selections.push(selection); return save(selection) } })
  t.after(async () => { releaseCleanup = true; read.resolve({ structuredContent: { exists: true } }); await controller.close().catch(() => {}) })
  if (autoStart) await controller.start()
  return { controller, bot, read, created, selections, loads, nativeCalls, nativeCloses: () => nativeCloses }
}

test('real engine exchange serves the previous synchronous projection until the durable selection ACK, then retires it', async t => {
  const ack = deferred(), entered = deferred()
  const f = await fixture(t, { save: async () => { entered.resolve(); await ack.promise } })
  const stableProject = f.controller.project
  assert.equal(stableProject(request('administration.view', f.bot)).fixtureVersion, null)
  const replacing = f.controller.replace(version)
  await entered.promise
  // Reads never 503 during an exchange: the previous engine answers until the new one is running.
  assert.equal(f.controller.project(request('administration.view', f.bot)).fixtureVersion, null)
  await assert.rejects(f.controller.dispatch(request('transport.notify', f.bot, 'LATE')), { code: 'EXECUTION_NOT_ACCEPTING' })
  assert.equal(f.controller.snapshot().currentVersionId, null)
  assert.equal(f.created.length, 2); assert.equal(f.created[0].retired, false)
  ack.resolve(); await replacing
  f.read.resolve({ structuredContent: { exists: true } })
  while (!f.created[0].retired) await tick()
  const result = stableProject(request('administration.view', f.bot))
  assert.equal(result.fixtureVersion, version); assert.equal(typeof result.then, 'undefined')
  assert.deepEqual(f.selections, [{ currentVersionId: version, previousVersionId: null }])
  assert.equal(f.controller.snapshot().stateCompatibility, EXECUTION_STATE_COMPATIBILITY)
  assert.equal(f.nativeCloses(), 0)
})

test('an old engine that refuses the handover cannot veto its replacement; the new engine starts cold', async t => {
  const f = await fixture(t, { refuseHandover: true })
  const reading = f.controller.dispatch(request('transport.observe', f.bot)); await tick()
  await f.controller.replace(version)
  assert.equal(f.created.length, 2)
  assert.equal(f.controller.snapshot().currentVersionId, version); assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.project(request('administration.view', f.bot)).fixtureVersion, version)
  assert.deepEqual(f.selections, [{ currentVersionId: version, previousVersionId: null }])
  assert.equal(f.created[0].retired, false)
  f.read.resolve({ structuredContent: { exists: true } }); await reading
  // The unreleased old engine retires itself once its own work is done.
  while (!f.created[0].retired) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(f.nativeCloses(), 0)
})

test('a failed candidate is closed before reconstructing the original factory and awaiting rollback ACK', async t => {
  const f = await fixture(t, { failInitialize: true })
  await assert.rejects(f.controller.replace(badVersion), { message: 'EXECUTION_REPLACE_ROLLBACK' })
  assert.deepEqual(f.created.map(x => [x.versionId, x.retired]), [[null, true], [badVersion, true], [null, false]])
  assert.deepEqual(f.selections, [{ currentVersionId: null, previousVersionId: null }])
  assert.equal(f.controller.project(request('administration.view', f.bot)).fixtureVersion, null)
  assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.nativeCloses(), 0)
})

test('unconfirmed candidate cleanup leaves the controller unavailable without constructing a rollback engine', async t => {
  const f = await fixture(t, { failInitialize: true, cleanupUnknown: true })
  await assert.rejects(f.controller.replace(badVersion))
  assert.equal(f.created.length, 2); assert.equal(f.controller.snapshot().available, false)
  assert.throws(() => f.controller.project(request('transport.session', f.bot)), { code: 'EXECUTION_NOT_ACCEPTING' })
  assert.deepEqual(f.selections, []); assert.equal(f.nativeCloses(), 0)
})

test('failed rollback persistence cannot reopen admission', async t => {
  const f = await fixture(t, { failInitialize: true, save: async () => { throw Error('synthetic selection ACK missing') } })
  await assert.rejects(f.controller.replace(badVersion))
  assert.equal(f.created.length, 3); assert.equal(f.controller.snapshot().available, false)
  assert.throws(() => f.controller.project(request('transport.session', f.bot)), { code: 'EXECUTION_NOT_ACCEPTING' })
})

test('a reserved update has actual completion, starts once, and an unstarted reservation is canceled on close', async t => {
  const ack = deferred(), entered = deferred()
  const f = await fixture(t, { save: async () => { entered.resolve(); await ack.promise } })
  const update = f.controller.reserve(version)
  let completed = false; update.completion.then(() => { completed = true })
  update.start(); update.start(); await entered.promise; await tick()
  assert.equal(completed, false); assert.equal(f.created.length, 2)
  ack.resolve(); await update.completion
  assert.equal(f.controller.snapshot().update.status, 'succeeded')
  const cancel = f.controller.reserve('builtin')
  await f.controller.close(); await cancel.completion
  assert.equal(f.controller.snapshot().update.status, 'not_started')
})


test('the selection response cannot release the generation before its real persistence completion', async t => {
  const durable = deferred(), responded = deferred()
  const f = await fixture(t, { save: () => { responded.resolve(); return Object.assign(Promise.resolve(), { completion: durable.promise }) } })
  const updating = f.controller.replace(version)
  await responded.promise; await tick()
  assert.equal(f.controller.snapshot().available, false)
  durable.resolve(); await updating
  assert.equal(f.controller.snapshot().currentVersionId, version)
})

test('closing during factory lookup cannot initialize a future engine', async t => {
  const loading = deferred(), entered = deferred()
  const f = await fixture(t, { autoStart: false, beforeLoad: async () => { entered.resolve(); await loading.promise } })
  const starting = f.controller.start(); await entered.promise
  const closing = f.controller.close()
  loading.resolve(); await assert.rejects(starting, { code: 'EXECUTION_CLOSED' }); await closing
  assert.equal(f.created.length, 0); assert.equal(f.controller.snapshot().phase, 'closed')
})


test('a constructor failure without an accepted engine restores the retained factory', async t => {
  const f = await fixture(t, { failConstruct: true })
  await assert.rejects(f.controller.replace(badVersion))
  assert.equal(f.created.length, 2); assert.equal(f.created[0].retired, true)
  assert.equal(f.controller.snapshot().available, true)
  await f.controller.close()
})

test('failed candidate adoption is rolled back only after candidate close and durable old selection ACK', async t => {
  const f = await fixture(t, { save: async selection => { if (selection.currentVersionId === version) throw Error('synthetic save failure') } })
  await assert.rejects(f.controller.replace(version), { message: 'EXECUTION_ADOPTION_ROLLBACK' })
  assert.deepEqual(f.created.map(x => [x.versionId, x.retired]), [[null, true], [version, true], [null, false]])
  assert.deepEqual(f.selections, [{ currentVersionId: version, previousVersionId: null }, { currentVersionId: null, previousVersionId: null }])
  assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.snapshot().currentVersionId, null)
})
