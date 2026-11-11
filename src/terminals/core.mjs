import { dirname } from 'node:path'
import { createTerminalRegistry, INTERNAL_FIELDS } from './registry.mjs'
import { OS_LABEL } from './paths.mjs'
import { createTerminalConnection } from './connection.mjs'
import { createRemoteTerminalProcesses } from './remote-process.mjs'

const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/

// Molly #767 mount: the parent calls this once; no child, no service.
// native: Elegg's UID1000 remote-terminal processes (credential and trust are Aiterm-held); `adapter` replaces it in tests.
export function createTerminalsCore({ stateRoot, credentials = null, report = null, seatProject = stateRoot && dirname(stateRoot), adapter = null, native: _sharedClient, ...options } = {}) {
  const watchers = new Set()
  const publish = event => { for (const listener of watchers) { try { listener(event) } catch {} } }
  const record = dto => Promise.resolve().then(() => report?.({ module: 'terminals', ...dto })).catch(() => {})
  let remote = adapter
  const native = () => (remote ??= createRemoteTerminalProcesses({ project: seatProject }))

  const registry = createTerminalRegistry({ stateRoot, onChange: event => connection.onRegistryChange(event) })
  const secrets = {
    withResolved(handle, context, consume) {
      if (typeof credentials?.withResolved !== 'function') throw Object.assign(new Error('Credential input unavailable'), { code: 'CREDENTIAL_UNAVAILABLE' })
      return credentials.withResolved(handle, context, consume)
    },
    credential(handle, context) {
      if (typeof credentials?.credential !== 'function') throw Object.assign(new Error('Credential input unavailable'), { code: 'CREDENTIAL_UNAVAILABLE' })
      return credentials.credential(handle, context)
    }
  }
  // Created lazily so a missing Aiterm release only makes targets/checks TERMINAL_UNAVAILABLE.
  const lazyNative = { connect: request => native().connect(request), trust: ref => native().trust(ref), loadCredential: request => native().loadCredential(request),
    provision: request => native().provision(request), authorizeKey: request => native().authorizeKey(request) }
  const connection = createTerminalConnection({ registry, secrets, native: lazyNative, ...options })
  connection.onAvailable(({ terminalId }) => publish({ terminalId, reachable: true, observedAt: new Date().toISOString() }))
  const unwatchCredentials = credentials?.watchCredentials?.(event => {
    if (event?.purpose === 'terminal.login') return void applyLogin(event)
    void applyKey(event).catch(() => {}); connection.onCredentialEvent(event)
  })

  const target = connection.target
  connection.target = async request => {
    try { return await target(request) } catch (error) {
      if (error.code === 'TARGET_MISMATCH') await record({ code: 'TERMINAL_TARGET_MISMATCH', terminalId: request?.terminalId, action: error.action })
      throw error
    }
  }

  // Aiterm's binding: the native key's ref (Owner terminals) or the keyless binding terminals registered for a secret key.
  async function withBindingRef(record, use) {
    if (record.keySource === 'secret' || !record.sshKeyRef) return use(record.bindingRef)
    return secrets.withResolved(record.sshKeyRef, { terminalId: record.terminalId, memberId: null, purpose: 'terminal.ssh' }, value => use(value?.nativeKeyRef))
  }

  async function confirm(record, fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprintPattern.test(fingerprint)) throw Object.assign(new Error('confirmHostKey must be the SHA256: fingerprint the Owner confirmed, for example SHA256: followed by 43 characters'), { code: 'INVALID_TERMINAL', status: 400 })
    try {
      const trust = await withBindingRef(record, ref => native().confirmHostKey(ref, fingerprint))
      if (!trust?.revision) throw new Error()
      return { provider: trust.provider, revision: trust.revision }
    } catch (error) {
      if (error?.code === 'UNREACHABLE' || error?.code === 'REMOTE_AITERM_UNAVAILABLE')
        throw Object.assign(new Error('The host key cannot be checked now; make sure the terminal is awake on the same network and try again'), { code: 'TERMINAL_UNAVAILABLE', status: 503 })
      throw Object.assign(new Error('Host key did not match the confirmed fingerprint'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH', status: 409, ...(error?.action ? { action: error.action } : {}) })
    }
  }

  // First-use trust, like OpenSSH accept-new (Owner ruling 2026-11-11): Aiterm's held trust for the binding wins (a held key is
  // never overwritten, so a changed key still stops); none held -> scan once and let trust-confirm write on Aiterm's equal scan.
  // null = nothing trusted yet (no binding, asleep, Aiterm refused); the next save / key / check tries again.
  async function firstTrust(record) {
    if (!(record.bindingRef || (record.sshKeyRef && record.keySource !== 'secret'))) return null
    const held = await withBindingRef(record, ref => native().trust(ref)).catch(() => undefined)
    if (held?.revision) return { provider: held.provider, revision: held.revision }
    if (held === undefined) return null
    const fingerprint = await Promise.resolve().then(() => native().scanHostKey({ host: record.host, port: record.port ?? 22 })).catch(() => null)
    return fingerprint ? confirm(record, fingerprint).catch(() => null) : null
  }
  const sameTargetAs = record => stored => stored.host === record.host && stored.user === record.user && stored.port === record.port
  async function adoptFirstTrust(terminalId) {
    const record = await registry.target(terminalId)
    if (!record || record.hostTrust) return
    const hostTrust = await firstTrust(record)
    if (hostTrust) await registry.update(terminalId, { hostTrust }, sameTargetAs(record))
  }

  // Every read-then-write on one terminal (put, remove, key request/apply/remove) runs in this per-terminal order,
  // so no snapshot is applied after a later DELETE, replacement or target change. close() joins what is in flight.
  const queues = new Map()
  const inflight = new Set()
  let closing = false
  function serial(terminalId, run) {
    const operation = (queues.get(terminalId) ?? Promise.resolve()).then(run)
    const settled = operation.catch(() => {})
    queues.set(terminalId, settled)
    inflight.add(settled)
    settled.then(() => { inflight.delete(settled); if (queues.get(terminalId) === settled) queues.delete(terminalId) })
    return operation
  }

  async function put({ confirmHostKey, ...input } = {}) {
    const internal = INTERNAL_FIELDS.filter(field => field in input)
    if (internal.length) throw Object.assign(new Error(`${internal.join(', ')} is set by terminals itself; to trust a changed host key pass confirmHostKey, to set a key use the key setting`), { code: 'INVALID_TERMINAL', status: 400 })
    return serial(input.terminalId, () => save(input, confirmHostKey))
  }

  // Internal writes (key setting) may carry the internal fields. Callers hold the terminal's serial slot.
  async function save(input, confirmHostKey) {
    const existing = input.terminalId ? await registry.target(input.terminalId) : null
    // A native key bound by bind_terminal_key replaces a secret key's source.
    if (existing && input.sshKeyRef && !('keySource' in input)) Object.assign(input, { keySource: null, sshKeyRequest: null })
    // A new host/user/port is a new target: its Aiterm binding, trust and pending key requests belong to the old one.
    const targetChanged = existing && ['host', 'user', 'port'].some(field => field in input && input[field] !== existing[field])
    if (targetChanged) {
      if (confirmHostKey !== undefined) throw Object.assign(new Error('Change the target first, set its SSH key again, then confirm the host key of the new target'), { code: 'INVALID_TERMINAL', status: 400 })
      Object.assign(input, { bindingRef: null, hostTrust: null, sshKeyRequest: null, sudoKeyRequest: null })
      // A native key is Aiterm's binding to the old target: not valid for the new one (a card key is, so it stays).
      if (existing.sshKeyRef && existing.keySource !== 'secret' && !('sshKeyRef' in input)) {
        await Promise.resolve(credentials?.unbind?.(existing.sshKeyRef, { terminalId: existing.terminalId, purpose: 'terminal.ssh' })).catch(() => {})
        Object.assign(input, { sshKeyRef: null, keySource: null })
      }
    }
    const next = { ...existing, ...input, terminalId: input.terminalId }
    if (confirmHostKey !== undefined) input.hostTrust = await confirm(next, confirmHostKey)
    else if (!targetChanged && !input.hostTrust && !next.hostTrust) {
      const trust = await firstTrust(next)
      if (trust) input.hostTrust = trust
    }
    if (!existing) return registry.register(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)))
    const { terminalId, ...patch } = input
    return registry.update(terminalId, patch)
  }

  // S2: the Apple app on that Mac attests its own host-key fingerprint; Aiterm trusts it only when its own scan is equal.
  const attest = (terminalId, fingerprint) => serial(terminalId, () => attestNow(terminalId, fingerprint))
  async function attestNow(terminalId, fingerprint) {
    const record = await registry.target(terminalId)
    if (!record) throw keyError('TERMINAL_NOT_FOUND', 404, 'Terminal not found; list_terminals shows the registered terminalIds')
    const sameTarget = stored => stored.host === record.host && stored.user === record.user && stored.port === record.port
    const changed = () => keyError('TERMINAL_CHANGED', 409, 'The terminal changed while its host key was being checked; check it again')
    let bindingRef = record.bindingRef
    // Right after 保存 there is no key yet: trust needs Aiterm's keyless binding for this target. Saved before the scan,
    // so a failed attempt is retried on the same binding and key setting reuses it.
    if (!bindingRef && !(record.sshKeyRef && record.keySource !== 'secret')) {
      bindingRef = await native().register({ host: record.host, user: record.user, port: record.port })
        .catch(() => { throw keyError('TERMINAL_UNAVAILABLE', 503, 'Aiterm could not create the terminal binding; try again later') })
      if (!await registry.update(terminalId, { bindingRef }, sameTarget)) throw changed()
    }
    const hostTrust = await confirm({ ...record, bindingRef }, fingerprint)
    const saved = await registry.update(terminalId, { hostTrust }, sameTarget)
    if (!saved) throw changed()
    return { terminal: saved }
  }

  // Key setting (Trony ruling): Mika's Owner secret card; the value never passes through terminals.
  // label = the secret card heading the Owner reads (Japanese).
  const KINDS = { ssh: { purpose: 'terminal.ssh', ref: 'sshKeyRef', source: 'keySource', request: 'sshKeyRequest', label: 'SSH鍵' },
    sudo: { purpose: 'terminal.sudo', ref: 'sudoKeyRef', source: 'sudoKeySource', request: 'sudoKeyRequest', label: 'sudoパスワード' } }
  const PURPOSES = Object.fromEntries(Object.values(KINDS).map(kind => [kind.purpose, kind]))
  const keyError = (code, status, message) => Object.assign(new Error(message), { code, status })

  async function keyTarget(terminalId, kindName) {
    const kind = Object.hasOwn(KINDS, kindName) ? KINDS[kindName] : null
    if (!kind) throw keyError('INVALID_KEY_KIND', 400, 'Key kind must be ssh or sudo')
    if (typeof credentials?.requestTerminalKey !== 'function') throw keyError('CREDENTIAL_UNAVAILABLE', 503, 'The secret input is not available now; try again later')
    const record = await registry.target(terminalId)
    if (!record) throw keyError('TERMINAL_NOT_FOUND', 404, 'Terminal not found; list_terminals shows the registered terminalIds')
    return { kind, record }
  }

  const requestKey = (terminalId, kindName) => serial(terminalId, () => requestKeyNow(terminalId, kindName))
  async function requestKeyNow(terminalId, kindName) {
    const { kind, record } = await keyTarget(terminalId, kindName)
    const patch = { terminalId }
    // Aiterm needs a binding for target + trust: reuse the native one, else create a keyless binding.
    if (kindName === 'ssh' && !record.bindingRef) {
      patch.bindingRef = record.sshKeyRef && record.keySource !== 'secret'
        ? await withBindingRef(record, ref => ref)
        : await native().register({ host: record.host, user: record.user, port: record.port })
          .catch(() => { throw keyError('TERMINAL_UNAVAILABLE', 503, 'Aiterm could not create the terminal binding; update Aiterm on BellTeam and try again') })
    }
    const { secretRequest } = await credentials.requestTerminalKey({ terminalId, purpose: kind.purpose, label: `端末 ${terminalId} の${kind.label}` })
    // Conditional on the snapshot's target: a target change by another writer (trust rebind) would make this binding wrong.
    const saved = await registry.update(terminalId, { ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'terminalId')), [kind.request]: secretRequest.id },
      stored => stored.host === record.host && stored.user === record.user && stored.port === record.port)
    if (!saved) throw keyError('TERMINAL_CHANGED', 409, 'The terminal changed while the key was being requested; request the key again')
    return { secretRequest }
  }

  // Mika's watchCredentials event after the card is submitted; applied only for the request terminals is waiting for.
  const applyKey = (event = {}) => closing ? Promise.resolve() : serial(event.terminalId, () => applyKeyNow(event))
  async function applyKeyNow({ terminalId, purpose, handle, requestId } = {}) {
    const kind = Object.hasOwn(PURPOSES, purpose) ? PURPOSES[purpose] : null
    if (!kind || typeof handle !== 'string' || typeof requestId !== 'string') return
    const saved = await registry.update(terminalId, { [kind.ref]: handle, [kind.source]: 'secret', [kind.request]: null }, stored => stored[kind.request] === requestId)
      .catch(error => { if (error?.code !== 'TERMINAL_NOT_FOUND') throw error })
    if (saved && kind.purpose === 'terminal.ssh') await adoptFirstTrust(terminalId)
  }

  // S4 (Mika #855): one-time Mac login password -> Aiterm authorize-key. Pending requests and outcomes live in memory only:
  // after a restart Mika's login handles are revoked, so the app simply asks again.
  const logins = new Map() // terminalId -> {requestId, generation}
  const authorizations = new Map() // terminalId -> {requestId, outcome, observedAt}
  const authorizeKey = terminalId => serial(terminalId, async () => {
    if (typeof credentials?.requestTerminalKey !== 'function') throw keyError('CREDENTIAL_UNAVAILABLE', 503, 'The secret input is not available now; try again later')
    const record = await registry.target(terminalId)
    if (!record) throw keyError('TERMINAL_NOT_FOUND', 404, 'Terminal not found; list_terminals shows the registered terminalIds')
    // No password is asked before the host is trusted (secret exposure to the wrong target); exit: 「このMacを確かめる」.
    if (!record.hostTrust) throw Object.assign(keyError('HOST_TRUST_MISSING', 409, 'Confirm this terminal first, then authorize the key'), { action: `先にこの${OS_LABEL[record.os] ?? '端末'}を確かめてください` })
    if (!record.sshKeyRef) throw Object.assign(keyError('SSH_KEY_UNSET', 409, 'Set the SSH key first, then authorize it'), { action: '先にSSH鍵を設定してください' })
    const generation = connection.generation(terminalId)
    const { secretRequest } = await credentials.requestTerminalKey({ terminalId, purpose: 'terminal.login', label: `端末 ${terminalId} の${OS_LABEL[record.os] ?? '端末'}のログインパスワード` })
    logins.set(terminalId, { requestId: secretRequest.id, generation })
    return { secretRequest }
  })
  function applyLogin({ terminalId, handle, requestId, available } = {}) {
    if (closing || typeof handle !== 'string' || available !== true) return
    const pending = logins.get(terminalId)
    const drop = () => Promise.resolve().then(() => credentials?.unbind?.(handle, { terminalId, purpose: 'terminal.login' })).catch(() => {})
    if (!pending || pending.requestId !== requestId || pending.consuming) return void (pending?.requestId !== requestId && drop())
    // Pending stays true until the outcome is recorded, so "pending false" alone means the outcome is readable (Admi).
    pending.consuming = true
    const work = connection.authorize({ terminalId, generation: pending.generation, handle })
      .then(outcome => {
        // Mika revokes the handle on consume; an unconsumed one (stale target) is dropped explicitly.
        if (outcome === 'TERMINAL_CHANGED') void drop()
        // A newer request (new POST) owns the screen now; this outcome is not shown in its place.
        if (logins.get(terminalId) !== pending) return
        authorizations.set(terminalId, { requestId, outcome, observedAt: new Date().toISOString() })
        logins.delete(terminalId)
      })
    inflight.add(work)
    work.finally(() => inflight.delete(work))
  }

  // Restart: an event missed while down is recovered from Mika's current handle.
  async function reconcileKeys() {
    if (typeof credentials?.current !== 'function') return
    for (const item of await registry.list().catch(() => [])) {
      const record = await registry.target(item.terminalId)
      for (const kind of Object.values(KINDS)) {
        if (!record?.[kind.request]) continue
        const current = await Promise.resolve(credentials.current({ terminalId: record.terminalId, purpose: kind.purpose })).catch(() => null)
        if (current?.handle) await applyKey({ terminalId: record.terminalId, purpose: kind.purpose, handle: current.handle, requestId: current.requestId })
      }
    }
  }

  const removeKey = (terminalId, kindName) => serial(terminalId, () => removeKeyNow(terminalId, kindName))
  async function removeKeyNow(terminalId, kindName) {
    const { kind, record } = await keyTarget(terminalId, kindName)
    // Mika: null = explicit scope cancel (pending cards and any raced binding), so a first pending request is cancelled too.
    await credentials.unbind(record[kind.ref] ?? null, { terminalId, purpose: kind.purpose })
    return registry.update(terminalId, { [kind.ref]: null, [kind.source]: null, [kind.request]: null })
  }

  async function check(terminalId) {
    await serial(terminalId, () => adoptFirstTrust(terminalId)).catch(() => {})
    const observation = await connection.check(terminalId)
    publish({ terminalId, reachable: observation.reachable, observedAt: observation.observedAt })
    return observation
  }

  // In-memory observations ride on the projection so existing surfaces show them.
  const withMemory = item => ({ ...item, maintenance: connection.maintenance.last(item.terminalId),
    keyAuthorizationPending: logins.has(item.terminalId), keyAuthorization: structuredClone(authorizations.get(item.terminalId) ?? null) })

  const ready = reconcileKeys().catch(() => {})
  return {
    // C8 outcome rides on the projection so existing surfaces show it (Centi's acceptance reads it there).
    registry: {
      list: async () => (await registry.list()).map(withMemory),
      get: async id => { const item = await registry.get(id); return item && withMemory(item) },
      put, remove: terminalId => serial(terminalId, () => registry.remove(terminalId))
    },
    reachability: { check },
    keys: { request: requestKey, remove: removeKey, authorize: authorizeKey },
    folder: request => connection.folder(request),
    folders: request => connection.folders(request),
    trust: { attest },
    connection,
    maintenance: connection.maintenance,
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener) },
    ready,
    // Joins startup reconciliation and in-flight key work before the caller closes the credential provider.
    async close() {
      closing = true
      unwatchCredentials?.()
      await ready
      while (inflight.size) await Promise.allSettled([...inflight])
      await connection.dispose()
    }
  }
}
