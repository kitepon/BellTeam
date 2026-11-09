import { isAbsolute } from 'node:path'

export const CONNECTION_CODES = ['TERMINAL_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'TARGET_MISMATCH']
const MESSAGES = {
  TERMINAL_UNAVAILABLE: 'Terminal is not reachable now',
  CREDENTIAL_UNAVAILABLE: 'Terminal credential is not available now',
  TARGET_MISMATCH: 'Terminal target does not match its registration'
}
// Elegg's RemoteTerminalError codes (aiterm-mcp remote-terminal.md) -> execution's three codes.
const NATIVE_CODES = {
  HOST_TRUST_MISSING: 'TARGET_MISMATCH', HOST_TRUST_STALE: 'TARGET_MISMATCH', HOST_KEY_MISMATCH: 'TARGET_MISMATCH', HOST_KEY_FINGERPRINT_MISMATCH: 'TARGET_MISMATCH',
  CREDENTIAL_UNUSABLE: 'CREDENTIAL_UNAVAILABLE', CREDENTIAL_REVISION_STALE: 'CREDENTIAL_UNAVAILABLE', AUTH_FAILED: 'CREDENTIAL_UNAVAILABLE',
  UNREACHABLE: 'TERMINAL_UNAVAILABLE', REMOTE_AITERM_UNAVAILABLE: 'TERMINAL_UNAVAILABLE', REMOTE_AITERM_TOO_OLD: 'TERMINAL_UNAVAILABLE', CONNECTION_LOST: 'TERMINAL_UNAVAILABLE'
}

function failure(code, action, reason) {
  return Object.assign(new Error(MESSAGES[code]), { code, effect: 'not_started', ...(reason ? { reason } : {}), ...(action ? { action } : {}) })
}

// Never echo native/secret-side text: keep only classified codes and Elegg's plain action.
function classify(error, target) {
  const reason = NATIVE_CODES[error?.code] ? error.code : undefined
  const code = CONNECTION_CODES.includes(error?.code) ? error.code : NATIVE_CODES[error?.code] ?? 'TERMINAL_UNAVAILABLE'
  const action = code !== 'TARGET_MISMATCH' ? undefined
    : typeof error?.action === 'string' ? `${error.action} on ${target.host}`
    : `confirm the host key of ${target.host}`
  return failure(code, action, reason)
}

// Trony ruling (2026-11-09 16:1x JST): ONE launch path. Execution passes the returned `terminal` + `cwd` to Aiterm's own
// agent_launch; send/wait/transcript go through Aiterm like a local seat. terminals opens a remote process only for
// reachability (open -> close) and C8 upkeep (claude_* commands), never for a seat.
export function createTerminalConnection({ registry, secrets, native, now = () => new Date(), probeDelays = { first: 30_000, max: 300_000 } } = {}) {
  if (!registry?.target || typeof secrets?.withResolved !== 'function' || typeof native?.connect !== 'function') throw new TypeError('Invalid terminal connection configuration')
  const wanted = new Map() // terminalId -> probe state
  const maintenance = new Map()
  const upkeep = new Map() // terminalId -> {generation, run}: in-flight C8 run shared by concurrent launches
  const listeners = new Set()
  const generations = new Map() // terminalId -> registry-change count; a target read across a change is stale
  const operations = new Set() // in-flight target/check runs, awaited by dispose
  let disposed = false

  function emitAvailable(terminalId) {
    clearTimeout(wanted.get(terminalId)?.timer)
    wanted.delete(terminalId)
    for (const listener of listeners) { try { listener({ terminalId }) } catch {} }
  }

  function want(terminalId) {
    if (disposed || wanted.has(terminalId)) return
    const probe = { delay: probeDelays.first, timer: null }
    wanted.set(terminalId, probe)
    const schedule = () => {
      probe.timer = setTimeout(async () => {
        if (wanted.get(terminalId) !== probe) return
        const observation = await check(terminalId)
        if (wanted.get(terminalId) !== probe) return
        if (observation.reason === 'TERMINAL_NOT_FOUND') return void wanted.delete(terminalId)
        if (observation.reachable) return emitAvailable(terminalId)
        probe.delay = Math.min(probe.delay * 2, probeDelays.max)
        schedule()
      }, probe.delay)
      probe.timer.unref?.()
    }
    schedule()
  }

  // Aiterm's held known_hosts changed (Owner-confirmed trust-confirm); bind its new revision so the registry change re-targets.
  async function rebindTrust(target, ref) {
    if (typeof native.trust !== 'function' || typeof registry.update !== 'function' || !ref) return
    try {
      const trust = await native.trust(ref)
      if (trust?.revision && trust.revision !== target.hostTrust.revision) await registry.update(target.terminalId, { hostTrust: { provider: trust.provider, revision: trust.revision } })
    } catch {}
  }

  // keySource 'terminal-native' (default): Mika's callback gives Aiterm's binding ref + native key revision (public metadata).
  // keySource 'secret': the key stays a Mika handle; Aiterm's UID1000 server resolves it, terminals never sees the value.
  async function resolveBinding(target, memberId) {
    if (!target.sshKeyRef) throw failure('CREDENTIAL_UNAVAILABLE', `set the SSH key of terminal ${target.terminalId}`, 'SSH_KEY_UNSET')
    if (!target.hostTrust) throw failure('TARGET_MISMATCH', `confirm the host key of ${target.host}`, 'HOST_TRUST_MISSING')
    const context = purpose => ({ terminalId: target.terminalId, memberId, purpose })
    let binding
    if (target.keySource === 'secret') {
      if (!target.bindingRef) throw failure('CREDENTIAL_UNAVAILABLE', `set the SSH key of terminal ${target.terminalId} again`, 'BINDING_UNSET')
      const credential = await handleOf(target.sshKeyRef, context('terminal.ssh'))
      if (!credential?.available) throw failure('CREDENTIAL_UNAVAILABLE')
      binding = { ref: target.bindingRef, credential: { handle: credential.handle, revision: credential.revision } }
    } else {
      try {
        binding = await secrets.withResolved(target.sshKeyRef, context('terminal.ssh'),
          value => (typeof value === 'string' ? null : { ref: value?.nativeKeyRef, credentialRevision: value?.revision }))
      } catch { throw failure('CREDENTIAL_UNAVAILABLE') }
      if (typeof binding?.ref !== 'string' || !binding.ref) throw failure('CREDENTIAL_UNAVAILABLE')
    }
    // Optional sudo never gates an ordinary launch: an unavailable sudo key is simply not offered.
    const sudo = target.sudoKeyRef ? await handleOf(target.sudoKeyRef, context('terminal.sudo')) : null
    if (sudo?.available) binding.sudoCredential = { handle: sudo.handle, revision: sudo.revision }
    return binding
  }

  async function handleOf(handle, context) {
    try { return await secrets.credential(handle, context) } catch { return null }
  }

  // One transient remote process; closed before returning. Classified like a launch would be.
  // `current` is re-checked after every await; a process connected across a registry change or dispose is closed unused.
  async function withProcess(target, binding, run, current) {
    if (!current()) throw failure('TERMINAL_UNAVAILABLE')
    let session
    try {
      session = await native.connect({
        target: { host: target.host, user: target.user, port: target.port, os: target.os },
        hostTrust: target.hostTrust,
        binding
      })
    } catch (error) {
      if (error?.code === 'HOST_TRUST_STALE') await rebindTrust(target, binding.ref)
      throw classify(error, target)
    }
    try {
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      return await run(session)
    } finally { await session.close().catch(() => {}) }
  }

  // C8: before a fresh Claude Code launch. A failed update never vetoes the launch; an unreachable terminal is reported as such.
  async function maintain(target, binding, current) {
    const record = { terminalId: target.terminalId, observedAt: now().toISOString(), before: null, after: null, outcome: 'failed' }
    try {
      await withProcess(target, binding, async session => {
        // Each command starts only while current; a stale run stops before its next command (outcome unrecorded).
        const command = op => { if (!current()) throw failure('TERMINAL_UNAVAILABLE'); return session.command(op) }
        try {
          record.before = (await command('claude_version')).version ?? null
          const step = await command(record.before ? 'claude_update' : 'claude_install')
          record.after = (await command('claude_version')).version ?? null
          if (step.exit_code === 0 && record.after) record.outcome = record.after === record.before ? 'current' : 'updated'
        } catch {}
      }, current)
    } finally { if (current()) maintenance.set(target.terminalId, record) }
  }

  function track(run) {
    const operation = Promise.resolve().then(run)
    operations.add(operation)
    operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }

  const target = request => track(() => targetNow(request ?? {}))
  async function targetNow({ terminalId, memberId, projectRoot, harness }) {
    if (disposed) throw failure('TERMINAL_UNAVAILABLE')
    // Generation is captured before the read, so a snapshot read across a registry change is never handed out.
    const generation = generations.get(terminalId) ?? 0
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const record = await registry.target(terminalId).catch(() => null)
    if (!current()) throw failure('TERMINAL_UNAVAILABLE')
    if (!record) { if (typeof terminalId === 'string') want(terminalId); throw failure('TERMINAL_UNAVAILABLE') }
    if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || typeof memberId !== 'string') throw failure('TARGET_MISMATCH', 'set an absolute project folder for the member')
    // TARGET_MISMATCH exits by registry revision (onRegistryChange), so only availability/credential failures are probed.
    try {
      const binding = await resolveBinding(record, memberId)
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      if (harness === 'claude-code') {
        // Shared only within one registry generation, so a launch never waits on a run against an older target.
        let shared = upkeep.get(terminalId)
        if (shared?.generation !== generation) {
          const run = maintain(record, binding, current).finally(() => { if (upkeep.get(terminalId) === shared) upkeep.delete(terminalId) })
          shared = { generation, run }
          upkeep.set(terminalId, shared)
        }
        await shared.run
      }
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      return {
        terminal: { ref: binding.ref, target: { host: record.host, user: record.user, port: record.port }, trustRevision: record.hostTrust.revision,
          ...(binding.credential ? { credential: binding.credential } : { credentialRevision: binding.credentialRevision }),
          ...(binding.sudoCredential ? { sudoCredential: binding.sudoCredential } : {}) },
        cwd: projectRoot,
        accountOwner: record.accountOwner
      }
    } catch (error) { if (error.code !== 'TARGET_MISMATCH' && current()) want(terminalId); throw error }
  }

  const check = terminalId => track(() => checkNow(terminalId))
  async function checkNow(terminalId) {
    const observation = { terminalId, observedAt: now().toISOString(), reachable: false, reason: null }
    if (disposed) return { ...observation, reason: 'TERMINAL_UNAVAILABLE' }
    const generation = generations.get(terminalId) ?? 0
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const record = await registry.target(terminalId).catch(() => null)
    if (!current()) return { ...observation, reason: 'TERMINAL_UNAVAILABLE' }
    if (!record) return { ...observation, reason: 'TERMINAL_NOT_FOUND' }
    try {
      const binding = await resolveBinding(record, null)
      await withProcess(record, binding, async () => {}, current)
      return { ...observation, reachable: true }
    } catch (error) {
      return { ...observation, reason: error.reason ?? error.code, ...(error.action ? { action: error.action } : {}) }
    }
  }

  // Registry change: targets handed out before it are stale; execution re-targets on the available event.
  function onRegistryChange({ terminalId, removed }) {
    generations.set(terminalId, (generations.get(terminalId) ?? 0) + 1)
    if (removed) { clearTimeout(wanted.get(terminalId)?.timer); wanted.delete(terminalId); return }
    emitAvailable(terminalId)
  }

  async function onCredentialEvent({ handle, available }) {
    if (!available) return
    for (const terminalId of [...wanted.keys()]) {
      const record = await registry.target(terminalId).catch(() => null)
      if (record?.sshKeyRef === handle) emitAvailable(terminalId)
    }
  }

  return {
    target,
    check,
    // Kiro #765: arms the same observer after Aiterm's launch answered a connectivity code; its exit is the available event.
    observe(terminalId) { if (typeof terminalId === 'string') want(terminalId) },
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    maintenance: { last: terminalId => structuredClone(maintenance.get(terminalId) ?? null) },
    onRegistryChange,
    onCredentialEvent,
    async dispose() {
      disposed = true
      for (const probe of wanted.values()) clearTimeout(probe.timer)
      wanted.clear()
      while (operations.size) await Promise.allSettled([...operations])
    }
  }
}
