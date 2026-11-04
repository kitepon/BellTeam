import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleProcess } from '../src/module-process.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => Promise.withResolvers()

for (const mode of ['normal', 'candidate_failure', 'close_without_writer']) test('failed writer recovery retains old native references: ' + mode, async t => {
  const failCandidate = mode !== 'normal'
  const root = await mkdtemp(join(tmpdir(), 'failed-generation-'))
  await mkdir(join(root, 'state'))
  const admission = new ConversationLifetimes(), children = [], channels = [], logs = []
  const incoming = deferred(), reaped = deferred(), native = deferred()
  let nativeSettled = false, oldFinished = false
  native.promise.then(() => { nativeSettled = true })
  t.mock.method(console, 'error', line => logs.push(JSON.parse(line)))
  const endChild = child => {
    child.exitCode = 1; child.connected = false; child.stdout.closed = child.stderr.closed = true
    child.stdout.emit('close'); child.stderr.emit('close'); child.emit('exit', 1, null); child.emit('close', 1, null)
  }
  const controller = createModuleProcess({ component: 'conversation', root, admission,
    prepareRelease: async () => assert.fail('same builtin version must be retained'), validateReady: () => {},
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null,
        stdout: Object.assign(new EventEmitter(), { closed: false, resume() {} }),
        stderr: Object.assign(new EventEmitter(), { closed: false, resume() {} }) })
      child.kill = () => { endChild(child); return true }; child.disconnect = () => endChild(child)
      children.push(child); return child
    },
    createChannel: child => {
      const old = children.length === 1
      const rejectedCandidate = failCandidate && children.length === 2
      const channel = { calls: [], ready: Promise.resolve({ versionId: null, protocolVersion: 1 }),
        control: async method => {
          channel.calls.push(method)
          if (rejectedCandidate && method === 'initialize') throw Object.assign(Error('CONVERSATION_READY_INVALID'), { code: 'CONVERSATION_READY_INVALID' })
          if (method === 'exit') queueMicrotask(() => endChild(child))
          return { resumed: true, quiesced: true }
        },
        request: async () => null,
        callback: async () => { channel.calls.push('callback'); throw Object.assign(Error('CONVERSATION_CHILD_EXITED'), { code: 'CONVERSATION_CHILD_EXITED' }) },
        drainIncoming: () => old ? incoming.promise : Promise.resolve(),
        reaped: () => old ? reaped.promise : Promise.resolve(),
      }
      channels.push(channel); return channel
    },
  })
  t.after(async () => {
    incoming.resolve(); reaped.resolve(); native.resolve(); await tick()
    await controller.close().catch(error => assert.ok(['CONVERSATION_PROTOCOL_UNCONFIRMED', 'CONVERSATION_DRAIN_TIMEOUT'].includes(error.code)))
    await rm(root, { recursive: true, force: true })
  })
  await controller.start()
  const oldGeneration = controller.snapshot().generation
  const operation = admission.enter(undefined, 'original-operation')
  const delivery = admission.registerDelivery(operation, { deliveryId: 'original-delivery', target: 'old-bot', kinds: ['delivery.status'], dispatch: (...args) => channels[0].callback(...args) })
  admission.claimNative(delivery, { deliveryId: 'original-delivery', target: 'old-bot', kind: 'notify' })
  admission.trackCompletion(delivery, native.promise)
  native.promise.then(() => { admission.finish(delivery); oldFinished = true })
  const oldDone = admission.operationCompletion(operation), callbacks = admission.callbacks(delivery)
  admission.finish(operation)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  endChild(children[0]); await tick()
  t.mock.timers.tick(1000); await tick(); assert.equal(children.length, 1)
  incoming.resolve(); await tick()
  t.mock.timers.tick(1000); await tick(); assert.equal(children.length, 1)
  reaped.resolve(); await tick()
  t.mock.timers.tick(1000); await tick()
  assert.equal(children.length, 2, 'old native completion must not block a reaped writer generation')
  if (failCandidate) {
    assert.equal(controller.snapshot().available, false)
    assert.equal(children[1].exitCode, 1)
    assert.equal(nativeSettled, false)
    if (mode === 'close_without_writer') {
      let settled = false
      const closing = controller.close().finally(() => { settled = true })
      const timedOut = assert.rejects(closing, error => error.code === 'CONVERSATION_DRAIN_TIMEOUT')
      await tick(); t.mock.timers.tick(59999); await tick(); assert.equal(settled, false)
      t.mock.timers.tick(1); await timedOut
      assert.equal(nativeSettled, false); assert.equal(oldFinished, false)
      assert.equal(controller.snapshot().phase, 'unavailable')
      native.resolve(); await oldDone
      assert.equal(children.length, 2, 'close must cancel recovery without dropping the retired reference')
      return
    }
    t.mock.timers.tick(2000); await tick()
    assert.equal(children.length, 3, 'the unresumed candidate must re-enter through the same closed ticket')
  }
  assert.equal(controller.snapshot().available, true)
  assert.notEqual(controller.snapshot().generation, oldGeneration)
  assert.equal(nativeSettled, false); assert.equal(oldFinished, false)
  const fresh = admission.enter(undefined, 'fresh-operation')
  await controller.request('synthetic', {}); admission.finish(fresh)
  await assert.rejects(async () => callbacks.onStatus('delivered'))
  assert.equal(channels.at(-1).calls.includes('callback'), false)
  assert.equal(controller.snapshot().available, true)
  let closeSettled = false
  const closing = controller.close().finally(() => { closeSettled = true })
  const closeFailure = assert.rejects(closing, error => error.code === 'CONVERSATION_PROTOCOL_UNCONFIRMED')
  await tick(); assert.equal(closeSettled, false, 'whole close must retain the old actual native reference')
  assert.equal(nativeSettled, false)
  native.resolve(); await oldDone; await closeFailure
  assert.equal(oldFinished, true); assert.equal(closeSettled, true)
  assert.equal(controller.snapshot().phase, 'unavailable', 'unconfirmed close must not be reported as closed success')
  assert.equal(children.length, failCandidate ? 3 : 2)
})
