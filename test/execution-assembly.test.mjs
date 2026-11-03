import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionAssembly } from '../src/execution-assembly.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'

const versionId = 'a'.repeat(64), sourceCommit = 'b'.repeat(40)
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, { initial = null, previous = null, onAdopt = async () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'execution-assembly-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', session: 'synthetic', harness: 'codex' }, gate = new MembersAdmission()
  let nativeCloses = 0
  const loads = [], engines = [], writes = [], listeners = new Set(), unsubscribe = () => {}
  const client = { async call(name) { assert.equal(name, 'pty_list'); return {} }, async close() { nativeCloses++ } }
  const requestStop = () => {}, watchQueue = listener => { listeners.add(listener); return unsubscribe }
  const ports = { native: client, bots: new Map([[bot.id, bot]]), rooms: {}, membersAdmission: gate,
    access: { assertWorkAllowed() {} }, configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    observer: { report() {}, emitQueue: change => { for (const listener of listeners) listener(change) } } }
  const assembly = createExecutionAssembly({ ports, currentVersionId: initial, previousVersionId: previous, requestStop, watchQueue,
    onAdopt: selection => { writes.push(selection); return onAdopt(selection) },
    loadFactory: async id => {
      loads.push(id)
      return Object.freeze({ versionId: id, sourceCommit, createExecutionDispatcher(params) {
        assert.equal(params.ports, ports)
        const engine = createExecutionDispatcher(params); engines.push(engine); return engine
      } })
    } })
  t.after(async () => { if (loads.length) await assembly.controller.close() })
  return { assembly, bot, client, gate, requestStop, watchQueue, unsubscribe, loads, engines, writes, nativeCloses: () => nativeCloses }
}

test('assembly stays dormant and exposes one controller with the exact parent mechanical ports', async t => {
  const f = await fixture(t), a = f.assembly
  assert.deepEqual(Object.keys(a).sort(), ['administration', 'controller', 'goals', 'transport'])
  assert.deepEqual(f.loads, []); assert.equal(f.engines.length, 0)
  assert.equal(a.transport.client, f.client); assert.equal(a.transport.membersAdmission, f.gate)
  assert.equal(a.transport.requestStop, f.requestStop); assert.equal(a.transport.watchQueue, f.watchQueue)
  assert.equal(a.transport.watchQueue(() => {}), f.unsubscribe)
  assert.throws(() => a.transport.queueItems(), { code: 'EXECUTION_NOT_ACCEPTING' })
  assert.equal(a.seatTurns, undefined); assert.equal(a.idleSessions, undefined)
  assert.equal(f.nativeCloses(), 0)
})

test('parent selection and real persistence completion connect one real generation to all stable callers', async t => {
  const persisted = defer(), called = defer()
  const f = await fixture(t, { initial: versionId, onAdopt: () => {
    called.resolve(); return Object.assign(Promise.resolve(), { completion: persisted.promise })
  } })
  const a = f.assembly, view = a.administration.view
  await a.controller.start()
  assert.deepEqual(f.loads, [versionId]); assert.equal(f.engines.length, 1)
  assert.equal(view(f.bot).id, f.bot.id); assert.deepEqual(a.transport.queueItems(), [])
  const old = f.engines[0], update = a.controller.replace('builtin')
  await called.promise
  assert.throws(() => view(f.bot), { code: 'EXECUTION_NOT_ACCEPTING' })
  assert.equal(a.controller.snapshot().currentVersionId, versionId)
  persisted.resolve(); await update
  assert.deepEqual(f.writes, [{ currentVersionId: null, previousVersionId: versionId }])
  assert.equal(f.engines.length, 2); assert.equal(view(f.bot).id, f.bot.id)
  assert.throws(() => old.project({ method: 'transport.session', args: [f.bot] }), { code: 'EXECUTION_NOT_ACCEPTING' })
  await a.transport.close()
  assert.equal(a.controller.snapshot().phase, 'closed'); assert.equal(f.nativeCloses(), 0)
})
