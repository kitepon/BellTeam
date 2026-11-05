import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { createModuleProcess } from '../src/module-process.mjs'
import { validateModuleExchangeDiagnostic } from '../src/module-exchange-diagnostic.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'

const sha = 'a'.repeat(64)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => {})
  return { promise, resolve, reject }
}
const turn = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'module-controller-'))
  await mkdir(join(root, 'state'))
  const children = [], controls = [], preparations = [], requests = []
  const behavior = { holdExit: false, quiesce: true, failNew: false, request: () => Promise.resolve('result'), ...options }
  const reap = child => {
    if (child.exitCode !== null) return
    child.exitCode = 0; child.connected = false
    child.stdout.closed = child.stderr.closed = true
    child.emit('exit', 0, null); child.emit('close', 0, null)
  }
  const process = createModuleProcess({ component: 'diagnostics', root, investigationsFile: '/fixture/notes.json',
    exchangeMutex: options.exchangeMutex, admission: options.admission,
    exportHandoff: () => behavior.export?.() ?? Promise.resolve(undefined),
    prepareRelease: async (versionId, expected) => {
      preparations.push({ versionId, expected })
      await behavior.prepare?.()
      return { versionId, appRoot: `/run/bellteam-maintenance/diagnostics/releases/${versionId}/payload` }
    },
    validateReady: ready => assert.equal(ready.protocolVersion, 1),
    spawnProcess: (path, args, spawnOptions) => {
      assert.equal(path, '/usr/local/libexec/bellteam-diagnostics-start')
      assert.deepEqual(spawnOptions.env, { BELLTEAM_DIAGNOSTIC_INVESTIGATIONS: '/fixture/notes.json' })
      assert.equal(spawnOptions.serialization, 'advanced')
      const child = new EventEmitter()
      Object.assign(child, { connected: true, exitCode: null, signalCode: null,
        versionId: args[0] === 'builtin' ? null : args[0],
        stdout: Object.assign(new EventEmitter(), { closed: false, resume() {} }),
        stderr: Object.assign(new EventEmitter(), { closed: false, resume() {} }),
        kill: () => { queueMicrotask(() => reap(child)); return true }, disconnect: () => reap(child),
      })
      children.push(child); return child
    },
    createChannel: (child, { generation }) => {
      if (child.versionId && behavior.failChannel) throw new Error('fixture channel construction failed')
      return {
      ready: Promise.resolve({ versionId: child.versionId, protocolVersion: 1 }),
      request: (method, params, requestOptions) => { requests.push({ method, params, requestOptions, generation }); return behavior.request() },
      callback: () => Promise.resolve('callback'),
      control: async (method, params) => {
        controls.push({ child, method, params })
        if (method === 'initialize') {
          await behavior.initialize?.(child)
          if (child.versionId && behavior.failNew) throw behavior.restoreError ?? new Error('fixture restore failed')
          assert.equal(params.generation, generation)
          return {}
        }
        if (method === 'resume') {
          if (child.versionId && behavior.failCandidateResume || !child.versionId && children.length > 2 && behavior.failRollbackResume)
            throw Object.assign(new Error('private message'), { code: 'DIAGNOSTICS_RESUME_FAILED' })
          return { resumed: true }
        }
        if (method === 'quiesce') return behavior.quiesceWait ?? { quiesced: behavior.quiesce }
        if (method === 'exit') { if (!behavior.holdExit) queueMicrotask(() => reap(child)); return { closed: true } }
      },
      reaped: async () => { await behavior.reaping?.(); child.reaped = true },
      childClosed: () => behavior.childClosed?.(),
      drainIncoming: () => behavior.parentWork?.() ?? Promise.resolve(),
      }
    },
  })
  t.after(async () => { behavior.holdExit = false; behavior.quiesce = true; await process.close(); await rm(root, { recursive: true, force: true }) })
  return { process, root, children, controls, preparations, requests, behavior, reap }
}

test('shared exchange mutex retains OS close and rejects another controller before prepare, then releases on failure', async t => {
  const exchangeMutex = createModuleExchangeMutex()
  const first = await fixture(t, { exchangeMutex }), second = await fixture(t, { exchangeMutex })
  await first.process.start(); await second.process.start()
  first.behavior.holdExit = true
  const replacing = first.process.replace(sha)
  await turn()
  assert.ok(first.controls.some(c => c.method === 'exit'))
  await assert.rejects(second.process.replace(sha), { code: 'MODULE_EXCHANGE_BUSY', outcome: 'not_accepted' })
  assert.equal(second.preparations.length, 0)
  assert.equal(second.process.snapshot().available, true)
  assert.equal(second.children.length, 1)
  const reserved = second.process.reserve(sha); reserved.start(); await reserved.completion
  assert.equal(second.process.snapshot().update.status, 'failed')
  assert.equal(second.preparations.length, 0)
  first.reap(first.children[0]); await replacing
  second.behavior.quiesce = false
  await assert.rejects(second.process.replace(sha), /QUIESCE_FAILED/)
  await exchangeMutex.runExclusive(() => {})
  second.behavior.quiesce = true
  await second.process.replace(sha)
  assert.equal(second.process.snapshot().currentVersionId, sha)
})

test('exchange retains actual request completion and OS/pipe close before the next generation', async t => {
  const f = await fixture(t)
  await f.process.start()
  const done = deferred(), result = Promise.resolve('accepted')
  Object.defineProperty(result, 'completion', { value: done.promise })
  f.behavior.request = () => result
  assert.equal(await f.process.request('record', { report: 'fixture' }), 'accepted')
  f.behavior.holdExit = true
  const exchanging = f.process.replace(sha)
  await turn()
  assert.equal(f.children.length, 1)
  await assert.rejects(f.process.request('record', {}), /NOT_ACCEPTING/)
  done.resolve(); await turn()
  assert.ok(f.controls.some(c => c.method === 'exit'))
  assert.equal(f.children.length, 1)
  f.reap(f.children[0])
  const state = await exchanging
  assert.equal(f.children.length, 2); assert.equal(f.children[0].reaped, true)
  assert.equal(state.currentVersionId, sha)
  const record = JSON.parse(await readFile(join(f.root, 'state/diagnostics-release.json')))
  assert.equal(record.currentVersionId, sha); assert.equal(record.previousVersionId, null)
})

test('failed quiesce resumes the original writer and issues no new child', async t => {
  const f = await fixture(t); await f.process.start()
  f.behavior.quiesce = false
  await assert.rejects(f.process.replace(sha), /QUIESCE_FAILED/)
  assert.equal(f.children.length, 1); assert.equal(f.children[0].exitCode, null)
  assert.equal(f.process.snapshot().available, true)
})

test('quiesce has an outer deadline while its actual completion remains held', async t => {
  const f = await fixture(t); await f.process.start()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const done = deferred(); f.behavior.quiesceWait = done.promise
  const replacing = f.process.replace(sha)
  await turn()
  const rejected = assert.rejects(replacing, /DRAIN_TIMEOUT/)
  t.mock.timers.tick(60001); await rejected
  assert.equal(f.children.length, 1); assert.equal(f.process.snapshot().available, true)
  let finished = false
  const closing = f.process.close().then(() => { finished = true })
  await turn(); assert.equal(finished, false)
  f.behavior.quiesceWait = null; done.resolve({ quiesced: true })
  t.mock.timers.reset(); await closing
})

test('parent effects after child OS close hold reaped and the next writer', async t => {
  const f = await fixture(t); await f.process.start()
  const done = deferred(); f.behavior.parentWork = () => done.promise
  const replacing = f.process.replace(sha); await turn()
  assert.equal(f.children[0].exitCode, 0)
  assert.equal(f.children[0].reaped, undefined); assert.equal(f.children.length, 1)
  done.resolve(); await replacing
  assert.equal(f.children[0].reaped, true); assert.equal(f.children.length, 2)
})

test('childClosed waits for every child barrier before releasing callback and draining incoming', async t => {
  const f = await fixture(t); await f.process.start()
  const child = f.children[0], callback = deferred(), incoming = deferred(), events = []
  f.behavior.holdExit = true
  f.behavior.childClosed = async () => { events.push('childClosed'); await callback.promise }
  f.behavior.parentWork = async () => { events.push('incoming'); await incoming.promise }
  const replacing = f.process.replace(sha)
  try {
    await turn()
    child.exitCode = 0; child.connected = false; child.emit('exit', 0, null)
    await turn(); assert.deepEqual(events, [])
    child.stdout.closed = true; child.stdout.emit('close')
    await turn(); assert.deepEqual(events, [])
    child.stderr.closed = true; child.stderr.emit('close'); child.emit('close', 0, null)
    await turn(); assert.deepEqual(events, ['childClosed'])
    assert.equal(child.reaped, undefined); assert.equal(f.children.length, 1)
    callback.resolve(); await turn()
    assert.deepEqual(events, ['childClosed', 'incoming'])
    assert.equal(child.reaped, undefined); assert.equal(f.children.length, 1)
    incoming.resolve(); await replacing
    assert.equal(child.reaped, true); assert.equal(f.children.length, 2)
  } finally {
    callback.resolve(); incoming.resolve(); f.behavior.holdExit = false
    child.stdout.closed = child.stderr.closed = true; child.emit('close', 0, null)
    await replacing
  }
})

test('private handoff metadata alone does not end the old generation before stream completion', async t => {
  const f = await fixture(t); await f.process.start()
  const done = deferred(), exported = Promise.resolve({ private: 'fixture' })
  Object.defineProperty(exported, 'completion', { value: done.promise })
  f.behavior.export = () => exported
  const replacing = f.process.replace(sha); await turn()
  assert.equal(f.children.length, 1)
  assert.equal(f.controls.some(c => c.method === 'exit'), false)
  done.resolve(); await replacing
  assert.equal(f.children.length, 2)
})

test('failed new read-restore reaps the candidate before restoring the old bundle', async t => {
  const f = await fixture(t, { failNew: true }); await f.process.start()
  await assert.rejects(f.process.replace(sha), /REPLACE_ROLLED_BACK/)
  assert.equal(f.children.length, 3)
  assert.equal(f.children[0].reaped, true); assert.equal(f.children[1].reaped, true)
  assert.equal(f.children[2].versionId, null)
  assert.equal(f.process.snapshot().available, true)
})

test('reservation completion covers real replacement or cancellation', async t => {
  const f = await fixture(t); await f.process.start()
  const cancelled = f.process.reserve(sha); cancelled.cancel(); await cancelled.completion
  assert.equal(f.process.snapshot().update.status, 'not_started')
  const done = deferred(); f.behavior.prepare = () => done.promise
  const operation = f.process.reserve(sha)
  await assert.rejects(f.process.replace(sha), /UPDATE_IN_PROGRESS/)
  operation.start()
  let settled = false; operation.completion.then(() => { settled = true })
  await turn(); assert.equal(settled, false)
  done.resolve(); await operation.completion
  assert.equal(f.process.snapshot().update.status, 'succeeded')
})

test('a channel constructor failure still reaps the spawned candidate before rollback', async t => {
  const f = await fixture(t, { failChannel: true }); await f.process.start()
  await assert.rejects(f.process.replace(sha), /REPLACE_ROLLED_BACK/)
  assert.equal(f.children.length, 3); assert.equal(f.children[1].exitCode, 0)
  assert.equal(f.process.snapshot().available, true)
})

test('shutdown during prepare prevents a new child after preparation finishes', async t => {
  const f = await fixture(t); await f.process.start()
  const done = deferred(); f.behavior.prepare = () => done.promise
  const replacing = f.process.replace(sha); await turn()
  const closing = f.process.close(); done.resolve()
  await assert.rejects(replacing, /CLOSED/); await closing
  assert.equal(f.children.length, 1); assert.equal(f.children[0].reaped, true)
})

test('adoption metadata with an invalid version fails closed before any child starts', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'state/diagnostics-release.json'), JSON.stringify({
    schema: 'bellteam.diagnostics.adoption.v1', currentVersionId: '../escape', previousVersionId: null,
  }), { mode: 0o600 })
  await assert.rejects(f.process.start(), /ADOPTION_INVALID/)
  assert.equal(f.children.length, 0)
})


test('private exchange diagnostics retain candidate stage and only a closed safe code after old resume',async t=>{
 for(const [options,stage,code] of [
  [{failNew:true,restoreError:Object.assign(new Error('secret-message'),{code:'PRIVATE_SECRET',errors:[{secret:'hidden'}]})},'initialize',null],
  [{failChannel:true},'channel',null],
  [{failCandidateResume:true},'resume','DIAGNOSTICS_RESUME_FAILED'],
 ]) {
  const f=await fixture(t,options);await f.process.start();
  await assert.rejects(f.process.replace(sha),error=>{
   assert.ok(error instanceof AggregateError);assert.equal(error.code,undefined);assert.equal(error.errors.length,1);
   const d=error.moduleDiagnostic;assert.ok(validateModuleExchangeDiagnostic(d));
   assert.deepEqual(d,{schema:'bellteam.module-exchange-diagnostic.v1',component:'diagnostics',stage,code,rollback:'succeeded',rollbackStage:null,rollbackCode:null});
   assert.doesNotMatch(JSON.stringify(d),/secret|private|hidden|message|stack|errors/);return true;
  });
  assert.equal(f.process.snapshot().available,true);assert.equal(f.process.snapshot().currentVersionId,null);
 }
})

test('rollback adoption alone is not success when old resume fails',async t=>{
 const f=await fixture(t,{failNew:true,failRollbackResume:true});await f.process.start();
 await assert.rejects(f.process.replace(sha),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.code,undefined);assert.equal(error.errors.length,2);
  const d=error.moduleDiagnostic;assert.ok(validateModuleExchangeDiagnostic(d));
  assert.equal(d.stage,'initialize');assert.equal(d.rollback,'failed');assert.equal(d.rollbackStage,'resume');assert.equal(d.rollbackCode,'DIAGNOSTICS_RESUME_FAILED');return true;
 });
 assert.equal(f.process.snapshot().available,false);
})

test('pre-candidate quiesce failure does not fabricate candidate diagnostics',async t=>{
 const f=await fixture(t);await f.process.start();f.behavior.quiesce=false;
 await assert.rejects(f.process.replace(sha),error=>{assert.equal(error.moduleDiagnostic,undefined);assert.equal(f.children.length,1);return true});
})


test('automatic recovery waits for asynchronous reaping and does not replay requests', async t => {
  const f = await fixture(t); await f.process.start()
  const done = deferred(), old = f.process.snapshot().generation
  f.behavior.reaping = () => done.promise
  f.reap(f.children[0]); await turn()
  assert.equal(f.children[0].reaped, undefined)
  assert.equal(f.process.snapshot().available, false)
  done.resolve(); await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(f.children.length, 2)
  assert.equal(f.children[0].reaped, true)
  assert.equal(f.process.snapshot().available, true)
  assert.notEqual(f.process.snapshot().generation, old)
  assert.equal(f.requests.length, 0)
})

test('automatic recovery cancels pending restart when parent closes', async t => {
  const f = await fixture(t); await f.process.start()
  f.reap(f.children[0]); await turn(); await f.process.close()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(f.children.length, 1)
  assert.equal(f.process.snapshot().phase, 'closed')
})


test('automatic recovery uses real generation recovery once then closed candidate adopt', async t => {
  const gate = new ConversationLifetimes('initial')
  const f = await fixture(t, { admission: gate }); await f.process.start()
  const root = gate.enter()
  const delivery = gate.registerDelivery(root, { deliveryId: 'delivery-a', target: 'bot-a', kinds: ['delivery.words'], dispatch: async () => ({ applied: false }) })
  await assert.rejects(gate.callbacks(delivery).onInterim(['old']), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  gate.finish(delivery); gate.finish(root); await turn()
  f.behavior.initialize = () => { if (f.children.length === 2) throw new Error('candidate initialization failure') }
  f.reap(f.children[0]); await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(f.children.length, 3)
  assert.equal(f.process.snapshot().available, true)
  assert.equal(gate.snapshot().unconfirmed, false)
  assert.equal(gate.snapshot().closed, false)
  assert.equal(f.requests.length, 0)
})


test('automatic recovery never replays an accepted request and waits its real completion', async t => {
  const f = await fixture(t); await f.process.start()
  const done = deferred(), result = Promise.resolve('accepted')
  result.completion = done.promise; f.behavior.request = () => result
  assert.equal(await f.process.request('record', {}), 'accepted')
  f.reap(f.children[0]); await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(f.children.length, 1)
  done.resolve(); await turn(); await turn()
  assert.equal(f.children.length, 2)
  assert.equal(f.requests.length, 1)
})

test('automatic recovery excludes intentional exchange exits', async t => {
  const f = await fixture(t); await f.process.start(); await f.process.replace(sha)
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(f.children.length, 2)
  assert.equal(f.process.snapshot().currentVersionId, sha)
})
