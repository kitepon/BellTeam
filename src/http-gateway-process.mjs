import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { writeAtomic } from './json-file.mjs'

export const GATEWAY_DRAIN_TIMEOUT_MS = 5000
export const GATEWAY_START_TIMEOUT_MS = 15000

export function createHttpGatewayProcess({ socketPath, port, appRoot, prepareRelease, adoptionPath = null }) {
  let child = null, address = null, ending = null
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
        || state.schema !== 'bellteam.web-gateway.adoption.v1' || !versionIdValid(state.currentVersionId)
        || state.previousVersionId !== null && !versionIdValid(state.previousVersionId))
        throw new Error('GATEWAY_ADOPTION_INVALID')
      return state
    } finally { await file.close() }
  }
  const startAt = async (root, versionId = null) => {
    if (child) throw new Error('GATEWAY_ALREADY_STARTED')
    const next = spawn(process.execPath, [join(root, 'src/http-gateway-entry.mjs'), socketPath, String(boundPort), versionId ?? '', assetCatalog()], {
      env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    child = next
    const ended = new Promise(resolve => next.once('close', (code, signal) => {
      if (child === next) { child = null; address = null }
      resolve({ code, signal })
    }))
    ending = ended
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
          next.kill('SIGKILL')
          reject(new Error('GATEWAY_START_TIMEOUT'))
        }, GATEWAY_START_TIMEOUT_MS)
        next.once('close', () => clearTimeout(deadline))
        const earlyExit = () => reject(new Error('GATEWAY_START_FAILED'))
        const failed = error => reject(error)
        next.once('close', earlyExit)
        next.once('error', failed)
        next.once('message', message => {
          if (message?.type !== 'ready' || message.protocolVersion !== 1 || !Number.isInteger(message.address?.port)
            || typeof message.assetVersion !== 'string' || !message.assetVersion
            || versionId !== null && message.assetVersion !== versionId)
            return reject(new Error('GATEWAY_START_FAILED'))
          address = message.address
          boundPort = address.port
          assetVersions.set(message.assetVersion, root)
          next.removeListener('close', earlyExit)
          next.removeListener('error', failed)
          clearTimeout(deadline)
          resolve()
        })
      })
      return address
    } catch (error) {
      next.kill('SIGKILL')
      await ended
      throw error
    }
  }
  let closing = null
  const stop = () => {
    if (!child) return ending ?? Promise.resolve()
    if (!closing) {
      const next = child, ended = ending
      closing = (async () => {
        let timedOut = false
        // The gateway owns connections, never the business work behind them.
        const deadline = setTimeout(() => { timedOut = true; next.kill('SIGKILL') }, GATEWAY_DRAIN_TIMEOUT_MS)
        try {
          if (next.connected) await new Promise((resolve, reject) => next.send({ type: 'close' }, error => error ? reject(error) : resolve()))
          else next.kill('SIGTERM')
        } finally { await ended; clearTimeout(deadline) }
        if (timedOut) throw new Error('GATEWAY_DRAIN_TIMEOUT')
      })().finally(() => { closing = null })
    }
    return closing
  }
  const start = async () => {
    if (updating) throw new Error('GATEWAY_UPDATE_IN_PROGRESS')
    const startup = new AbortController()
    updating = startup
    try {
      if (!initialized) {
        const state = await readAdoption()
        startup.signal.throwIfAborted()
        if (state) {
          const release = await prepare(state.currentVersionId, startup.signal)
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
  const close = () => {
    updating?.abort()
    return stop()
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
      assetCatalog(new Map([...assetVersions, [versionId, release.appRoot]]))
      if (release.appRoot === currentRoot) {
        currentVersion = release.versionId
        return { versionId: currentVersion, address }
      }
      try {
        await stop()
        update.signal.throwIfAborted()
        await startAt(release.appRoot, release.versionId)
        update.signal.throwIfAborted()
        if (adoptionPath) await writeAtomic(adoptionPath, { schema: 'bellteam.web-gateway.adoption.v1',
          currentVersionId: release.versionId, previousVersionId: previousVersion })
      } catch (error) {
        if (update.signal.aborted) throw error
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
