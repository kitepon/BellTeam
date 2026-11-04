import { createModuleChildRestart, reportModuleChildExit, observeModuleChild } from './module-child-restart.mjs'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeAtomic } from './json-file.mjs'
import { prepareNotificationsRelease, assertNotificationsCatalogRelease } from './notifications-release.mjs'
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
  let builtinSourceCommit = null
  let status = null, applyError = { apns: null, webPush: null }, available = false, exchanging = false, update = null, closed = false
  let configurationEpoch = -1, capturedConfiguration = null
  const desiredEpoch = { apns: -1, webPush: -1 }, appliedEpoch = { apns: null, webPush: null }, errorEpoch = { apns: -1, webPush: -1 }
  const providers = ['apns', 'webPush']
  let operation = null, cancellation = null, closing = null, configuring = 0, initialized = false
  const recovery = createModuleChildRestart(async () => {
    await operation?.catch(() => {})
    if (closed || instance || !initialized) return
    await exclusive(async signal => {
      await prepare(currentVersionId, signal)
      const target = await launch(currentVersionId, signal)
      try { await resume(target, signal); state('running', true) }
      catch (error) { await killAndReap(target); throw error }
    })
  })
  const captureConfiguration = (provider, expected) => {
    const next = structuredClone(configuration())
    if (!next || Object.keys(next).sort().join(',') !== 'apns,webPush') throw failure('NOTIFICATIONS_CONFIGURATION_INVALID')
    if (provider && !isDeepStrictEqual(next[provider], expected)) throw failure('PUSH_CONFIGURATION_STALE', 409)
    if (provider || !isDeepStrictEqual(next, capturedConfiguration)) {
      configurationEpoch++
      for (const name of providers)
        if (provider === name || !isDeepStrictEqual(next[name], capturedConfiguration?.[name])) desiredEpoch[name] = configurationEpoch
      capturedConfiguration = next
    }
    return { configuration: structuredClone(capturedConfiguration), epochs: { ...desiredEpoch } }
  }
  const emit = () => { try { onState({ phase, exchanging, available, status, applyError: { ...applyError },
    configurationEpoch, appliedEpoch: { ...appliedEpoch } }) } catch {} }
  const state = (next, usable = false) => { phase = next; available = usable; if (usable) recovery.running(); emit() }
  const snapshot = () => ({ currentVersionId, previousVersionId, currentTarget: currentVersionId === null ? 'builtin' : 'release', builtinSourceCommit, available, status, applyError: { ...applyError }, phase,
    configurationEpoch, appliedEpoch: { ...appliedEpoch }, protocolVersion: 2, stateSchema: 2, update: update ? { ...update } : null })
  const commitApplication = (provider, epoch, value, error) => {
    if (value !== undefined) status = { ...status, [provider]: value }
    if (!error) appliedEpoch[provider] = epoch
    if (epoch >= errorEpoch[provider]) {
      applyError[provider] = error ?? null
      errorEpoch[provider] = epoch
    }
  }
  const prepare = async (versionId, signal, expectedRelease) => {
    if (versionId === null) return
    if (!versionValid(versionId)) throw failure('NOTIFICATIONS_VERSION_INVALID', 400)
    const value = await prepareRelease(versionId, { signal, expectedRelease })
    signal.throwIfAborted()
    if (value?.versionId !== versionId || value.appRoot !== `/run/bellteam-maintenance/notifications/releases/${versionId}/payload`
      || value.protocolVersion !== 2 || value.stateSchema !== 2) throw failure('NOTIFICATIONS_RELEASE_INVALID')
    if (expectedRelease) assertNotificationsCatalogRelease(expectedRelease, value)
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
        || record.schema !== 'bellteam.notifications.adoption.v1' || (record.currentVersionId !== null && !versionValid(record.currentVersionId))
        || record.previousVersionId !== null && !versionValid(record.previousVersionId)) throw failure('NOTIFICATIONS_ADOPTION_INVALID')
      return record
    } finally { await file.close() }
  }
  const killAndReap = async target => {
    if (!target || target.ended) return
    target.child.kill('SIGKILL')
    await target.end
  }
  const launch = async (versionId, signal) => {
    signal.throwIfAborted()
    if (instance) throw failure('NOTIFICATIONS_ALREADY_STARTED')
    const child = spawn('/usr/local/libexec/bellteam-notifications-start', [versionId ?? 'builtin'], {
      env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const target = { child, ended: false, attemptedEpoch: {}, channel: createNotificationsParentChannel(child, { onDiagnostic }) }
    target.end = waitNotificationsChildClose(child).then(result => {
      const unexpected = target.resumed && initialized && !closed && !target.intentional
      if (unexpected) reportModuleChildExit('notifications', result, target.stderrCodes())
      target.ended = true
      target.channel.dispose()
      if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
      if (unexpected) recovery.lost()
    })
    target.stderrCodes = observeModuleChild(child)
    instance = target
    try {
      const startedAt = Date.now()
      const captured = captureConfiguration()
      const initialized = await abortable(target.channel.control('initialize', { configuration: captured.configuration }, 45000), signal)
      let timer
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(failure('NOTIFICATIONS_READY_TIMEOUT')), Math.max(1, 45000 - (Date.now() - startedAt))) })
      let ready
      try { ready = await abortable(Promise.race([target.channel.ready, deadline]), signal) }
      finally { clearTimeout(timer) }
      if (ready.versionId !== versionId || !isDeepStrictEqual(ready.status, initialized.status)
        || !isDeepStrictEqual(ready.applyError, initialized.applyError)) throw failure('NOTIFICATIONS_READY_INVALID')
      for (const provider of providers) {
        target.attemptedEpoch[provider] = captured.epochs[provider]
        commitApplication(provider, captured.epochs[provider], initialized.status[provider], initialized.applyError[provider])
      }
      return target
    } catch (error) { await killAndReap(target); throw error }
  }
  const resume = async (target, signal) => {
    const resumed = await abortable(target.channel.control('resume', {}, 5000), signal)
    if (resumed?.resumed !== true) throw failure('NOTIFICATIONS_RESUME_FAILED')
    signal.throwIfAborted()
    if (target.ended) throw failure('NOTIFICATIONS_UNAVAILABLE')
    // The private child can now accept configure; parent business admission stays closed until the latest snapshot is applied.
    while (true) {
      const captured = captureConfiguration()
      for (const provider of providers) {
        if (target.attemptedEpoch[provider] >= captured.epochs[provider]) continue
        const epoch = captured.epochs[provider]
        try {
          const value = await abortable(target.channel.request('configure', { ...captured.configuration[provider], provider }), signal)
          commitApplication(provider, epoch, value, null)
        } catch (error) {
          if (signal.aborted) throw error
          commitApplication(provider, epoch, undefined, /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'PUSH_CONFIGURATION_FAILED')
          if (!target.child.connected) throw failure('NOTIFICATIONS_UNAVAILABLE')
          try {
            const value = await abortable(target.channel.request('status', { provider }), signal)
            status = { ...status, [provider]: value }
          } catch (readError) { if (signal.aborted) throw readError }
        }
        target.attemptedEpoch[provider] = epoch
      }
      const latest = captureConfiguration()
      if (target.ended || !target.child.connected) throw failure('NOTIFICATIONS_UNAVAILABLE')
      if (providers.every(provider => target.attemptedEpoch[provider] >= latest.epochs[provider])) { target.resumed = true; return }
    }
  }
  const finishExit = async target => {
    target.intentional = true
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
      let metadata
      try {
        metadata = await open('/app/distribution.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const info = await metadata.stat()
        if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o22 || info.size > 4096) throw failure('NOTIFICATIONS_BUILTIN_IDENTITY_INVALID')
        const value = JSON.parse(await metadata.readFile('utf8'))
        if (value.schema !== 'bellteam.server.distribution.v1' || !/^[a-f0-9]{40}$/.test(value.sourceCommit)) throw failure('NOTIFICATIONS_BUILTIN_IDENTITY_INVALID')
        builtinSourceCommit = value.sourceCommit
      } finally { await metadata?.close() }
      const record = await readAdoption()
      if (record) {
        await prepare(record.currentVersionId, signal)
        await prepare(record.previousVersionId, signal)
        currentVersionId = record.currentVersionId; previousVersionId = record.previousVersionId
      }
      try {
        const target = await launch(currentVersionId, signal)
        await resume(target, signal)
        initialized = true
        state('running', true)
        return { versionId: currentVersionId, protocolVersion: 2, stateSchema: 2, status, applyError: { ...applyError } }
      } catch (error) { await killAndReap(instance); state('unavailable'); throw error }
    })
  }
  const request = async (method, params) => {
    if (closed) throw failure('PUSH_NOT_ACCEPTING')
    const provider = params?.provider
    const expected = params ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'provider')) : null
    const captured = method === 'configure' && providers.includes(provider) ? captureConfiguration(provider, expected) : null
    if (closed || !available || exchanging || !instance) {
      if (captured && !closed) { commitApplication(provider, captured.epochs[provider], undefined, 'PUSH_CONFIGURATION_BUSY'); emit() }
      throw failure('PUSH_NOT_ACCEPTING')
    }
    if (method === 'configure' && (operation || configuring || update && ['accepted', 'running'].includes(update.status))) {
      if (captured) { commitApplication(provider, captured.epochs[provider], undefined, 'PUSH_CONFIGURATION_BUSY'); emit() }
      throw failure('PUSH_CONFIGURATION_BUSY', 409)
    }
    if (method === 'configure') configuring++
    const target = instance
    try {
      const value = await target.channel.request(method, params)
      if (method === 'configure' || method === 'status' && (provider === 'apns' || !Object.hasOwn(params, 'endpoint'))) {
        if (method === 'configure') {
          commitApplication(provider, captured.epochs[provider], value, null)
          target.attemptedEpoch[provider] = captured.epochs[provider]
        } else status = { ...status, [provider]: value }
        emit()
      }
      return value
    } catch (error) {
      if (!target.child.connected) state('unavailable')
      if (method === 'configure' && captured) {
        commitApplication(provider, captured.epochs[provider], undefined, /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'PUSH_CONFIGURATION_FAILED')
        if (target.child.connected) {
          try { status = { ...status, [provider]: await target.channel.request('status', { provider }) } } catch {}
        }
        emit()
      }
      throw error
    } finally { if (method === 'configure') configuring-- }
  }
  const replace = (versionId, { expectedRelease } = {}) => {
    if (versionId !== 'builtin' && !versionValid(versionId)) return Promise.reject(failure('NOTIFICATIONS_VERSION_INVALID', 400))
    versionId = versionId === 'builtin' ? null : versionId
    if (closed || !initialized || !instance) return Promise.reject(failure('NOTIFICATIONS_UNAVAILABLE'))
    if (configuring) return Promise.reject(failure('NOTIFICATIONS_CONFIGURATION_BUSY', 409))
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    return exclusive(async signal => {
      const oldVersion = currentVersionId, oldPrevious = previousVersionId, old = instance
      captureConfiguration()
      await prepare(versionId, signal, expected)
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
        try { await prepare(versionId, signal, expected) }
        catch (error) {
          if (!signal.aborted && !closed) { await resume(old, signal); exchanging = false; state('running', true) }
          throw error
        }
        await finishExit(old)
        signal.throwIfAborted()
        state('starting')
        let adoptionCommitted = false
        try {
          const next = await launch(versionId, signal)
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
            const restored = await launch(oldVersion, signal)
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
  const reserve = (versionId, { expectedRelease } = {}) => {
    if (versionId !== 'builtin' && !versionValid(versionId)) throw failure('NOTIFICATIONS_VERSION_INVALID', 400)
    if (closed || !initialized || !instance || !available) throw failure('NOTIFICATIONS_UNAVAILABLE')
    if (configuring || operation || update && ['accepted', 'running'].includes(update.status)) throw failure('NOTIFICATIONS_UPDATE_IN_PROGRESS', 409)
    const next = { versionId, status: 'accepted' }; update = next
    const options = expectedRelease ? { expectedRelease: structuredClone(expectedRelease) } : undefined
    let complete
    const completion = new Promise(resolve => { complete = resolve })
    let settled = false
    return { completion, start() {
      if (settled) return
      settled = true
      if (closed) { next.status = 'not_started'; complete(); return }
      next.status = 'running'
      void replace(versionId, options).then(() => { next.status = 'succeeded' }, error => {
        next.status = 'failed'
        next.error = /^NOTIFICATIONS_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'NOTIFICATIONS_UPDATE_FAILED'
      }).finally(complete)
    }, cancel() { if (!settled) { settled = true; next.status = 'not_started'; complete() } } }
  }
  const close = () => {
    if (closing) return closing
    closed = true; recovery.close(); available = false; cancellation?.abort(); emit()
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
