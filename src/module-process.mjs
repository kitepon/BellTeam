import { createModuleChildRestart, reportModuleChildExit, observeModuleChild, reportConversationChildExitOrigin } from './module-child-restart.mjs'
import { moduleExchangeDiagnostic, moduleDrainDiagnostic, moduleRecoveryLog, moduleTerminationLog } from './module-exchange-diagnostic.mjs'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeAtomic } from './json-file.mjs'
import { waitNotificationsChildClose } from './notifications-ipc.mjs'

const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status, outcome: 'not_accepted' })
const within = async (value, milliseconds, code) => {
  let timer
  try {
    return await Promise.race([value, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure(code)), Math.max(1, milliseconds))
    })])
  } finally { clearTimeout(timer) }
}

// Business DTOs, authority and private projections belong to the injected closed channel.
export function createModuleProcess({ component, root, createChannel, prepareRelease, validateReady,
  initializeParams = ({ generation, mode }) => ({ generation, mode }),
  exportHandoff = async () => undefined, admission, canContinue = () => false,
  onGeneration = () => {}, onState = () => {}, onModuleChildExit, investigationsFile = null,
  startPaused = false, restoreAfterRestart = async () => {}, exchangeMutex = null, spawnProcess = spawn }) {
  if (!['conversation', 'usage', 'diagnostics'].includes(component) || typeof root !== 'string'
    || typeof createChannel !== 'function' || typeof prepareRelease !== 'function' || typeof validateReady !== 'function'
    || component !== 'diagnostics' && investigationsFile !== null
    || startPaused && component !== 'usage'
    || investigationsFile !== null && typeof investigationsFile !== 'string') throw failure('MODULE_OPTIONS_INVALID', 400)
  const prefix = component.toUpperCase(), adoptionPath = join(root, `state/${component}-release.json`)
  const fail = (suffix, status) => failure(`${prefix}_${suffix}`, status)
  let instance = null, currentVersionId = null, previousVersionId = null, generation = null
  let initialized = false, closed = false, available = false, phase = 'unavailable', exchanging = false
  let operation = null, closing = null, update = null, reservation = null, startingReservation = false
  let failedWriterReaped = false, proofHeld = false, writerRetiring = false
  let recoveryAttempt = 0, childSequence = 0
  const recovery = createModuleChildRestart(async () => {
    recoveryAttempt = Math.min(Number.MAX_SAFE_INTEGER, recoveryAttempt + 1)
    let stage = 'operation'
    const report = (event, error) => {
      try { console.error(JSON.stringify(moduleRecoveryLog(component, stage, event, recoveryAttempt, active.size, admission, error))) } catch {}
    }
    const mark = next => { stage = next; report('waiting') }
    try {
      mark('operation')
      await operation?.catch(() => {})
      if (closed || instance || !initialized) { report('skipped'); return }
      const perform = async () => {
        if (closed || instance) { report('skipped'); return }
        const ticket = closeAdmission('module_recovery')
        mark('runner')
        await waitActive()
        mark('prepare')
        await prepare(currentVersionId)
        state('starting')
        const target = await launch(currentVersionId, ticket, 'restore', undefined, mark, true)
        try {
          mark('restore')
          await restoreAfterRestart(target.channel, target.generation)
          mark('resume')
          await resume(target, ticket)
        } catch (error) { await stopUnadmitted(target); throw error }
        report('completed')
      }
      mark('local_mutex')
      await exclusive(signal => {
        mark('mutex')
        return exchangeMutex ? exchangeMutex.runExclusive(() => perform(signal)) : perform(signal)
      })
    } catch (error) { report('failed', error); throw error }
  })
  const active = new Set()
  const snapshot = () => ({ currentVersionId, previousVersionId, generation, available, phase, exchanging,
    currentTarget: currentVersionId === null ? 'builtin' : 'release',
    protocolVersion: instance?.ready?.protocolVersion ?? null,
    stateCompatibility: instance?.ready?.stateCompatibility ? structuredClone(instance.ready.stateCompatibility) : null,
    update: update ? { ...update } : null })
  const state = (next, usable = false) => {
    phase = next; available = usable
    if (usable) recovery.running()
    try { onState(snapshot()) } catch {}
  }
  const track = promise => {
    const completion = promise.completion ?? promise
    active.add(completion)
    completion.then(() => active.delete(completion), () => active.delete(completion))
    return promise
  }
  const waitActive = async () => { while (active.size) await Promise.allSettled([...active]) }
  const prepare = async (versionId, expectedRelease) => {
    if (versionId === null) return
    if (!versionValid(versionId)) throw fail('VERSION_INVALID', 400)
    const descriptor = await prepareRelease(versionId, { expectedRelease })
    if (descriptor?.versionId !== versionId
      || descriptor.appRoot !== `/run/bellteam-maintenance/${component}/releases/${versionId}/payload`)
      throw fail('RELEASE_INVALID')
  }
  const record = (current, previous) => ({ schema: `bellteam.${component}.adoption.v1`, currentVersionId: current, previousVersionId: previous })
  const readAdoption = async () => {
    let file
    try { file = await open(adoptionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4096)
        throw fail('ADOPTION_INVALID')
      const value = JSON.parse(await file.readFile('utf8'))
      if (!value || Object.keys(value).sort().join(',') !== 'currentVersionId,previousVersionId,schema'
        || value.schema !== `bellteam.${component}.adoption.v1`
        || value.currentVersionId !== null && !versionValid(value.currentVersionId)
        || value.previousVersionId !== null && !versionValid(value.previousVersionId)) throw fail('ADOPTION_INVALID')
      return value
    } finally { await file.close() }
  }
  const closeAdmission = source => admission?.close(source)
  const stopUnadmitted = async target => {
    if (!target || target.ended) return
    // Never kill a previously resumed writer as an exchange timeout shortcut.
    if (target.resumed) throw fail('DRAIN_REQUIRED')
    target.child.kill('SIGKILL')
    await target.end
  }
  const launch = async (versionId, ticket, mode, handoff, markStage = () => {}, recovering = false) => {
    if (closed || instance) throw fail('NOT_ACCEPTING')
    const nextGeneration = `${versionId ?? 'builtin'}:${randomUUID()}`
    if (recovering) markStage('recover_admission')
    if (recovering && component === 'conversation' && admission?.recoverFailedGeneration) {
      if (!failedWriterReaped) throw fail('NOT_ACCEPTING')
      admission.recoverFailedGeneration(ticket, generation, nextGeneration)
    }
    else if (recovering && admission?.recover && ticket.generation === generation) admission.recover(ticket, generation, nextGeneration)
    else admission?.adopt(ticket, nextGeneration)
    generation = nextGeneration
    onGeneration(nextGeneration)
    const env = component === 'diagnostics' && investigationsFile !== null
      ? { BELLTEAM_DIAGNOSTIC_INVESTIGATIONS: investigationsFile } : {}
    markStage('spawn')
    const child = spawnProcess(`/usr/local/libexec/bellteam-${component}-start`, [versionId ?? 'builtin'], {
      env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    // Pipes are drained without retaining or publishing arbitrary child output.
    child.stdout?.resume(); child.stderr?.resume()
    childSequence = Math.min(Number.MAX_SAFE_INTEGER, childSequence + 1)
    const target = { sequence: childSequence, child, generation: nextGeneration, ticket, ended: false, resumed: false, channel: null }
    target.stderrObservation = observeModuleChild(child)
    instance = target
    target.end = waitNotificationsChildClose(child).then(async result => {
      if (component === 'conversation') reportConversationChildExitOrigin(target.sequence, target.stderrObservation())
      const unexpected = target.resumed && initialized && !closed && !target.intentional
      if (unexpected) { closeAdmission('module_child_exit'); state('unavailable'); reportModuleChildExit(component, result, target.stderrObservation(), onModuleChildExit) }
      let stage = 'os_closed'
      const report = (event, error) => {
        if (!unexpected && !recovering && !target.retirementAck) return
        try { console.error(JSON.stringify(moduleTerminationLog(component, stage, event, target.sequence, active.size, admission, error))) } catch {}
      }
      report('completed')
      try {
        stage = 'incoming'; report('waiting')
        await target.channel?.drainIncoming?.()
        report('completed')
        target.ended = true
        stage = 'reaped'; report('waiting')
        await target.channel?.reaped()
        report('completed')
        if (target.retirementAck && !await target.retirementAck) throw fail('WRITER_RETIREMENT_UNCONFIRMED')
        if (unexpected || recovering || target.retirementAck) failedWriterReaped = true
        if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
        if (unexpected || target.retirementAck) { stage = 'lost'; recovery.lost(); report('completed') }
      } catch (error) { report('failed', error); throw error }
    })
    const started = Date.now()
    try {
      markStage('channel')
      target.channel = createChannel(child, { generation: nextGeneration })
      if (component !== 'diagnostics' && typeof target.channel.drainIncoming !== 'function') throw fail('CHANNEL_INVALID')
      markStage('initialize')
      const params = await initializeParams({ generation: nextGeneration, mode, handoff })
      const initializing = target.channel.control('initialize', params, 45000)
      await initializing
      await within(initializing.completion ?? Promise.resolve(), 45000 - (Date.now() - started), `${prefix}_READY_TIMEOUT`)
      markStage('ready')
      const ready = await within(target.channel.ready, 45000 - (Date.now() - started), `${prefix}_READY_TIMEOUT`)
      if (ready.versionId !== versionId) throw fail('READY_INVALID')
      validateReady(ready)
      target.ready = structuredClone(ready)
      return target
    } catch (error) { await stopUnadmitted(target); throw error }
  }
  const resume = async (target, ticket) => {
    if (closed || target.ended) throw fail('CLOSED')
    if ((await target.channel.control('resume')).resumed !== true) throw fail('RESUME_FAILED')
    target.resumed = true
    if (closed) throw fail('CLOSED')
    admission?.resume(ticket)
    failedWriterReaped = false
    exchanging = false; state('running', true)
  }
  const drainAdmission = (ticket, forClose) => forClose && component === 'conversation' && admission?.drainForClose
    ? admission.drainForClose(ticket) : admission?.drain(ticket)
  const drain = async (target, ticket, markStage = () => {}, forClose = false) => {
    const started = Date.now()
    markStage('parent_drain')
    const [, admissionResult] = await within(Promise.all([waitActive(), drainAdmission(ticket, forClose)]), 60000, `${prefix}_DRAIN_TIMEOUT`)
    if (admissionResult?.status === 'busy') throw fail('DRAIN_TIMEOUT')
    const remaining = Math.max(1, 60000 - (Date.now() - started))
    markStage('child_quiesce')
    if ((await within(track(target.channel.control('quiesce', {}, remaining)), remaining, `${prefix}_DRAIN_TIMEOUT`)).quiesced !== true)
      throw fail('QUIESCE_FAILED')
  }
  const finishExit = async target => {
    target.intentional = true
    let timer
    try {
      void target.channel.control('exit').catch(() => {})
      timer = setTimeout(() => { if (!target.ended) target.child.kill('SIGKILL') }, 5000)
      await target.end
    } finally { clearTimeout(timer) }
  }
  const exclusive = action => {
    if (operation) return Promise.reject(fail('UPDATE_IN_PROGRESS', 409))
    const promise = Promise.resolve().then(action)
    operation = promise
    void promise.finally(() => { if (operation === promise) operation = null }).catch(() => {})
    return promise
  }
  const start = () => exclusive(async () => {
    if (closed || initialized) throw fail('ALREADY_STARTED')
    state('starting')
    const saved = await readAdoption()
    if (saved) {
      await prepare(saved.currentVersionId); await prepare(saved.previousVersionId)
      currentVersionId = saved.currentVersionId; previousVersionId = saved.previousVersionId
    }
    const ticket = closeAdmission('module_start')
    try {
      await admission?.drain(ticket)
      const target = await launch(currentVersionId, ticket, saved ? 'restore' : 'bootstrap')
      if (startPaused) state('initializing')
      else await resume(target, ticket)
      initialized = true
      return snapshot()
    } catch (error) { state(closed ? 'closed' : 'unavailable'); throw error }
  })
  const invoke = (kind, method, params, options) => {
    try {
      const target = instance
      if (proofHeld) throw fail('PROOF_UNAVAILABLE')
      if (writerRetiring || target?.retirementStarted) throw fail('WRITER_RETIREMENT_UNAVAILABLE')
      if (!target || target.ended || kind === 'request' && !available && !canContinue(method, options, target.generation))
        throw fail('NOT_ACCEPTING')
      return track(target.channel[kind](method, params, options))
    } catch (error) { return Promise.reject(error) }
  }
  const replace = (requested, { expectedRelease } = {}) => {
    if (requested !== 'builtin' && !versionValid(requested)) return Promise.reject(fail('VERSION_INVALID', 400))
    if (!initialized || !available || closed) return Promise.reject(fail('NOT_ACCEPTING'))
    if (reservation && !startingReservation) return Promise.reject(fail('UPDATE_IN_PROGRESS', 409))
    const versionId = requested === 'builtin' ? null : requested
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    const perform = async () => {
      await prepare(versionId, expected)
      if (versionId === currentVersionId) return snapshot()
      if (closed) throw fail('CLOSED')
      const old = instance, oldVersion = currentVersionId, oldPrevious = previousVersionId
      const ticket = closeAdmission('module_replace')
      exchanging = true; state('quiescing')
      let handoff, drainStage = 'parent_drain'
      try {
        await drain(old, ticket, stage => { drainStage = stage })
        drainStage = 'handoff'
        const exporting = track(exportHandoff(old.channel))
        handoff = (await within(Promise.all([exporting, exporting.completion]), 60000, `${prefix}_DRAIN_TIMEOUT`))[0]
        await prepare(versionId, expected)
      } catch (error) {
        try {
          if (error?.code === `${prefix}_DRAIN_TIMEOUT`)
            error.moduleDiagnostic = moduleDrainDiagnostic(component, drainStage, active.size, admission)
        } catch {}
        if (!closed) { try { await resume(old, ticket) } catch { state('unavailable') } }
        throw error
      }
      if (closed) throw fail('CLOSED')
      await finishExit(old)
      if (closed) throw fail('CLOSED')
      state('starting')
      let stage = 'spawn'
      const markStage = value => { stage = value }
      try {
        const next = await launch(versionId, ticket, 'restore', handoff, markStage)
        stage = 'adoption'
        await writeAtomic(adoptionPath, record(versionId, oldVersion))
        currentVersionId = versionId; previousVersionId = oldVersion
        stage = 'resume'
        await resume(next, ticket)
        return snapshot()
      } catch (error) {
        const errors = [error], failedStage = stage
        let rollbackStage = null, rollbackError
        try {
          stage = 'candidate_cleanup'
          await stopUnadmitted(instance)
          if (closed) throw fail('CLOSED')
          stage = 'prepare'
          await prepare(oldVersion)
          stage = 'spawn'
          const restored = await launch(oldVersion, ticket, 'restore', handoff, markStage)
          stage = 'adoption'
          await writeAtomic(adoptionPath, record(oldVersion, oldPrevious))
          currentVersionId = oldVersion; previousVersionId = oldPrevious
          stage = 'resume'
          await resume(restored, ticket)
        } catch (rollback) { rollbackStage = stage; rollbackError = rollback; errors.push(rollback); state(closed ? 'closed' : 'unavailable') }
        const result = new AggregateError(errors, errors.length === 1 ? `${prefix}_REPLACE_ROLLED_BACK` : `${prefix}_REPLACE_AND_ROLLBACK_FAILED`)
        result.moduleDiagnostic = moduleExchangeDiagnostic(component, failedStage, error, rollbackStage, rollbackError)
        throw result
      } finally { if (phase !== 'running') { exchanging = false; state(phase) } }
    }
    return exclusive(() => exchangeMutex ? exchangeMutex.runExclusive(perform) : perform())
  }
  const reserve = (versionId, options) => {
    if (versionId !== 'builtin' && !versionValid(versionId)) throw fail('VERSION_INVALID', 400)
    if (!available || closed) throw fail('NOT_ACCEPTING')
    if (operation || reservation) throw fail('UPDATE_IN_PROGRESS', 409)
    const next = { versionId, status: 'accepted' }; update = next
    const captured = options?.expectedRelease ? { expectedRelease: structuredClone(options.expectedRelease) } : undefined
    let resolve, started = false
    const completion = new Promise(done => { resolve = done })
    const done = () => { reservation = null; resolve() }
    reservation = { cancel: () => { if (!started) { started = true; next.status = 'not_started'; done() } } }
    return { completion, cancel: reservation.cancel, start: () => {
      if (started) return
      started = true
      if (closed) { next.status = 'not_started'; done(); return }
      next.status = 'running'
      startingReservation = true
      const attempt = replace(versionId, captured)
      startingReservation = false
      void attempt.then(() => { next.status = 'succeeded' }, () => {
        next.status = 'failed'; next.error = `${prefix}_UPDATE_FAILED`
      }).finally(done)
    } }
  }
  const close = () => {
    if (closing) return closing
    closed = true; recovery.close(); available = false; reservation?.cancel()
    closing = (async () => {
      const retainCloseFailure = component === 'conversation' && typeof admission?.drainForClose === 'function'
      try {
        await operation?.catch(() => {})
        const target = instance
        if (target) {
          const ticket = closeAdmission('module_close')
          try { await drain(target, ticket, () => {}, true); await finishExit(target) }
          catch (error) {
            if (target.child.connected) target.child.disconnect()
            await target.end
            throw error
          }
        } else if (retainCloseFailure) {
          const ticket = closeAdmission('module_close')
          const [, result] = await within(Promise.all([waitActive(), drainAdmission(ticket, true)]), 60000, `${prefix}_DRAIN_TIMEOUT`)
          if (result?.status === 'busy') throw fail('DRAIN_TIMEOUT')
        }
        state('closed')
      } catch (error) { state(retainCloseFailure ? 'unavailable' : 'closed'); throw error }
    })()
    return closing
  }
  const withInstallReconciliationProof = action => exclusive(async () => {
    if (component !== 'conversation' || typeof action !== 'function' || !initialized || !available
      || closed || exchanging || reservation || !instance || typeof admission?.assertOpen !== 'function'
      || typeof admission?.drainForClose !== 'function') throw fail('PROOF_UNAVAILABLE')
    admission.assertOpen()
    const target = instance, heldGeneration = generation
    const ticket = closeAdmission('module_close')
    let holding = false, primaryError
    const assertQuiescent = () => {
      if (!holding || closed || instance !== target || generation !== heldGeneration || target.ended
        || !target.child.connected || target.child.exitCode !== null || target.child.signalCode !== null
        || active.size || admission.snapshot().active || admission.snapshot().unconfirmed)
        throw fail('PROOF_UNAVAILABLE')
      return true
    }
    state('quiescing')
    try {
      await drain(target, ticket, () => {}, true)
      await waitActive()
      await target.channel.drainIncoming()
      holding = true; proofHeld = true
      assertQuiescent()
      const pending = action(assertQuiescent)
      const [result, completion] = await Promise.allSettled([pending, pending?.completion])
      if (result.status === 'rejected') throw result.reason
      if (completion.status === 'rejected') throw completion.reason
      assertQuiescent()
      return result.value
    } catch (error) { primaryError = error; throw error }
    finally {
      holding = false
      try {
      if (!closed && instance === target && !target.ended && target.child.connected) {
        try {
          const resuming = target.channel.control('resume')
          const [result, completion] = await Promise.allSettled([resuming, resuming.completion])
          if (result.status === 'rejected') throw result.reason
          if (completion.status === 'rejected') throw completion.reason
          if (result.value?.resumed !== true || closed || instance !== target || target.ended
            || !target.child.connected || generation !== heldGeneration) throw fail('PROOF_UNAVAILABLE')
          admission.resume(ticket)
          target.resumed = true; failedWriterReaped = false
          state('running', true)
        }
        catch (error) {
          state('unavailable')
          if (primaryError) throw new AggregateError([primaryError, error], 'CONVERSATION_PROOF_RESUME_FAILED')
          throw error
        }
      }
      } finally { proofHeld = false }
    }
  })
  const retireProtocolFailedWriter = params => {
    if (!params || Array.isArray(params) || Object.keys(params).join(',') !== 'generation'
      || typeof params.generation !== 'string') return Promise.reject(fail('WRITER_RETIREMENT_UNAVAILABLE'))
    const expectedGeneration = params.generation
    // The parent owns the one shared exchange mutex; this port holds only the local operation.
    return exclusive(async () => {
      const target = instance
      const assertHeld = (alive = true) => {
        if (component !== 'conversation' || closed || !initialized || !target || instance !== target
          || generation !== expectedGeneration || admission?.capture?.().generation !== expectedGeneration
          || admission?.inspectAdmission?.().failed !== true || reservation || proofHeld
          || alive && (target.ended || !target.resumed || !target.child.connected
            || target.child.exitCode !== null || target.child.signalCode !== null)) throw fail('WRITER_RETIREMENT_UNAVAILABLE')
      }
      assertHeld()
      if (exchanging || writerRetiring || target.retirementStarted) throw fail('WRITER_RETIREMENT_UNAVAILABLE')
      closeAdmission('module_protocol_failure')
      target.retirementStarted = true
      writerRetiring = true; state('quiescing')
      const controlWriter = async (method, key, timeout) => {
        const pending = target.channel.control(method, {}, timeout)
        if (!(pending?.completion instanceof Promise)) throw fail('WRITER_RETIREMENT_UNCONFIRMED')
        const [result, completion] = await Promise.allSettled([pending, pending.completion])
        if (result.status === 'rejected') throw result.reason
        if (completion.status === 'rejected') throw completion.reason
        if (!result.value || Array.isArray(result.value) || Object.keys(result.value).join(',') !== key
          || result.value[key] !== true) throw fail('WRITER_RETIREMENT_UNCONFIRMED')
      }
      try {
        await controlWriter('quiesceWriter', 'writerQuiesced', 60000)
        await target.channel.drainIncoming()
        assertHeld()
        // OS close may precede delivery of the exit ACK; neither alone proves retirement.
        const acknowledged = Promise.withResolvers()
        target.retirementAck = acknowledged.promise; target.intentional = true
        void target.end.catch(() => {})
        try {
          await controlWriter('exitWriter', 'writerClosed', 5000)
          assertHeld(false)
          acknowledged.resolve(true)
        } catch (error) { acknowledged.resolve(false); throw error }
        await target.end
        if (closed || instance !== null || generation !== expectedGeneration || !failedWriterReaped)
          throw fail('WRITER_RETIREMENT_UNCONFIRMED')
        return snapshot()
      } catch (error) { state(closed ? 'closed' : 'unavailable'); throw error }
      finally { writerRetiring = false }
    })
  }
  return { start, close, replace, reserve, snapshot, withInstallReconciliationProof, retireProtocolFailedWriter,
    request: (method, params, options = {}) => invoke('request', method, params, options),
    callback: (method, params, options = {}) => invoke('callback', method, params, options),
    initialize: mode => {
      if (!available && phase !== 'initializing' || closed || exchanging) return Promise.reject(fail('NOT_ACCEPTING'))
      return track(Promise.resolve(initializeParams({ generation, mode })).then(params => track(instance.channel.control('initialize', params, 45000))))
    },
    activate: () => exclusive(async () => {
      if (closed || phase !== 'initializing' || !instance) throw fail('NOT_ACCEPTING')
      await waitActive()
      await resume(instance, instance.ticket)
      return snapshot()
    }),
  }
}
