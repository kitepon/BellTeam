import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createModuleProcess } from '../src/module-process.mjs'
import { createConversationParentChannel, waitConversationChildClose } from '../src/conversation-ipc.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

test('real child exit releases issued callback after its effect and recovers while native remains held', { timeout: 6000 }, async t => {
  t.mock.method(console, 'error', () => {})
  const root = await mkdtemp(join(tmpdir(), 'callback-exit-'))
  await mkdir(join(root, 'state'))
  const gate = new ConversationLifetimes('initial'), children = [], channels = [], closes = []
  const effectStarted = Promise.withResolvers(), effect = Promise.withResolvers(), native = Promise.withResolvers(), restored = Promise.withResolvers()
  let initialGeneration, lease, delivery, callback, callbackEnded = false, nativeEnded = false, notifyCalls = 0
  native.promise.then(() => { nativeEnded = true })
  const controller = createModuleProcess({ component: 'conversation', root, admission: gate,
    prepareRelease: () => assert.fail('builtin needs no preparation'), validateReady() {},
    initializeParams: ({ generation, mode }) => ({ generation, mode, bots: [] }),
    onState: state => { if (initialGeneration && state.available && state.generation !== initialGeneration) restored.resolve(state) },
    spawnProcess: (_path, _args, options) => {
      const child = spawn(process.execPath, [new URL('./fixtures/conversation-callback-exit-child.mjs', import.meta.url).pathname], options)
      children.push(child); closes.push(waitConversationChildClose(child)); return child
    },
    createChannel: (child, { generation }) => {
      const channel = createConversationParentChannel(child, { generation, admission: gate, authorizeActor: () => ({ kind: 'owner' }),
        onEffect: async (method, params, context) => {
          if (method === 'members.profiles.read') { effectStarted.resolve(); await effect.promise; return { bots: [] } }
          assert.equal(method, 'execution.notify'); notifyCalls++
          delivery = context.conversationDelivery
          gate.claimNative(delivery, { deliveryId: params.deliveryId, target: params.target, kind: 'notify' })
          gate.trackNativeContinuation(delivery, { mode: 'agent_dispatch', event_cursor: 1, wait_process: 'old' }, native.promise)
          callback = gate.invoke(delivery, 'delivery.status', { delivery: 'running' })
          callback.then(() => { callbackEnded = true }, () => { callbackEnded = true })
          await callback
          return { delivery: 'running' }
        } })
      channels.push(channel); return channel
    } })
  t.after(async () => {
    effect.resolve(); native.resolve()
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGUSR2')
    await Promise.all(closes)
    // Failure cleanup only; this does not establish the production barrier order.
    for (const channel of channels) await channel.reaped()
    for (const retained of [delivery, lease]) if (retained) { try { gate.finish(retained) } catch {} }
    await setImmediate(); await controller.close().catch(() => {}); await rm(root, { recursive: true, force: true })
  })
  await controller.start(); initialGeneration = controller.snapshot().generation
  lease = gate.enter()
  const request = controller.request('direct.post', { from: 'bot-fixture', target: 'bot-target', message: 'local fixture', images: [] }, { conversationLease: lease })
  request.catch(() => {}); request.completion.catch(() => {})
  await effectStarted.promise
  children[0].kill('SIGUSR2'); await closes[0]; await setImmediate()
  assert.equal(children[0].exitCode, 0); assert.equal(children[0].signalCode, null)
  assert.equal(children[0].connected, false); assert(children[0].stdout.closed && children[0].stderr.closed)
  assert.equal(callbackEnded, false); assert.equal(children.length, 1)
  effect.resolve()
  await assert.rejects(callback, { code: 'CONVERSATION_CHILD_EXITED', outcome: 'unknown' })
  await assert.rejects(request.completion)
  gate.finish(lease)
  const state = await restored.promise
  assert.equal(state.currentVersionId, null); assert.equal(children.length, 2)
  assert.equal(notifyCalls, 1); assert.equal(nativeEnded, false)
  assert.equal(gate.assertLease(delivery), delivery); assert(gate.snapshot().active > 0)
  const current = gate.enter(); assert.notEqual(current.generation, initialGeneration); gate.finish(current)
})
