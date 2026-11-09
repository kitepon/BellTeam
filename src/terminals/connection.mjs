import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { accountLoginEnvironment } from '../aiterm-client.mjs'

export const CONNECTION_CODES = ['TERMINAL_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'TARGET_MISMATCH']
const MESSAGES = {
  TERMINAL_UNAVAILABLE: 'Terminal is not reachable now',
  CREDENTIAL_UNAVAILABLE: 'Terminal credential is not available now',
  TARGET_MISMATCH: 'Terminal target does not match its registration'
}
// Elegg's RemoteTerminalError codes (aiterm-mcp remote-terminal.md, b35eb48 + f7022539 correction) -> execution's three codes.
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

export function createTerminalConnection({ registry, secrets, native, seatCredentials = null, loginEnvironment = accountLoginEnvironment, now = () => new Date(), probeDelays = { first: 30_000, max: 300_000 } } = {}) {
  if (!registry?.target || typeof secrets?.withResolved !== 'function' || typeof native?.connect !== 'function') throw new TypeError('Invalid terminal connection configuration')
  const connections = new Map() // connectionRef -> {terminalId, session}
  const wanted = new Map() // terminalId -> probe state
  const maintenance = new Map()
  const listeners = new Set()
  const generations = new Map() // terminalId -> registry-change count; an open started before a change is stale
  const operations = new Set() // whole open/check lifecycles, awaited by dispose
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

  // Aiterm's held known_hosts changed (Owner-confirmed trust-confirm); bind its new revision and let the registry change re-open.
  async function rebindTrust(target, credential) {
    if (typeof native.trust !== 'function' || typeof registry.update !== 'function' || !credential?.nativeKeyRef) return
    try {
      const trust = await native.trust(credential.nativeKeyRef)
      if (trust?.revision && trust.revision !== target.hostTrust.revision) await registry.update(target.terminalId, { hostTrust: { provider: trust.provider, revision: trust.revision } })
    } catch {}
  }

  async function connectTarget(target, memberId, privateEnv, current = () => !disposed) {
    if (!target.hostTrust) throw failure('TARGET_MISMATCH', `confirm the host key of ${target.host}`, 'HOST_TRUST_MISSING')
    let credential = null
    try {
      return await secrets.withResolved(target.sshKeyRef, { terminalId: target.terminalId, memberId, purpose: 'terminal.ssh' }, value => {
        if (!current()) throw failure('TERMINAL_UNAVAILABLE') // disposed or target revised while resolving: start no process
        // Mika's value union: a key value (future) or P1's native-held {nativeKeyRef, revision}; neither is kept after this call.
        credential = typeof value === 'string' ? { privateKey: value } : { nativeKeyRef: value?.nativeKeyRef, credentialRevision: value?.revision }
        return native.connect({
          target: { host: target.host, user: target.user, port: target.port, os: target.os },
          hostTrust: target.hostTrust,
          credential,
          ...(privateEnv ? { privateEnv } : {})
        })
      })
    } catch (error) {
      if (!credential && !CONNECTION_CODES.includes(error?.code)) throw failure('CREDENTIAL_UNAVAILABLE')
      if (error?.code === 'HOST_TRUST_STALE') await rebindTrust(target, credential)
      throw classify(error, target)
    } finally { credential = null }
  }

  async function maintain(terminalId, session) {
    const record = { terminalId, observedAt: now().toISOString(), before: null, after: null, outcome: 'failed' }
    try {
      record.before = (await session.command('claude_version')).version ?? null
      const step = await session.command(record.before ? 'claude_update' : 'claude_install')
      record.after = (await session.command('claude_version')).version ?? null
      if (step.exit_code === 0 && record.after) record.outcome = record.after === record.before ? 'current' : 'updated'
    } catch {}
    maintenance.set(terminalId, record)
  }

  function bind(connectionRef, terminalId, projectRoot, sessionName, session) {
    let maintained = false
    return {
      async callTool(name, args = {}, options) {
        if (!connections.has(connectionRef)) throw failure('TERMINAL_UNAVAILABLE')
        if (name === 'agent_launch') {
          if (args.cwd !== projectRoot || args.session_name !== sessionName) throw failure('TARGET_MISMATCH', 'launch with the member folder and seat bound at open')
          if (args.harness === 'claude-code' && !maintained) { maintained = true; await maintain(terminalId, session) }
        }
        return session.callTool(name, args, options)
      },
      transcript: { read: request => session.transcript.read(request) },
      async wait(waitProcess, options) {
        if (!connections.has(connectionRef)) throw failure('TERMINAL_UNAVAILABLE')
        return session.wait(waitProcess, options)
      }
    }
  }

  // Kiro #765: names -> references only; values are resolved here and travel only in Elegg's privateEnv.
  async function resolvePrivateEnv(credentials = {}, target) {
    const env = {}
    for (const [name, ref] of Object.entries(credentials ?? {})) {
      if (name === 'BELLTEAM_MCP_TOKEN' && seatCredentials?.reveal) {
        const token = await Promise.resolve(seatCredentials.reveal(ref)).catch(() => null)
        if (typeof token !== 'string' || !token) throw failure('CREDENTIAL_UNAVAILABLE')
        env[name] = token
      } else if (name === 'CLAUDE_CODE_OAUTH_TOKEN' && target.accountOwner === 'owner' && ref?.harness === 'claude') {
        // shortcut: parent UID1001 cannot read the seat user's token file; upgrade to a seat-user/native login supply before 2nd-slot acceptance.
        Object.assign(env, await loginEnvironment(ref.slot).catch(() => { throw failure('CREDENTIAL_UNAVAILABLE') }))
      } else throw failure('CREDENTIAL_UNAVAILABLE') // never read the Owner's login for another person's terminal
    }
    return Object.keys(env).length ? env : undefined
  }

  function track(run) {
    const operation = Promise.resolve().then(run)
    operations.add(operation)
    operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }

  const open = request => track(() => openNow(request ?? {}))
  async function openNow({ terminalId, memberId, projectRoot, seatBinding, accountOwner, credentials }) {
    if (disposed) throw failure('TERMINAL_UNAVAILABLE')
    // Generation is captured before the read, so a snapshot read across a registry change is never accepted.
    const generation = generations.get(terminalId) ?? 0
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const target = await registry.target(terminalId).catch(() => null)
    if (!target) { if (typeof terminalId === 'string') want(terminalId); throw failure('TERMINAL_UNAVAILABLE') }
    if (accountOwner !== target.accountOwner) throw failure('TARGET_MISMATCH', `set the account owner of terminal ${terminalId} or the member binding`)
    if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || typeof seatBinding?.sessionName !== 'string' || typeof memberId !== 'string') throw failure('TARGET_MISMATCH', 'set an absolute project folder and seat for the member')
    let session
    // TARGET_MISMATCH exits by registry revision (onRegistryChange), so only availability failures are probed.
    try {
      const privateEnv = await resolvePrivateEnv(credentials, target)
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      session = await connectTarget(target, memberId, privateEnv, current)
    } catch (error) { if (error.code !== 'TARGET_MISMATCH' && current()) want(terminalId); throw error }
    // Registry revision or shutdown while connecting: never publish a connection to the old target.
    if (!current()) { await session.close().catch(() => {}); throw failure('TERMINAL_UNAVAILABLE') }
    const connectionRef = randomUUID()
    connections.set(connectionRef, { terminalId, session })
    session.onEvent?.(event => { if (event?.type === 'lost' && connections.delete(connectionRef)) want(terminalId) })
    return { connectionRef, native: bind(connectionRef, terminalId, projectRoot, seatBinding.sessionName, session) }
  }

  // Tracked like open/check, so dispose also waits for a close already in flight (registry change or caller).
  const close = connectionRef => track(async () => {
    const entry = connections.get(connectionRef)
    if (!entry) return { closed: false }
    connections.delete(connectionRef)
    await entry.session.close()
    return { closed: true }
  })

  const check = terminalId => track(() => checkNow(terminalId))
  async function checkNow(terminalId) {
    const observation = { terminalId, observedAt: now().toISOString(), reachable: false, reason: null }
    if (disposed) return { ...observation, reason: 'TERMINAL_UNAVAILABLE' }
    const target = await registry.target(terminalId).catch(() => null)
    if (!target) return { ...observation, reason: 'TERMINAL_NOT_FOUND' }
    try {
      const session = await connectTarget(target, null)
      await session.close().catch(() => {})
      return { ...observation, reachable: true }
    } catch (error) {
      return { ...observation, reason: error.reason ?? error.code, ...(error.action ? { action: error.action } : {}) }
    }
  }

  // Registry change: the old target revision is stale; close it, then let execution re-open.
  async function onRegistryChange({ terminalId, removed }) {
    generations.set(terminalId, (generations.get(terminalId) ?? 0) + 1)
    for (const [ref, entry] of connections) if (entry.terminalId === terminalId) await close(ref).catch(() => {})
    if (removed) { clearTimeout(wanted.get(terminalId)?.timer); wanted.delete(terminalId); return }
    emitAvailable(terminalId)
  }

  async function onCredentialEvent({ handle, available }) {
    if (!available) return
    for (const terminalId of [...wanted.keys()]) {
      const target = await registry.target(terminalId).catch(() => null)
      if (target?.sshKeyRef === handle) emitAvailable(terminalId)
    }
  }

  return {
    open,
    close,
    check,
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    maintenance: { last: terminalId => structuredClone(maintenance.get(terminalId) ?? null) },
    onRegistryChange,
    onCredentialEvent,
    async dispose() {
      disposed = true
      for (const probe of wanted.values()) clearTimeout(probe.timer)
      wanted.clear()
      while (operations.size) await Promise.allSettled([...operations])
      await Promise.allSettled([...connections.keys()].map(close))
    }
  }
}
