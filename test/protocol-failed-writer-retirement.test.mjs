import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleProcess } from '../src/module-process.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
const turn = () => new Promise(resolve => setImmediate(resolve))
const settled = async () => { for (let n = 0; n < 8; n++) await turn() }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'failed-writer-')); await mkdir(join(root, 'state'))
  const admission = new ConversationLifetimes(), exchangeMutex = createModuleExchangeMutex(), children = [], calls = []
  const behavior = { autoExit: true }, incomingBefore = Promise.withResolvers(), incomingAfter = Promise.withResolvers(), reaped = Promise.withResolvers()
  incomingBefore.resolve(); incomingAfter.resolve(); reaped.resolve()
  behavior.incomingBefore = incomingBefore.promise; behavior.incomingAfter = incomingAfter.promise; behavior.reaped = reaped.promise
  const finish = child => {
    if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0, null) }
    if (child.connected) { child.connected = false; child.emit('disconnect') }
    for (const pipe of [child.stdout, child.stderr]) if (!pipe.closed) { pipe.closed = true; pipe.emit('close') }
  }
  let mutexCalls = 0
  const mutex = { runExclusive: fn => { mutexCalls++; return exchangeMutex.runExclusive(fn) } }
  t.mock.method(console, 'error', () => {})
  const controller = createModuleProcess({ component: 'conversation', root, admission, exchangeMutex: mutex,
    prepareRelease: async () => {}, validateReady: () => {}, canContinue: () => true,
    spawnProcess: () => {
      const pipe = () => Object.assign(new EventEmitter(), { closed: false, resume() {} })
      const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null, stdout: pipe(), stderr: pipe() })
      child.kill = () => assert.fail('retirement must not kill'); child.disconnect = () => finish(child)
      children.push(child); return child
    },
    createChannel: (child, { generation }) => ({ ready: Promise.resolve({ versionId: null, protocolVersion: 1 }),
      request: async () => 'read', callback: async () => 'callback',
      control(method) {
        calls.push({ child, method, generation })
        if (method === 'quiesceWriter' && behavior.quiesceError) return Object.assign(Promise.reject(behavior.quiesceError), { completion: Promise.resolve() })
        const value = method === 'quiesceWriter' ? (behavior.quiesceValue ?? { writerQuiesced: true })
          : method === 'exitWriter' ? (behavior.exitValue ?? { writerClosed: true }) : { resumed: true, quiesced: true }
        const pending = Promise.resolve(value)
        pending.completion = method === 'quiesceWriter' ? behavior.quiesceCompletion ?? Promise.resolve()
          : method === 'exitWriter' ? behavior.exitCompletion ?? Promise.resolve() : Promise.resolve()
        if (method === 'quiesceWriter' && behavior.noCompletion) delete pending.completion
        if (method === 'exitWriter' && behavior.autoExit || method === 'exit') queueMicrotask(() => finish(child))
        return pending
      },
      async drainIncoming() { await (child.exitCode === null ? behavior.incomingBefore : behavior.incomingAfter) },
      async reaped() { await behavior.reaped; child.reaped = true },
    }),
  })
  t.after(async () => { behavior.incomingBefore = behavior.incomingAfter = behavior.reaped = Promise.resolve(); await controller.close().catch(() => {}); await rm(root, { recursive: true, force: true }) })
  await controller.start()
  const fail = () => assert.throws(() => admission.assertDelivery({}), { code: 'CONVERSATION_PROTOCOL_UNCONFIRMED' })
  const retire = () => exchangeMutex.runExclusive(() => controller.retireProtocolFailedWriter({ generation: admission.capture().generation }))
  return { admission, exchangeMutex, controller, children, calls, behavior, finish, fail, retire, mutexCalls: () => mutexCalls }
}

test('failed writer: real completion, OS, IPC, all pipes, incoming and reaped precede Q; old lease remains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t), native = Promise.withResolvers()
  const lease = f.admission.enter(), oldGeneration = lease.generation
  const delivery = f.admission.registerDelivery(lease, { deliveryId: 'old', target: 'bot', kinds: ['delivery.answer'], dispatch: async () => ({ applied: true }) })
  f.admission.claimNative(delivery, { deliveryId: 'old', target: 'bot', kind: 'notify' })
  f.admission.trackNativeContinuation(delivery, { mode: 'agent_dispatch', event_cursor: 1, wait_process: 'old' }, native.promise)
  f.admission.finish(delivery); f.admission.finish(lease); f.fail()
  const quiesce = Promise.withResolvers(), incoming = Promise.withResolvers(), exit = Promise.withResolvers(), effects = Promise.withResolvers(), reap = Promise.withResolvers()
  f.behavior.quiesceCompletion = quiesce.promise; f.behavior.incomingBefore = incoming.promise; f.behavior.exitCompletion = exit.promise
  f.behavior.incomingAfter = effects.promise; f.behavior.reaped = reap.promise; f.behavior.autoExit = false
  let completed = false
  const retiring = f.retire(); retiring.then(() => { completed = true })
  await settled(); assert.equal(f.calls.at(-1).method, 'quiesceWriter')
  await assert.rejects(f.controller.callback('old', {}), /RETIREMENT_UNAVAILABLE/)
  await assert.rejects(f.controller.retireProtocolFailedWriter({ generation: oldGeneration }), /UPDATE_IN_PROGRESS/)
  quiesce.resolve(); await settled(); assert.equal(f.calls.at(-1).method, 'quiesceWriter')
  incoming.resolve(); await settled(); assert.equal(f.calls.at(-1).method, 'exitWriter')
  const child = f.children[0]
  child.exitCode = 0; child.emit('exit', 0, null); await settled(); assert.equal(completed, false)
  child.connected = false; child.emit('disconnect'); await settled(); assert.equal(child.reaped, undefined)
  child.stdout.closed = true; child.stdout.emit('close'); await settled(); assert.equal(child.reaped, undefined)
  child.stderr.closed = true; child.stderr.emit('close'); await settled(); assert.equal(child.reaped, undefined)
  effects.resolve(); await settled(); assert.equal(child.reaped, undefined)
  reap.resolve(); await settled(); assert.equal(child.reaped, true); assert.equal(completed, false, 'OS/barrier cannot replace exit actual completion')
  exit.resolve(); const result = await retiring; assert.equal(result.available, false); assert.equal(f.mutexCalls(), 0)
  assert.equal(f.children.length, 1); assert.equal(f.admission.snapshot().active, 2)
  t.mock.timers.tick(1001); await settled()
  assert.equal(f.children.length, 2); assert.equal(f.controller.snapshot().available, true)
  assert.notEqual(f.admission.capture().generation, oldGeneration); assert.equal(f.admission.inspectAdmission().failed, false)
  assert.equal(f.admission.snapshot().unconfirmed, true, 'old failure must not prevent current resume')
  assert.equal(f.admission.assertLease(delivery), delivery)
  assert.equal(await f.controller.request('history', {}), 'read')
  native.resolve(); await settled()
})

for (const mode of ['not_failed', 'wrong_generation', 'extra_key', 'quiesce_failure', 'invalid_quiesce_ack', 'missing_completion']) test('failed writer refuses before exit: ' + mode, async t => {
  const f = await fixture(t)
  if (mode !== 'not_failed') f.fail()
  if (mode === 'quiesce_failure') f.behavior.quiesceError = Object.assign(Error('unknown'), { code: 'CONVERSATION_WRITER_UNCONFIRMED' })
  if (mode === 'invalid_quiesce_ack') f.behavior.quiesceValue = { writerQuiesced: true, opaque: 'untrusted' }
  if (mode === 'missing_completion') f.behavior.noCompletion = true
  const args = { generation: mode === 'wrong_generation' ? 'other' : f.admission.capture().generation, ...(mode === 'extra_key' ? { target: 'pid' } : {}) }
  await assert.rejects(f.exchangeMutex.runExclusive(() => f.controller.retireProtocolFailedWriter(args)))
  assert.equal(f.children.length, 1); assert.equal(f.children[0].exitCode, null)
  assert.equal(f.calls.some(call => call.method === 'exitWriter'), false); assert.equal(f.mutexCalls(), 0)
  if (mode === 'quiesce_failure') {
    await assert.rejects(f.retire(), /RETIREMENT_UNAVAILABLE/)
    assert.equal(f.calls.filter(call => call.method === 'quiesceWriter').length, 1, 'one attempt per instance')
  }
})

test('failed writer rejects unknown exit completion even after real OS/barrier; Q stays unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t); f.fail()
  const exit = Promise.withResolvers(); f.behavior.exitCompletion = exit.promise
  const retired = f.retire(), rejected = assert.rejects(retired, /exit unknown/)
  await settled(); assert.equal(f.children[0].reaped, true)
  exit.reject(Error('exit unknown')); await rejected
  t.mock.timers.tick(10000); await settled()
  assert.equal(f.children.length, 1); assert.equal(f.controller.snapshot().available, false)
  assert.equal(f.admission.inspectAdmission().failed, true); assert.equal(f.admission.capture().generation, f.controller.snapshot().generation)
})

test('failed writer rechecks current generation after asynchronous writer barrier', async t => {
  const f = await fixture(t); f.fail()
  const quiesce = Promise.withResolvers(); f.behavior.quiesceCompletion = quiesce.promise
  const attempt = f.retire(), rejected = assert.rejects(attempt, /RETIREMENT_UNAVAILABLE/)
  await settled()
  const capture = f.admission.capture.bind(f.admission)
  t.mock.method(f.admission, 'capture', () => ({ ...capture(), generation: 'superseded' }))
  quiesce.resolve(); await rejected
  assert.equal(f.calls.some(call => call.method === 'exitWriter'), false)
  assert.equal(f.children[0].exitCode, null); assert.equal(f.controller.snapshot().available, false)
})
