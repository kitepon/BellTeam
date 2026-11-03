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
  onGeneration = () => {}, onState = () => {}, investigationsFile = null,
  spawnProcess = spawn }) {
  if (!['conversation', 'usage', 'diagnostics'].includes(component) || typeof root !== 'string'
    || typeof createChannel !== 'function' || typeof prepareRelease !== 'function' || typeof validateReady !== 'function'
    || component !== 'diagnostics' && investigationsFile !== null
    || investigationsFile !== null && typeof investigationsFile !== 'string') throw failure('MODULE_OPTIONS_INVALID', 400)
  const prefix = component.toUpperCase(), adoptionPath = join(root, `state/${component}-release.json`)
  const fail = (suffix, status) => failure(`${prefix}_${suffix}`, status)
  let instance = null, currentVersionId = null, previousVersionId = null, generation = null
  let initialized = false, closed = false, available = false, phase = 'unavailable', exchanging = false
  let operation = null, closing = null, update = null, reservation = null, startingReservation = false
  const active = new Set()
  const snapshot = () => ({ currentVersionId, previousVersionId, generation, available, phase, exchanging,
    currentTarget: currentVersionId === null ? 'builtin' : 'release',
    protocolVersion: instance?.ready?.protocolVersion ?? null,
    stateCompatibility: instance?.ready?.stateCompatibility ? structuredClone(instance.ready.stateCompatibility) : null,
    update: update ? { ...update } : null })
  const state = (next, usable = false) => {
    phase = next; available = usable
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
  const closeAdmission = () => admission?.close()
  const stopUnadmitted = async target => {
    if (!target || target.ended) return
    // Never kill a previously resumed writer as an exchange timeout shortcut.
    if (target.resumed) throw fail('DRAIN_REQUIRED')
    target.child.kill('SIGKILL')
    await target.end
  }
  const launch = async (versionId, ticket, mode, handoff) => {
    if (closed || instance) throw fail('NOT_ACCEPTING')
    const nextGeneration = `${versionId ?? 'builtin'}:${randomUUID()}`
    admission?.adopt(ticket, nextGeneration)
    generation = nextGeneration
    onGeneration(nextGeneration)
    const env = component === 'diagnostics' && investigationsFile !== null
      ? { BELLTEAM_DIAGNOSTIC_INVESTIGATIONS: investigationsFile } : {}
    const child = spawnProcess(`/usr/local/libexec/bellteam-${component}-start`, [versionId ?? 'builtin'], {
      env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    // Pipes are drained without retaining or publishing arbitrary child output.
    child.stdout?.resume(); child.stderr?.resume()
    const target = { child, generation: nextGeneration, ended: false, resumed: false, channel: null }
    instance = target
    target.end = waitNotificationsChildClose(child).then(async () => {
      await target.channel?.drainIncoming?.()
      target.ended = true
      target.channel?.reaped()
      if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
    })
    const started = Date.now()
    try {
      target.channel = createChannel(child, { generation: nextGeneration })
      if (component !== 'diagnostics' && typeof target.channel.drainIncoming !== 'function') throw fail('CHANNEL_INVALID')
      const params = await initializeParams({ generation: nextGeneration, mode, handoff })
      const initializing = target.channel.control('initialize', params, 45000)
      await initializing
      await within(initializing.completion ?? Promise.resolve(), 45000 - (Date.now() - started), `${prefix}_READY_TIMEOUT`)
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
    exchanging = false; state('running', true)
  }
  const drain = async (target, ticket) => {
    const started = Date.now()
    await within(Promise.all([waitActive(), admission?.drain(ticket)]), 60000, `${prefix}_DRAIN_TIMEOUT`)
    if ((await track(target.channel.control('quiesce', {}, Math.max(1, 60000 - (Date.now() - started))))).quiesced !== true)
      throw fail('QUIESCE_FAILED')
  }
  const finishExit = async target => {
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
    const ticket = closeAdmission()
    try {
      await admission?.drain(ticket)
      const target = await launch(currentVersionId, ticket, saved ? 'restore' : 'bootstrap')
      await resume(target, ticket)
      initialized = true
      return snapshot()
    } catch (error) { state(closed ? 'closed' : 'unavailable'); throw error }
  })
  const invoke = (kind, method, params, options) => {
    try {
      const target = instance
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
    return exclusive(async () => {
      await prepare(versionId, expected)
      if (versionId === currentVersionId) return snapshot()
      if (closed) throw fail('CLOSED')
      const old = instance, oldVersion = currentVersionId, oldPrevious = previousVersionId
      const ticket = closeAdmission()
      exchanging = true; state('quiescing')
      let handoff
      try {
        await drain(old, ticket)
        const exporting = track(exportHandoff(old.channel))
        handoff = (await within(Promise.all([exporting, exporting.completion]), 60000, `${prefix}_DRAIN_TIMEOUT`))[0]
        await prepare(versionId, expected)
      } catch (error) {
        if (!closed) { try { await resume(old, ticket) } catch { state('unavailable') } }
        throw error
      }
      if (closed) throw fail('CLOSED')
      await finishExit(old)
      if (closed) throw fail('CLOSED')
      state('starting')
      try {
        const next = await launch(versionId, ticket, 'restore', handoff)
        await writeAtomic(adoptionPath, record(versionId, oldVersion))
        currentVersionId = versionId; previousVersionId = oldVersion
        await resume(next, ticket)
        return snapshot()
      } catch (error) {
        const errors = [error]
        try {
          await stopUnadmitted(instance)
          if (closed) throw fail('CLOSED')
          await prepare(oldVersion)
          const restored = await launch(oldVersion, ticket, 'restore', handoff)
          await writeAtomic(adoptionPath, record(oldVersion, oldPrevious))
          currentVersionId = oldVersion; previousVersionId = oldPrevious
          await resume(restored, ticket)
        } catch (rollback) { errors.push(rollback); state(closed ? 'closed' : 'unavailable') }
        throw new AggregateError(errors, errors.length === 1 ? `${prefix}_REPLACE_ROLLED_BACK` : `${prefix}_REPLACE_AND_ROLLBACK_FAILED`)
      } finally { if (phase !== 'running') { exchanging = false; state(phase) } }
    })
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
    closed = true; available = false; reservation?.cancel()
    closing = (async () => {
      await operation?.catch(() => {})
      const target = instance
      if (target) {
        const ticket = closeAdmission()
        try { await drain(target, ticket); await finishExit(target) }
        catch (error) {
          if (target.child.connected) target.child.disconnect()
          await target.end
          state('closed'); throw error
        }
      }
      state('closed')
    })()
    return closing
  }
  return { start, close, replace, reserve, snapshot,
    request: (method, params, options = {}) => invoke('request', method, params, options),
    callback: (method, params, options = {}) => invoke('callback', method, params, options),
    initialize: mode => {
      if (!available || closed || exchanging) return Promise.reject(fail('NOT_ACCEPTING'))
      return track(Promise.resolve(initializeParams({ generation, mode })).then(params => track(instance.channel.control('initialize', params, 45000))))
    },
  }
}
