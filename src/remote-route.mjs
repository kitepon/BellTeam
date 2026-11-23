// The route of a remote seat launched on Aiterm's `remote` input (docs/architecture/modules/execution/remote-route.md,
// a532b2 stage 2, Tronie ruling B): Aiterm keeps no session map for it, so BellTeam names the route on every call.
// terminalId -> {remote, forward, revision}; session -> terminalId. A seat launched on `terminal` is never here.

// The seat listener's own port, the same value as remote-seat-port.mjs (not imported: that file is not in the execution artifact).
const KEEP_MS = 60_000 // Aiterm holds a forward without a binding for 120 s from each ensure_forward call (Elegg 2026-11-23)
const AGENT_EMPTY_TRIES = 3
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export const routeUnavailable = reason => Object.assign(new Error(`REMOTE_ROUTE_UNAVAILABLE: ${reason ?? 'UNKNOWN'}`), { code: 'REMOTE_ROUTE_UNAVAILABLE', reason })

// pty_list rows of a machine -> seat_turns rows (current-work.md): a running turn carries wait_process null, event_cursor null.
export function viewRows(sessions) {
  const rows = [], unread = []
  for (const row of Array.isArray(sessions) ? sessions : []) {
    if (typeof row?.session_id !== 'string') continue
    // A machine older than 0.70.108 ignores `include`: no turn field, or null (not readable / read by another reader) = not read.
    if (!row.turn || typeof row.turn !== 'object') { unread.push(row.session_id); continue }
    const turn = row.turn.state === 'running'
      ? { state: 'running', turn_id: row.turn.turn_id, started_at: row.turn.started_at, event_cursor: null, interim_from: row.turn.interim_from ?? null, wait_process: null }
      : row.turn
    rows.push({ session_id: row.session_id, harness: row.harness, launch_id: row.launch_id, turn, own_work: row.own_work ?? null, limit_end: row.limit_end })
  }
  return { rows, unread }
}

export class RemoteRoutes {
  // recorded(session) reads the transport's launch record (D5): {route: 'remote', target: 'terminalId\nprojectRoot'}.
  constructor({ terminals, recorded = async () => null, report = () => {}, port = () => Number(process.env.BELLTEAM_REMOTE_SEAT_PORT ?? 4183), now = Date.now }) {
    this.terminals = terminals
    this.recorded = recorded
    this.report = report
    this.port = port
    this.now = now
    this.client = null // set by RemoteSeats.route(): the Aiterm client the calls go through
    this.routes = new Map() // terminalId -> {remote, forward, revision}
    this.sessions = new Map() // session -> terminalId
    this.resolving = new Map() // terminalId -> promise (overlapping remoteFor calls share one)
    this.kept = new Map() // terminalId -> ms of the last ensure_forward
    this.viewing = new Map() // terminalId -> promise of the pty_list in flight (one reader per machine)
    this.reported = new Set()
  }

  add(session, terminalId, route) {
    this.routes.set(terminalId, { remote: route.remote, forward: route.forward, revision: route.revision ?? null })
    this.sessions.set(session, terminalId)
    this.kept.set(terminalId, this.now())
  }

  remove(session) { this.sessions.delete(session) }

  // terminals' remoteFor, one call per terminal at a time; AGENT_EMPTY (the key is being loaded again) is retried.
  resolve(terminalId) {
    const held = this.resolving.get(terminalId)
    if (held) return held
    const run = (async () => {
      for (let attempt = 1; ; attempt++) {
        const answer = await this.terminals.connection.remoteFor?.(terminalId)
        if (answer?.remote && answer.forward) {
          const route = { remote: answer.remote, forward: answer.forward, revision: answer.revision ?? null }
          this.routes.set(terminalId, route)
          return route
        }
        if (answer?.reason !== 'AGENT_EMPTY' || attempt >= AGENT_EMPTY_TRIES) throw routeUnavailable(answer?.reason ?? 'REMOTE_FOR_UNAVAILABLE')
        await wait(1000)
      }
    })().finally(() => this.resolving.delete(terminalId))
    this.resolving.set(terminalId, run)
    return run
  }

  // The entry of a session on `remote`: held, or rebuilt from the launch record after a body restart; null = not a remote-route seat.
  // A remote-route seat whose route cannot be named throws: a call without `remote` would address no seat (no fallback to `terminal`).
  async of(session) {
    let terminalId = this.sessions.get(session)
    if (!terminalId) {
      const record = await Promise.resolve(this.recorded(session)).catch(() => null)
      if (record?.route !== 'remote' || typeof record.target !== 'string') return null
      terminalId = record.target.split('\n')[0]
      this.sessions.set(session, terminalId)
    }
    return { terminalId, ...(this.routes.get(terminalId) ?? await this.resolve(terminalId)) }
  }

  async withRoute(args) {
    if (args.remote || typeof args.session_id !== 'string') return args
    const entry = await this.of(args.session_id)
    return entry ? { ...args, remote: entry.remote } : args
  }

  // agent_stop applies one `remote` to every listed id: ids on different routes go in separate calls, one merged answer.
  async stop(call, args) {
    const groups = new Map()
    for (const id of args.session_ids) {
      const entry = await this.of(id)
      const key = entry?.terminalId ?? ''
      groups.set(key, { entry, ids: [...(groups.get(key)?.ids ?? []), id] })
    }
    if (groups.size < 2) { const [only] = groups.values(); return call({ ...args, ...(only?.entry ? { remote: only.entry.remote } : {}) }) }
    const results = await Promise.all([...groups.values()].map(({ entry, ids }) => call({ ...args, session_ids: ids, ...(entry ? { remote: entry.remote } : {}) })))
    const data = results.map(result => result?.structuredContent)
    const targets = data.flatMap(value => Array.isArray(value?.targets) ? value.targets : [])
    const statuses = data.map(value => value?.status)
    const status = statuses.every(value => value === 'idle') ? 'idle' : statuses.every(value => value === 'failed') ? 'failed'
      : statuses.some(value => value === 'failed' || value === 'partial') ? 'partial' : 'sent'
    return { ...results[0], isError: results.some(result => result?.isError), structuredContent: { ...data[0], status, targets } }
  }

  // The same ensure_forward again keeps the keeper: once a minute per terminal that has a seat; a changed registry/trust revision
  // replaces the entry. A failed round is reported once per terminal and retried on the next tick.
  async keep() {
    if (!this.client) return
    const live = new Set(this.sessions.values())
    await Promise.all([...live].map(async terminalId => {
      if (this.now() - (this.kept.get(terminalId) ?? 0) < KEEP_MS) return
      this.kept.set(terminalId, this.now())
      try {
        const fresh = await this.resolve(terminalId)
        await this.client.call('ensure_forward', { id: fresh.forward.id, to: { host: '127.0.0.1', port: this.port() } })
        this.reported.delete(terminalId)
      } catch (error) {
        if (this.reported.has(terminalId)) return
        this.reported.add(terminalId)
        process.stderr.write(`BellTeam remote route: ${terminalId}: ${error?.code ?? 'KEEP_FAILED'}\n`)
      }
    }))
  }

  // The seat view of the terminals that have `remote` seats: one pty_list per machine, never two at once (the span lock).
  // A machine that did not answer: its sessions are not read this time (the unread of today). meta = the exclusion list.
  async views(meta) {
    if (!this.client) return null
    const bySession = new Map()
    for (const [session, terminalId] of this.sessions) bySession.set(terminalId, [...(bySession.get(terminalId) ?? []), session])
    const parts = await Promise.all([...bySession].map(([terminalId, sessions]) => {
      const busy = this.viewing.get(terminalId)
      if (busy) return busy.then(() => ({ rows: [], unread: sessions }))
      const run = (async () => {
        try {
          const route = this.routes.get(terminalId) ?? await this.resolve(terminalId)
          const result = await this.client.call('pty_list', { remote: route.remote, include: ['turn', 'own_work'] }, meta ? { meta } : {})
          const seen = viewRows(result?.structuredContent?.sessions)
          // A valid answer without a session: the seat is gone from that machine, so it leaves the table (no turn can run).
          const listed = new Set([...seen.rows.map(row => row.session_id), ...seen.unread])
          for (const session of sessions) if (!listed.has(session)) this.remove(session)
          return { rows: seen.rows.filter(row => sessions.includes(row.session_id)), unread: seen.unread.filter(id => sessions.includes(id)) }
        } catch { return { rows: [], unread: sessions } }
      })().finally(() => this.viewing.delete(terminalId))
      this.viewing.set(terminalId, run)
      return run
    }))
    return { rows: parts.flatMap(part => part.rows), unread: parts.flatMap(part => part.unread) }
  }

  // The pinned-ssh flags of aiterm-transcript-read (Aiterm >= 0.70.112) for a seat on `remote`; [] for any other seat.
  async transcriptFlags(session) {
    const entry = await this.of(session)
    const ssh = entry?.remote?.ssh
    if (!entry) return []
    return ['--host', entry.remote.host, '--user', entry.remote.user, ...(entry.remote.port ? ['--port', String(entry.remote.port)] : []),
      '--known-hosts', ssh.known_hosts_file, ...(ssh.host_key_alias ? ['--host-key-alias', ssh.host_key_alias] : []), '--identity-agent', ssh.identity_agent]
  }
}
