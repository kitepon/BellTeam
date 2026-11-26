// The connector client of the running exclusions and the seat approval cards (Kiro). Lattice moved to the P1 port (src/lattice-decisions.mjs, f24); this moves to the 決裁箱拡張 module with Kiro's code step (seats-on-hosted-daemon.md).
// Each caller has its OWN connector connection: the token is a request_secret card held in BellTeam's secret store and read only inside withResolved (usage secret-credentials.md, Mika).
const ORIGIN = 'https://approval-box.kitepon.dev/connector/v1'
const idOf = value => value?.id ?? value?.decision_id

// One connector connection per owner (Flora 2026-11-13: never shared; the session_label identity, revocation and outages stay
// per purpose). Each caller passes its own credential scope and request_secret card {botId, toolId}.
// daemon: the body's hosted connector ({status(), route()}, approval-box-daemon.mjs). Paired (mode 'pc') -> the decision routes go through it;
// otherwise, and for an id it does not know (404 not_found), the token path below, unchanged (a490f, design peer-channel-v0.2 section 5).
// tokenSource: async () => token | null (seat-approval-card.md: the token of the body's own QR pairing, read at call time and never stored here); null means unavailable.
// onUnauthorized(token): called when /connector/v1 answers 401 for that token (the Owner removed the connection).
export function createApprovalDecisions({ credentials, secretRequests, fetchImpl = fetch, scope, secret, code, daemon = null, now = Date.now, tokenSource = null, onUnauthorized = null }) {
  // UNAVAILABLE (no token, timeout, network, 5xx) ends the caller's filing for this tick; REFUSED (4xx) skips one request (README L18, Molly review).
  const unavailable = () => Object.assign(new Error(`${code}_UNAVAILABLE`), { code: `${code}_UNAVAILABLE`, status: 503 })
  const refused = () => Object.assign(new Error(`${code}_REFUSED`), { code: `${code}_REFUSED`, status: 409 })
  const failedBy = status => status >= 400 && status < 500 ? refused() : unavailable()
  // The parent decides which request may enter this scope (Mika): the owner's own submitted request with the fixed tool id, newest first.
  async function handle() {
    if (!credentials || !secretRequests) throw unavailable()
    const current = await credentials.current(scope)
    if (current) { if (!current.available) throw unavailable(); return current.handle }
    const rows = secretRequests.timeline({ botId: secret.botId }).map(row => row.secret_request)
      .filter(card => card?.botId === secret.botId && card.toolId === secret.toolId && card.status === 'submitted')
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    // shortcut: rotation happens when the current binding is gone (revoked/unbound); a newer submission alone does not replace a live one.
    if (!rows.length) throw unavailable()
    const bound = await credentials.bind(rows[0].id, scope)
    if (!bound?.available) throw unavailable()
    return bound.handle
  }
  async function send(token, method, path, body) {
    if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) throw unavailable()
    // 5 s: the caller's chain is shared (Lattice: the child's root chain with every seat's lattice call, Molly review; running exclusions: the 60 s poll).
    const response = await fetchImpl(ORIGIN + path, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      .catch(() => { throw unavailable() })
    if (response.status === 401 && onUnauthorized) await Promise.resolve(onUnauthorized(token)).catch(() => {})
    const json = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, json }
  }
  async function call(method, path, body) {
    if (tokenSource) return send(await Promise.resolve(tokenSource()).catch(() => null), method, path, body)
    const id = await handle()
    return credentials.withResolved(id, { ...scope, memberId: null }, token => send(token, method, path, body))
  }
  // The daemon is paired only when it says so; any failure of the question means 'not paired' (the token path is today's behaviour).
  // shortcut: the answer is reused 3 s, so a poll tick asks once; upgrade if pairing must take effect inside one tick.
  let pairedAt = -Infinity, pairedValue = false
  async function paired() {
    if (!daemon) return false
    if (now() - pairedAt < 3000) return pairedValue
    pairedValue = await Promise.resolve(daemon.status()).then(status => status?.daemon?.mode === 'pc', () => false)
    pairedAt = now()
    return pairedValue
  }
  // Same {ok,status,json} as call(); 5 s per request like the token path (the child's chain is shared). A coded daemon error keeps its status.
  async function callDaemon(method, path, body) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { status: 503 })), 5000).unref?.())
    try {
      const result = await Promise.race([daemon.route(method, path, body), timeout])
      return { ok: true, status: 200, json: result ?? {} }
    } catch (error) {
      return { ok: false, status: Number.isInteger(error?.status) ? error.status : 503, json: { error: { ...(error?.body ?? {}), code: typeof error?.code === 'string' ? error.code : 'unavailable' } } }
    }
  }
  // Only 'this connection never filed that id' lets the token path answer; 503 not_paired/starting means not ready, not not mine (Nayuta 2026-11-22).
  const unknownToDaemon = reply => !reply.ok && reply.status === 404 && reply.json?.error?.code === 'not_found'
  // Decision routes by id: the daemon first when paired, the token path for what it does not know.
  async function byId(method, path, body) {
    if (!(await paired())) return call(method, path, body)
    const reply = await callDaemon(method, path, body)
    return unknownToDaemon(reply) ? call(method, path, body) : reply
  }
  return {
    // One request per Owner-lane task. The session_label (projectId / plan/task, stable ids) is its durable identity on this connection, which only Lattice uses (Epinel gate):
    // a request created earlier whose response or record was lost is adopted as existing, answered or not, so it is never filed twice.
    async file(params) {
      // Nayuta 2026-11-13: session_label and client are required; lists carry the raw session_label; no route (polled). The requester is a display name, not identity.
      const same = item => item?.session_label === params.session_label && idOf(item)
      // shortcut: duplicate-ask recovery covers only the connector's 24h window (open + updated within 24h); upgrade when Approval Box can look up by session_label without a time limit
      const viaDaemon = await paired()
      const send = viaDaemon ? callDaemon : call
      const listed = await send('GET', '/decisions')
      if (!listed.ok || !Array.isArray(listed.json?.items)) throw failedBy(listed.ok ? 502 : listed.status)
      const known = listed.json.items.find(same)
      if (known) return { decisionId: idOf(known), existing: true }
      if (viaDaemon) { // filed before the pairing on the token path and still inside its 24 h window: adopt, never file twice (best effort: the token may be gone)
        const earlier = await call('GET', '/decisions').catch(() => null)
        const old = earlier?.ok && Array.isArray(earlier.json?.items) ? earlier.json.items.find(same) : null
        if (old) return { decisionId: idOf(old), existing: true }
      }
      const body = { title: params.title, context: params.context, options: params.options, requester: params.requester,
        session_label: params.session_label, urgency: 'normal', client: 'other' }
      let status = 0
      for (let round = 0; round < 2; round++) {
        const answer = await send('POST', '/decisions', body), { ok, json } = answer
        status = answer.status
        if (ok && idOf(json)) return { decisionId: idOf(json), existing: false }
        const error = json?.error && typeof json.error === 'object' ? json.error : json ?? {}
        const open = [...error.decisions ?? [], ...error.existing ? [].concat(error.existing) : []].find(same)
        if (open) return { decisionId: idOf(open), existing: true }
        if (error.code !== 'confirm_required' || !error.check_token) break
        body.check_token = String(error.check_token)
      }
      throw failedBy(status)
    },
    async read({ decisionId }) {
      const { ok, status, json } = await byId('GET', `/decisions/${encodeURIComponent(decisionId)}`)
      // 404 after the fallback = unknown to the daemon and to the token path (or purged): the child drops the record and the hand-over asks once (Flora, a490f-lattice-gone).
      if (!ok && status === 404) throw Object.assign(new Error(`${code}_GONE`), { code: `${code}_GONE`, status: 404 })
      if (!ok) throw failedBy(status)
      if (idOf(json) !== decisionId || !['pending', 'held', 'answered', 'cancelled'].includes(json.status)) throw unavailable()
      const answer = json.answer ? { ...(typeof json.answer.option_id === 'string' && { optionId: json.answer.option_id }),
        ...(typeof json.answer.text === 'string' && { text: json.answer.text }) } : undefined
      // Marks the answer collected (delivery stays 'waiting' otherwise); a failed mark changes nothing for the child.
      if (json.status === 'answered') await byId('POST', `/decisions/${encodeURIComponent(decisionId)}/fetched`).catch(() => null)
      return { status: json.status, ...(answer && { answer }) }
    },
    // Withdraws a still-open request (README L19: its Owner-lane task ended on the chart). An answered or cancelled one answers 4xx -> REFUSED.
    async cancel({ decisionId, reason }) {
      const { ok, status, json } = await byId('POST', `/decisions/${encodeURIComponent(decisionId)}/cancel`, { reason })
      if (!ok) throw failedBy(status)
      if (idOf(json) !== decisionId || json.status !== 'cancelled') throw unavailable()
      return { status: 'cancelled' }
    },
  }
}
