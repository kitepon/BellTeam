import { randomUUID } from 'node:crypto'
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
  currentVersionId = null, previousVersionId = null, exchangeMutex = null, onState = () => {} }) {
  if (typeof loadFactory !== 'function' || typeof onAdopt !== 'function' || !valid(currentVersionId) || !valid(previousVersionId))
    throw fail('OPTIONS_INVALID', 400)
  let started = false, unsafe = false
  let instance = null, phase = 'unavailable', available = false, closed = false, operation = null, closing = null
  let builtinSourceCommit = null, reservation = null, startingReservation = false, update = null
  const active = new Set()
  const snapshot = () => ({ currentVersionId, previousVersionId, builtinSourceCommit,
    generation: instance?.generation ?? null, available, phase, exchanging: operation !== null,
    protocolVersion: 1, stateCompatibility: EXECUTION_STATE_COMPATIBILITY, update: update ? { ...update } : null })
  const state = (next, usable = false) => { phase = next; available = usable; try { onState(snapshot()) } catch {} }
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
    unsafe = true
    const engine = factory.createExecutionDispatcher({ generation, ports, handoff, backgroundSummary, requestRestartSummary })
    if (!engine || !['validateRequest', 'dispatch', 'project', 'control', 'exportState', 'disconnect'].every(key => typeof engine[key] === 'function'))
      throw fail('FACTORY_INVALID')
    unsafe = false
    return { engine, generation, factory, initialized: false, quiesced: false }
  }
  const initialize = async target => {
    const result = await within(target.engine.control('initialize'), 45_000, 'INITIALIZE_TIMEOUT')
    target.initialized = true
    if (result?.stateCompatibility !== EXECUTION_STATE_COMPATIBILITY) throw fail('STATE_INCOMPATIBLE')
  }
  const quiesce = async target => {
    const started = performance.now()
    const stopping = target.engine.control('quiesce', { timeoutMs: 60_000 })
    target.quiescing = stopping
    void Promise.resolve(stopping).finally(() => { if (target.quiescing === stopping) target.quiescing = null }).catch(() => {})
    const [result] = await within(Promise.all([stopping, waitActive()]), 60_000, 'BUSY')
    if (result?.quiesced !== true || performance.now() - started > 60_000) throw fail('QUIESCE_FAILED')
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
    if (!target) throw fail('CLEANUP_UNCONFIRMED')
    if (target.initialized && !target.quiesced) await quiesce(target)
    if ((await within(target.engine.disconnect(), 5000, 'CLEANUP_UNCONFIRMED'))?.closed !== true) throw fail('CLEANUP_UNCONFIRMED')
    if (instance === target) instance = null
  }
  const adopt = async value => {
    // The parent port must include its real durable completion, including after caller timeout.
    const saving = onAdopt({ ...value })
    try { await saving }
    finally { await (saving?.completion ?? saving) }
  }
  const exclusive = action => {
    if (operation) return Promise.reject(fail('UPDATE_IN_PROGRESS', 409))
    const pending = Promise.resolve().then(action)
    operation = pending
    void pending.finally(() => { if (operation === pending) operation = null }).catch(() => {})
    return pending
  }
  const exchange = action => exclusive(() => exchangeMutex ? exchangeMutex.runExclusive(action) : action())
  const start = () => exchange(async () => {
    if (started || instance || closed) throw fail('NOT_ACCEPTING')
    started = true; state('starting')
    try {
      const factory = await load(currentVersionId)
      if (closed) throw fail('CLOSED')
      instance = make(factory)
      await initialize(instance)
      if (closed) throw fail('CLOSED')
      state('running', true)
      return snapshot()
    } catch (error) {
      try { await dispose(instance) } catch { /* An unconfirmed candidate fences all subsequent admission. */ }
      state(closed ? 'closed' : 'unavailable'); throw error
    }
  })
  const requireCurrent = () => {
    if (!available || closed || !instance) throw fail('NOT_ACCEPTING')
    return instance
  }
  const replace = (requested, { expectedRelease } = {}) => {
    const versionId = requested === 'builtin' ? null : requested
    if (requested !== 'builtin' && (requested === null || !valid(versionId))) return Promise.reject(fail('VERSION_INVALID', 400))
    if (!available || closed || reservation && !startingReservation) return Promise.reject(fail('NOT_ACCEPTING'))
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    return exchange(async () => {
      const nextFactory = await load(versionId, { expectedRelease: expected })
      if (closed) throw fail('CLOSED')
      if (currentVersionId === versionId) return snapshot()
      const old = instance, oldSelection = { currentVersionId, previousVersionId }
      state('quiescing')
      let handoff
      try {
        await quiesce(old)
        handoff = old.engine.exportState()
      } catch (error) {
        try {
          await resume(old)
        } catch { state('unavailable') }
        throw error
      }
      // From this point the retired instance is never resumed.
      try { await dispose(old) } catch (error) { state('unavailable'); throw error }
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
        const errors = [error]
        try {
          // If no handle or no closed ACK exists, never construct another engine.
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
    })
  }
  const reserve = (requested, options = {}) => {
    if (requested !== 'builtin' && !valid(requested) || requested === null) throw fail('VERSION_INVALID', 400)
    requireCurrent()
    if (operation || reservation) throw fail('UPDATE_IN_PROGRESS', 409)
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
    closed = true; reservation?.cancel?.(); state('closing')
    await operation?.catch(() => {})
    if (unsafe) { state('unavailable'); throw fail('CLEANUP_UNCONFIRMED') }
    if (instance) {
      try { await dispose(instance) }
      catch (error) { state('unavailable'); throw error }
    }
    state('closed')
  })()
  const withInstallReconciliationProof = callback => {
    if (typeof callback !== 'function') return Promise.reject(fail('REQUEST_INVALID', 400))
    if (reservation) return Promise.reject(fail('UPDATE_IN_PROGRESS', 409))
    return exclusive(async () => {
      const target = requireCurrent(), expectedGeneration = target.generation
      if (typeof target.engine.assertQuiescent !== 'function') throw fail('PROOF_UNAVAILABLE')
      state('quiescing')
      let valid = true
      const assertQuiescent = () => {
        if (!valid || closed || instance !== target || target.generation !== expectedGeneration
          || phase !== 'quiescing' || available || !target.quiesced) throw fail('PROOF_UNAVAILABLE')
        if (target.engine.assertQuiescent() !== true) throw fail('PROOF_UNAVAILABLE')
        return true
      }
      try {
        await quiesce(target)
        assertQuiescent()
        const result = callback(assertQuiescent)
        let value
        try { value = await result }
        finally { await (result?.completion ?? result) }
        assertQuiescent()
        return value
      } finally {
        valid = false
        if (!closed) {
          try { await resume(target) }
          catch (error) { state('unavailable'); throw error }
        }
      }
    })
  }
  return Object.freeze({ start, replace, reserve, snapshot, close, withInstallReconciliationProof,
    dispatch(request) {
      try { return track(requireCurrent().engine.dispatch(request)) } catch (error) { return Promise.reject(error) }
    },
    project(request) { return requireCurrent().engine.project(request) },
  })
}
