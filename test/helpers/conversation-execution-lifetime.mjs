import assert from 'node:assert/strict'
import { createExecutionAssembly } from '../../src/execution-assembly.mjs'

const deferred = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setImmediate(resolve))
const fail = code => Object.assign(new Error(code), { code })

// The outer fixture owns AppRuntime, the real conversation process, replacement and cleanup.
export function createConversationExecutionLifetimeFixture({ botId }) {
  if (typeof botId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(botId)) throw fail('CONVERSATION_LIFETIME_BOT_INVALID')
  let runtime, execution, ports, current = null, last = null, unsubscribe = null, closed = false, releasedAt = -1
  const sends = new Map()
  const counts = { sourceSends: 0, reportSends: 0, nativeCalls: 0, nativeWaits: 0, nativeDone: 0,
    nativeAborts: 0, nativeStops: 0, nativeLaunches: 0, sdkCloses: 0, ptyCloses: 0,
    callbacksHeld: 0, holds: 0, released: 0, resumed: 0, bodyResends: 0 }
  const live = () => {
    assert.ok(runtime && !closed, 'CONVERSATION_LIFETIME_NOT_ATTACHED')
    return runtime.services.conversationAssembly
  }
  const session = () => runtime ? runtime.services.transport.session(runtime.services.bots.get(botId)) : botId
  const snapshot = () => {
    const state = current ?? last
    return { attached: Boolean(runtime), closed, holding: Boolean(current && !current.releasing),
      rootResultSettled: state?.rootResultSettled ?? false, rootRPCSettled: state?.rootRPCSettled ?? false,
      originalOperationLive: state?.operationLive ?? false, reportUsesOriginalOperation: state?.sameReportOperation ?? false,
      callbackPending: Boolean(state?.callbackPending), ...counts, actualSeatSDK: false, externalEffects: 0 }
  }
  const client = {
    async connect() {}, async launchOptions() { return {} }, async close() { counts.sdkCloses++ },
    async call(name, args = {}, options = {}) {
      counts.nativeCalls++
      if (name === 'pty_list') return { content: [{ type: 'text', text: session() }],
        _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [] } } }
      if (name === 'agent_stop') counts.nativeStops++
      if (name === 'agent_launch') counts.nativeLaunches++
      if (name === 'pty_close') counts.ptyCloses++
      if (name === 'pty_send') {
        const state = current, assembly = live()
        assert.ok(state && !state.releasing, 'CONVERSATION_LIFETIME_UNEXPECTED_SEND')
        assert.equal(args.session_id, session()); assert.equal(args.require_agent, true)
        assert.equal(typeof options.admissionCheck, 'function'); options.admissionCheck()
        const operation = assembly.currentOperation()
        const report = args.text.includes('BellTeamからの確認です。')
        if (report) {
          assert.equal(state.kind, 'report'); assert.equal(state.report, undefined)
          assembly.admission.assertLease(operation.conversationLease)
          assert.equal(operation, state.operation); state.sameReportOperation = true; counts.reportSends++
        } else {
          assembly.moduleOperations.assert(operation)
          if (state.source) counts.bodyResends++
          assert.equal(state.source, undefined); counts.sourceSends++
          state.operation = operation
          state.operationDone = assembly.admission.operationCompletion(operation.conversationLease)
          state.operationDone.then(() => { state.operationLive = false })
          state.operationLive = true
        }
        const id = String(sends.size + 1), waiting = deferred()
        const entry = { id, report, waiting, state, done: false }
        sends.set(id, entry); state[report ? 'report' : 'source'] = entry
        return { structuredContent: { mode: 'agent_dispatch', session_id: session(), launch_id: 'a'.repeat(32),
          vendor: 'codex', event_cursor: Number(id), wait_process: { executable: 'synthetic-lifetime-only', args: [id] } } }
      }
      if (name === 'pty_observe') return { structuredContent: { exists: true, session_id: session(), state: 'idle' },
        _meta: { 'aiterm/interim_words': { schema: 'aiterm.interim-words.v1', event_cursor: sends.size, words: [] } } }
      if (name === 'pty_read') {
        const entry = sends.get(String(args.operation_id).replace('synthetic-operation-', ''))
        assert.ok(entry?.done, 'CONVERSATION_LIFETIME_TRANSCRIPT_BEFORE_DONE')
        return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript',
          turn_id: `synthetic-turn-${entry.id}`, text: entry.state.kind === 'report' ? '' : 'synthetic lifetime reply' } }
      }
      throw fail('CONVERSATION_LIFETIME_NATIVE_UNEXPECTED')
    },
  }
  const waitProcess = async (descriptor, signal) => {
    assert.equal(descriptor.executable, 'synthetic-lifetime-only')
    const entry = sends.get(descriptor.args[0]); assert.ok(entry); counts.nativeWaits++
    const aborted = deferred()
    const abort = () => { counts.nativeAborts++; aborted.reject(fail('CONVERSATION_LIFETIME_NATIVE_ABORTED')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    if (entry.report || entry.state.kind === 'ai') entry.state.entered.resolve()
    try {
      await Promise.race([entry.waiting.promise, aborted.promise])
      entry.done = true; counts.nativeDone++
      return { schema: 'aiterm.agent-wait-result.v1', outcome: 'done', session_id: session(), launch_id: 'a'.repeat(32),
        turn_id: `synthetic-turn-${entry.id}`, operation_id: `synthetic-operation-${entry.id}` }
    } finally { signal?.removeEventListener('abort', abort) }
  }
  const release = state => state.releasing ??= (async () => {
    state.callback.resolve()
    state.source?.waiting.resolve(); state.report?.waiting.resolve()
    await state.root
    await runtime.services.transport.idle(botId)
    await state.operationDone
    assert.equal(state.operationLive, false)
    assert.equal(counts.nativeAborts, 0); assert.equal(counts.nativeStops, 0)
    assert.equal(counts.bodyResends, 0); assert.equal(counts.ptyCloses, 0); assert.equal(counts.sdkCloses, 0)
    counts.released++; releasedAt = Date.now()
    if (current === state) { last = state; current = null }
    return snapshot()
  })()
  return {
    client, snapshot,
    createExecutionAssembly(options) {
      assert.equal(execution, undefined); assert.equal(options.ports.native, client)
      ports = options.ports
      execution = createExecutionAssembly({ ...options, ports: { ...ports,
        seat: { ...ports.seat, waitProcess, handoffContext: async () => '' } } })
      return execution
    },
    attach(value) {
      assert.equal(runtime, undefined); assert.equal(closed, false)
      assert.equal(value.services.execution, execution); assert.ok(execution)
      assert.equal(ports.conversationAdmission, value.services.conversationAssembly.admission)
      assert.equal(ports.moduleOperations, value.services.conversationAssembly.moduleOperations)
      assert.equal(value.services.transport.client, client); assert.ok(value.services.bots.get(botId))
      runtime = value
      unsubscribe = live().watch(async change => {
        const state = current
        if (state?.kind === 'callback' && state.accepted && !state.callbackPending && change.all === true) {
          state.callbackPending = true; counts.callbacksHeld++
          state.entered.resolve(); await state.callback.promise; state.callbackPending = false
        }
      })
      return snapshot()
    },
    async hold(kind) {
      const assembly = live()
      assert.ok(['ai', 'callback', 'report'].includes(kind), 'CONVERSATION_LIFETIME_KIND_INVALID')
      assert.equal(current, null); assert.equal(assembly.controller.snapshot().available, true)
      // Report windows include both endpoints; do not include the preceding fixture reply in the next turn.
      while (Date.now() <= releasedAt) await new Promise(resolve => setTimeout(resolve, 1))
      const state = current = { kind, entered: deferred(), callback: deferred(), accepted: false,
        generation: assembly.controller.snapshot().generation, rootResultSettled: false, rootRPCSettled: false }
      counts.holds++
      state.root = assembly.run({ kind: 'owner' }, () => runtime.services.messenger.userTurn({
        target: botId, message: `synthetic lifetime ${kind} ${counts.holds}`,
      }))
      state.root.catch(() => {})
      state.root.then(() => { state.rootResultSettled = true }, () => { state.rootResultSettled = true })
      const completion = state.root.completion ?? state.root
      completion.then(() => { state.rootRPCSettled = true }, () => { state.rootRPCSettled = true })
      try {
        const accepted = await state.root.accepted
        assert.equal(accepted.delivery, 'running'); state.accepted = true
        assert.ok(state.operationLive)
        if (kind !== 'ai') state.source.waiting.resolve()
        await Promise.race([state.entered.promise, state.operationDone.then(() => assert.fail('CONVERSATION_LIFETIME_HOLD_NOT_OBSERVED'))])
        if (kind === 'report') { await state.root; await completion; assert.equal(state.sameReportOperation, true) }
        assert.ok(state.operationLive); assert.ok(assembly.admission.snapshot().active > 0)
        return { snapshot,
          assertResumed() {
            assert.equal(current, state); assert.ok(state.operationLive)
            const now = assembly.controller.snapshot()
            assert.equal(now.generation, state.generation); assert.equal(now.available, true); assert.equal(now.phase, 'running')
            assert.ok(assembly.admission.snapshot().active > 0)
            assert.equal(counts.nativeAborts, 0); assert.equal(counts.nativeStops, 0); assert.equal(counts.bodyResends, 0)
            counts.resumed++; return snapshot()
          },
          release: () => release(state),
        }
      } catch (error) { state.callback.resolve(); state.source?.waiting.resolve(); state.report?.waiting.resolve(); throw error }
    },
    async close() {
      if (current) await release(current)
      unsubscribe?.(); unsubscribe = null; closed = true
      return snapshot()
    },
  }
}
