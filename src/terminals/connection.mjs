import { OS_LABEL, childPath, isEntryName, isTerminalPath, parentPath } from './paths.mjs'
import { parseExport } from './trust-copy.mjs'

export const CONNECTION_CODES = ['TERMINAL_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'TARGET_MISMATCH']
const MESSAGES = {
  TERMINAL_UNAVAILABLE: 'Terminal is not reachable now',
  CREDENTIAL_UNAVAILABLE: 'Terminal credential is not available now',
  TARGET_MISMATCH: 'Terminal target does not match its registration'
}
// Elegg's RemoteTerminalError codes (aiterm-mcp remote-terminal.md) -> execution's three codes.
const NATIVE_CODES = {
  HOST_TRUST_MISSING: 'TARGET_MISMATCH', HOST_TRUST_STALE: 'TARGET_MISMATCH', HOST_KEY_MISMATCH: 'TARGET_MISMATCH', HOST_KEY_FINGERPRINT_MISMATCH: 'TARGET_MISMATCH',
  // Elegg 0.70.7/0.70.8: Aiterm probed a platform other than the registered os; exit = the Owner corrects os (registry change).
  TERMINAL_OS_MISMATCH: 'TARGET_MISMATCH',
  CREDENTIAL_UNUSABLE: 'CREDENTIAL_UNAVAILABLE', CREDENTIAL_REVISION_STALE: 'CREDENTIAL_UNAVAILABLE', AUTH_FAILED: 'CREDENTIAL_UNAVAILABLE',
  // aiterm-mcp 0.67.0: a handle key not yet loaded by Mika's credential-load handoff; her availability event is the exit.
  CREDENTIAL_NOT_LOADED: 'CREDENTIAL_UNAVAILABLE', CREDENTIAL_REQUIRED: 'CREDENTIAL_UNAVAILABLE',
  UNREACHABLE: 'TERMINAL_UNAVAILABLE', CONNECTION_REFUSED: 'TERMINAL_UNAVAILABLE', REMOTE_AITERM_UNAVAILABLE: 'TERMINAL_UNAVAILABLE', REMOTE_AITERM_TOO_OLD: 'TERMINAL_UNAVAILABLE', CONNECTION_LOST: 'TERMINAL_UNAVAILABLE'
}

// Evidence, not diagnosis (Elegg): the action names the likely fix without asserting the cause.
// Shown to the Owner as is (Japanese, user rule); AIs read the same text through MCP.
// The text names the terminal's OS and that OS's own step (README "Windows and Linux terminals").
const label = os => OS_LABEL[os] ?? '端末'
const REMOTE_LOGIN = {
  macos: 'Macの「システム設定 > 一般 > 共有」で「リモートログイン」がオンか',
  windows: 'Windowsの「設定 > システム > オプション機能」でOpenSSHサーバーが入っていて、サービスの「OpenSSH SSH Server」が開始しているか',
  linux: 'Linuxにopenssh-serverが入っていて、sshサービスが動いているか'
}
const ACTIONS = {
  CONNECTION_REFUSED: os => `${REMOTE_LOGIN[os] ?? '端末のSSHサーバーが動いているか'}確かめてから、もう一度確かめてください`,
  AUTH_FAILED: os => `この鍵がまだ${label(os)}に入っていないかもしれません。「この${label(os)}にこの鍵を入れる」で、${label(os)}のログインパスワードを使って入れられます`,
  UNREACHABLE: os => `${label(os)}が起きていて、BellTeamと同じネットワークにつながっているか確かめてから、もう一度お試しください`
}
const FOLDER_ACTIONS = {
  FOLDER_MISSING: os => `このフォルダは${label(os)}にありません。作るか、あるフォルダを選んでください`,
  FOLDER_NOT_DIRECTORY: () => 'これはファイルです。フォルダを選んでください',
  FOLDER_NOT_WRITABLE: os => `この${label(os)}のユーザーが書き込めるフォルダを選んでください`,
  FOLDER_NOT_PERMITTED: os => os === 'macos'
    ? 'Macがこのフォルダを開かせてくれません。デスクトップ・書類・ダウンロードの外を選ぶか、リモートログインの「リモートユーザにフルディスクアクセスを許可」をオンにしてください'
    : `この${label(os)}のユーザーではこのフォルダを開けません。ほかのフォルダを選んでください`
}
// The Mac and Windows apps attest (S2) only an untrusted terminal, so a changed key gets the fingerprint step on every OS (Rapi #1019).
const APP_ATTESTS = new Set(['macos', 'windows'])
const trustAction = (target, reason) => APP_ATTESTS.has(target.os) && reason === 'HOST_TRUST_MISSING' ? `${target.host} の${label(target.os)}を確かめてください。その${label(target.os)}でBellTeamアプリを開くと、自動で確かめます`
  : `${target.host} の${label(target.os)}を確かめてください。Webの「端末」でこの端末の指紋を確かめて「この指紋を信用する」を押すと使えます`
// resolveBinding's own reasons: the Owner sets the key, a registry change.
const REGISTRY_REASONS = new Set(['SSH_KEY_UNSET', 'BINDING_UNSET'])
const PROVISION_CODES = new Set(['REMOTE_AITERM_UNAVAILABLE', 'REMOTE_AITERM_TOO_OLD'])
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const REMOTE_ROUTE_MINIMUM = '0.70.113'
const version = value => /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '')?.slice(1).map(Number) ?? null
function atLeast(value, minimum) {
  const a = version(value), b = version(minimum)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}
// The container's Aiterm version seen by the open that made an `aiterm` evidence object; not part of the evidence itself.
const containerVersions = new WeakMap()
const parseVersion = value => /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '')?.slice(1).map(Number)
// Unreadable on either side is not older: an unknown version never starts an install.
const isOlder = (remote, local) => {
  const a = parseVersion(remote), b = parseVersion(local)
  const i = a && b ? a.findIndex((part, k) => part !== b[k]) : -1
  return i >= 0 && a[i] < b[i]
}

// C8 harnesses (Owner via Root 2026-11-10). codex-cli and grok-cli have no Aiterm launch auth preflight (Kiro, 0.70.9).
const CLI_NAMES = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI', 'grok-cli': 'Grok CLI', 'cursor-cli': 'Cursor CLI' }
const NO_LAUNCH_AUTH_CHECK = new Set(['codex-cli', 'grok-cli'])
// Same shape as Aiterm's own launch refusal, so execution queues it like the other three harnesses' preflight (no execution change).
function loginRequired(harness, os) {
  const action = `${label(os)}の${CLI_NAMES[harness]}にログインが必要です。ログインした後に送ったメッセージから起動します`
  const launchRefusal = { schema: 'aiterm.agent-launch-error.v1', harness, code: 'AGENT_AUTH_REQUIRED', phase: 'input', effect: 'not_started', session_created: false, action }
  return Object.assign(new Error(action), { code: 'AGENT_AUTH_REQUIRED', effect: 'not_started', harness, action, launchRefusal })
}

function failure(code, action, reason) {
  return Object.assign(new Error(MESSAGES[code]), { code, effect: 'not_started', ...(reason ? { reason } : {}), ...(action ? { action } : {}) })
}

// Never echo native/secret-side text: keep only classified codes and Elegg's plain action.
function classify(error, target) {
  const reason = NATIVE_CODES[error?.code] ? error.code : undefined
  const code = CONNECTION_CODES.includes(error?.code) ? error.code : NATIVE_CODES[error?.code] ?? 'TERMINAL_UNAVAILABLE'
  const action = code !== 'TARGET_MISMATCH' ? ACTIONS[reason]?.(target.os)
    : reason === 'TERMINAL_OS_MISMATCH' ? `${target.host} は登録したOS（${label(target.os)}）と違うOSでした。Webの「端末」でOSを直してください` : trustAction(target, reason)
  return failure(code, action, reason)
}

// Trony ruling (2026-11-09 16:1x JST): ONE launch path. Execution passes the returned `terminal` + `cwd` to Aiterm's own
// agent_launch; send/wait/transcript go through Aiterm like a local seat. terminals opens a remote process only for
// reachability (open -> close) and C8 upkeep (version/update/install, login for codex/grok), never for a seat.
export function createTerminalConnection({ registry, secrets, native, keyReader = null, now = () => new Date(), probeDelays = { first: 30_000, max: 300_000 } } = {}) {
  if (!registry?.target || typeof secrets?.withResolved !== 'function' || typeof native?.connect !== 'function') throw new TypeError('Invalid terminal connection configuration')
  const wanted = new Map() // terminalId -> probe state
  const maintenance = new Map()
  const upkeep = new Map() // terminalId\0harness -> {generation, run}: in-flight C8 run shared by concurrent launches
  const listeners = new Set()
  const generations = new Map() // terminalId -> registry-change count; a target read across a change is stale
  const operations = new Set() // in-flight target/check runs, awaited by dispose
  const trustCopies = new Map() // terminalId -> in-flight export, shared so two launches never export one terminal twice
  const provisions = new Map() // terminalId -> in-flight provision, shared so two launches never install on one terminal at once
  const lastChecks = new Map() // terminalId -> last current-revision check {reachable, reason, action?, checkedAt}; in memory
  let disposed = false

  // Newest observation wins: a slow check that started earlier never hides a later open (launch, folder, check).
  function note(terminalId, entry) {
    const last = lastChecks.get(terminalId)
    if (!last || last.checkedAt <= entry.checkedAt) lastChecks.set(terminalId, entry)
  }

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
      if (trust?.revision && trust.revision !== target.hostTrust.revision) await registry.update(target.terminalId, { hostTrust: { provider: trust.provider, revision: trust.revision } }, stored => stored.revision === target.revision)
    } catch {}
  }

  // keySource 'terminal-native' (default): Mika's callback gives Aiterm's binding ref + native key revision (public metadata).
  // keySource 'secret': the key stays a Mika handle; Aiterm's UID1000 server resolves it, terminals never sees the value.
  async function resolveBinding(target, memberId) {
    if (!target.sshKeyRef) throw failure('CREDENTIAL_UNAVAILABLE', `端末 ${target.terminalId} のSSH鍵を設定してください`, 'SSH_KEY_UNSET')
    if (!target.hostTrust) throw failure('TARGET_MISMATCH', trustAction(target, 'HOST_TRUST_MISSING'), 'HOST_TRUST_MISSING')
    const context = purpose => ({ terminalId: target.terminalId, memberId, purpose })
    let binding
    if (target.keySource === 'secret') {
      if (!target.bindingRef) throw failure('CREDENTIAL_UNAVAILABLE', `端末 ${target.terminalId} のSSH鍵をもう一度設定してください`, 'BINDING_UNSET')
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

  // keyReader (terminal-keys-via-authmed): an owned secret terminal's key is read and loaded by the 認証仲介 loader, never by this parent;
  // availability is the reader's answer (no Mika source), the revision only a label for Aiterm.
  const mediated = target => target.keySource === 'secret' && keyReader?.owns?.(target.terminalId) === true

  async function handleOf(handle, context) {
    if (context.purpose === 'terminal.ssh' && keyReader?.owns?.(context.terminalId) === true) {
      try { const state = await keyReader.available(context.terminalId); return { handle, revision: state?.revision, available: state?.available === true } } catch { return null }
    }
    try { return await secrets.credential(handle, context) } catch { return null }
  }

  // A handle key must be in Aiterm before its own open (aiterm-mcp 0.67.0 credential-load); execution loads it the same way
  // before a launch. The value exists only inside Mika's callback and goes to Aiterm's stdin.
  async function loadKey(target, binding, current, extra) {
    if (!binding.credential) return
    if (mediated(target)) {
      try { await keyReader.load({ terminalId: target.terminalId, memberId: null, ref: binding.ref, ...binding.credential }) } catch { throw Object.assign(new Error('x'), { code: 'CREDENTIAL_NOT_LOADED' }) }
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      if (extra) extra.agent = { outcome: 'loaded' } // the loader's one run also loaded the per-terminal agent
      return
    }
    // expectedRevision (Mika, as Molly #813 uses it): bytes of a newer revision are never labelled with the target's revision.
    await secrets.withResolved(target.sshKeyRef, { terminalId: target.terminalId, memberId: null, purpose: 'terminal.ssh', expectedRevision: binding.credential.revision },
      async key => {
        if (!current()) throw failure('TERMINAL_UNAVAILABLE') // resolution may have spanned a revision or dispose
        await native.loadCredential({ ref: binding.ref, terminalId: target.terminalId, ...binding.credential, purpose: 'ssh-key', key })
        // a532b4 stage 2: the same bytes to the per-terminal agent, best effort (Aiterm's store stays the live path; the next load retries).
        if (typeof native.loadAgent !== 'function') return
        try { await native.loadAgent({ terminalId: target.terminalId, key }); if (extra) extra.agent = { outcome: 'loaded' } }
        catch (error) { if (extra) extra.agent = { outcome: 'failed', ...(typeof error?.code === 'string' && CODE.test(error.code) ? { reason: error.code } : {}) } }
      })
      .catch(error => { throw error?.code === 'TERMINAL_UNAVAILABLE' ? error : Object.assign(new Error('x'), { code: 'CREDENTIAL_NOT_LOADED' }) })
    if (!current()) throw failure('TERMINAL_UNAVAILABLE')
  }

  function provisionOnce(terminalId, ref) {
    let run = provisions.get(terminalId)
    if (!run) { run = Promise.resolve().then(() => native.provision({ ref })).finally(() => provisions.delete(terminalId)); provisions.set(terminalId, run) }
    return run
  }

  // a532b4 stage 2: copy Aiterm's public host trust once per terminal and registry generation, in the background of the open that saw a
  // revision the copy does not have. Never awaited by a launch, never vetoes it; a failure leaves Aiterm's store live and the next open retries.
  function copyTrustOnce(target, ref, trust) {
    const revision = target.hostTrust?.revision
    if (typeof native.exportBinding !== 'function' || typeof registry.setTrustCopy !== 'function' || !revision) return
    if (target.trustCopy?.ref === ref && target.trustCopy.revision === revision) return void Object.assign(trust, { revision, outcome: 'current' })
    let run = trustCopies.get(target.terminalId)
    if (!run) {
      run = Promise.resolve().then(async () => {
        const copy = parseExport(await native.exportBinding({ ref }), ref, now().toISOString())
        // Aiterm's trust moved between the open and the export: nothing is stored, the next open reads the new revision.
        if (copy.revision !== revision) throw Object.assign(new Error('TRUST_REVISION_CHANGED'), { code: 'TRUST_REVISION_CHANGED' })
        if (!(await registry.setTrustCopy(target.terminalId, copy, target.revision))) throw failure('TERMINAL_UNAVAILABLE')
      }).finally(() => trustCopies.delete(target.terminalId))
      trustCopies.set(target.terminalId, run)
    }
    Object.assign(trust, { revision, outcome: 'copying' })
    run.then(() => Object.assign(trust, { outcome: 'copied' }),
      error => Object.assign(trust, { outcome: 'failed', ...(typeof error?.code === 'string' && CODE.test(error.code) ? { reason: error.code } : {}) }))
  }

  // The conditions that do not depend on a launch: the copy, the key in the agent, the known_hosts file. {fields} or {reason}.
  async function assembleRemote(record, binding) {
    if (typeof native.trustFile !== 'function' || typeof native.agentHeld !== 'function' || typeof native.agentSocket !== 'function') return { reason: 'UNSUPPORTED' }
    const copy = record.trustCopy
    if (!copy || copy.ref !== binding.ref || copy.revision !== record.hostTrust?.revision) return { reason: 'TRUST_COPY_MISSING' }
    if (!binding.credential) return { reason: 'KEY_NOT_IN_AGENT' } // a native key file stays in Aiterm; only a handle key reaches the agent
    let file
    try {
      if (!(await native.agentHeld({ terminalId: record.terminalId }))) return { reason: 'AGENT_EMPTY' }
      file = await native.trustFile({ terminalId: record.terminalId, revision: copy.revision, lines: copy.lines })
    } catch { return { reason: 'TRUST_FILE_FAILED' } }
    return { fields: {
      remote: { host: record.host, user: record.user, port: record.port,
        ssh: { known_hosts_file: file, ...(copy.alias ? { host_key_alias: copy.alias } : {}), identity_agent: native.agentSocket({ terminalId: record.terminalId }), strict_host_key: true } },
      forward: { id: binding.ref, to: { host: '127.0.0.1' } }
    }, revision: `${record.revision}:${copy.revision}` }
  }

  // a532b4 stage 3: for a terminal whose launchInput is 'remote', the generic remote input of Aiterm (remote.ssh + a forward id) beside
  // `terminal`; any unmet condition leaves `terminal` alone (the fallback) and says which in the evidence. Returns the extra target fields.
  async function remoteInput(record, binding, aiterm, evidence) {
    if (record.launchInput !== 'remote') return {}
    const stay = reason => { if (evidence) evidence.input = { outcome: 'terminal', reason }; return {} }
    // Execution's route over the remote input (transcript read over the pinned ssh, the wait, the launch) needs 0.70.113 on the terminal's
    // Aiterm and the container's, for every OS (Kiro's #2429, remote-route.md; Epinel). The surface itself began in 0.70.101.
    const minimum = REMOTE_ROUTE_MINIMUM
    if (!atLeast(aiterm?.before, minimum) || !atLeast(containerVersions.get(aiterm), minimum)) return stay(typeof native.trustFile === 'function' ? 'AITERM_TOO_OLD' : 'UNSUPPORTED')
    const built = await assembleRemote(record, binding)
    if (!built.fields) return stay(built.reason)
    if (evidence) evidence.input = { outcome: 'remote' }
    return built.fields
  }

  // a532b4 stage 5: the pinned-ssh input of the check, C8 and folder commands for a terminal whose maintainInput is 'remote': Aiterm's one-shot
  // CLIs (`aiterm-remote probe|command`, R31) instead of the binding and `serve`. Decided before the connection only (no double attempt on an
  // unreachable terminal): when a condition does not hold the binding path opens as before and the evidence says why. Returns `remote` or null.
  async function maintainRemote(target, binding, extra) {
    if (target.maintainInput !== 'remote' || typeof native.connectRemote !== 'function' || typeof native.containerAitermVersion !== 'function') return null
    const stay = reason => { if (extra) extra.maintain = { outcome: 'binding', reason }; return null }
    if (!atLeast(await native.containerAitermVersion().catch(() => null), REMOTE_ROUTE_MINIMUM)) return stay('AITERM_TOO_OLD')
    const built = await assembleRemote(target, binding)
    if (!built.fields) return stay(built.reason)
    if (extra) extra.maintain = { outcome: 'remote' }
    return built.fields.remote
  }

  // a532b4 stage 3 (Tronie ruling B, 2026-11-23): execution carries `remote` on every later call of a switched seat through one route table, filled
  // at launch and rebuilt from here after a body restart. By terminal id, any time: no launch, no C8, no member. The agent dies with the
  // container, so an empty agent gets the key again first (the same Mika callback as a launch). The Aiterm version gate is not repeated: an
  // existing seat passed it at launch. `revision` changes when the registry or the host trust does (the known_hosts file name carries it).
  async function remoteForNow(terminalId) {
    const generation = generations.get(terminalId) ?? 0
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const record = await registry.target(terminalId).catch(() => null)
    if (!current()) return { reason: 'TERMINAL_UNAVAILABLE' }
    if (!record) return { reason: 'TERMINAL_NOT_FOUND' }
    if (record.launchInput !== 'remote') return { reason: 'NOT_SWITCHED' }
    let binding
    try { binding = await resolveBinding(record, null) } catch (error) { return { reason: typeof error?.code === 'string' && CODE.test(error.code) ? error.code : 'TERMINAL_UNAVAILABLE' } }
    if (!current()) return { reason: 'TERMINAL_UNAVAILABLE' }
    let built = await assembleRemote(record, binding)
    if (built.reason === 'AGENT_EMPTY') {
      try { await loadKey(record, binding, current) } catch { return { reason: 'AGENT_EMPTY' } }
      built = await assembleRemote(record, binding)
    }
    return built.fields ? { ...built.fields, revision: built.revision } : { reason: built.reason }
  }

  // One transient remote process; closed before returning. Classified like a launch would be.
  // `current` is re-checked after every await; a process connected across a registry change or dispose is closed unused.
  // `aiterm` (C8 only): an older terminal Aiterm that opened can launch the seat, so it is brought to the container's version in the
  // background (never awaited: a stalled download must not hold a launch) and this object receives {before, after, outcome, reason?}.
  async function withProcess(target, binding, run, current, aiterm, extra) {
    if (!current()) throw failure('TERMINAL_UNAVAILABLE')
    let session
    try {
      await loadKey(target, binding, current, extra)
      const open = async () => {
        const remote = await maintainRemote(target, binding, extra)
        return remote ? native.connectRemote({ remote }) : native.connect({
          target: { host: target.host, user: target.user, port: target.port, os: target.os },
          hostTrust: target.hostTrust,
          binding
        })
      }
      try { session = await open() } catch (error) {
        // The Mac lacks Aiterm's remote side (or it is too old): provision once over the same trusted, keyed SSH, reopen once.
        if (!PROVISION_CODES.has(error?.code) || typeof native.provision !== 'function') throw error
        if (!current()) throw failure('TERMINAL_UNAVAILABLE')
        try { await provisionOnce(target.terminalId, binding.ref) } catch { throw error }
        if (!current()) throw failure('TERMINAL_UNAVAILABLE')
        session = await open()
      }
      if (aiterm) {
        const before = session.remoteVersion ?? null, local = session.localVersion
        const outcome = !parseVersion(before) || !parseVersion(local) ? 'unknown' : !isOlder(before, local) ? 'current' : typeof native.provision === 'function' ? 'updating' : 'failed'
        Object.assign(aiterm, { before, after: before, outcome })
        containerVersions.set(aiterm, local)
        // A run already going on this terminal is joined, never doubled. The run completes this launch's evidence when it ends.
        if (outcome === 'updating') provisionOnce(target.terminalId, binding.ref).then(
          result => { const after = typeof result?.version === 'string' ? result.version : null; Object.assign(aiterm, { after, outcome: isOlder(after, local) ? 'failed' : 'updated' }) },
          error => { Object.assign(aiterm, { outcome: 'failed', ...(typeof error?.code === 'string' && CODE.test(error.code) ? { reason: error.code } : {}) }) })
      }
      if (aiterm && extra) copyTrustOnce(target, binding.ref, extra.trust ??= {})
      // Any open of the current record is a check: a terminal in use never shows an older failure (Trony 11/13).
      if (current()) note(target.terminalId, { reachable: true, reason: null, checkedAt: now().toISOString() })
    } catch (error) {
      if (error?.code === 'HOST_TRUST_STALE') await rebindTrust(target, binding.ref)
      throw classify(error, target)
    }
    try {
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      return await run(session)
    } finally { await session.close().catch(() => {}) }
  }

  // C8: before a fresh launch of any of the five harnesses. A failed update never vetoes the launch; an unreachable terminal
  // is reported as such. claude-code keeps Aiterm's claude_* aliases (any terminal Aiterm); the others need cli_* (>= 0.70.9).
  async function maintain(target, binding, current, harness) {
    const record = { terminalId: target.terminalId, harness, observedAt: now().toISOString(), before: null, after: null, outcome: 'failed', loggedIn: null }
    const aiterm = {}, extra = {}
    try {
      await withProcess(target, binding, async session => {
        // Each command starts only while current; a stale run stops before its next command (outcome unrecorded).
        const command = name => {
          if (!current()) throw failure('TERMINAL_UNAVAILABLE')
          return harness === 'claude-code' ? session.command(`claude_${name}`) : session.command(`cli_${name}`, { harness })
        }
        try {
          record.before = (await command('version')).version ?? null
          const step = await command(record.before ? 'update' : 'install')
          record.after = (await command('version')).version ?? null
          if (step.exit_code === 0 && record.after) record.outcome = record.after === record.before ? 'current' : 'updated'
        } catch {}
        // Aiterm's launch preflight covers the other three; any error or non-boolean stays null and never vetoes.
        if (NO_LAUNCH_AUTH_CHECK.has(harness)) try { const { logged_in } = await command('auth_status'); if (typeof logged_in === 'boolean') record.loggedIn = logged_in } catch {}
      }, current, aiterm, extra)
    } finally { if (Object.keys(aiterm).length) record.aiterm = aiterm; if (extra.trust && Object.keys(extra.trust).length) record.trust = extra.trust; if (extra.agent) record.agent = extra.agent; if (extra.maintain) record.maintain = extra.maintain; if (current()) maintenance.set(`${target.terminalId}\0${harness}`, record) }
    return record
  }

  function track(run) {
    const operation = Promise.resolve().then(run)
    operations.add(operation)
    operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }

  const target = request => track(() => targetNow(request ?? {}))
  // One run per terminal at a time: overlapping callers share the answer, so two reloads of the agent (delete, then add) never race and
  // a caller never sees AGENT_EMPTY for a moment after a body restart (Epinel, #2426).
  const remoteForRuns = new Map()
  const remoteFor = terminalId => {
    let run = remoteForRuns.get(terminalId)
    if (!run) { run = track(() => remoteForNow(terminalId)).finally(() => remoteForRuns.delete(terminalId)); remoteForRuns.set(terminalId, run) }
    return run
  }
  async function targetNow({ terminalId, memberId, projectRoot, harness }) {
    if (disposed) throw failure('TERMINAL_UNAVAILABLE')
    // Generation is captured before the read, so a snapshot read across a registry change is never handed out.
    const generation = generations.get(terminalId) ?? 0
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const record = await registry.target(terminalId).catch(() => null)
    if (!current()) throw failure('TERMINAL_UNAVAILABLE')
    if (!record) { if (typeof terminalId === 'string') want(terminalId); throw failure('TERMINAL_UNAVAILABLE') }
    if (!isTerminalPath(record.os, projectRoot) || typeof memberId !== 'string') throw failure('TARGET_MISMATCH', record.os === 'windows'
      ? 'メンバーのフォルダを、Windows上の C:\\ のようなドライブで始まる場所で設定してください' : `メンバーのフォルダを、${label(record.os)}上の / で始まる場所で設定してください`)
    // TARGET_MISMATCH exits by registry revision (onRegistryChange), so only availability/credential failures are probed.
    try {
      const binding = await resolveBinding(record, memberId)
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      let inputFields = {}
      if (Object.hasOwn(CLI_NAMES, harness)) {
        // Shared only within one registry generation, so a launch never waits on a run against an older target.
        const key = `${terminalId}\0${harness}`
        let shared = upkeep.get(key)
        if (shared?.generation !== generation) {
          const run = maintain(record, binding, current, harness).finally(() => { if (upkeep.get(key) === shared) upkeep.delete(key) })
          shared = { generation, run }
          upkeep.set(key, shared)
        }
        const result = await shared.run, { loggedIn, aiterm } = result
        if (!current()) throw failure('TERMINAL_UNAVAILABLE')
        if (loggedIn === false) throw loginRequired(harness, record.os)
        inputFields = await remoteInput(record, binding, aiterm, result)
        if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      }
      if (!current()) throw failure('TERMINAL_UNAVAILABLE')
      return {
        terminal: { ref: binding.ref, target: { host: record.host, user: record.user, port: record.port }, trustRevision: record.hostTrust.revision,
          ...(binding.credential ? { credential: binding.credential } : { credentialRevision: binding.credentialRevision }),
          ...(binding.sudoCredential ? { sudoCredential: binding.sudoCredential } : {}) },
        cwd: projectRoot,
        os: record.os,
        accountOwner: record.accountOwner,
        ...inputFields
      }
    } catch (error) { if (error.code !== 'TARGET_MISMATCH' && error.code !== 'AGENT_AUTH_REQUIRED' && current()) want(terminalId); throw error }
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
    let result
    try {
      const binding = await resolveBinding(record, null)
      await withProcess(record, binding, async () => {}, current)
      result = { ...observation, reachable: true }
    } catch (error) {
      result = { ...observation, reason: error.reason ?? error.code, ...(error.action ? { action: error.action } : {}) }
      // A failure the Owner fixes in the registry exits by that change (and its self-check); any other is re-checked by
      // the non-AI observer until it reaches the terminal, so a start-up or sleep failure never stays shown (Trony 11/13).
      if (current() && error.code !== 'TARGET_MISMATCH' && !REGISTRY_REASONS.has(error.reason)) want(terminalId)
    }
    // A check that crossed a registry change describes the old record; only a current one becomes lastCheck.
    if (current()) note(terminalId, { reachable: result.reachable, reason: result.reason, ...(result.action ? { action: result.action } : {}), checkedAt: result.observedAt })
    return result
  }

  // The OS is known only after the registry read: any OS form passes here, onFolder rechecks it against the terminal's os.
  const validPath = path => ['macos', 'windows'].some(os => isTerminalPath(os, path))
  const invalidPath = () => Object.assign(new Error('path must be an absolute folder path on that terminal (/... on Mac/Linux, C:\\... on Windows), without a trailing separator, . or ..'), { code: 'INVALID_PATH', status: 400 })

  // S5: members' folder check on save. Availability is a reason, never a throw, so an unchecked folder can still be saved.
  const folder = request => {
    const { terminalId, path, create = false } = request ?? {}
    if (!validPath(path) || typeof create !== 'boolean') throw invalidPath()
    const observation = { terminalId, path, observedAt: now().toISOString(), exists: null, directory: null, writable: null, reason: null }
    return track(() => onFolder(terminalId, observation, create ? 'make_dir' : 'path_status', { path }, (status, os) => {
      Object.assign(observation, { exists: Boolean(status?.exists), directory: Boolean(status?.directory), writable: Boolean(status?.writable) })
      return !observation.exists ? 'FOLDER_MISSING' : !observation.directory ? 'FOLDER_NOT_DIRECTORY' : !observation.writable ? 'FOLDER_NOT_WRITABLE' : null
    }))
  }

  // S6: the member editor's folder picker. Read only; an unreachable terminal is a reason, never an empty list.
  const folders = request => {
    const { terminalId, path = null } = request ?? {}
    if (path !== null && !validPath(path)) throw invalidPath()
    const observation = { terminalId, observedAt: now().toISOString(), home: null, path, parent: null, entries: [], truncated: false, reason: null }
    return track(() => onFolder(terminalId, observation, 'list_dirs', path === null ? {} : { path }, (listing, os) => {
      if (listing?.exists === false) return 'FOLDER_MISSING'
      if (listing?.directory === false) return 'FOLDER_NOT_DIRECTORY'
      const at = isTerminalPath(os, listing?.path) ? listing.path : null
      if (!at || !Array.isArray(listing.entries)) return 'TERMINAL_UNAVAILABLE'
      const names = listing.entries.map(entry => entry?.name).filter(name => isEntryName(os, name) && !name.startsWith('.'))
      Object.assign(observation, {
        home: isTerminalPath(os, listing.home) ? listing.home : null,
        path: at, parent: parentPath(os, at),
        entries: names.slice(0, 500).map(name => ({ name, path: childPath(os, at, name) })),
        truncated: listing.truncated === true || names.length > 500
      })
      return null
    }))
  }

  async function onFolder(terminalId, observation, op, args, read) {
    let os
    const done = reason => ({ ...observation, reason, ...(FOLDER_ACTIONS[reason] ? { action: FOLDER_ACTIONS[reason](os) } : {}) })
    if (disposed) return done('TERMINAL_UNAVAILABLE')
    const generation = generations.get(terminalId) ?? 0
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const record = await registry.target(terminalId).catch(() => null)
    if (!current()) return done('TERMINAL_UNAVAILABLE')
    if (!record) return done('TERMINAL_NOT_FOUND')
    os = record.os
    if (args.path !== undefined && !isTerminalPath(os, args.path)) throw invalidPath()
    try {
      const binding = await resolveBinding(record, null)
      const result = await withProcess(record, binding, session => {
        if (!current()) throw failure('TERMINAL_UNAVAILABLE')
        return session.command(op, args)
      }, current)
      return done(read(result, os))
    } catch (error) {
      if (error?.code === 'FOLDER_NOT_PERMITTED') return done('FOLDER_NOT_PERMITTED')
      // The terminal was reached but its Aiterm failed the folder command (rabbit 2026-11-11: aiterm-remote-terminal missing, exit 127).
      if (!error?.reason && !CONNECTION_CODES.includes(error?.code) && CODE.test(error?.code ?? ''))
        return { ...observation, reason: error.code, action: `${label(os)}にはつながりましたが、${label(os)}のAitermがフォルダの操作をできませんでした（${error.code}）。${label(os)}のAitermが全部入っているか確かめてください` }
      const reason = error?.reason ?? (CONNECTION_CODES.includes(error?.code) ? error.code : 'TERMINAL_UNAVAILABLE')
      return { ...observation, reason, ...(error?.action ? { action: error.action } : {}) }
    }
  }

  // S4: one-time Mac login password -> Aiterm authorize-key. Returns an outcome code; never throws, never keeps the value.
  const authorize = request => track(() => authorizeNow(request ?? {}))
  async function authorizeNow({ terminalId, generation, handle }) {
    const current = () => !disposed && (generations.get(terminalId) ?? 0) === generation
    const record = await registry.target(terminalId).catch(() => null)
    if (!current() || !record) return 'TERMINAL_CHANGED'
    try {
      const binding = await resolveBinding(record, null)
      await loadKey(record, binding, current)
      if (!current()) return 'TERMINAL_CHANGED'
      const result = await secrets.withResolved(handle, { terminalId, memberId: null, purpose: 'terminal.login' }, password => {
        if (!current()) throw failure('TERMINAL_UNAVAILABLE', undefined, 'TERMINAL_CHANGED')
        if (typeof password !== 'string') throw failure('CREDENTIAL_UNAVAILABLE')
        return native.authorizeKey({ ref: binding.ref, password })
      })
      // Success only from Elegg's receipt for this binding; anything else on exit 0 is not claimed as authorized.
      const valid = result?.schema === 'aiterm.remote-key-authorization.v1' && result.ref === binding.ref && ['AUTHORIZED', 'ALREADY_AUTHORIZED'].includes(result.result)
      return valid ? result.result : 'AUTHORIZATION_UNCONFIRMED'
    } catch (error) {
      const code = error?.reason ?? error?.code
      if (typeof code === 'string' && (/^SECRET_/.test(code) || code === 'CREDENTIAL_NOT_LOADED')) return 'CREDENTIAL_UNAVAILABLE'
      return typeof code === 'string' && CODE.test(code) ? code : 'TERMINAL_UNAVAILABLE'
    }
  }

  // Registry change: targets handed out before it are stale; execution re-targets on the available event.
  function onRegistryChange({ terminalId, removed }) {
    generations.set(terminalId, (generations.get(terminalId) ?? 0) + 1)
    lastChecks.delete(terminalId)
    if (removed) { clearTimeout(wanted.get(terminalId)?.timer); wanted.delete(terminalId); return }
    emitAvailable(terminalId)
  }

  async function onCredentialEvent({ handle, available }) {
    if (!available) return
    for (const terminalId of [...wanted.keys()]) {
      const record = await registry.target(terminalId).catch(() => null)
      // The probe ends with the event, so the key's arrival is checked once to replace the failure on the list.
      if (record?.sshKeyRef === handle) { emitAvailable(terminalId); void check(terminalId) }
    }
  }

  return {
    target,
    remoteFor,
    check,
    folder,
    folders,
    authorize,
    generation: terminalId => generations.get(terminalId) ?? 0,
    // Kiro #765: arms the same observer after Aiterm's launch answered a connectivity code; its exit is the available event.
    observe(terminalId) { if (typeof terminalId === 'string') want(terminalId) },
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    lastCheck: terminalId => structuredClone(lastChecks.get(terminalId) ?? null),
    maintenance: { last: (terminalId, harness = 'claude-code') => structuredClone(maintenance.get(`${terminalId}\0${harness}`) ?? null) },
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
