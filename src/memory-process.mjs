import { probeModuleReady } from './module-ready-probe.mjs'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSeatProcessRunner } from './seat-process.mjs'
import { createMemoryService } from './memory/factory.mjs'
import { MEMORY_METHODS, assertMemoryStateCompatibility } from './memory/dispatcher.mjs'
import { prepareMemoryRelease } from './memory-release.mjs'
import { writeAtomic } from './json-file.mjs'
import { createModuleChildRestart } from './module-child-restart.mjs'

// Ready probe read: the real search validator rejects an empty query, so a fixed word is required.
export const MEMORY_READY_PROBE = Object.freeze({ args: [Object.freeze({ scope: 'shared', query: 'ready', limit: 1 })], profiles: [] })
const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const failure = (code, outcome = 'not_accepted') => Object.assign(new Error(code), { code, status: 503, outcome })
const within = async (task, code) => {
  let timer
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), 60000) })]) }
  finally { clearTimeout(timer) }
}

// Each generation owns the actual seat children, not merely their returned JSON values.
export function createMemoryProcess({ root, run = createSeatProcessRunner(root, { environment: 'base' }),
  prepareRelease = prepareMemoryRelease, exchangeMutex = null, onState = () => {}, onModuleRestartLimit }) {
  const adoptionPath = join(root, 'state/memory-release.json'), active = new Set()
  const builtinRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  let currentVersionId = null, previousVersionId = null, descriptor = null, generation, available = false
  let phase = 'unavailable', changing = false, closed = false, starting, closing, replacing, reservation = null, update = null
  const recovery = createModuleChildRestart(async () => {
    await replacing?.catch(() => {})
    await Promise.allSettled([...active])
    if (!closed) await startAttempt()
  }, 'memory', onModuleRestartLimit)
  const snapshot = () => ({ currentVersionId, previousVersionId, generation, available, exchanging: changing, phase, update: update ? { ...update } : null })
  const state = (next, usable = false) => {
    phase = next; available = usable
    if (usable) recovery.running()
    else if (next === 'unavailable' && !closed) recovery.lost()
    try { onState(snapshot()) } catch {}
  }
  const record = () => ({ schema: 'bellteam.memory.adoption.v1', currentVersionId, previousVersionId })
  const prepare = async (versionId, expectedRelease) => {
    if (versionId === null) return { versionId: null, appRoot: builtinRoot, protocolVersion: 1 }
    if (!versionValid(versionId)) throw failure('MEMORY_VERSION_INVALID')
    const value = await prepareRelease(versionId, { expectedRelease })
    if (value.versionId !== versionId || value.appRoot !== `/run/bellteam-memory-code/${versionId}/payload` || value.protocolVersion !== 1)
      throw failure('MEMORY_RELEASE_INVALID')
    assertMemoryStateCompatibility(value.stateCompatibility)
    return value
  }
  const execute = (target, epoch, method, params) => {
    const task = (async () => {
    const { stdout } = await run(process.execPath, [join(target.appRoot, 'src/run-memory-runtime.mjs')], {
      input: JSON.stringify({ root, generation: epoch, method, params }),
    })
    let value
    try { value = JSON.parse(stdout) } catch { throw failure('MEMORY_RESULT_UNCONFIRMED', 'unknown') }
    if (!value || value.protocolVersion !== 1 || value.generation !== epoch
      || Object.keys(value).sort().join(',') !== (Object.hasOwn(value, 'error') ? 'error,generation,protocolVersion,stateCompatibility' : 'generation,protocolVersion,result,stateCompatibility'))
      throw failure('MEMORY_RESULT_UNCONFIRMED', 'unknown')
    assertMemoryStateCompatibility(value.stateCompatibility)
    if (value.error) throw Object.assign(new Error(value.error.message), value.error)
    return value.result
    })()
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const restore = async (target, epoch) => {
    recovery.restarting()
    const value = await execute(target, epoch, null, null)
    if (!value || Object.keys(value).join(',') !== 'restored' || value.restored !== true) throw failure('MEMORY_RESTORE_INVALID')
    await probeModuleReady(() => execute(target, epoch, 'recallMemory', structuredClone(MEMORY_READY_PROBE)))
  }
  const readAdoption = async () => {
    let file
    try { file = await open(adoptionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    try {
      const st = await file.stat()
      if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600 || st.size > 4096)
        throw failure('MEMORY_ADOPTION_INVALID')
      const value = JSON.parse(await file.readFile('utf8'))
      if (!value || Object.keys(value).sort().join(',') !== 'currentVersionId,previousVersionId,schema'
        || value.schema !== 'bellteam.memory.adoption.v1'
        || [value.currentVersionId, value.previousVersionId].some(id => id !== null && !versionValid(id))) throw failure('MEMORY_ADOPTION_INVALID')
      currentVersionId = value.currentVersionId; previousVersionId = value.previousVersionId
    } finally { await file.close() }
  }
  const startAttempt = () => {
    if (closed) return Promise.reject(failure('MEMORY_CLOSED'))
    if (available || changing) return Promise.resolve(snapshot())
    return starting ??= (async () => {
    try {
    if (closed) throw failure('MEMORY_CLOSED')
    currentVersionId = null; previousVersionId = null
    await readAdoption(); descriptor = await prepare(currentVersionId); generation = randomUUID()
    await restore(descriptor, generation)
    if (closed) throw failure('MEMORY_CLOSED')
    state('running', true); return snapshot()
    } catch (error) { state(closed ? 'closed' : 'unavailable'); throw error }
    })().finally(() => { starting = null })
  }
  const start = () => available ? Promise.resolve(snapshot()) : startAttempt().catch(error => {
    if (closed || phase !== 'unavailable') throw error
    return recovery.wait().then(() => { if (closed) throw error; return snapshot() })
  })
  const request = async (method, params) => {
    await start()
    if (!closed && MEMORY_METHODS.includes(method) && (!available || changing)) return recovery.hold(() => request(method, params), () => failure('MEMORY_NOT_ACCEPTED'))
    if (!available || changing || closed || !MEMORY_METHODS.includes(method)) throw failure('MEMORY_NOT_ACCEPTED')
    return execute(descriptor, generation, method, params)
  }
  const replace = async (requested, { expectedRelease } = {}) => {
    await start()
    if (changing || reservation || closed || !available) throw failure('MEMORY_NOT_ACCEPTED')
    const versionId = requested === 'builtin' ? null : requested
    if (versionId !== null && !versionValid(versionId)) throw failure('MEMORY_VERSION_INVALID')
    if (versionId === currentVersionId) return snapshot()
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    changing = true; update = { versionId: requested, status: 'running' }; state('preparing', true)
    const perform = async () => {
      const old = record(), oldDescriptor = descriptor, oldGeneration = generation
      let saving = false
      try {
        await prepare(versionId, expected)
        if (closed) throw failure('MEMORY_CLOSED')
        state('draining')
        await within(Promise.allSettled([...active]), 'MEMORY_BUSY')
        if (closed) throw failure('MEMORY_CLOSED')
        const next = await prepare(versionId, expected), nextGeneration = randomUUID()
        state('restoring'); await restore(next, nextGeneration)
        if (closed) throw failure('MEMORY_CLOSED')
        saving = true
        await writeAtomic(adoptionPath, { schema: 'bellteam.memory.adoption.v1', currentVersionId: versionId, previousVersionId: currentVersionId })
        if (closed) throw failure('MEMORY_CLOSED')
        previousVersionId = currentVersionId; currentVersionId = versionId; descriptor = next; generation = nextGeneration
        update = { versionId: requested, status: 'succeeded' }; state('running', true)
        return snapshot()
      } catch (error) {
        if (['READY_TIMEOUT', 'READY_PROBE_FAILED'].includes(error?.code)) {
          await writeAtomic(adoptionPath, { schema: 'bellteam.memory.adoption.v1', currentVersionId: versionId, previousVersionId: old.currentVersionId })
          descriptor = null; state('unavailable'); recovery.lost(error); throw error
        }
        if (saving) {
          try { await writeAtomic(adoptionPath, old) }
          catch (rollback) { state('unavailable'); throw new AggregateError([error, rollback], 'MEMORY_ADOPTION_UNCONFIRMED') }
        }
        descriptor = oldDescriptor; generation = oldGeneration
        update = { versionId: requested, status: 'failed', error: error.code === 'MEMORY_BUSY' ? 'MEMORY_BUSY' : 'MEMORY_UPDATE_FAILED' }
        state(closed ? 'closed' : 'running', !closed)
        throw error
      }
    }
    try { replacing = Promise.resolve().then(() => exchangeMutex ? exchangeMutex.runExclusive(perform) : perform()); return await replacing }
    finally { changing = false; if (available) recovery.running() }
  }
  const reserve = (requested, options = {}) => {
    if (requested !== 'builtin' && !versionValid(requested)) throw failure('MEMORY_VERSION_INVALID')
    if (!available || changing || reservation || closed) throw failure('MEMORY_NOT_ACCEPTED')
    const ticket = {}; reservation = ticket
    const next = { versionId: requested, status: 'accepted' }; update = next
    const expected = options.expectedRelease ? { expectedRelease: structuredClone(options.expectedRelease) } : undefined
    let settled = false
    return { start() {
      if (settled) return; settled = true; reservation = null
      if (closed) { next.status = 'not_started'; return }
      next.status = 'running'; state(phase, available)
      void replace(requested, expected).then(() => { next.status = 'succeeded'; state(phase, available) }, () => { next.status = 'failed'; state(phase, available) })
    }, cancel() { if (!settled) { settled = true; if (reservation === ticket) reservation = null; next.status = 'not_started'; state(phase, available) } } }
  }
  return { start, request, replace, reserve, snapshot,
    memory: registry => createMemoryService({ registry, dispatch: request }),
    close: () => closing ??= (async () => {
      closed = true; recovery.close(); state('closing')
      if (update?.status === 'accepted') update.status = 'not_started'
      await starting?.catch(() => {})
      await replacing?.catch(() => {})
      await Promise.allSettled([...active]); state('closed')
    })(),
  }
}
