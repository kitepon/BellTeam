import { createModuleChildRestart, reportModuleChildExit, observeModuleChild } from './module-child-restart.mjs'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeAtomic } from './json-file.mjs'
import { MembersAdmission } from './members-admission.mjs'
import { createMembersParentChannel, waitMembersChildClose, membersError } from './members-ipc.mjs'
import { prepareMembersRelease, assertMembersCatalogRelease } from './members-release.mjs'
import { assertMembersStateCompatibility } from './members/state-compatibility.mjs'

const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = (code, status = 503) => membersError(code, 'not_accepted', status)
const abortable = (promise, signal) => {
  signal?.throwIfAborted()
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
const within = async (promise, milliseconds, code) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(membersError(code)), Math.max(1, milliseconds))
    })])
  } finally { clearTimeout(timer) }
}

export function createMembersProcess({ root, membersAdmission = new MembersAdmission(),
  onEffect, onProjection, onGeneration = () => {}, onDiagnostic, onState = () => {}, authorizeOwner,
  prepareRelease = prepareMembersRelease, exchangeMutex = null }) {
  const adoptionPath = join(root, 'state/members-release.json')
  let instance = null, currentVersionId = null, previousVersionId = null, builtinSourceCommit = null
  let available = false, exchanging = false, phase = 'unavailable', initialized = false, closed = false
  let operation = null, closing = null, update = null, draining = null, cancellation = null
  const recovery = createModuleChildRestart(async () => {
    await operation?.catch(() => {})
    if (closed || instance || !initialized) return
    const perform = async signal => {
      const ticket = membersAdmission.close()
      await membersAdmission.drain(ticket)
      await prepare(currentVersionId, undefined, signal)
      const target = await launch(currentVersionId, ticket, signal)
      try { await resume(target, ticket) }
      catch (error) { await killUnadmitted(target); throw error }
    }
    await exclusive(signal => exchangeMutex ? exchangeMutex.runExclusive(() => perform(signal)) : perform(signal))
  })
  const snapshot = () => ({ currentVersionId, previousVersionId, currentTarget: currentVersionId === null ? 'builtin' : 'release',
    builtinSourceCommit, available, exchanging, phase, generation: membersAdmission.capture().generation, update: update ? { ...update } : null })
  const state = (next, usable = false) => {
    phase = next; available = usable
    if (usable) recovery.running()
    try { onState(snapshot()) } catch {}
  }
  const prepare = async (versionId, expectedRelease, signal) => {
    if (versionId === null) return
    if (!versionValid(versionId)) throw fail('MEMBERS_VERSION_INVALID', 400)
    const descriptor = await abortable(prepareRelease(versionId, { expectedRelease, signal }), signal)
    if (descriptor?.versionId !== versionId || descriptor.appRoot !== `/run/bellteam-maintenance/members/releases/${versionId}/payload`
      || descriptor.protocolVersion !== 1) throw fail('MEMBERS_RELEASE_INVALID')
    assertMembersStateCompatibility(descriptor.stateCompatibility)
    if (expectedRelease) assertMembersCatalogRelease(expectedRelease, descriptor)
  }
  const readAdoption = async () => {
    let file
    try { file = await open(adoptionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4096)
        throw fail('MEMBERS_ADOPTION_INVALID')
      const value = JSON.parse(await file.readFile('utf8'))
      if (!value || Object.keys(value).sort().join(',') !== 'currentVersionId,previousVersionId,schema'
        || value.schema !== 'bellteam.members.adoption.v1'
        || value.currentVersionId !== null && !versionValid(value.currentVersionId)
        || value.previousVersionId !== null && !versionValid(value.previousVersionId)) throw fail('MEMBERS_ADOPTION_INVALID')
      return value
    } finally { await file.close() }
  }
  const killUnadmitted = async target => {
    if (!target || target.ended) return
    // A never-resumed replacement performs read-restore only, with no root/effect admission.
    target.child.kill('SIGKILL'); await target.end
  }
  const launch = async (versionId, ticket, signal) => {
    if (closed || instance) throw fail('MEMBERS_NOT_ACCEPTING')
    const generation = `${versionId ?? 'builtin'}:${randomUUID()}`
    membersAdmission.adopt(ticket, generation)
    onGeneration(generation)
    const child = spawn('/usr/local/libexec/bellteam-members-start', [versionId ?? 'builtin'], {
      env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const target = { child, ended: false, resumed: false, generation,
      channel: createMembersParentChannel(child, { generation, admission: membersAdmission,
        onEffect, onProjection, onDiagnostic, authorizeOwner }) }
    target.stderrCodes = observeModuleChild(child)
    instance = target
    target.end = waitMembersChildClose(child).then(async result => {
      const unexpected = target.resumed && initialized && !closed && !target.intentional
      if (unexpected) { membersAdmission.close(); state('unavailable'); reportModuleChildExit('members', result, target.stderrCodes()) }
      await target.channel.drainIncoming?.()
      target.ended = true; await target.channel.reaped()
      if (instance === target) { instance = null; state(closed ? 'closed' : 'unavailable') }
      if (unexpected) recovery.lost()
    })
    const started = Date.now()
    try {
      await abortable(target.channel.control('initialize', { generation }, 45000), signal)
      const ready = await abortable(within(target.channel.ready, 45000 - (Date.now() - started), 'MEMBERS_READY_TIMEOUT'), signal)
      if (ready.versionId !== versionId) throw fail('MEMBERS_READY_INVALID')
      assertMembersStateCompatibility(ready.stateCompatibility)
      return target
    } catch (error) { await killUnadmitted(target); throw error }
  }
  const resume = async (target, ticket) => {
    if (closed) throw fail('MEMBERS_CLOSED')
    if (target.ended || (await target.channel.control('resume')).resumed !== true) throw fail('MEMBERS_RESUME_FAILED')
    if (closed) throw fail('MEMBERS_CLOSED')
    target.resumed = true
    membersAdmission.resume(ticket)
    exchanging = false; state('running', true)
  }
  const drain = async (target, ticket) => {
    const started = Date.now()
    const completing = membersAdmission.drain(ticket)
    draining = completing
    void completing.finally(() => { if (draining === completing) draining = null }).catch(() => {})
    await within(completing, 60000, 'MEMBERS_DRAIN_TIMEOUT')
    const attempt = target.channel.control('quiesce', {}, Math.max(1, 60000 - (Date.now() - started)))
    draining = attempt.completion
    void attempt.completion.finally(() => { if (draining === attempt.completion) draining = null }).catch(() => {})
    if ((await attempt).quiesced !== true) throw fail('MEMBERS_QUIESCE_FAILED')
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
    if (operation) return Promise.reject(fail('MEMBERS_UPDATE_IN_PROGRESS', 409))
    const controller = new AbortController(); cancellation = controller
    const promise = Promise.resolve().then(() => action(controller.signal)); operation = promise
    void promise.finally(() => { if (operation === promise) { operation = null; cancellation = null } }).catch(() => {})
    return promise
  }
  const start = () => exclusive(async signal => {
    if (closed || initialized) throw fail('MEMBERS_ALREADY_STARTED')
    state('starting')
    const metadata = await open('/app/distribution.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await metadata.stat()
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o22 || info.size > 4096) throw fail('MEMBERS_BUILTIN_IDENTITY_INVALID')
      const value = JSON.parse(await metadata.readFile('utf8'))
      if (value.schema !== 'bellteam.server.distribution.v1' || !/^[a-f0-9]{40}$/.test(value.sourceCommit)) throw fail('MEMBERS_BUILTIN_IDENTITY_INVALID')
      builtinSourceCommit = value.sourceCommit
    } finally { await metadata.close() }
    const record = await readAdoption()
    if (record) {
      await prepare(record.currentVersionId, undefined, signal); await prepare(record.previousVersionId, undefined, signal)
      currentVersionId = record.currentVersionId; previousVersionId = record.previousVersionId
    }
    const ticket = membersAdmission.close()
    try {
      await membersAdmission.drain(ticket)
      const target = await launch(currentVersionId, ticket, signal)
      if (closed) throw fail('MEMBERS_CLOSED')
      await resume(target, ticket); initialized = true
      return snapshot()
    } catch (error) { await killUnadmitted(instance); state('unavailable'); throw error }
  })
  const request = (method, params, options = {}) => {
    if (!instance || !options.membersLease && !options.membersReadPin && (!available || exchanging || closed)) return Promise.reject(fail('MEMBERS_NOT_ACCEPTING'))
    try {
      if (options.membersReadPin) {
        membersAdmission.assertReadPin(options.membersReadPin, { method })
        return instance.channel.request(method, params, options)
      }
      return membersAdmission.withLease(lease => instance.channel.request(method, params, { ...options, membersLease: lease }), { lease: options.membersLease })
    }
    catch (error) { return Promise.reject(error) }
  }
  const callback = (method, params, options = {}) => {
    if (!instance || !options.membersLease) return Promise.reject(fail('MEMBERS_NOT_ACCEPTING'))
    return instance.channel.callback(method, params, options)
  }
  const replace = (requested, { expectedRelease } = {}) => {
    if (requested !== 'builtin' && !versionValid(requested)) return Promise.reject(fail('MEMBERS_VERSION_INVALID', 400))
    if (closed || !initialized || !instance || !available || draining) return Promise.reject(fail('MEMBERS_NOT_ACCEPTING'))
    const versionId = requested === 'builtin' ? null : requested
    const expected = expectedRelease ? structuredClone(expectedRelease) : undefined
    const perform = async signal => {
      await prepare(versionId, expected, signal)
      if (versionId === currentVersionId) return snapshot()
      if (closed) throw fail('MEMBERS_CLOSED')
      const old = instance, oldVersion = currentVersionId, oldPrevious = previousVersionId
      const ticket = membersAdmission.close()
      exchanging = true; state('quiescing')
      try { await drain(old, ticket) }
      catch (error) {
        if (!closed) { try { await resume(old, ticket) } catch { state('unavailable') } }
        throw error
      }
      if (closed) throw fail('MEMBERS_CLOSED')
      // Revalidate the authenticated target immediately before replacing the only writer.
      try { await prepare(versionId, expected, signal) }
      catch (error) { if (!closed) await resume(old, ticket); throw error }
      await finishExit(old)
      if (closed) throw fail('MEMBERS_CLOSED')
      state('starting')
      let committed = false
      try {
        const next = await launch(versionId, ticket, signal)
        await writeAtomic(adoptionPath, { schema: 'bellteam.members.adoption.v1', currentVersionId: versionId, previousVersionId: oldVersion })
        committed = true
        currentVersionId = versionId; previousVersionId = oldVersion
        await resume(next, ticket)
        return snapshot()
      } catch (error) {
        await killUnadmitted(instance)
        if (closed) throw error
        const errors = [error]
        try {
          await prepare(oldVersion, undefined, signal)
          const restored = await launch(oldVersion, ticket, signal)
          if (committed) await writeAtomic(adoptionPath, { schema: 'bellteam.members.adoption.v1', currentVersionId: oldVersion, previousVersionId: oldPrevious })
          currentVersionId = oldVersion; previousVersionId = oldPrevious
          await resume(restored, ticket)
        } catch (rollback) { errors.push(rollback); state('unavailable') }
        throw new AggregateError(errors, errors.length === 1 ? 'MEMBERS_REPLACE_ROLLED_BACK' : 'MEMBERS_REPLACE_AND_ROLLBACK_FAILED')
      } finally { if (phase !== 'running') { exchanging = false; state(phase) } }
    }
    return exclusive(signal => exchangeMutex ? exchangeMutex.runExclusive(() => perform(signal)) : perform(signal))
  }
  const reserve = (versionId, { expectedRelease } = {}) => {
    if (versionId !== 'builtin' && !versionValid(versionId)) throw fail('MEMBERS_VERSION_INVALID', 400)
    if (!available || closed || draining) throw fail('MEMBERS_NOT_ACCEPTING')
    if (operation || update && ['accepted', 'running'].includes(update.status)) throw fail('MEMBERS_UPDATE_IN_PROGRESS', 409)
    const next = { versionId, status: 'accepted' }; update = next
    const options = expectedRelease ? { expectedRelease: structuredClone(expectedRelease) } : undefined
    let settled = false
    return { start() {
      if (settled) return; settled = true
      if (closed) { next.status = 'not_started'; return }
      next.status = 'running'
      void replace(versionId, options).then(() => { next.status = 'succeeded' }, () => { next.status = 'failed'; next.error = 'MEMBERS_UPDATE_FAILED' })
    }, cancel() { if (!settled) { settled = true; next.status = 'not_started' } } }
  }
  const close = () => {
    if (closing) return closing
    closed = true; recovery.close(); available = false; cancellation?.abort()
    if (update?.status === 'accepted') update.status = 'not_started'
    closing = (async () => {
      await operation?.catch(() => {})
      const target = instance
      if (target) {
        const ticket = membersAdmission.close()
        try { await drain(target, ticket); await finishExit(target) }
        catch (error) {
          // An unquiesced writer is not killed; parent loss uses the child's finite drain contract.
          if (target.child.connected) target.child.disconnect()
          await target.end
          exchanging = false; state('closed'); throw error
        }
      }
      exchanging = false; state('closed')
    })()
    return closing
  }
  return { start, close, request, callback, replace, reserve, snapshot, membersAdmission }
}
