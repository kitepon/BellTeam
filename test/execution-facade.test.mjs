import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionFacade } from '../src/execution-facade.mjs'
import { createExecutionGeneration } from '../src/execution-generation.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

function wiring(getController) {
  const unsubscribe = () => {}, watchQueue = listener => { assert.equal(typeof listener, 'function'); return unsubscribe }
  const ports = { getController, client: {}, membersAdmission: {}, requestStop() {}, watchQueue }
  return { facade: createExecutionFacade(ports), ports, unsubscribe }
}

test('captured synchronous facade methods resolve the current controller on each call', () => {
  const first = { dispatch() {}, close() {}, project: input => ({ engine: 'first', input }) }
  let selected = first
  const { facade } = wiring(() => selected), session = facade.transport.session, bot = { id: 'synthetic' }
  assert.equal(session(bot).engine, 'first')
  selected = { ...first, project: input => ({ engine: 'second', input }) }
  const next = session(bot)
  assert.equal(next.engine, 'second'); assert.equal(next.input.method, 'transport.session')
  assert.equal(next.input.args[0], bot); assert.equal(typeof next.then, 'undefined')
  assert.equal(facade.transport.invoke, undefined); assert.equal(facade.transport.arbitraryNativeMethod, undefined)
  assert.ok(Object.isFrozen(facade.transport))
})

test('async facade preserves the exact promise and opaque options including actual completion', async () => {
  const completion = Promise.resolve(), response = Object.assign(Promise.resolve('accepted'), { completion })
  let captured
  const { facade } = wiring(() => ({ project() {}, close() {}, dispatch: input => { captured = input; return response } }))
  const bot = {}, lease = {}, options = { membersLease: lease, onStatus() {} }
  const returned = facade.transport.notify(bot, 'synthetic', options)
  assert.equal(returned, response); assert.equal(returned.completion, completion)
  assert.equal(captured.method, 'transport.notify'); assert.equal(captured.args[0], bot)
  assert.equal(captured.args[2], options); assert.equal(captured.args[2].membersLease, lease)
  assert.equal(await returned, 'accepted')
})

test('shared mechanical ports and queue subscriptions keep their parent identity while the engine is unavailable', async () => {
  const { facade, ports, unsubscribe } = wiring(() => null)
  for (const key of ['client', 'membersAdmission', 'requestStop', 'watchQueue']) assert.equal(facade.transport[key], ports[key])
  assert.equal(facade.transport.watchQueue(() => {}), unsubscribe)
  assert.throws(() => facade.transport.queueItems(), { code: 'EXECUTION_NOT_ACCEPTING' })
  await assert.rejects(facade.administration.update('synthetic', {}), { code: 'EXECUTION_NOT_ACCEPTING' })
})

test('legacy close delegates only to the current controller and never closes the shared client', async () => {
  let closes = 0
  const current = { dispatch() {}, project() {}, close: async () => { closes++ } }
  const { facade, ports } = wiring(() => current)
  let nativeCloses = 0; ports.client.close = () => { nativeCloses++ }
  await facade.transport.close()
  assert.equal(closes, 1); assert.equal(nativeCloses, 0)
})

test('stable facade is wired through the real generation transaction and real dispatcher across a durable ACK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-facade-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', session: 'synthetic', harness: 'codex' }, bots = new Map([[bot.id, bot]])
  let nativeCloses = 0, ack, reached
  const saving = new Promise(resolve => { ack = resolve }), entered = new Promise(resolve => { reached = resolve })
  const native = { async call(name) { assert.equal(name, 'pty_list'); return {} }, async close() { nativeCloses++ } }
  const membersAdmission = new MembersAdmission()
  const controller = createExecutionGeneration({
    ports: { native, bots, rooms: {}, membersAdmission, access: { assertWorkAllowed() {} }, observer: { report() {} },
      configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() } },
    loadFactory: async versionId => Object.freeze({ versionId, sourceCommit: 'c'.repeat(40), createExecutionDispatcher }),
    onAdopt: () => { reached(); return saving },
  })
  t.after(() => controller.close())
  const facade = createExecutionFacade({ getController: () => controller, client: native, membersAdmission, requestStop() {}, watchQueue: () => () => {} })
  await controller.start()
  const queue = facade.transport.queueItems, view = facade.administration.view
  assert.deepEqual(queue(), []); assert.equal(view(bot).id, bot.id)
  const originalGeneration = controller.snapshot().generation
  const updating = controller.replace('a'.repeat(64)); await entered
  assert.throws(() => queue(), { code: 'EXECUTION_NOT_ACCEPTING' })
  ack(); await updating
  assert.notEqual(controller.snapshot().generation, originalGeneration)
  assert.deepEqual(queue(), []); assert.equal(view(bot).id, bot.id)
  assert.equal(facade.transport.membersAdmission, membersAdmission)
  assert.equal(facade.transport.client, native); assert.equal(nativeCloses, 0)
})
