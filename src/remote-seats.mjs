// Remote seats (docs/architecture/modules/execution/remote-seat.md, Owner ruling 2026-11-09: ONE launch path). A Bot whose
// member record names a terminal launches through the same Aiterm agent_launch with terminals' target and its projectRoot;
// every later call is the same session call as a local seat. This module only adds the launch inputs, the asleep-terminal
// queue edge, the seat credential and C7 (Throughline) for the transcript that stays on the terminal.
import { authenticationPreflightCodes, authenticationPreflightFailure, launchRefusal } from './agent-launch-error.mjs'
import { mcpRequestContext } from './mcp-request-context.mjs'
import { RemoteRoutes } from './remote-route.mjs'
import * as botEnvironment from './bot-environment.mjs'

// SEC-111: a terminal seat commits as the same noreply identity as a container seat (env beats `git -c user.email`).
// shortcut: a body without BOT_GIT_IDENTITY (older than #2607) gives {} and the seat keeps its old behaviour; drop the guard once every body has it.
const gitIdentityEnv = () => {
  const id = botEnvironment.BOT_GIT_IDENTITY
  return id ? { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email } : {}
}

// Terminal and credential unavailability keeps the saved message queued (Owner 2026-11-09 13:38). Each code has an exit:
// terminals' observer (connectivity) or its registry-change edge (target/trust revision). A missing folder or a too old
// Aiterm on the terminal stays a visible delivery failure unless Aiterm's launch refusal proves nothing started (below).
const REACHABILITY = new Set(['TERMINAL_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'UNREACHABLE', 'HOST_TRUST_STALE', 'SEAT_FORWARD_UNAVAILABLE',
  'TERMINAL_TARGET_CHANGED', 'TERMINAL_UNRESPONSIVE'])
const NOT_STARTED = new Set([...REACHABILITY, 'TARGET_MISMATCH', 'HOST_KEY_MISMATCH', 'TERMINAL_NOT_FOUND',
  'BOT_REMOTE_BINDING_MISSING', 'MEMBERS_EFFECT_UNSUPPORTED', 'SEAT_CREDENTIAL_INVALID', 'TERMINALS_UNAVAILABLE'])
const reachability = code => REACHABILITY.has(code) || typeof code === 'string' && code.startsWith('CREDENTIAL_')
// Trony 2026-11-10: Aiterm's Claude auth preflight on the terminal refused before any session (session_created false).
// No observer sees the login; the exit is the next drain of the member's queue (its next delivery or launch).
const authNotReady = error => {
  const preflight = authenticationPreflightFailure(error?.agentLaunchError)
  return preflight !== null && preflight.code === error.code
}
// Aiterm >= 0.70.0: any other launch it refused before a seat existed (e.g. CWD_UNAVAILABLE, REMOTE_AITERM_TOO_OLD), with its
// fixed plain action. Same exit as auth (common rule guards.give-up-is-a-guard): the member's next drain after the Owner's fix.
const refused = error => { const value = launchRefusal(error?.launchRefusal); return value !== null && value.code === error.code ? value : null }
// The Owner's plain next step for a terminal whose claude is not logged in (Trony's wording), named by terminals' target.os.
const OS_NAMES = { macos: 'Mac', windows: 'Windows', linux: 'Linux' }
export const loginAction = os => `${OS_NAMES[os] ?? 'Mac'}のclaudeにログインが必要`
export const notStarted = error => {
  if (NOT_STARTED.has(error?.code) || reachability(error?.code) || authNotReady(error) || refused(error)) try { error.effect = 'not_started' } catch {}
  return error
}
// remote-seat.md "Remote-seat not-started proof": the durable receipt requeues the same ID only on this delivery-bound field.
export const remoteSeatNotStarted = (bot, deliveryId, error) =>
  isRemoteBot(bot) && typeof deliveryId === 'string' && deliveryId && error?.effect === 'not_started'
    && (NOT_STARTED.has(error.code) || reachability(error.code) || authenticationPreflightCodes.includes(error.code) || refused(error))
    ? { schema: 'bellteam.remote-seat-not-started.v1', code: error.code, deliveryId, botId: bot.id, terminalId: bot.terminalId } : null

// Throughline's public CLI runs on the server as the seat user (Rivalin remote-ingest.md, Throughline >= 0.17.0). The seat
// runner passes argv only, so this bridge feeds the JSON pieces to the CLI's stdin and prints its one JSON result.
export const THROUGHLINE_SCRIPT = `const { spawn } = require('node:child_process')
const [args, ...parts] = process.argv.slice(1)
let out = '', done = false
const finish = text => { if (!done) { done = true; process.stdout.write(text) } }
const child = spawn('throughline', JSON.parse(args), { stdio: ['pipe', 'pipe', 'ignore'] })
child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
child.on('error', () => finish(JSON.stringify({ status: 'error', code: 'THROUGHLINE_UNAVAILABLE' })))
child.on('close', () => finish(out || JSON.stringify({ status: 'error', code: 'THROUGHLINE_EMPTY' })))
child.stdin.on('error', () => {})
child.stdin.end(parts.join(''))`
// One argv string is at most 128 KiB (bytes) on Linux; pieces are cut by UTF-8 bytes between code points, so joined they are
// the exact JSON. Pages stay well under the total argv limit.
const ARG_PIECE = 96 * 1024, PAGE_BYTES = 1024 * 1024, PAGES_PER_TURN = 64
export function pieces(text) {
  const out = []
  let piece = '', bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > ARG_PIECE) { out.push(piece); piece = ''; bytes = 0 }
    piece += char
    bytes += size
  }
  if (piece) out.push(piece)
  return out
}

export const KEY_RELOAD = new Set(['CREDENTIAL_NOT_LOADED', 'CREDENTIAL_REVISION_STALE'])
// Aiterm >= 0.70.5 returns a session call's refusal code in _meta (error.aitermErrorCode); agent_launch has its own _meta.
// shortcut: the text "aiterm: CODE: ..." is still read because a 0.70.4 container relay drops _meta; drop it once every body runs >= 0.70.5.
const reloadCode = error => error?.code ?? error?.aitermErrorCode
  ?? (error?.aitermResponseReturned === true ? /^(?:aiterm: )?([A-Z][A-Z0-9_]+):/u.exec(String(error.message ?? ''))?.[1] : undefined)

export const isRemoteBot = bot => typeof bot?.terminalId === 'string' && bot.terminalId !== ''
  && typeof bot.projectRoot === 'string' && bot.projectRoot !== ''
// The authoritative target of a seat: a change of either member field is a fresh launch at the next idle boundary.
export const seatTarget = bot => isRemoteBot(bot) ? `${bot.terminalId}\n${bot.projectRoot}` : ''

export class RemoteSeats {
  // recorded(sessionName) reads the transport's launch record (D5), which keeps a remote seat's target, botId and launchId
  // across a body restart.
  constructor({ terminals, ingress, launchContext, emitQueue = () => {}, notify = () => {}, seatCommand = null, recorded = async () => null }) {
    this.seatCommand = seatCommand
    this.recorded = recorded
    this.terminals = terminals
    this.ingress = ingress
    this.launchContext = launchContext
    this.emitQueue = emitQueue
    this.seats = new Map() // sessionName -> {sessionName, botId, terminalId, projectRoot, launchId, cursor}; cache of the launch record
    this.waiting = new Map() // terminalId -> Set(botId) whose launch was not started
    this.notices = new Map() // botId -> {code, action, terminalId, at}: the latest not-started launch, shown to the Owner
    this.oses = new Map() // terminalId -> terminals' target.os at the last target (login text only)
    this.notify = notify
    this.routes = new RemoteRoutes({ terminals, recorded }) // a532b2 stage 2: the `remote` route of seats launched on it (remote-route.md)
    this.unwatch = terminals.watch?.(event => this.available(event)) ?? (() => {})
  }

  // The launch inputs for the same agent_launch: terminals' target unchanged, the member's folder, the launch context and the
  // seat MCP config. Values never pass here; the credential stays a reference until the seat launcher's private env.
  async prepare(bot, args, { shortTermMemory, context, slot, harness, kind = 'main' }) {
    const sessionName = args.session_name
    let issued = false
    try {
      const { terminal, remote, forward, cwd, accountOwner } = await this.target(bot, harness)
      const { text } = await this.launchContext(bot.id, { sessionName, shortTermMemory }, context)
      const { url, credentialRef } = await this.ingress.seatCredential.issue({ botId: bot.id, sessionName, terminalId: bot.terminalId, ...(kind === 'fork' ? { kind } : {}) })
      issued = true
      // remote-route.md: a terminal switched to `remote` gets its forward ensured first; the seat URLs then name P. Any failure here
      // launches this seat on `terminal` as before (same id, same keeper, same P).
      const route = await this.ensureRoute(bot, { remote, forward, url })
      // A relaunch of the same name on `terminal` (fallback, or the terminal is not switched) ends an older route of that name.
      if (route) this.routes.add(sessionName, bot.terminalId, route); else this.routes.remove(sessionName)
      const seatUrl = route?.url ?? url
      const headers = { Authorization: 'Bearer ${BELLTEAM_MCP_TOKEN}', 'X-Bellteam-Seat': '${AITERM_SESSION_ID}', 'X-Bellteam-Launch-Id': '${AITERM_AGENT_LAUNCH_ID}' }
      // remote-user-tools.md U4: the Bot's user-global MCP servers of this harness, each through the same seat listener.
      // A list failure never stops the launch: the seat starts with bellteam and call-bridge only.
      // Only with the container Aiterm that keeps a terminal's own same-name server (a138, >= 0.70.62): there the managed
      // servers carry replace (every terminal has its own stdio call-bridge) and user tools never do. Older: as before.
      const callerReplace = this.ingress.userTools?.callerReplace === true
      let userTools = []
      if (callerReplace) {
        try { userTools = await this.ingress.userTools.list(bot.id) ?? [] }
        catch (error) { process.stderr.write(`BellTeam remote seat: user tools unavailable: ${bot.id}: ${error?.code ?? 'USER_TOOL_LIST_FAILED'}\n`) }
      }
      const managed = callerReplace ? { replace: true } : {}
      const userServers = Object.fromEntries(userTools.map(({ name }) => [name, { type: 'http', url: `${seatUrl}/user/${name}`, headers }]))
      // Owner ruling: the Owner's 1st/2nd login applies only on the Owner's terminals; others use the terminal's own login.
      // One login per slot (harness-accounts.md 2026-11-11): every slot, the 1st too, so no host login is needed.
      const claudeLogin = accountOwner === 'owner' && slot ? slot : null
      return {
        args: { ...args, ...(route ? { remote: route.remote } : { terminal }), cwd, append_system_prompt: text,
          mcp_config: { mcpServers: { ...userServers, bellteam: { type: 'http', url: seatUrl, headers, ...managed }, 'call-bridge': { type: 'http', url: `${seatUrl}/call-bridge`, headers, ...managed } } } },
        claudeLogin,
        route,
        // CREDENTIAL_NOT_LOADED / CREDENTIAL_REVISION_STALE on agent_launch: load again and launch once more (R13), only for
        // the same target intent. A changed owner, binding, host or folder would mix the prepared login/options with another
        // target, so it is not started; terminals' observer drains it and the next wake prepares afresh.
        reloadKey: async () => {
          const fresh = await this.target(bot, harness)
          if (fresh.accountOwner !== accountOwner || fresh.cwd !== cwd || fresh.terminal?.ref !== terminal.ref
            || JSON.stringify(fresh.terminal?.target) !== JSON.stringify(terminal.target))
            throw Object.assign(new Error('TERMINAL_TARGET_CHANGED'), { code: 'TERMINAL_TARGET_CHANGED', effect: 'not_started' })
          return fresh.terminal
        },
        // The seat launcher forwards exactly these names (Molly #793); the login value still comes only from claudeLogin.
        privateEnv: { names: ['BELLTEAM_MCP_TOKEN', ...(claudeLogin ? ['CLAUDE_CODE_OAUTH_TOKEN'] : []), ...Object.keys(gitIdentityEnv())],
          resolve: async () => ({ BELLTEAM_MCP_TOKEN: await this.ingress.seatCredential.reveal(credentialRef), ...gitIdentityEnv() }) },
        revoke: () => this.revoke(sessionName),
      }
    } catch (error) {
      if (issued) await this.revoke(sessionName)
      // terminals' own target() failure already armed its observer.
      // A fork's refusal goes back to its asker; the main seat's queue and launch notice are not touched (execution/fork.md).
      // terminals' C8 auth check (codex/grok) refuses in Aiterm's shape: notice only, no observer (exit = the member's next drain).
      const refusal = refused(error)
      if (kind !== 'fork' && refusal) this.notice(bot, refusal)
      else if (kind !== 'fork' && (NOT_STARTED.has(error?.code) || reachability(error?.code))) { this.wait(bot); this.notice(bot, error) }
      throw notStarted(error)
    }
  }

  // terminals' target; an app-set key (terminal.credential) is loaded into Aiterm before the target is used (R13).
  async target({ id, terminalId, projectRoot }, harness = 'claude-code') {
    const target = await this.terminals.connection.target({ terminalId, memberId: id, projectRoot, harness })
    if (target?.os) this.oses.set(terminalId, target.os)
    if (target?.terminal?.credential) {
      // terminals' target succeeded, so its observer is not armed; arm it so Mika's availability event drains the wait.
      try { await this.loadKey({ id, terminalId }, target.terminal) }
      catch (error) { this.terminals.connection.observe?.(terminalId); throw error }
    }
    return target
  }

  // remote-route.md: `remote` + `forward` beside `terminal` (terminals' target) and a client that can reach Aiterm's ensure_forward.
  // Returns {remote, forward, revision, port: P, url} and records the route for this session, or null (this launch uses `terminal`).
  async ensureRoute(bot, { remote, forward, url }) {
    const client = this.routes.client
    if (!remote || !forward?.id || !client) return null
    try {
      const seat = new URL(url)
      const result = await client.call('ensure_forward', { id: forward.id, remote, to: { host: '127.0.0.1', port: Number(seat.port) } })
      const port = result?.structuredContent?.port ?? result?.port
      if (result?.isError || !Number.isInteger(port)) return null
      seat.port = String(port)
      return { remote, forward, port, readyAt: result?.structuredContent?.ready_at ?? null, revision: forward.revision ?? null, url: `${seat.origin}${seat.pathname.replace(/\/$/u, '')}` }
    } catch (error) {
      process.stderr.write(`BellTeam remote route: ensure_forward failed, launching on terminal: ${bot.id}: ${error?.code ?? 'FAILED'}\n`)
      return null
    }
  }

  // The parent resolves Mika's handle and pipes the key to Aiterm's credential-load (Molly #813); execution never holds the
  // value. Any failure is CREDENTIAL_UNAVAILABLE (not started; Mika's/terminals' events drain it).
  async loadKey({ id, terminalId }, { ref, credential: { handle, revision } }) {
    const unavailable = () => Object.assign(new Error('CREDENTIAL_UNAVAILABLE'), { code: 'CREDENTIAL_UNAVAILABLE', effect: 'not_started' })
    if (typeof this.ingress.seatCredential.loadTerminalKey !== 'function') throw unavailable()
    let receipt
    try { receipt = await this.ingress.seatCredential.loadTerminalKey({ terminalId, memberId: id, ref, handle, revision }) }
    catch { throw unavailable() }
    if (receipt?.accepted !== true || receipt.handle !== handle || receipt.revision !== revision) throw unavailable()
  }

  // Fresh body (remote-seat.md R13 "Body restart"): the key agent died with the container, so load the key once per terminal
  // that has a recorded remote seat; Aiterm's keeper then rebuilds the seat MCP route without waiting for a Mac operation.
  async warm(launches) {
    // remote-route.md: a seat launched on `remote` keeps its forward only while ensure_forward is called again; the table is
    // filled from the launch record so the keeper runs from the first tick. A seat that is gone is dropped by the first seat-view read.
    for (const [session, record] of Object.entries(launches ?? {})) if (record?.route === 'remote' && typeof record.target === 'string') this.routes.sessions.set(session, record.target.split('\n')[0])
    const terminals = new Map()
    for (const { botId, target } of Object.values(launches ?? {})) {
      const [terminalId, projectRoot] = typeof target === 'string' ? target.split('\n') : []
      if (terminalId && projectRoot && typeof botId === 'string' && !terminals.has(terminalId))
        terminals.set(terminalId, { id: botId, terminalId, projectRoot })
    }
    // No harness: terminals runs no C8 (CLI upkeep/login check), so a logged-out CLI cannot keep the key out (Epinel #996).
    await Promise.all([...terminals.values()].map(bot => this.target(bot, null).catch(() => {})))
    return [...terminals.keys()]
  }

  // A session call of a held remote seat refused because Aiterm's key agent is gone: load again for its terminal.
  async reloadKey(sessionName) {
    const seat = await this.seatOf(sessionName)
    if (!seat?.terminalId) return false
    await this.target({ id: seat.botId, terminalId: seat.terminalId, projectRoot: seat.projectRoot })
    return true
  }

  // After a successful launch receipt. Only an entry of the same name is replaced; another seat of this Bot under another name
  // (account-slot move, #750/#756) stays until its explicit pty_close.
  launched(bot, receipt) {
    const sessionName = receipt?.session_id
    if (typeof sessionName !== 'string') return
    // remote-user-tools.md (a138): the terminal's own same-name server won (dropped) or BellTeam's managed one replaced it.
    for (const kind of ['dropped', 'replaced']) {
      const names = receipt.caller_mcp?.[kind]
      if (Array.isArray(names) && names.length) process.stderr.write(`BellTeam remote seat: caller MCP ${kind} by the terminal's own config: ${bot.id}: ${names.filter(name => typeof name === 'string').join(', ')}\n`)
    }
    const launchId = receipt.launch_id
    this.seats.set(sessionName, { sessionName, botId: bot.id, terminalId: bot.terminalId, projectRoot: bot.projectRoot,
      launchId: typeof launchId === 'string' ? launchId : null, cursor: null })
    if (this.notices.delete(bot.id)) this.notify()
  }

  // remote-seat.md "Launch notice": the message stays queued with no failed callback, so the Owner sees the code and the
  // plain next step on the member instead. Only the code and terminals'/Aiterm's action text are kept.
  notice(bot, error) {
    const action = typeof error?.action === 'string' && error.action.trim() ? error.action.trim().slice(0, 500) : null
    this.notices.set(bot.id, { code: error.code, action, terminalId: bot.terminalId, at: new Date().toISOString() })
    this.notify()
  }

  launchNotice(bot) {
    const notice = this.notices.get(bot?.id)
    return notice && isRemoteBot(bot) && bot.terminalId === notice.terminalId ? { ...notice } : null
  }

  // A remote seat by session name: this generation's entry, or rebuilt from the launch record after a body restart (the
  // Throughline cursor then starts at null; its replay is idempotent).
  async seatOf(sessionName) {
    const held = this.seats.get(sessionName)
    if (held) return held
    const record = await Promise.resolve(this.recorded(sessionName)).catch(() => null)
    if (!record?.target || typeof record.botId !== 'string') return null
    const [terminalId, projectRoot] = record.target.split('\n')
    const seat = { sessionName, botId: record.botId, terminalId, projectRoot, launchId: typeof record.launchId === 'string' ? record.launchId : null, cursor: null }
    this.seats.set(sessionName, seat)
    return seat
  }

  async closed(sessionName) {
    this.routes.remove(sessionName)
    if (!await this.seatOf(sessionName)) return
    this.seats.delete(sessionName)
    await this.revoke(sessionName)
  }

  // agent_launch (after a successful target) answered a terminal code: queue as not started; a connectivity code also arms
  // terminals' non-AI observer, whose reachable event drains the same IDs.
  launchFailed(bot, error) {
    // a443: the terminal's agent_launch outlived BellTeam's 60 s MCP request limit (host too slow to answer). The launch is
    // prompt-free, so nothing was typed: keep the message queued like an unreachable terminal (remote-seat.md).
    if (error?.code === -32001 && mcpRequestContext(error)?.tool === 'agent_launch') error.code = 'TERMINAL_UNRESPONSIVE'
    if (authNotReady(error)) { notStarted(error); this.notice(bot, { code: error.code, action: loginAction(this.oses.get(bot.terminalId)) }); return }
    const refusal = refused(error)
    if (refusal) { notStarted(error); this.notice(bot, refusal); return }
    // Aiterm >= 0.70.1: a logged-out claude stops at its first screen in a created session. Information only: a session
    // exists on the terminal, so this stays today's visible failure; the notice says what the Owner must do.
    const startup = error?.launch?.schema === 'aiterm.agent-launch-result.v1' ? error.launch.startup : null
    if (startup?.status === 'blocked' && startup.reason === 'vendor_onboarding_required') {
      this.notice(bot, { code: 'VENDOR_ONBOARDING_REQUIRED', action: loginAction(this.oses.get(bot.terminalId)) })
      return
    }
    if (!NOT_STARTED.has(error?.code) && !reachability(error?.code)) return
    notStarted(error)
    this.wait(bot)
    this.notice(bot, error)
    if (reachability(error.code)) this.terminals.connection.observe?.(bot.terminalId)
  }

  // a443 live-seat gate (remote-seat.md "TERMINAL_UNRESPONSIVE"): a failed send to a live idle seat while this member holds a
  // reachability notice for its terminal must not close the seat (its host is slow, not the seat gone). Returns the not-started
  // error to throw, or null when no such notice is held. Exit: terminals' reachable event clears the notice (available()).
  holdLiveSeat(bot, refusal) {
    const notice = this.launchNotice(bot)
    if (!notice || !reachability(notice.code)) return null
    const held = Object.assign(new Error(`TERMINAL_UNRESPONSIVE: seat kept, its terminal is not answering (${refusal?.code ?? 'send failed'})`), { code: 'TERMINAL_UNRESPONSIVE', cause: refusal })
    notStarted(held)
    this.wait(bot)
    this.terminals.connection.observe?.(bot.terminalId)
    return held
  }

  // a442b: the launch fell back to no Code Mode (remote-seat.md "Code Mode for every Claude seat"). Information only: it names the
  // machine and the one step; the next launch's `launched()` clears it and that launch tries Code Mode again.
  codeModeSkipped(bot, code) {
    const action = code === 'REMOTE_AITERM_TOO_OLD'
      ? `端末 ${bot.terminalId} のAitermを0.70.76以上に更新するとCode Modeで起動します`
      : `端末 ${bot.terminalId} でClaudeのCode Modeの確認画面に一度答えるとCode Modeで起動します`
    this.notice(bot, { code: 'CODE_MODE_SKIPPED', action })
  }

  revoke(sessionName) {
    this.routes.remove(sessionName)
    return Promise.resolve(this.ingress.seatCredential.revoke({ sessionName })).catch(() => {})
  }

  wait({ id, terminalId }) {
    const set = this.waiting.get(terminalId) ?? new Set()
    set.add(id)
    this.waiting.set(terminalId, set)
  }

  // terminals' availability observer is the exit of every not-started state: the existing queue edge drains the same IDs.
  available(event) {
    if (event?.reachable !== true) return
    const ids = this.waiting.get(event.terminalId) ?? new Set()
    this.waiting.delete(event.terminalId)
    // a443: the terminal answers again, so a reachability notice for it is over; a drain that fails again sets it again.
    let cleared = false
    for (const [botId, notice] of this.notices) if (notice.terminalId === event.terminalId && reachability(notice.code)) { this.notices.delete(botId); cleared = true }
    if (cleared) this.notify()
    for (const id of ids) this.emitQueue({ bot: { id } })
  }

  // A successful pty_close of a held remote seat revokes its credential; every other call passes unchanged.
  route(base) {
    const remote = this
    this.routes.client = base
    const routed = client => Object.create(client, {
      call: { value: async (name, args = {}, options = {}) => {
        let result
        // remote-route.md: a seat launched on `remote` has no session map in Aiterm; every call that names it carries the route.
        if (name === 'agent_stop' && Array.isArray(args.session_ids)) return remote.routes.stop(next => client.call(name, next, options), args)
        args = await remote.routes.withRoute(args)
        try { result = await client.call(name, args, options) } catch (error) {
          // Aiterm refuses before contacting the terminal, so the same call is issued once more after the load (R13).
          if (!KEY_RELOAD.has(reloadCode(error)) || typeof args.session_id !== 'string' || !await remote.reloadKey(args.session_id)) throw error
          result = await client.call(name, args, options)
        }
        if (name === 'pty_close' && !result?.isError && typeof args.session_id === 'string') await remote.closed(args.session_id)
        return result
      } },
      ...(typeof client.pin === 'function' ? { pin: { value: () => routed(client.pin()) } } : {}),
    })
    return this.client = routed(base)
  }

  // The same wait as a local seat; a completed remote turn then hands its transcript to Throughline (C7).
  waitProcess(local) {
    return async (process, signal, context) => {
      const result = await local(process, signal)
      const args = Array.isArray(process?.args) ? process.args : []
      const name = typeof context?.session === 'string' ? context.session : args.includes('--session') ? args[args.indexOf('--session') + 1] : null
      const seat = name ? await this.seatOf(name) : null
      if (seat && ['done', 'error', 'rate_limited'].includes(result?.outcome)) void this.forward(seat)
      return result
    }
  }

  // Throughline short-term memory for a remote member, read on the server. Missing memory never keeps a seat from starting.
  async handoffContext(botId) {
    try {
      const result = await this.throughline(['remote-handoff-context', '--bot', botId, '--json'])
      if (result?.schema === 'throughline.handoff_context.v1' && typeof result.context === 'string')
        return result.status === 'ready' ? result.context.trim() : ''
    } catch {}
    process.stderr.write(`BellTeam remote seat: short-term memory unavailable: ${botId}\n`)
    return ''
  }

  throughline(args, input = '') {
    if (!this.seatCommand) return Promise.reject(Object.assign(new Error('THROUGHLINE_UNAVAILABLE'), { code: 'THROUGHLINE_UNAVAILABLE' }))
    return this.seatCommand({ executable: globalThis.process.execPath, args: ['-e', THROUGHLINE_SCRIPT, JSON.stringify(args), ...pieces(input)] }, null)
  }

  // Aiterm's transcript read, the same command for local and terminal seats (aiterm.transcript-read.v1).
  transcript(seat) {
    const cursor = seat.cursor
    // A seat on `remote` is read over the pinned ssh of its route (Aiterm >= 0.70.112); any other seat as before.
    return this.routes.transcriptFlags(seat.sessionName).then(flags => this.seatCommand({ executable: 'aiterm-transcript-read', args: ['--session', seat.sessionName,
      ...(cursor ? ['--cursor-session', cursor.claudeSessionId, '--offset', String(cursor.offset)] : []), '--max-bytes', String(PAGE_BYTES), ...flags] }, null))
  }

  // C7: after a native completion, hand the completed transcript prefix to Throughline; only its ACK cursor stays here.
  // A gap or conflict moves to Throughline's expected cursor; anything else keeps the cursor for the next completion.
  async forward(seat) {
    if (seat.forwarding) { seat.forwardAgain = true; return }
    if (!this.seatCommand) return
    seat.forwarding = true
    try {
      // A remote agent_launch result carries launch_id null (terminal and remote route alike); the seat's own observation names it.
      const launchId = seat.launchId ?? await this.launchIdOf(seat.sessionName)
      if (!launchId) { process.stderr.write(`BellTeam remote seat: transcript not read: ${seat.botId} NO_LAUNCH_ID\n`); return }
      for (let page = 0; page < PAGES_PER_TURN; page++) {
        const read = await this.transcript(seat)
        if (!Array.isArray(read?.entries) || !read.entries.length || !read.cursor) break
        // remote-seat.md C7: a fork goes as `--fork` (Throughline 0.17.0 refuses that argv and stores nothing).
        const fork = seat.fork ? { sessionKind: 'fork', parentSessionId: seat.fork.parentSessionId, forkId: seat.fork.forkId } : {}
        const result = await this.throughline(['remote-ingest', ...(seat.fork ? ['--fork'] : []), '--json'], JSON.stringify({ botId: seat.botId, sessionName: seat.sessionName,
          launchId, claudeSessionId: read.cursor.claudeSessionId, entries: read.entries, cursor: read.cursor, ...fork }))
        if (result?.status === 'ready' && result.ackedCursor) { seat.cursor = result.ackedCursor; continue }
        if (result?.expectedCursor) seat.cursor = result.expectedCursor
        process.stderr.write(`BellTeam remote seat: transcript not stored: ${seat.botId} ${typeof result?.code === 'string' ? result.code : 'FAILED'}\n`)
        break
      }
    } catch (error) {
      process.stderr.write(`BellTeam remote seat: transcript not stored: ${seat.botId} ${typeof error?.code === 'string' ? error.code : 'FAILED'}\n`)
    } finally {
      seat.forwarding = false
      if (seat.forwardAgain) { seat.forwardAgain = false; void this.forward(seat) }
    }
  }

  // pty_observe through the routed client: a seat on `remote` carries its route, any other seat is found by Aiterm's own map.
  async launchIdOf(sessionName) {
    try {
      const id = (await this.client?.call('pty_observe', { session_id: sessionName }))?.structuredContent?.launch_id
      return typeof id === 'string' && /^[a-f0-9]{32}$/u.test(id) ? id : null
    } catch { return null }
  }

  close() { this.unwatch() }
}
