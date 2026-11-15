import { probeModuleReady } from './module-ready-probe.mjs'
import { createModuleChildRestart, reportModuleChildExit, observeModuleChild } from './module-child-restart.mjs'
import { get } from 'node:http'
import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { writeAtomic } from './json-file.mjs'

export const GATEWAY_DRAIN_TIMEOUT_MS = 5000
export const GATEWAY_START_TIMEOUT_MS = 15000
export const GATEWAY_ASSET_SHARE_TIMEOUT_MS = 5000

export function createHttpGatewayProcess({ socketPath, port, appRoot, prepareRelease, adoptionPath = null, onModuleChildExit, onModuleRestartLimit,
  writeAdoption = writeAtomic }) {
  let child = null, address = null
  let closed = false
  const recovery = createModuleChildRestart(async () => {
    if (closed || child) return
    await start()
  }, 'web-gateway', onModuleRestartLimit)
  let boundPort = port
  // shortcut: older assets live in this parent; persist the list to retain them across parent restarts.
  const assetVersions = new Map()
  const assetCatalog = (entries = assetVersions) => {
    const value = JSON.stringify([...entries])
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error('GATEWAY_ASSET_CATALOG_TOO_LARGE')
    return value
  }
  let currentRoot = appRoot, currentVersion = null, updating = null, initialized = false
  const versionIdValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const prepare = async (versionId, signal) => {
    signal?.throwIfAborted()
    if (versionId === 'builtin') return { versionId: null, appRoot, protocolVersion: 1 }
    if (!versionIdValid(versionId)) throw new Error('GATEWAY_VERSION_INVALID')
    if (typeof prepareRelease !== 'function') throw new Error('GATEWAY_RELEASES_UNAVAILABLE')
    const release = await prepareRelease(versionId, { signal })
    signal?.throwIfAborted()
    if (release?.versionId !== versionId || typeof release.appRoot !== 'string' || !isAbsolute(release.appRoot)
      || release.protocolVersion !== 1) throw new Error('GATEWAY_RELEASE_INVALID')
    return release
  }
  const readAdoption = async () => {
    if (!adoptionPath) return null
    let file
    try { file = await open(adoptionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4096)
        throw new Error('GATEWAY_ADOPTION_INVALID')
      let state
      try { state = JSON.parse(await file.readFile('utf8')) }
      catch { throw new Error('GATEWAY_ADOPTION_INVALID') }
      if (Object.keys(state ?? {}).sort().join(',') !== 'currentVersionId,previousVersionId,schema'
        || state.schema !== 'bellteam.web-gateway.adoption.v1'
        || state.currentVersionId !== null && !versionIdValid(state.currentVersionId)
        || state.previousVersionId !== null && !versionIdValid(state.previousVersionId))
        throw new Error('GATEWAY_ADOPTION_INVALID')
      return state
    } finally { await file.close() }
  }
  // Every spawned child until its close; close() ends all of them (an exchange briefly has two).
  const live = new Set()
  // overlap: the new child binds beside the serving one (SO_REUSEPORT) and stays out of `child` until commit().
  // The builtin key is chosen here, not in the child, so an old child can be told it before the new one starts.
  const launch = async (root, versionId, overlap, assetKey = versionId ?? Date.now().toString(36)) => {
    const requestedPort = boundPort
    recovery.restarting()
    const next = spawn(process.execPath, [join(root, 'src/http-gateway-entry.mjs'), socketPath, String(requestedPort), assetKey, assetCatalog()], {
      env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    // A child bound without SO_REUSEPORT (a release before 95eef79b) on either side makes the new bind fail with EADDRINUSE.
    let addressInUse = false
    const stderrObservation = observeModuleChild(next, line => { if (line.includes('EADDRINUSE')) addressInUse = true })
    if (!overlap) child = next
    // An overlap candidate is not serving until commit(): its crash is reported, but recovery belongs to the serving child.
    next.candidate = overlap
    live.add(next)
    next.ended = new Promise(resolve => next.once('close', (code, signal) => {
      live.delete(next)
      if (child === next) { child = null; address = null }
      if (next.wasReady && !next.intentional && !closed) {
        if (!next.candidate) recovery.exited({ code, signal })
        reportModuleChildExit('web-gateway', { code, signal }, stderrObservation(), onModuleChildExit)
        if (!next.candidate) recovery.lost()
      }
      resolve({ code, signal })
    }))
    let ready
    try {
      ready = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
          next.kill('SIGKILL')
          reject(new Error('GATEWAY_START_TIMEOUT'))
        }, GATEWAY_START_TIMEOUT_MS)
        next.once('close', () => clearTimeout(deadline))
        const earlyExit = () => reject(new Error(overlap && addressInUse ? 'GATEWAY_PORT_NOT_SHARED' : 'GATEWAY_START_FAILED'))
        const failed = error => reject(error)
        next.once('close', earlyExit)
        next.once('error', failed)
        next.once('message', message => {
          const readyPort = message?.address?.port, probePort = message?.probePort
          if (message?.type !== 'ready' || message.protocolVersion !== 1 || !Number.isInteger(readyPort)
            || readyPort < 1 || readyPort > 65535 || requestedPort !== 0 && readyPort !== requestedPort
            || probePort !== undefined && (!Number.isInteger(probePort) || probePort < 1 || probePort > 65535)
            || typeof message.assetVersion !== 'string' || !message.assetVersion
            || message.assetVersion !== assetKey)
            return reject(new Error('GATEWAY_START_FAILED'))
          // Beside a serving child the public port may answer from either; only the child's own probe port proves it serves `/`.
          if (overlap && probePort === undefined) return reject(new Error('GATEWAY_PORT_NOT_SHARED'))
          next.wasReady = true
          next.removeListener('close', earlyExit)
          next.removeListener('error', failed)
          clearTimeout(deadline)
          resolve(message)
        })
      })
      await probeModuleReady(() => new Promise((resolve, reject) => {
        const request = get({ host: '127.0.0.1', port: ready.probePort ?? ready.address.port, path: '/', timeout: 30_000 }, response => {
          response.resume()
          response.once('end', () => response.statusCode === 200 ? resolve() : reject(new Error('HTTP_STATUS')))
          response.once('error', reject)
        })
        request.once('timeout', () => request.destroy(new Error('HTTP_TIMEOUT')))
        request.once('error', reject)
      }))
      return { next, root, address: ready.address, assetVersion: ready.assetVersion }
    } catch (error) {
      // A discarded overlap candidate is an intentional stop: the serving child is untouched, so no recovery.
      if (overlap) next.intentional = true
      next.kill('SIGKILL')
      await next.ended
      throw error
    }
  }
  const commit = candidate => {
    candidate.next.candidate = false
    child = candidate.next
    address = candidate.address
    boundPort = address.port
    assetVersions.set(candidate.assetVersion, candidate.root)
    recovery.running()
    return address
  }
  const startAt = async (root, versionId = null) => {
    if (child) throw new Error('GATEWAY_ALREADY_STARTED')
    return commit(await launch(root, versionId, false))
  }
  const stopChild = next => {
    next.intentional = true
    next.stopping ??= (async () => {
      let timedOut = false
      // The gateway owns connections, never the business work behind them.
      const deadline = setTimeout(() => { timedOut = true; next.kill('SIGKILL') }, GATEWAY_DRAIN_TIMEOUT_MS)
      try {
        if (next.connected) await new Promise((resolve, reject) => next.send({ type: 'close' }, error => error ? reject(error) : resolve()))
        else next.kill('SIGTERM')
      } finally { await next.ended; clearTimeout(deadline) }
      if (timedOut) throw new Error('GATEWAY_DRAIN_TIMEOUT')
    })()
    return next.stopping
  }
  const stop = () => child ? stopChild(child) : Promise.resolve()
  const shareAssetVersion = (next, version, root) => new Promise(resolve => {
    if (!next.connected) return resolve(false)
    const done = value => {
      clearTimeout(timer); next.removeListener('message', answered); next.removeListener('close', gone)
      resolve(value)
    }
    const answered = message => { if (message?.type === 'asset-version-ack' && message.version === version) done(!message.error) }
    const gone = () => done(false)
    const timer = setTimeout(() => done(false), GATEWAY_ASSET_SHARE_TIMEOUT_MS)
    next.on('message', answered); next.once('close', gone)
    next.send({ type: 'asset-version', version, root }, error => { if (error) done(false) })
  })
  // 95eef79b: the new child is listening and ready before the old one stops, so the public port is never unanswered.
  // false = the port or the assets could not be shared (a child before 95eef79b); the caller falls back to stop-then-start.
  const exchange = async (release, previousVersion, signal) => {
    const old = child, assetKey = release.versionId ?? Date.now().toString(36)
    // Either child may answer any request while both listen: the old one must resolve the new ?v= assets
    // (the new one gets the old ones through assetCatalog()). No ack = a child that cannot share them.
    if (!await shareAssetVersion(old, assetKey, release.appRoot)) { signal.throwIfAborted(); return false }
    signal.throwIfAborted()
    let candidate
    try { candidate = await launch(release.appRoot, release.versionId, true, assetKey) }
    catch (error) {
      signal.throwIfAborted()
      if (error.message === 'GATEWAY_PORT_NOT_SHARED') return false
      // The old child kept serving throughout: nothing to roll back, adopt or recover.
      if (['READY_TIMEOUT', 'READY_PROBE_FAILED'].includes(error?.code)) throw error
      throw new Error('GATEWAY_REPLACE_ROLLED_BACK', { cause: error })
    }
    // The record the old child was serving under, written back if the candidate dies after the new one is written.
    const restore = adoptionPath ? await readAdoption().catch(() => null)
      ?? { schema: 'bellteam.web-gateway.adoption.v1', currentVersionId: previousVersion, previousVersionId: null } : null
    try {
      signal.throwIfAborted()
      if (adoptionPath) await writeAdoption(adoptionPath, { schema: 'bellteam.web-gateway.adoption.v1',
        currentVersionId: release.versionId, previousVersionId: previousVersion })
      signal.throwIfAborted()
    } catch (error) {
      await stopChild(candidate.next).catch(() => {})
      signal.throwIfAborted()
      throw new Error('GATEWAY_REPLACE_ROLLED_BACK', { cause: error })
    }
    // A candidate that exited during the write must not be committed: the old child would be retired with no listener left.
    // commit() and the old child's close below run with no await between, so this one check covers both.
    const next = candidate.next
    if (next.exitCode !== null || next.signalCode !== null || !live.has(next)) {
      await stopChild(next).catch(() => {})
      const exited = new Error('GATEWAY_START_FAILED')
      if (adoptionPath) {
        try { await writeAdoption(adoptionPath, restore) }
        catch (restoreError) { throw new AggregateError([exited, restoreError], 'GATEWAY_REPLACE_AND_ROLLBACK_FAILED') }
      }
      signal.throwIfAborted()
      throw new Error('GATEWAY_REPLACE_ROLLED_BACK', { cause: exited })
    }
    commit(candidate)
    // The old gateway cannot veto its replacement (Owner 2026-11-08): stopChild always ends it (SIGKILL after the 5 s drain).
    await stopChild(old).catch(() => {})
    return true
  }
  const start = async () => {
    if (closed) throw new Error('GATEWAY_CLOSED')
    if (updating) throw new Error('GATEWAY_UPDATE_IN_PROGRESS')
    const startup = new AbortController()
    updating = startup
    try {
      if (!initialized) {
        const state = await readAdoption()
        startup.signal.throwIfAborted()
        if (state) {
          const release = await prepare(state.currentVersionId ?? 'builtin', startup.signal)
          if (state.previousVersionId) {
            const previous = await prepare(state.previousVersionId, startup.signal)
            assetVersions.set(previous.versionId, previous.appRoot)
          }
          currentRoot = release.appRoot
          currentVersion = release.versionId
        }
        initialized = true
      }
      startup.signal.throwIfAborted()
      await startAt(currentRoot, currentVersion)
      startup.signal.throwIfAborted()
      return address
    } finally { if (updating === startup) updating = null }
  }
  const close = async () => {
    closed = true; recovery.close()
    updating?.abort()
    const failed = (await Promise.allSettled([...live].map(stopChild))).find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  const replace = async versionId => {
    if (updating) throw new Error('GATEWAY_UPDATE_IN_PROGRESS')
    if (!initialized) throw new Error('GATEWAY_NOT_INITIALIZED')
    const update = new AbortController()
    updating = update
    const previousRoot = currentRoot
    const previousVersion = currentVersion
    try {
      const release = await prepare(versionId, update.signal)
      assetCatalog(release.versionId === null ? assetVersions : new Map([...assetVersions, [release.versionId, release.appRoot]]))
      if (release.appRoot === currentRoot) {
        currentVersion = release.versionId
        return { versionId: currentVersion, address }
      }
      if (!(child && await exchange(release, previousVersion, update.signal))) try {
        // Fallback when the port cannot be shared: stop the old gateway, then start the new one (a short no-listener gap).
        // The old gateway cannot veto its replacement (Owner 2026-11-08): stop() always ends it (SIGKILL after the 5 s drain).
        await stop().catch(() => {})
        update.signal.throwIfAborted()
        await startAt(release.appRoot, release.versionId)
        update.signal.throwIfAborted()
        if (adoptionPath) await writeAdoption(adoptionPath, { schema: 'bellteam.web-gateway.adoption.v1',
          currentVersionId: release.versionId, previousVersionId: previousVersion })
      } catch (error) {
        if (update.signal.aborted) throw error
        if (['READY_TIMEOUT', 'READY_PROBE_FAILED'].includes(error?.code)) {
          currentRoot = release.appRoot; currentVersion = release.versionId
          if (adoptionPath) await writeAdoption(adoptionPath, { schema: 'bellteam.web-gateway.adoption.v1', currentVersionId: currentVersion, previousVersionId: previousVersion })
          recovery.lost(error); throw error
        }
        const errors = [error]
        try { await stop() } catch (stopError) { errors.push(stopError) }
        try {
          update.signal.throwIfAborted()
          if (previousVersion) await prepare(previousVersion, update.signal)
          await startAt(previousRoot, previousVersion)
        } catch (rollbackError) { throw new AggregateError([...errors, rollbackError], 'GATEWAY_REPLACE_AND_ROLLBACK_FAILED') }
        if (errors.length > 1) throw new AggregateError(errors, 'GATEWAY_REPLACE_ROLLED_BACK')
        throw new Error('GATEWAY_REPLACE_ROLLED_BACK', { cause: error })
      }
      currentRoot = release.appRoot
      currentVersion = release.versionId
      update.signal.throwIfAborted()
      return { versionId: currentVersion, address }
    } finally { if (updating === update) updating = null }
  }
  return { start, close, replace, get versionId() { return currentVersion },
    get address() { return address }, get pid() { return child?.pid ?? null } }
}
