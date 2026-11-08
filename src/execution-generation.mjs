import { probeModuleReady } from './module-ready-probe.mjs'
import { randomUUID } from 'node:crypto'
import { createModuleChildRestart } from './module-child-restart.mjs'
import { EXECUTION_STATE_COMPATIBILITY } from './execution-dispatcher.mjs'
export { EXECUTION_STATE_COMPATIBILITY }

const valid = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const fail = (code, status = 503) => Object.assign(new Error(`EXECUTION_${code}`), { code: `EXECUTION_${code}`, status })
const within = async (promise, ms, code) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail(code)), ms) })]) }
  finally { clearTimeout(timer) }
}

// The runtime reader supplies factories; no caller URL or import is accepted here.
export function createExecutionGeneration({ ports, loadFactory, onAdopt, backgroundSummary = null, requestRestartSummary = null,
  currentVersionId = null, previousVersionId = null, exchangeMutex = null, onState = () => {}, onModuleRestartLimit }) {
  if (typeof loadFactory !== 'function' || typeof onAdopt !== 'function' || !valid(currentVersionId) || !valid(previousVersionId))
    throw fail('OPTIONS_INVALID', 400)
  let instance = null, phase = 'unavailable', available = false, closed = false, operation = null, closing = null
  let builtinSourceCommit = null, reservation = null, startingReservation = false, update = null
  let recoveryState = null
  // The previous engine keeps serving reads while an exchange makes the generation unavailable.
  let readable = null
  const recovery = createModuleChildRestart(async () => {
    await operation?.catch(() => {})
    if (closed || available) return
    await exchange(async () => {
      if (closed || available) return
      try {
        const retained = instance, saved = recoveryState
        if (retained?.ready && !retained.retiring && (!saved || retained.factory === saved.factory)) {
          if (saved) {
            await adopt(saved.selection)
            currentVersionId = saved.selection.currentVersionId; previousVersionId = saved.selection.previousVersionId
          }
          state('quiescing')
          await resume(retained)
          return
        }
        if (retained) await dispose(retained)
        if (closed) return
        const factory = saved?.factory ?? await load(currentVersionId)
        if (closed) return
        instance = make(factory, saved?.handoff)
        await initialize(instance)
        if (closed) return
        if (saved) {
          await adopt(saved.selection)
          currentVersionId = saved.selection.currentVersionId; previousVersionId = saved.selection.previousVersionId
        }
        state('running', true)
      } catch (error) { state(closed ? 'closed' : 'unavailable'); throw error }
    })
  }, 'execution', onModuleRestartLimit)
  const active = new Set()
  const snapshot = () => ({ currentVersionId, previousVersionId, builtinSourceCommit,
    generation: instance?.generation ?? null, available, phase, exchanging: operation !== null,
    protocolVersion: 1, stateCompatibility: EXECUTION_STATE_COMPATIBILITY, update: update ? { ...update } : null })
  const state = (next, usable = false) => {
    phase = next; available = usable
    if (usable) { recoveryState = null; readable = null; recovery.running() }
    else if (next === 'unavailable' && !closed) recovery.lost()
    try { onState(snapshot()) } catch {}
  }
  const track = promise => {
    const done = promise?.completion ?? promise
    if (done?.then) { active.add(done); done.then(() => active.delete(done), () => active.delete(done)) }
    return promise
  }
  const waitActive = async () => { while (active.size) await Promise.allSettled([...active]) }
  const load = async (versionId, options) => {
    const value = await loadFactory(versionId, options)
    if (!Object.isFrozen(value) || value.versionId !== versionId || typeof value.createExecutionDispatcher !== 'function'
      || value.sourceCommit !== null && !/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? '')
      || versionId !== null && value.sourceCommit === null) throw fail('FACTORY_INVALID')
    if (versionId === null) builtinSourceCommit = value.sourceCommit
    return value
  }
  const make = (factory, handoff) => {
    const generation = `${factory.versionId ?? 'builtin'}:${randomUUID()}`
    recovery.restarting()
    const engine = factory.createExecutionDispatcher({ generation, ports, handoff, backgroundSummary, requestRestartSummary })
    if (!engine || !['validateRequest', 'dispatch', 'project', 'control', 'exportState', 'disconnect'].every(key => typeof engine[key] === 'function'))
      throw fail('FACTORY_INVALID')
    return { engine, generation, factory, initialized: false, quiesced: false }
  }
  const initialize = async target => {
    target.initializing = Promise.resolve(target.engine.control('initialize')).then(result => {
      target.initialized = true
      if (result?.stateCompatibility !== EXECUTION_STATE_COMPATIBILITY) throw fail('STATE_INCOMPATIBLE')
      target.ready = true
    })
    await within(target.initializing, 45_000, 'INITIALIZE_TIMEOUT')
    await probeModuleReady(() => target.engine.project({ method: 'transport.queueItems', args: [] }))
  }
  const quiesce = async (target, { handover = false } = {}) => {
    const started = performance.now()
    const stopping = target.engine.control('quiesce', { timeoutMs: 60_000, ...(handover ? { handover: true } : {}) })
    target.quiescing = stopping
    void Promise.resolve(stopping).finally(() => { if (target.quiescing === stopping) target.quiescing = null }).catch(() => {})
    // Handover: accepted turns stay on the old engine, so their dispatch promises are not drained here.
    // A module update (handover) never waits for running work; only close/dispose keeps the drain and 60 s bound.
    const [result] = handover ? [await stopping] : await within(Promise.all([stopping, waitActive()]), 60_000, 'BUSY')
    if (result?.quiesced !== true || (!handover && performance.now() - started > 60_000)) throw fail('QUIESCE_FAILED')
    target.quiesced = true
  }
  const resume = async target => {
    const resumed = await within((async () => {
      await target.quiescing?.catch(() => {})
      if (closed || instance !== target || phase !== 'quiescing') throw fail('RESUME_FAILED')
      return target.engine.control('resume')
    })(), 5000, 'RESUME_FAILED')
    if (resumed?.resumed !== true) throw fail('RESUME_FAILED')
    target.quiesced = false; state('running', true)
  }
  const dispose = async target => {
    if (!target) return
    target.retiring = true
    await target.initializing?.catch(() => {})
    if (target.initialized && !target.quiesced) await quiesce(target)
    if ((await within(target.engine.disconnect(), 5000, 'CLEANUP_UNCONFIRMED'))?.closed !== true) throw fail('CLEANUP_UNCONFIRMED')
    if (instance === target) instance = null
  }
  // Cleanup only: an engine that refused the handover finishes its own accepted turns, then stops; it drains only its own work, not the whole generation's.
  const retireUnreleased = async old => {
    // An engine that never became ready has no work of its own to finish.
    if (!old.ready) { await within(Promise.resolve().then(() => old.engine.disconnect()), 5000, 'CLEANUP_UNCONFIRMED').catch(() => {}); return }
    while (!closed) {
      try {
        if ((await old.engine.control('quiesce', { timeoutMs: 60_000 }))?.quiesced === true
          && (await within(old.engine.disconnect(), 5000, 'CLEANUP_UNCONFIRMED'))?.closed === true) return
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000).unref?.())
    }
  }
  const adopt = async value => {
    // The parent port must include its real durable completion, including after caller timeout.
    const saving = onAdopt({ ...value })
    try { await saving }
    finally { await (saving?.completion ?? saving) }
  }
  // Exchanges and recovery take turns instead of refusing each other (Owner 2026-11-08).
  const exclusive = action => {
    const pending = (operation ?? Promise.resolve()).catch(() => {}).then(action)
    operation = pending
    void pending.finally(() => { if (operation === pending) operation = null }).catch(() => {})
    return pending
  }
  const exchange = action => exclusive(() => exchangeMutex ? exchangeMutex.runExclusive(action) : action())
  const startAttempt = () => exchange(async () => {
    if (instance || closed) throw fail('NOT_ACCEPTING')
    state('starting')
    try {
      const factory = await load(currentVersionId)
      if (closed) throw fail('CLOSED')
      instance = make(factory)
      await initialize(instance)
      if (closed) throw fail('CLOSED')
      state('running', true)
      return snapshot()
    } catch (error) {
      try { await dispose(instance) } catch { /* Lifecycle recovery retains the actual candidate for cleanup. */ }
      state(closed ? 'closed' : 'unavailable'); throw error
    }
  })
  const start = () => available ? Promise.resolve(snapshot()) : startAttempt().catch(error => {
    if (closed || phase !== 'unavailable') throw error
    return recovery.wait().then(() => { if (closed) throw error; return snapshot() })
  })
  const requireCurrent = () => {
    if (!available || closed || !instance) throw fail('NOT_ACCEPTING')
    return instance
  }
  const replace = (requested, { expectedRelease } = {}) => {
    const versionId = requested === 'builtin' ? null : requested
    if (requested !== 'builtin' && (requested === null || !valid(versionId))) return Promise.reject(fail('VERSION_INVALID', 400))
    // A stopped engine is replaceable too: the update is how a broken version gets fixed.
    if (closed || reservation && !startingReservation) return Promise.reject(fail('NOT_ACCEPTING'))
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    return exchange(async () => {
      const nextFactory = await load(versionId, { expectedRelease: expected })
      if (closed) throw fail('CLOSED')
      if (currentVersionId === versionId) return snapshot()
      const old = instance, oldSelection = { currentVersionId, previousVersionId }
      readable = old
      state('quiescing')
      let handoff = null
      try {
        await within(quiesce(old, { handover: true }), 70_000, 'HANDOVER_TIMEOUT')
        handoff = old.engine.exportState({ handover: true })
      } catch {
        // The old module cannot veto its replacement (Owner 2026-11-08): retire it unreleased and start the new one cold.
        handoff = null
      }
      // From this point the retired instance is never resumed.
      recoveryState = { factory: old?.factory ?? nextFactory, handoff, selection: oldSelection }
      if (!handoff) {
        readable = null
        if (old) { old.retiring = true; void retireUnreleased(old) }
      } else if (!handoff.released?.then) {
        try { await dispose(old) } catch (error) { state('unavailable'); throw error }
        readable = null
      } else old.retiring = true
      try {
        if (closed) { state('closed'); throw fail('CLOSED') }
        state('restoring')
        let candidate = null, saving = false
        try {
          candidate = make(nextFactory, handoff); instance = candidate
          await initialize(candidate)
          if (closed) throw fail('CLOSED')
          saving = true
          await adopt({ currentVersionId: versionId, previousVersionId: oldSelection.currentVersionId })
          if (closed) throw fail('CLOSED')
          previousVersionId = oldSelection.currentVersionId; currentVersionId = versionId
          state('running', true)
          return snapshot()
        } catch (error) {
          if (['READY_TIMEOUT', 'READY_PROBE_FAILED'].includes(error?.code)) {
            recoveryState = { factory: nextFactory, handoff, selection: { currentVersionId: versionId, previousVersionId: oldSelection.currentVersionId } }
            candidate.retiring = true
            state('unavailable'); recovery.lost(error)
            await adopt(recoveryState.selection)
            throw error
          }
          const errors = [error]
          try {
            await dispose(candidate)
            if (closed) throw fail('CLOSED')
            const restored = make(old.factory, handoff); instance = restored
            await initialize(restored)
            await adopt(oldSelection)
            currentVersionId = oldSelection.currentVersionId; previousVersionId = oldSelection.previousVersionId
            state('running', true)
          } catch (rollback) {
            errors.push(rollback)
            state(closed ? 'closed' : 'unavailable')
          }
          throw new AggregateError(errors, saving ? 'EXECUTION_ADOPTION_ROLLBACK' : 'EXECUTION_REPLACE_ROLLBACK')
        }
      } finally {
        // The old engine keeps serving reads during this exchange, finishes its own accepted turns, then retires.
        if (handoff?.released?.then) void handoff.released.then(() => old.engine.disconnect()).catch(() => {})
      }
    })
  }
  const reserve = (requested, options = {}) => {
    if (requested !== 'builtin' && !valid(requested) || requested === null) throw fail('VERSION_INVALID', 400)
    if (closed) throw fail('NOT_ACCEPTING')
    if (reservation) throw fail('UPDATE_IN_PROGRESS', 409)
    const ticket = {}, record = { versionId: requested, status: 'accepted' }
    reservation = ticket; update = record; state(phase, available)
    const expected = options.expectedRelease ? { expectedRelease: structuredClone(options.expectedRelease) } : undefined
    let settled = false, resolve
    const completion = new Promise(done => { resolve = done })
    const cancel = () => { if (!settled) { settled = true; reservation = null; record.status = 'not_started'; state(phase, available); resolve() } }
    ticket.cancel = cancel
    return { completion, cancel, start() {
      if (settled) return
      settled = true
      if (closed) { reservation = null; record.status = 'not_started'; resolve(); return }
      record.status = 'running'; state(phase, available); startingReservation = true
      const attempt = replace(requested, expected); startingReservation = false
      void attempt.then(() => { record.status = 'succeeded' }, () => { record.status = 'failed'; record.error = 'EXECUTION_UPDATE_FAILED' })
        .finally(() => { if (reservation === ticket) reservation = null; state(phase, available); resolve() })
    } }
  }
  const close = () => closing ??= (async () => {
    closed = true; recovery.close(); reservation?.cancel?.(); state('closing')
    await operation?.catch(() => {})
    if (instance) {
      try { await dispose(instance) }
      catch (error) { state('unavailable'); throw error }
    }
    state('closed')
  })()
  const api = Object.freeze({ start, replace, reserve, snapshot, close,
    dispatch(request) {
      try {
        if (!available && !closed && !(readable && request?.method === 'transport.runningBots'))
          return recovery.hold(() => api.dispatch(request), () => fail('NOT_ACCEPTING'))
        const target = !available && readable && !closed && request?.method === 'transport.runningBots' ? readable : requireCurrent()
        return track(target.engine.dispatch(request))
      } catch (error) { return Promise.reject(error) }
    },
    project(request) { return (!available && readable && !closed ? readable : requireCurrent()).engine.project(request) },
  })
  return api
}
