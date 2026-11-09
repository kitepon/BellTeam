import { dirname } from 'node:path'
import { createTerminalRegistry, INTERNAL_FIELDS } from './registry.mjs'
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
  const lazyNative = { connect: request => native().connect(request), trust: ref => native().trust(ref) }
  const connection = createTerminalConnection({ registry, secrets, native: lazyNative, ...options })
  connection.onAvailable(({ terminalId }) => publish({ terminalId, reachable: true, observedAt: new Date().toISOString() }))
  const unwatchCredentials = credentials?.watchCredentials?.(event => { void applyKey(event).catch(() => {}); connection.onCredentialEvent(event) })

  const target = connection.target
  connection.target = async request => {
    try { return await target(request) } catch (error) {
      if (error.code === 'TARGET_MISMATCH') await record({ code: 'TERMINAL_TARGET_MISMATCH', terminalId: request?.terminalId, action: error.action })
      throw error
    }
  }

  // Aiterm's binding: the native key's ref (Owner terminals) or the keyless binding terminals registered for a secret key.
  async function withBindingRef(record, use) {
    if (record.keySource === 'secret') return use(record.bindingRef)
    return secrets.withResolved(record.sshKeyRef, { terminalId: record.terminalId, memberId: null, purpose: 'terminal.ssh' }, value => use(value?.nativeKeyRef))
  }

  async function confirm(record, fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprintPattern.test(fingerprint)) throw Object.assign(new Error('confirmHostKey must be the SHA256: fingerprint the Owner confirmed, for example SHA256: followed by 43 characters'), { code: 'INVALID_TERMINAL', status: 400 })
    try {
      const trust = await withBindingRef(record, ref => native().confirmHostKey(ref, fingerprint))
      if (!trust?.revision) throw new Error()
      return { provider: trust.provider, revision: trust.revision }
    } catch (error) {
      throw Object.assign(new Error('Host key did not match the confirmed fingerprint'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH', status: 409, ...(error?.action ? { action: error.action } : {}) })
    }
  }

  async function put({ confirmHostKey, ...input } = {}) {
    const internal = INTERNAL_FIELDS.filter(field => field in input)
    if (internal.length) throw Object.assign(new Error(`${internal.join(', ')} is set by terminals itself; to trust a changed host key pass confirmHostKey, to set a key use the key setting`), { code: 'INVALID_TERMINAL', status: 400 })
    return save(input, confirmHostKey)
  }

  // Internal writes (key setting) may carry the internal fields.
  async function save(input, confirmHostKey) {
    const existing = input.terminalId ? await registry.target(input.terminalId) : null
    // A native key bound by bind_terminal_key replaces a secret key's source.
    if (existing && input.sshKeyRef && !('keySource' in input)) Object.assign(input, { keySource: null, sshKeyRequest: null })
    const next = { ...existing, ...input, terminalId: input.terminalId }
    if (confirmHostKey !== undefined) input.hostTrust = await confirm(next, confirmHostKey)
    // Bind Aiterm's already-held trust (P1 pre-enrolled known_hosts); none held leaves hostTrust missing -> TARGET_MISMATCH until confirmed.
    else if (!input.hostTrust && !existing?.hostTrust && next.sshKeyRef && (next.keySource !== 'secret' || next.bindingRef)) {
      const trust = await withBindingRef(next, ref => native().trust(ref)).catch(() => null)
      if (trust?.revision) input.hostTrust = { provider: trust.provider, revision: trust.revision }
    }
    if (!existing) return registry.register(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)))
    const { terminalId, ...patch } = input
    return registry.update(terminalId, patch)
  }

  // Key setting (Trony ruling): Mika's Owner secret card; the value never passes through terminals.
  const KINDS = { ssh: { purpose: 'terminal.ssh', ref: 'sshKeyRef', source: 'keySource', request: 'sshKeyRequest', label: 'SSH key' },
    sudo: { purpose: 'terminal.sudo', ref: 'sudoKeyRef', source: 'sudoKeySource', request: 'sudoKeyRequest', label: 'sudo password' } }
  const PURPOSES = Object.fromEntries(Object.values(KINDS).map(kind => [kind.purpose, kind]))
  const keyError = (code, status, message) => Object.assign(new Error(message), { code, status })

  async function keyTarget(terminalId, kindName) {
    const kind = KINDS[kindName]
    if (!kind) throw keyError('INVALID_KEY_KIND', 400, 'Key kind must be ssh or sudo')
    if (typeof credentials?.requestTerminalKey !== 'function') throw keyError('CREDENTIAL_UNAVAILABLE', 503, 'The secret input is not available now; try again later')
    const record = await registry.target(terminalId)
    if (!record) throw keyError('TERMINAL_NOT_FOUND', 404, 'Terminal not found; list_terminals shows the registered terminalIds')
    return { kind, record }
  }

  async function requestKey(terminalId, kindName) {
    const { kind, record } = await keyTarget(terminalId, kindName)
    const patch = { terminalId }
    // Aiterm needs a binding for target + trust: reuse the native one, else create a keyless binding.
    if (kindName === 'ssh' && !record.bindingRef) {
      patch.bindingRef = record.sshKeyRef && record.keySource !== 'secret'
        ? await withBindingRef(record, ref => ref)
        : await native().register({ host: record.host, user: record.user, port: record.port })
          .catch(() => { throw keyError('TERMINAL_UNAVAILABLE', 503, 'Aiterm could not create the terminal binding; update Aiterm on BellTeam and try again') })
    }
    const { secretRequest } = await credentials.requestTerminalKey({ terminalId, purpose: kind.purpose, label: `${kind.label} for terminal ${terminalId}` })
    await save({ ...patch, [kind.request]: secretRequest.id })
    return { secretRequest }
  }

  // Mika's watchCredentials event after the card is submitted; applied only while terminals asked for that key.
  async function applyKey({ terminalId, purpose, handle } = {}) {
    const kind = PURPOSES[purpose]
    if (!kind || typeof handle !== 'string') return
    const record = await registry.target(terminalId).catch(() => null)
    if (!record?.[kind.request] || record[kind.ref] === handle) return
    await registry.update(terminalId, { [kind.ref]: handle, [kind.source]: 'secret', [kind.request]: null })
  }

  // Restart: an event missed while down is recovered from Mika's current handle.
  async function reconcileKeys() {
    if (typeof credentials?.current !== 'function') return
    for (const item of await registry.list().catch(() => [])) {
      const record = await registry.target(item.terminalId)
      for (const kind of Object.values(KINDS)) {
        if (!record?.[kind.request]) continue
        const current = await Promise.resolve(credentials.current({ terminalId: record.terminalId, purpose: kind.purpose })).catch(() => null)
        if (current?.handle) await applyKey({ terminalId: record.terminalId, purpose: kind.purpose, handle: current.handle })
      }
    }
  }

  async function removeKey(terminalId, kindName) {
    const { kind, record } = await keyTarget(terminalId, kindName)
    if (record[kind.ref]) await credentials.unbind(record[kind.ref], { terminalId, purpose: kind.purpose })
    return registry.update(terminalId, { [kind.ref]: null, [kind.source]: null, [kind.request]: null })
  }

  async function check(terminalId) {
    const observation = await connection.check(terminalId)
    publish({ terminalId, reachable: observation.reachable, observedAt: observation.observedAt })
    return observation
  }

  return {
    // C8 outcome rides on the projection so existing surfaces show it (Centi's acceptance reads it there).
    registry: {
      list: async () => (await registry.list()).map(item => ({ ...item, maintenance: connection.maintenance.last(item.terminalId) })),
      get: async id => { const item = await registry.get(id); return item && { ...item, maintenance: connection.maintenance.last(id) } },
      put, remove: registry.remove
    },
    reachability: { check },
    keys: { request: requestKey, remove: removeKey },
    connection,
    maintenance: connection.maintenance,
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener) },
    ready: reconcileKeys().catch(() => {}),
    async close() { unwatchCredentials?.(); await connection.dispose() }
  }
}
