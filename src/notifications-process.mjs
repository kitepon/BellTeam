import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './json-file.mjs'
import { prepareNotificationsRelease } from './notifications-release.mjs'
import { createNotificationsParentChannel, waitNotificationsChildClose, notificationError } from './notifications-ipc.mjs'

const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const failure = (code, status = 503) => notificationError(code, 'not_accepted', status)
const abortable = (promise, signal) => {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createNotificationsProcess({ root, configuration, onDiagnostic = async () => {}, onState = () => {}, prepareRelease = prepareNotificationsRelease }) {
  const adoptionPath = join(root, 'state/notifications-release.json')
  let instance = null, currentVersionId = null, previousVersionId = null, phase = 'unavailable'
  let status = null, applyError = null, available = false, exchanging = false, update = null, closed = false
  let operation = null, cancellation = null, closing = null, configuring = 0, initialized = false
  const emit = () => { try { onState({ phase, exchanging, available, status, applyError }) } catch {} }
  const state = (next, usable = false) => { phase = next; available = usable; emit() }
  const snapshot = () => ({ currentVersionId, previousVersionId, available, status, applyError, phase, update: update ? { ...update } : null })
  const prepare = async (versionId, signal) => {
    if (versionId === null) return
    if (!versionValid(versionId)) throw failure('NOTIFICATIONS_VERSION_INVALID', 400)
    const value = await prepareRelease(versionId, { signal })
    signal.throwIfAborted()
    if (value?.versionId !== versionId || value.appRoot !== `/run/bellteam-maintenance/notifications/releases/${versionId}/payload`
      || value.protocolVersion !== 1 || value.stateSchema !== 1) throw failure('NOTIFICATIONS_RELEASE_INVALID')
  }
  const readAdoption = async () => {
    let file
    try { file = await open(adoptionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4096)
        throw failure('NOTIFICATIONS_ADOPTION_INVALID')
      let record
      try { record = JSON.parse(await file.readFile('utf8')) } catch { throw failure('NOTIFICATIONS_ADOPTION_INVALID') }
      if (Object.keys(record ?? {}).sort().join(',') !== 'currentVersionId,previousVersionId,schema'
        || record.schema !== 'bellteam.notifications.adoption.v1' || !versionValid(record.currentVersionId)
        || record.previousVersionId !== null && !versionValid(record.previousVersionId)) throw failure('NOTIFICATIONS_ADOPTION_INVALID')
      return record
    } finally { await file.close() }
  }
  const killAndReap = async target => {
    if (!target || target.ended) return
    target.child.kill('SIGKILL')
    await target.end
  }
  const launch = async (versionId, config, signal) => {
    signal.throwIfAborted()
    if (instance) throw failure('NOTIFICATIONS_ALREADY_STARTED')
    const child = spawn('/usr/local/libexec/bellteam-notifications-start', [versionId ?? 'builtin'], {
      env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const target = { child, ended: false, channel: createNotificationsParentChannel(child, { onDiagnostic }) }
    target.end = waitNotificationsChildClose(child).then(() => {
      target.ended = true
      target.channel.dispose()
      if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
    })
    instance = target
    try {
      const startedAt = Date.now()
      await abortable(target.channel.control('initialize', { configuration: config }, 45000), signal)
      let timer
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(failure('NOTIFICATIONS_READY_TIMEOUT')), Math.max(1, 45000 - (Date.now() - startedAt))) })
      let ready
      try { ready = await abortable(Promise.race([target.channel.ready, deadline]), signal) }
      finally { clearTimeout(timer) }
      if (ready.versionId !== versionId) throw failure('NOTIFICATIONS_READY_INVALID')
      status = ready.status; applyError = ready.applyError
      return target
    } catch (error) { await killAndReap(target); throw error }
  }
  const resume = async (target, signal) => {
    const resumed = await abortable(target.channel.control('resume', {}, 5000), signal)
    if (resumed?.resumed !== true) throw failure('NOTIFICATIONS_RESUME_FAILED')
    signal.throwIfAborted()
    if (target.ended) throw failure('NOTIFICATIONS_UNAVAILABLE')
  }
  const finishExit = async target => {
    let timer, timedOut = false
    const deadline = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; target.child.kill('SIGKILL'); resolve() }, 5000) })
    try {
      // Child owns provider shutdown; result loss is reconciled only by OS close, never retried.
      void target.channel.control('exit', {}, 5000).catch(() => {})
      await Promise.race([target.end, deadline])
      if (timedOut) await target.end
    } finally { clearTimeout(timer) }
  }
  const exclusive = callback => {
    if (operation) return Promise.reject(failure('NOTIFICATIONS_UPDATE_IN_PROGRESS', 409))
    const controller = new AbortController()
    cancellation = controller
    const promise = Promise.resolve().then(() => callback(controller.signal))
    operation = promise
    void promise.finally(() => { if (operation === promise) { operation = null; cancellation = null } }).catch(() => {})
    return promise
  }
  const start = () => {
    if (closed) return Promise.reject(failure('NOTIFICATIONS_CLOSED'))
    return exclusive(async signal => {
      if (initialized) throw failure('NOTIFICATIONS_ALREADY_STARTED')
      state('starting')
      const record = await readAdoption()
      if (record) {
        await prepare(record.currentVersionId, signal)
        await prepare(record.previousVersionId, signal)
        currentVersionId = record.currentVersionId; previousVersionId = record.previousVersionId
      }
      try {
        const target = await launch(currentVersionId, configuration(), signal)
        await resume(target, signal)
        initialized = true
        state('running', true)
        return { versionId: currentVersionId, protocolVersion: 1, stateSchema: 1, status, applyError }
      } catch (error) { await killAndReap(instance); state('unavailable'); throw error }
    })
  }
  const request = async (method, params) => {
    if (closed || !available || exchanging || !instance) throw failure('PUSH_NOT_ACCEPTING')
    if (method === 'configure' && (operation || configuring || update && ['accepted', 'running'].includes(update.status))) throw failure('PUSH_CONFIGURATION_BUSY', 409)
    if (method === 'configure') configuring++
    try {
      const value = await instance.channel.request(method, params)
      if (method === 'configure' || method === 'status') {
        status = value
        if (method === 'configure') applyError = null
        emit()
      }
      return value
    } catch (error) {
      if (method === 'configure') { applyError = /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'PUSH_CONFIGURATION_FAILED'; emit() }
      throw error
    } finally { if (method === 'configure') configuring-- }
  }
  const replace = versionId => {
    if (!versionValid(versionId)) return Promise.reject(failure('NOTIFICATIONS_VERSION_INVALID', 400))
    if (closed || !initialized || !instance) return Promise.reject(failure('NOTIFICATIONS_UNAVAILABLE'))
    if (configuring) return Promise.reject(failure('NOTIFICATIONS_CONFIGURATION_BUSY', 409))
    return exclusive(async signal => {
      const oldVersion = currentVersionId, oldPrevious = previousVersionId, old = instance
      const config = configuration()
      await prepare(versionId, signal)
      if (versionId === currentVersionId) return snapshot()
      exchanging = true; state('quiescing')
      try {
        try {
          const quiesced = await abortable(old.channel.control('quiesce', {}, 60000), signal)
          if (quiesced?.quiesced !== true) throw failure('NOTIFICATIONS_QUIESCE_FAILED')
        }
        catch (error) {
          if (signal.aborted || closed) throw error
          try { await resume(old, signal); exchanging = false; state('running', true) }
          catch { state('unavailable') }
          throw failure('NOTIFICATIONS_QUIESCE_FAILED')
        }
        signal.throwIfAborted()
        await finishExit(old)
        signal.throwIfAborted()
        state('starting')
        let adoptionCommitted = false
        try {
          const next = await launch(versionId, config, signal)
          signal.throwIfAborted()
          await writeAtomic(adoptionPath, { schema: 'bellteam.notifications.adoption.v1', currentVersionId: versionId, previousVersionId: oldVersion })
          adoptionCommitted = true
          signal.throwIfAborted()
          await resume(next, signal)
          currentVersionId = versionId; previousVersionId = oldVersion
          exchanging = false; state('running', true)
          return snapshot()
        } catch (error) {
          if (signal.aborted || closed) throw error
          const errors = [error]
          await killAndReap(instance)
          try {
            await prepare(oldVersion, signal)
            const restored = await launch(oldVersion, config, signal)
            // Adoption may have succeeded before a resume failure; restore only the version record, never business data.
            if (adoptionCommitted && oldVersion === null) {
              const { unlink } = await import('node:fs/promises')
              await unlink(adoptionPath).catch(error => { if (error.code !== 'ENOENT') throw error })
            } else if (adoptionCommitted) await writeAtomic(adoptionPath, { schema: 'bellteam.notifications.adoption.v1', currentVersionId: oldVersion, previousVersionId: oldPrevious })
            await resume(restored, signal)
            currentVersionId = oldVersion; previousVersionId = oldPrevious
            exchanging = false; state('running', true)
          } catch (rollbackError) { errors.push(rollbackError); state('unavailable') }
          throw new AggregateError(errors, errors.length > 1 ? 'NOTIFICATIONS_REPLACE_AND_ROLLBACK_FAILED' : 'NOTIFICATIONS_REPLACE_ROLLED_BACK')
        }
      } finally { if (phase !== 'running') { exchanging = false; emit() } }
    })
  }
  const reserve = versionId => {
    if (!versionValid(versionId)) throw failure('NOTIFICATIONS_VERSION_INVALID', 400)
    if (closed || !initialized || !instance || !available) throw failure('NOTIFICATIONS_UNAVAILABLE')
    if (configuring || operation || update && ['accepted', 'running'].includes(update.status)) throw failure('NOTIFICATIONS_UPDATE_IN_PROGRESS', 409)
    const next = { versionId, status: 'accepted' }; update = next
    let settled = false
    return { start() {
      if (settled) return
      settled = true
      if (closed) { next.status = 'not_started'; return }
      next.status = 'running'
      void replace(versionId).then(() => { next.status = 'succeeded' }, error => {
        next.status = 'failed'
        next.error = /^NOTIFICATIONS_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'NOTIFICATIONS_UPDATE_FAILED'
      })
    }, cancel() { if (!settled) { settled = true; next.status = 'not_started' } } }
  }
  const close = () => {
    if (closing) return closing
    closed = true; available = false; cancellation?.abort(); emit()
    if (update?.status === 'accepted') update.status = 'not_started'
    closing = (async () => {
      await operation?.catch(() => {})
      const target = instance
      if (target) {
        try {
          const result = await target.channel.control('quiesce', {}, 60000)
          if (result?.quiesced !== true) throw failure('NOTIFICATIONS_QUIESCE_FAILED')
          await finishExit(target)
        }
        catch { await killAndReap(target) }
      }
      exchanging = false; state('closed')
    })()
    return closing
  }
  return { start, close, request, replace, snapshot, reserve }
}
