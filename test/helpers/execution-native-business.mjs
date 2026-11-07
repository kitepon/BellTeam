import assert from 'node:assert/strict'
import { isAbsolute, join, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { createExecutionAssembly } from '../../src/execution-assembly.mjs'
import { loadExecutionFactory } from '../../src/execution-loader.mjs'
import { createExecutionAdoptionStore } from '../../src/execution-adoption.mjs'
import { MembersAdmission } from '../../src/members-admission.mjs'

const deferred = () => { const { promise, resolve } = Promise.withResolvers(); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const rejected = code => Object.assign(new Error(code), { code })
export const EXECUTION_NATIVE_BUSINESS_BASE = '48e508bab1c1cad2f8c3220f062715b27bcd3376'
// The outer image fixture prepares the private root and signed release. No loader/import substitution.
export function createExecutionNativeFixture({ root }) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) throw rejected('EXECUTION_FIXTURE_ROOT_INVALID')
  const bot = { id: 'bot-execution-fixture', session: 'synthetic-before', harness: 'codex', project: root }
  const sourceSession = 'synthetic-execution-session', launch = 'a'.repeat(32)
  const bots = new Map([[bot.id, bot]]), members = new MembersAdmission(), store = createExecutionAdoptionStore({ root })
  let assembly, started = false, closed = false, failed = false, gate = null
  const generations = new Set(), targets = [], listeners = new Set(), sentBodies = []
  const counts = { exchanges: 0, attempts: 0, failedExchanges: 0, nativeReads: 0, syntheticLaunches: 0,
    syntheticSends: 0, sdkCloses: 0, ptyCloses: 0, adoptionAcks: 0, ackAdmissionClosed: 0,
    drainAdmissionClosed: 0, retiredGuards: 0, reminderSeen: 0, sessionSaves: 0 }
  const checks = { samePorts: false, synchronousProjection: false, sessionKept: false, selectionDurable: false, generationsChanged: false, builtinSourceMatched: false }
  let capturedGuard = null
  const client = { async connect() {}, async launchOptions() { return {} }, async close() { counts.sdkCloses++ },
    async call(name, args, options) {
      if (name === 'pty_list') return { content: [{ type: 'text', text: '' }], _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [] } } }
      if (name === 'agent_launch') { counts.syntheticLaunches++; return { structuredContent: { session_id: sourceSession } } }
      if (name === 'pty_send') {
        counts.syntheticSends++; assert.equal(args.session_id, sourceSession)
        sentBodies.push(args.text)
        if (typeof args.text === 'string' && args.text.includes('<bellteam_task_settings>')) counts.reminderSeen++
        capturedGuard = options.admissionCheck; capturedGuard()
        return { structuredContent: { mode: 'agent_dispatch', session_id: sourceSession, launch_id: launch,
          vendor: 'codex', event_cursor: 1, wait_process: { executable: 'synthetic-only', args: [] } } }
      }
      if (name === 'pty_observe') {
        counts.nativeReads++
        if (gate) { const current = gate; current.entered.resolve(); await current.release.promise }
        return { structuredContent: { schema: 'aiterm.pty-observe-result.v1', session_id: sourceSession, exists: true, launch_id: launch, state: 'idle' } }
      }
      if (name === 'pty_close') counts.ptyCloses++
      throw rejected('EXECUTION_FIXTURE_NATIVE_UNEXPECTED')
    } }
  const requestStop = () => { throw rejected('EXECUTION_FIXTURE_STOP_UNEXPECTED') }
  const watchQueue = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const closedProjection = () => {
    assert.equal(assembly.controller.snapshot().available, false)
    assert.throws(() => assembly.transport.queueItems(), { code: 'EXECUTION_NOT_ACCEPTING' })
  }
  // During a drain new work is refused, while reads keep answering from the previous engine.
  const drainProjection = async () => {
    assert.equal(assembly.controller.snapshot().available, false)
    assert.ok(Array.isArray(assembly.transport.queueItems()))
    await assert.rejects(assembly.transport.notify(bot, 'refused during drain', { admissionCheck() {} }), { code: 'EXECUTION_NOT_ACCEPTING' })
  }
  assembly = createExecutionAssembly({ ports: { native: client, membersAdmission: members, bots, rooms: {},
    configurationStorage: { root: join(root, 'state/configuration-intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} }, storage: { async prepareStartup() {}, async updateSession(id, session) {
      assert.equal(id, bot.id); assert.equal(session, sourceSession); counts.sessionSaves++
    }, async updateFastMode() {} }, seat: { handoffContext: async () => '', waitProcess: async () => ({
      schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: sourceSession, launch_id: launch, turn_id: 'synthetic-turn' }) },
    observer: { report() {}, emitQueue: value => { for (const listener of listeners) listener(value) } },
  }, requestStop, watchQueue, loadFactory: loadExecutionFactory,
    onAdopt: async selection => {
      await drainProjection(); counts.ackAdmissionClosed++
      await store.save(selection)
      assert.deepEqual(await store.read(), selection)
      await drainProjection(); counts.adoptionAcks++
    }, onState: value => { if (value.phase === 'quiescing') gate?.draining.resolve() } })
  const { controller, transport, administration } = assembly
  const projection = administration.view, queue = transport.queueItems
  const snapshot = () => ({ started, closed, failed, ...counts, ...checks,
    available: controller.snapshot().available, generations: generations.size, signedNow: controller.snapshot().currentVersionId !== null,
    actualSeatSDK: false, externalEffects: 0 })
  const inspect = async () => {
    assert.equal(administration.view, projection); assert.equal(transport.queueItems, queue)
    assert.equal(transport.client, client); assert.equal(transport.membersAdmission, members)
    assert.equal(transport.requestStop, requestStop); assert.equal(transport.watchQueue, watchQueue)
    const items = queue(); assert.equal(items instanceof Promise, false); assert.deepEqual(items, [])
    assert.equal(projection(bot).id, bot.id); assert.equal(transport.session(bot), sourceSession)
    assert.equal(counts.sdkCloses, 0); assert.equal(counts.ptyCloses, 0)
    const saved = await store.read()
    if (counts.exchanges) {
      assert.equal(saved.currentVersionId, controller.snapshot().currentVersionId)
      assert.equal(saved.previousVersionId, controller.snapshot().previousVersionId)
      assert.equal((await stat(join(root, 'state/execution-release.json'))).mode & 0o777, 0o600)
      checks.selectionDurable = true
    }
    checks.samePorts = checks.synchronousProjection = checks.sessionKept = true
    return snapshot()
  }
  return {
    controller, snapshot,
    async start() {
      assert.equal(started, false); assert.equal(closed, false)
      if (await store.read() !== null) throw rejected('EXECUTION_FIXTURE_ROOT_NOT_EMPTY')
      await controller.start()
      assert.equal(controller.snapshot().builtinSourceCommit, EXECUTION_NATIVE_BUSINESS_BASE)
      checks.builtinSourceMatched = true
      await transport.wake(bot)
      assert.equal(counts.syntheticLaunches, 1); assert.equal(counts.sessionSaves, 1)
      started = true; generations.add(controller.snapshot().generation)
      return inspect()
    },
    async replace(target) {
      assert.equal(started, true); assert.equal(closed, false); assert.equal(gate, null)
      if (target !== 'builtin' && !/^[a-f0-9]{64}$/.test(target ?? '')) throw rejected('EXECUTION_FIXTURE_TARGET_INVALID')
      if ((target === 'builtin' ? null : target) === controller.snapshot().currentVersionId) throw rejected('EXECUTION_FIXTURE_TARGET_UNCHANGED')
      counts.attempts++
      await transport.notify(bot, 'synthetic fixture only', { admissionCheck() {} })
      await transport.idle(bot.id)
      const oldGuard = capturedGuard; assert.equal(typeof oldGuard, 'function'); oldGuard()
      const current = gate = { entered: deferred(), release: deferred(), draining: deferred() }
      const read = transport.observe(bot); read.catch(() => {})
      let replacing, settled = false
      try {
        await Promise.race([current.entered.promise, read.then(() => assert.fail('EXECUTION_FIXTURE_READ_NOT_HELD'))])
        replacing = controller.replace(target); replacing.then(() => { settled = true }, () => { settled = true })
        await Promise.race([current.draining.promise, replacing.then(() => assert.fail('EXECUTION_FIXTURE_DRAIN_NOT_OBSERVED'))])
        await drainProjection(); counts.drainAdmissionClosed++
        await tick(); assert.equal(settled, false)
        current.release.resolve(); await read; await replacing
        // The previous engine retires in the background once its own work has settled.
        for (let i = 0; i < 1000; i++) { try { oldGuard() } catch { break } await tick() }
        assert.throws(oldGuard, { code: 'EXECUTION_GENERATION_RETIRED' }); counts.retiredGuards++
        counts.exchanges++; targets.push(target); generations.add(controller.snapshot().generation)
        checks.generationsChanged = generations.size === counts.exchanges + 1
        assert.equal(checks.generationsChanged, true)
        assert.equal(controller.snapshot().currentVersionId, target === 'builtin' ? null : target)
        return inspect()
      } catch (error) { failed = true; counts.failedExchanges++; throw error }
      finally { current.release.resolve(); await Promise.allSettled([read, replacing]); gate = null }
    },
    async verify() {
      assert.equal(counts.exchanges, 2, 'EXECUTION_FIXTURE_EXCHANGE_INCOMPLETE')
      assert.match(targets[0], /^[a-f0-9]{64}$/); assert.equal(targets[1], 'builtin')
      assert.equal(controller.snapshot().currentVersionId, null); assert.equal(counts.failedExchanges, 0)
      assert.equal(counts.adoptionAcks, 2); assert.equal(counts.retiredGuards, 2)
      assert.equal(counts.syntheticLaunches, 1); assert.equal(counts.syntheticSends, 2)
      assert.equal(sentBodies.length, 2); assert.equal(counts.reminderSeen, 0)
      return inspect()
    },
    async close() {
      gate?.release.resolve(); await controller.close(); closed = true
      assert.equal(controller.snapshot().phase, 'closed'); closedProjection()
      assert.equal(counts.sdkCloses, 0); assert.equal(counts.ptyCloses, 0)
      return snapshot()
    },
  }
}
