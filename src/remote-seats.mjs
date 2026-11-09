// Remote seats (docs/architecture/modules/execution/remote-seat.md): a Bot whose member record names a terminal runs
// its seat there. Only the destination of its native calls changes; every other execution path stays the same.
import { textResult } from './aiterm-client.mjs'

// Terminal, credential, folder and launch-context unavailability keeps the saved message queued (Owner 2026-11-09 13:38).
const NOT_STARTED = new Set(['TERMINAL_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'TARGET_MISMATCH', 'CWD_UNAVAILABLE',
  'BOT_REMOTE_BINDING_MISSING', 'MEMBERS_EFFECT_UNSUPPORTED', 'SEAT_CREDENTIAL_INVALID', 'TERMINAL_NOT_FOUND',
  'TERMINAL_INGRESS_UNSET', 'TERMINALS_UNAVAILABLE'])
const notStarted = error => {
  if (NOT_STARTED.has(error?.code)) try { error.effect = 'not_started' } catch {}
  return error
}

export const isRemoteBot = bot => typeof bot?.terminalId === 'string' && bot.terminalId !== ''
  && typeof bot.projectRoot === 'string' && bot.projectRoot !== ''

export class RemoteSeats {
  constructor({ terminals, ingress, launchContext, emitQueue = () => {} }) {
    this.terminals = terminals
    this.ingress = ingress
    this.launchContext = launchContext
    this.emitQueue = emitQueue
    this.seats = new Map() // sessionName -> {botId, terminalId, projectRoot, connectionRef, native}
    this.waiting = new Map() // terminalId -> Set(botId) whose open was not started
    this.unwatch = terminals.watch?.(event => this.available(event)) ?? (() => {})
  }

  // Launch on the member's terminal. A seat already alive there under the same name (after a body restart, whose
  // credential survives) is taken over instead of launched twice. Values never pass here: only names and references.
  async launch(bot, args, { shortTermMemory, context, slot }) {
    const sessionName = args.session_name, target = { botId: bot.id, terminalId: bot.terminalId, projectRoot: bot.projectRoot }
    let opened = null
    try {
      opened = await this.open(target, sessionName, null)
      const seen = await opened.native.callTool('pty_observe', { session_id: sessionName }).catch(() => null)
      let result
      if (seen?.structuredContent?.exists === true) {
        result = { content: [], structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: sessionName,
          startup: { status: 'ready' }, fast: bot.fastMode === true, adopted: true } }
      } else {
        await this.terminals.connection.close(opened.connectionRef).catch(() => {})
        opened = null
        const { text } = await this.launchContext(bot.id, { sessionName, shortTermMemory }, context)
        const { url, credentialRef } = await this.ingress.seatCredential.issue({ botId: bot.id, sessionName, terminalId: bot.terminalId })
        const login = slot && slot !== '1st'
        opened = await this.open(target, sessionName, { BELLTEAM_MCP_TOKEN: credentialRef,
          ...(login ? { CLAUDE_CODE_OAUTH_TOKEN: { harness: 'claude', slot } } : {}) })
        const headers = { Authorization: 'Bearer ${BELLTEAM_MCP_TOKEN}', 'X-Bellteam-Seat': '${AITERM_SESSION_ID}', 'X-Bellteam-Launch-Id': '${AITERM_AGENT_LAUNCH_ID}' }
        result = await opened.native.callTool('agent_launch', { ...args, cwd: bot.projectRoot }, { private: {
          appendSystemPrompt: text,
          mcpConfig: { mcpServers: { bellteam: { type: 'http', url, headers }, 'call-bridge': { type: 'http', url: `${url}/call-bridge`, headers } } },
          env: ['BELLTEAM_MCP_TOKEN', ...(login ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [])],
        } })
        if (result?.isError) {
          // A half-started remote seat is closed on its own terminal, never through the shared local client.
          const leftover = result.structuredContent?.session_id
          if (leftover) await opened.native.callTool('pty_close', { session_id: leftover }).catch(() => {})
          throw Object.assign(new Error(textResult(result) || 'AITERM_LAUNCH_FAILED'), { code: result.structuredContent?.code ?? result.structuredContent?.error?.code })
        }
      }
      const previous = this.seatOf(bot.id)
      // Reissuing for the same name already replaced that token; revoking it would cut the new seat.
      if (previous) await this.release(previous, { keepCredential: previous.sessionName === sessionName })
      this.seats.set(sessionName, { sessionName, ...opened })
      return result
    } catch (error) {
      if (opened) await this.terminals.connection.close(opened.connectionRef).catch(() => {})
      if (NOT_STARTED.has(error?.code)) this.wait(target)
      throw notStarted(error)
    }
  }

  async open({ botId, terminalId, projectRoot }, sessionName, credentials) {
    const { connectionRef, native } = await this.terminals.connection.open({ terminalId, memberId: botId,
      projectRoot, seatBinding: { botId, sessionName },
      // shortcut: P1 serves only the Owner's terminals; P3 reads accountOwner from the terminals registry for others' machines.
      accountOwner: 'owner', ...(credentials ? { credentials } : {}) })
    return { botId, terminalId, projectRoot, connectionRef, native }
  }

  seatOf(botId) { return [...this.seats.values()].find(seat => seat.botId === botId) ?? null }

  async release(seat, { keepCredential = false } = {}) {
    if (!seat) return
    this.seats.delete(seat.sessionName)
    await this.terminals.connection.close(seat.connectionRef).catch(() => {})
    if (!keepCredential) await Promise.resolve(this.ingress.seatCredential.revoke({ sessionName: seat.sessionName })).catch(() => {})
  }

  wait({ botId, terminalId }) {
    const set = this.waiting.get(terminalId) ?? new Set()
    set.add(botId)
    this.waiting.set(terminalId, set)
  }

  // terminals' availability observer is the exit of every not-started state: the existing queue edge drains the same IDs.
  available(event) {
    if (event?.reachable !== true) return
    const ids = new Set([...(this.waiting.get(event.terminalId) ?? []),
      ...[...this.seats.values()].filter(seat => seat.terminalId === event.terminalId).map(seat => seat.botId)])
    this.waiting.delete(event.terminalId)
    for (const id of ids) this.emitQueue({ bot: { id } })
  }

  // A held seat survives a lost connection on the terminal; reopen without credentials (the launch already has them).
  // Only a call refused before sending (connection gone) is retried once; an in-flight CONNECTION_LOST is never replayed.
  async call(seat, name, args, options) {
    const issue = native => native.callTool(name, args, options)
    try { return await issue(seat.native) } catch (error) {
      if (error?.code !== 'TERMINAL_UNAVAILABLE' || this.seats.get(seat.sessionName) !== seat) throw notStarted(error)
    }
    let reopened
    try { reopened = await this.open(seat, seat.sessionName, null) }
    catch (error) { if (NOT_STARTED.has(error?.code)) this.wait(seat); throw notStarted(error) }
    Object.assign(seat, { connectionRef: reopened.connectionRef, native: reopened.native })
    return issue(seat.native).catch(error => { throw notStarted(error) })
  }

  // The native port the transport sees: remote sessions route to their connection, all others to the shared client.
  route(base) {
    const remote = this
    const routed = client => Object.create(client, {
      call: { value: async (name, args = {}, options = {}) => {
        if (name === 'pty_list') return remote.list(await client.call(name, args, options))
        const seat = remote.seats.get(args.session_id)
        if (!seat) return client.call(name, args, options)
        // The remote adapter takes only its own options; the send guard runs right before the input is issued.
        if (typeof options.admissionCheck === 'function') options.admissionCheck()
        const result = await remote.call(seat, name, args, options.timeoutMs ? { timeoutMs: options.timeoutMs } : undefined)
        if (name === 'pty_close' && !result?.isError) await remote.release(seat)
        return result
      } },
      ...(typeof client.pin === 'function' ? { pin: { value: () => routed(client.pin()) } } : {}),
    })
    return routed(base)
  }

  // Held remote seats are listed as running: the seat survives on the terminal while the connection is away.
  list(result) {
    if (!this.seats.size) return result
    const names = [...this.seats.keys()]
    const text = [textResult(result), ...names.map(name => `${name}\tremote`)].filter(Boolean).join('\n')
    const structured = result?.structuredContent
    return { ...result, content: [{ type: 'text', text }],
      ...(structured && Array.isArray(structured.sessions)
        ? { structuredContent: { ...structured, sessions: [...structured.sessions, ...names.map(session_id => ({ session_id }))] } } : {}) }
  }

  // A remote receipt's wait_process names the terminal's own aiterm-wait; it runs there through the bound connection.
  waitProcess(local) {
    return async (process, signal) => {
      const args = Array.isArray(process?.args) ? process.args : []
      const seat = this.seats.get(args[args.indexOf('--session') + 1])
      if (!args.includes('--session') || !seat) return local(process, signal)
      if (typeof seat.native.wait !== 'function')
        throw Object.assign(new Error('REMOTE_WAIT_UNAVAILABLE'), { code: 'REMOTE_WAIT_UNAVAILABLE' })
      return seat.native.wait(process, { signal })
    }
  }

  close() { this.unwatch() }
}
