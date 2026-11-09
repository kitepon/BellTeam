import { dirname } from 'node:path'
import { createTerminalRegistry } from './registry.mjs'
import { createTerminalConnection } from './connection.mjs'
import { createRemoteTerminalProcesses } from './remote-process.mjs'

const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/

// Molly #767 mount: the parent calls this once; no child, no service.
// native: Elegg's UID1000 remote-terminal processes (credential and trust are Aiterm-held); `adapter` replaces it in tests.
export function createTerminalsCore({ stateRoot, credentials = null, seatCredentials = null, report = null, seatProject = stateRoot && dirname(stateRoot), adapter = null, native: _sharedClient, ...options } = {}) {
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
    }
  }
  // Created lazily so a missing Aiterm release only makes opens TERMINAL_UNAVAILABLE.
  const lazyNative = { connect: request => native().connect(request), trust: ref => native().trust(ref) }
  const connection = createTerminalConnection({ registry, secrets, native: lazyNative, seatCredentials, ...options })
  connection.onAvailable(({ terminalId }) => publish({ terminalId, reachable: true, observedAt: new Date().toISOString() }))
  const unwatchCredentials = credentials?.watchCredentials?.(event => connection.onCredentialEvent(event))

  const open = connection.open
  connection.open = async request => {
    try { return await open(request) } catch (error) {
      if (error.code === 'TARGET_MISMATCH') await record({ code: 'TERMINAL_TARGET_MISMATCH', terminalId: request?.terminalId, action: error.action })
      throw error
    }
  }

  async function confirm(terminalId, sshKeyRef, fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprintPattern.test(fingerprint)) throw Object.assign(new Error('Invalid host key fingerprint'), { code: 'INVALID_TERMINAL', status: 400 })
    try {
      const trust = await secrets.withResolved(sshKeyRef, { terminalId, memberId: null, purpose: 'terminal.ssh' }, value => native().confirmHostKey(value?.nativeKeyRef, fingerprint))
      if (!trust?.revision) throw new Error()
      return { provider: trust.provider, revision: trust.revision }
    } catch (error) {
      throw Object.assign(new Error('Host key did not match the confirmed fingerprint'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH', status: 409, ...(error?.action ? { action: error.action } : {}) })
    }
  }

  async function put({ confirmHostKey, ...input } = {}) {
    const existing = input.terminalId ? await registry.target(input.terminalId) : null
    const sshKeyRef = input.sshKeyRef ?? existing?.sshKeyRef
    if (confirmHostKey !== undefined) input.hostTrust = await confirm(input.terminalId, sshKeyRef, confirmHostKey)
    // Bind Aiterm's already-held trust (P1 pre-enrolled known_hosts); none held leaves hostTrust missing -> TARGET_MISMATCH until confirmed.
    else if (!input.hostTrust && !existing?.hostTrust && sshKeyRef) {
      const trust = await secrets.withResolved(sshKeyRef, { terminalId: input.terminalId, memberId: null, purpose: 'terminal.ssh' }, value => native().trust(value?.nativeKeyRef)).catch(() => null)
      if (trust?.revision) input.hostTrust = { provider: trust.provider, revision: trust.revision }
    }
    if (!existing) return registry.register(input)
    const { terminalId, ...patch } = input
    return registry.update(terminalId, patch)
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
    connection,
    maintenance: connection.maintenance,
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener) },
    close() { unwatchCredentials?.(); connection.dispose() }
  }
}
