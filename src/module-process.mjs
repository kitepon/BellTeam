import { probeModuleReady } from './module-ready-probe.mjs'
import { createModuleChildRestart, reportModuleChildExit, observeModuleChild, reportConversationChildExitOrigin } from './module-child-restart.mjs'
import { moduleExchangeDiagnostic, moduleRecoveryLog, moduleTerminationLog } from './module-exchange-diagnostic.mjs'
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
  onGeneration = () => {}, onState = () => {}, onModuleChildExit, onModuleRestartLimit, probeCandidate, investigationsFile = null,
  startPaused = false, restoreAfterRestart = async () => {}, exchangeMutex = null, spawnProcess = spawn }) {
  if (!['conversation', 'usage', 'diagnostics', 'work-graph'].includes(component) || typeof root !== 'string'
    || typeof createChannel !== 'function' || typeof prepareRelease !== 'function' || typeof validateReady !== 'function'
    || component !== 'diagnostics' && investigationsFile !== null
    || startPaused && component !== 'usage'
    || investigationsFile !== null && typeof investigationsFile !== 'string') throw failure('MODULE_OPTIONS_INVALID', 400)
  const prefix = component.toUpperCase().replaceAll('-', '_'), adoptionPath = join(root, `state/${component}-release.json`)
  const fail = (suffix, status) => failure(`${prefix}_${suffix}`, status)
  let instance = null, currentVersionId = null, previousVersionId = null, generation = null
  let initialized = false, closed = false, available = false, phase = 'unavailable', exchanging = false
  let operation = null, closing = null, update = null, reservation = null, startingReservation = false
  let proofHeld = false
  let recoveryAttempt = 0, childSequence = 0
  const recoveryEvidence = new Set()
  const recovery = createModuleChildRestart(async () => {
    recoveryAttempt = Math.min(Number.MAX_SAFE_INTEGER, recoveryAttempt + 1)
    let stage = 'operation'
    const report = (event, error) => {
      const key = `${stage}:${event}`
      if (recoveryEvidence.has(key)) return
      recoveryEvidence.add(key)
      try { console.error(JSON.stringify(moduleRecoveryLog(component, stage, event, recoveryAttempt, active.size, admission, error))) } catch {}
    }
    const mark = next => { stage = next; report('waiting') }
    try {
      mark('operation')
      await operation?.catch(() => {})
      if (closed || available) { report('skipped'); return }
      if (!initialized && !instance) { await startAttempt(); return }
      const perform = async () => {
        if (closed || available) { report('skipped'); return }
        const selected = await readAdoption()
        currentVersionId = selected?.currentVersionId ?? null; previousVersionId = selected?.previousVersionId ?? null
        mark('prepare'); await prepare(currentVersionId)
        const ticket = closeAdmission('module_recovery')
        if (instance) {
          const retained = instance
          if (retained.child.exitCode !== null || retained.child.signalCode !== null || !retained.child.connected) await retained.finishTermination()
          else if (retained.probeFailed) { await drain(retained, ticket, mark); await finishExit(retained) }
          else if (retained.intentional) await finishExit(retained)
          else if (retained.versionId === currentVersionId && retained.ready) { await resume(retained, ticket); initialized = true; return }
          else if (retained.resumed) { await drain(retained, ticket, mark); await finishExit(retained) }
          else await stopUnadmitted(retained)
        }
        mark('runner')
        if (component !== 'conversation') await waitActive()
        state('starting')
        const target = await launch(currentVersionId, ticket, 'restore', undefined, mark, true)
        try {
          mark('restore')
          await restoreAfterRestart(target.channel, target.generation)
          mark('resume')
          await resume(target, ticket)
        } catch (error) { if (!target.probeFailed) await stopUnadmitted(target); throw error }
        report('completed')
      }
      mark('local_mutex')
      await exclusive(signal => {
        mark('mutex')
        return exchangeMutex ? exchangeMutex.runExclusive(() => perform(signal)) : perform(signal)
      })
    } catch (error) { report('failed', error); throw error }
  }, component, onModuleRestartLimit)
  const active = new Set()
  const snapshot = () => ({ currentVersionId, previousVersionId, generation, available, phase, exchanging,
    currentTarget: currentVersionId === null ? 'builtin' : 'release',
    protocolVersion: instance?.ready?.protocolVersion ?? null,
    stateCompatibility: instance?.ready?.stateCompatibility ? structuredClone(instance.ready.stateCompatibility) : null,
    update: update ? { ...update } : null })
  const state = (next, usable = false) => {
    phase = next; available = usable
    if (usable) { recovery.running(); recoveryEvidence.clear() }
    else if (next === 'unavailable' && !closed) recovery.lost()
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
  const closeAdmission = source => component === 'conversation' ? undefined : admission?.close(source)
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
    if (component === 'conversation') admission?.selectGeneration?.(nextGeneration)
    else if (recovering && admission?.recover && ticket.generation === generation) admission.recover(ticket, generation, nextGeneration)
    else admission?.adopt(ticket, nextGeneration)
    generation = nextGeneration
    onGeneration(nextGeneration)
    const env = component === 'diagnostics' && investigationsFile !== null
      ? { BELLTEAM_DIAGNOSTIC_INVESTIGATIONS: investigationsFile } : {}
    markStage('spawn')
    recovery.restarting()
    const child = spawnProcess(`/usr/local/libexec/bellteam-${component}-start`, [versionId ?? 'builtin'], {
      env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    // Pipes are drained without retaining or publishing arbitrary child output.
    child.stdout?.resume(); child.stderr?.resume()
    childSequence = Math.min(Number.MAX_SAFE_INTEGER, childSequence + 1)
    const target = { sequence: childSequence, versionId, child, generation: nextGeneration, ticket, ended: false, resumed: false, channel: null }
    target.stderrObservation = observeModuleChild(child)
    instance = target
    const osClosed = waitNotificationsChildClose(child)
    const terminationEvidence = new Set()
    const reportTermination = (stage, event, error) => {
      if (!target.unexpected && !recovering && !target.retirementAck) return
      const key = `${stage}:${event}`
      if (terminationEvidence.has(key)) return
      terminationEvidence.add(key)
      try { console.error(JSON.stringify(moduleTerminationLog(component, stage, event, target.sequence, active.size, admission, error))) } catch {}
    }
    target.finishTermination = () => target.termination ??= (async () => {
      await osClosed
      let stage = 'os_closed'
      reportTermination(stage, 'completed')
      if (component === 'conversation') {
        target.ended = true
        // Old callers retain their own outcomes; their effects cannot fence a new child after observed OS death.
        void Promise.resolve().then(() => target.channel?.reaped()).catch(error => reportTermination('reaped', 'failed', error))
        void Promise.resolve().then(() => target.channel?.drainIncoming?.()).catch(error => reportTermination('incoming', 'failed', error))
        if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
        reportTermination('lost', 'completed')
        return
      }
      try {
        stage = 'incoming'; reportTermination(stage, 'waiting')
        if (!target.childClosed) { await target.channel?.childClosed?.(); target.childClosed = true }
        if (!target.incomingDrained) { await target.channel?.drainIncoming?.(); target.incomingDrained = true }
        reportTermination(stage, 'completed')
        target.ended = true
        stage = 'reaped'; reportTermination(stage, 'waiting')
        if (!target.reaped) { await target.channel?.reaped(); target.reaped = true }
        reportTermination(stage, 'completed')
        if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
        stage = 'lost'; reportTermination(stage, 'completed')
      } catch (error) { reportTermination(stage, 'failed', error); throw error }
    })().finally(() => { target.termination = null })
    target.end = osClosed.then(async result => {
      if (component === 'conversation') reportConversationChildExitOrigin(target.sequence, target.stderrObservation())
      target.unexpected = target.resumed && initialized && !closed && !target.intentional
      if (target.unexpected) {
        closeAdmission('module_child_exit'); state('unavailable')
        recovery.exited(result)
        reportModuleChildExit(component, result, target.stderrObservation(), onModuleChildExit)
      }
      await target.finishTermination()
    })
    void target.end.catch(() => { state(closed ? 'closed' : 'unavailable') })
    const started = Date.now()
    try {
      markStage('channel')
      target.channel = createChannel(child, { generation: nextGeneration })
      // work-graph effects run only inside its root calls, which waitActive already drains.
      if (!['diagnostics', 'work-graph'].includes(component) && typeof target.channel.drainIncoming !== 'function') throw fail('CHANNEL_INVALID')
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
    } catch (error) { if (!target.probeFailed) await stopUnadmitted(target); throw error }
  }
  const resume = async (target, ticket) => {
    if (closed || target.ended) throw fail('CLOSED')
    if ((await target.channel.control('resume')).resumed !== true) throw fail('RESUME_FAILED')
    target.resumed = true
    if (closed) throw fail('CLOSED')
    if (component !== 'conversation') admission?.resume(ticket)
    if (!target.probed) {
      try {
        await probeModuleReady(() => probeCandidate ? probeCandidate(target.channel)
          : component === 'diagnostics' ? target.channel.request('list', { status: 'all', limit: 1 })
            : Promise.reject(failure('READY_PROBE_FAILED')))
        target.probed = true
      } catch (error) {
        target.probeFailed = true
        state('unavailable'); recovery.lost(error)
        throw error
      }
    }
    exchanging = false; state('running', true)
  }
  const drainAdmission = (ticket, forClose) => forClose && component === 'conversation' && admission?.drainForClose
    ? admission.drainForClose(ticket) : admission?.drain(ticket)
  const drain = async (target, ticket, markStage = () => {}, forClose = false) => {
    const started = Date.now()
    markStage('parent_drain')
    const [, admissionResult] = await within(Promise.all(component === 'conversation' ? [] : [waitActive(), drainAdmission(ticket, forClose)]), 60000, `${prefix}_DRAIN_TIMEOUT`)
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
  // Exchanges and recovery take turns instead of refusing each other (Owner 2026-11-08).
  const exclusive = action => {
    const promise = (operation ?? Promise.resolve()).catch(() => {}).then(action)
    operation = promise
    void promise.finally(() => { if (operation === promise) operation = null }).catch(() => {})
    return promise
  }
  const startAttempt = () => exclusive(async () => {
    if (closed || initialized) throw fail('ALREADY_STARTED')
    state('starting')
    const saved = await readAdoption()
    if (saved) {
      // A release signed for another body's state format cannot run here; this body's bundled module can.
      const adoptable = versionId => prepare(versionId).then(() => versionId, error => {
        if (error?.code !== `${prefix}_STATE_INCOMPATIBLE`) throw error
        console.error(JSON.stringify({ code: 'MODULE_ADOPTION_INCOMPATIBLE', component, versionId }))
        return null
      })
      const current = await adoptable(saved.currentVersionId), previous = await adoptable(saved.previousVersionId)
      if (current !== saved.currentVersionId || previous !== saved.previousVersionId) await writeAtomic(adoptionPath, record(current, previous))
      currentVersionId = current; previousVersionId = previous
    }
    const ticket = closeAdmission('module_start')
    try {
      if (component !== 'conversation') await admission?.drain(ticket)
      const target = await launch(currentVersionId, ticket, saved ? 'restore' : 'bootstrap')
      if (startPaused) state('initializing')
      else await resume(target, ticket)
      initialized = true
      return snapshot()
    } catch (error) { state(closed ? 'closed' : 'unavailable'); throw error }
  })
  const start = () => available ? Promise.resolve(snapshot()) : startAttempt().catch(error => {
    if (closed || phase !== 'unavailable') throw error
    return recovery.wait().then(() => { if (closed) throw error; return snapshot() })
  })
  const invoke = (kind, method, params, options) => {
    try {
      const target = instance
      if (component !== 'conversation' && proofHeld) throw fail('PROOF_UNAVAILABLE')
      if (!target || target.ended || component !== 'conversation' && kind === 'request' && !available && !canContinue(method, options, target.generation)) {
        if (kind === 'request' && !closed) return recovery.hold(() => invoke(kind, method, params, options), () => fail('NOT_ACCEPTING'))
        throw fail('NOT_ACCEPTING')
      }
      return track(target.channel[kind](method, params, options))
    } catch (error) { return Promise.reject(error) }
  }
  const replace = (requested, { expectedRelease } = {}) => {
    if (requested !== 'builtin' && !versionValid(requested)) return Promise.reject(fail('VERSION_INVALID', 400))
    // A stopped or never-started module is replaceable too: the update is how a broken version gets fixed.
    if (closed) return Promise.reject(fail('NOT_ACCEPTING'))
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
      let handoff
      try {
        await drain(old, ticket)
        const exporting = track(exportHandoff(old.channel))
        handoff = (await within(Promise.all([exporting, exporting.completion]), 60000, `${prefix}_DRAIN_TIMEOUT`))[0]
      } catch {
        // The old module cannot veto its replacement (Owner 2026-11-08): it is stopped below like a crashed child and
        // the candidate restores from durable state, exactly as after an unexpected exit.
        handoff = undefined
      }
      try { await prepare(versionId, expected) } catch (error) {
        if (!closed) { try { await resume(old, ticket) } catch { state('unavailable') } }
        throw error
      }
      if (closed) throw fail('CLOSED')
      if (old && !old.ended) await finishExit(old)
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
        initialized = true
        return snapshot()
      } catch (error) {
        if (['READY_TIMEOUT', 'READY_PROBE_FAILED'].includes(error?.code)) {
          state('unavailable'); recovery.lost(error)
          throw error
        }
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
      } finally { if (phase !== 'running') { exchanging = false; state(closed ? 'closed' : 'unavailable') } }
    }
    return exclusive(() => exchangeMutex ? exchangeMutex.runExclusive(perform) : perform())
  }
  const reserve = (versionId, options) => {
    if (versionId !== 'builtin' && !versionValid(versionId)) throw fail('VERSION_INVALID', 400)
    if (closed) throw fail('NOT_ACCEPTING')
    if (reservation) throw fail('UPDATE_IN_PROGRESS', 409)
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
        || active.size)
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
          target.resumed = true
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
  return { start, close, replace, reserve, snapshot, withInstallReconciliationProof,
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
