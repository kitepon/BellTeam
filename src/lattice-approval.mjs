// Body side of the Lattice effects decisions.file / decisions.read (lattice README L18-L19; Trony ruling 2026-11-13).
// The body files Owner-lane tasks to the Approval Box with its OWN connector connection (and running exclusions with another one, a41): the token is a Flora request_secret
// (tool id below) held in BellTeam's secret store and read only inside withResolved (usage secret-credentials.md, Mika).
export const LATTICE_APPROVAL_SCOPE = Object.freeze({ terminalId: 'lattice', purpose: 'approval-box.connector' })
export const LATTICE_APPROVAL_SECRET = Object.freeze({ botId: 'bot-7e777fe5', toolId: 'lattice-approval-box' })
const ORIGIN = 'https://approval-box.kitepon.dev/connector/v1'
const idOf = value => value?.id ?? value?.decision_id

export const createLatticeDecisions = options =>
  createApprovalDecisions({ ...options, scope: LATTICE_APPROVAL_SCOPE, secret: LATTICE_APPROVAL_SECRET, code: 'LATTICE_DECISIONS' })

// One connector connection per owner (Flora 2026-11-13: never shared; the session_label identity, revocation and outages stay
// per purpose). Each caller passes its own credential scope and request_secret card {botId, toolId}.
export function createApprovalDecisions({ credentials, secretRequests, fetchImpl = fetch, scope, secret, code }) {
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
  async function call(method, path, body) {
    const id = await handle()
    return credentials.withResolved(id, { ...scope, memberId: null }, async token => {
      if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) throw unavailable()
      // 5 s: the caller's chain is shared (Lattice: the child's root chain with every seat's lattice call, Molly review; running exclusions: the 60 s poll).
      const response = await fetchImpl(ORIGIN + path, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
        .catch(() => { throw unavailable() })
      const json = await response.json().catch(() => ({}))
      return { ok: response.ok, status: response.status, json }
    })
  }
  return {
    // One request per Owner-lane task. The session_label (projectId / plan/task, stable ids) is its durable identity on this connection, which only Lattice uses (Epinel gate):
    // a request created earlier whose response or record was lost is adopted as existing, answered or not, so it is never filed twice.
    async file(params) {
      // Nayuta 2026-11-13: session_label and client are required; lists carry the raw session_label; no route (polled). The requester is a display name, not identity.
      const same = item => item?.session_label === params.session_label && idOf(item)
      // shortcut: duplicate-ask recovery covers only the connector's 24h window (open + updated within 24h); upgrade when Approval Box can look up by session_label without a time limit
      const listed = await call('GET', '/decisions')
      if (!listed.ok || !Array.isArray(listed.json?.items)) throw failedBy(listed.ok ? 502 : listed.status)
      const known = listed.json.items.find(same)
      if (known) return { decisionId: idOf(known), existing: true }
      const body = { title: params.title, context: params.context, options: params.options, requester: params.requester,
        session_label: params.session_label, urgency: 'normal', client: 'other' }
      let status = 0
      for (let round = 0; round < 2; round++) {
        const answer = await call('POST', '/decisions', body), { ok, json } = answer
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
      const { ok, status, json } = await call('GET', `/decisions/${encodeURIComponent(decisionId)}`)
      if (!ok) throw failedBy(status)
      if (idOf(json) !== decisionId || !['pending', 'held', 'answered', 'cancelled'].includes(json.status)) throw unavailable()
      const answer = json.answer ? { ...(typeof json.answer.option_id === 'string' && { optionId: json.answer.option_id }),
        ...(typeof json.answer.text === 'string' && { text: json.answer.text }) } : undefined
      // Marks the answer collected (delivery stays 'waiting' otherwise); a failed mark changes nothing for the child.
      if (json.status === 'answered') await call('POST', `/decisions/${encodeURIComponent(decisionId)}/fetched`).catch(() => null)
      return { status: json.status, ...(answer && { answer }) }
    },
    // Withdraws a still-open request (README L19: its Owner-lane task ended on the chart). An answered or cancelled one answers 4xx -> REFUSED.
    async cancel({ decisionId, reason }) {
      const { ok, status, json } = await call('POST', `/decisions/${encodeURIComponent(decisionId)}/cancel`, { reason })
      if (!ok) throw failedBy(status)
      if (idOf(json) !== decisionId || json.status !== 'cancelled') throw unavailable()
      return { status: 'cancelled' }
    },
  }
}
