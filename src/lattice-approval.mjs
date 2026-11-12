// Body side of the Lattice effects decisions.file / decisions.read (lattice README L18-L19; Trony ruling 2026-11-13).
// The body files Owner-lane tasks to the Approval Box with its OWN connector connection: the token is a Flora request_secret
// (tool id below) held in BellTeam's secret store and read only inside withResolved (usage secret-credentials.md, Mika).
export const LATTICE_APPROVAL_SCOPE = Object.freeze({ terminalId: 'lattice', purpose: 'approval-box.connector' })
export const LATTICE_APPROVAL_SECRET = Object.freeze({ botId: 'bot-7e777fe5', toolId: 'lattice-approval-box' })
const ORIGIN = 'https://approval-box.kitepon.dev/connector/v1'
// UNAVAILABLE (no token, timeout, network, 5xx) ends the child's filing for this tick; REFUSED (4xx) skips one card (README L18, Molly review).
const unavailable = () => Object.assign(new Error('LATTICE_DECISIONS_UNAVAILABLE'), { code: 'LATTICE_DECISIONS_UNAVAILABLE', status: 503 })
const refused = () => Object.assign(new Error('LATTICE_DECISIONS_REFUSED'), { code: 'LATTICE_DECISIONS_REFUSED', status: 409 })
const failedBy = status => status >= 400 && status < 500 ? refused() : unavailable()
const idOf = value => value?.id ?? value?.decision_id

export function createLatticeDecisions({ credentials, secretRequests, fetchImpl = fetch }) {
  // The parent decides which request may enter this scope (Mika): Flora's own submitted request with the fixed tool id, newest first.
  async function handle() {
    if (!credentials || !secretRequests) throw unavailable()
    const current = await credentials.current(LATTICE_APPROVAL_SCOPE)
    if (current) { if (!current.available) throw unavailable(); return current.handle }
    const rows = secretRequests.timeline({ botId: LATTICE_APPROVAL_SECRET.botId }).map(row => row.secret_request)
      .filter(card => card?.botId === LATTICE_APPROVAL_SECRET.botId && card.toolId === LATTICE_APPROVAL_SECRET.toolId && card.status === 'submitted')
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    // shortcut: rotation happens when the current binding is gone (revoked/unbound); a newer submission alone does not replace a live one.
    if (!rows.length) throw unavailable()
    const bound = await credentials.bind(rows[0].id, LATTICE_APPROVAL_SCOPE)
    if (!bound?.available) throw unavailable()
    return bound.handle
  }
  async function call(method, path, body) {
    const id = await handle()
    return credentials.withResolved(id, { ...LATTICE_APPROVAL_SCOPE, memberId: null }, async token => {
      if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) throw unavailable()
      // 5 s: the child's root chain is shared with every seat's lattice call (Molly review).
      const response = await fetchImpl(ORIGIN + path, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
        .catch(() => { throw unavailable() })
      const json = await response.json().catch(() => ({}))
      return { ok: response.ok, status: response.status, json }
    })
  }
  return {
    // One request per Owner-lane task: the first POST answers confirm_required with check_token; an open request of this connection with the
    // same requester / work_label (duplicate_suspected, or listed in the confirm list) is returned as existing instead of filing again.
    async file(params) {
      // Nayuta 2026-11-13: session_label and client are required; the server lists it back as `requester / session_label`; no route (polled).
      const label = `${params.requester} / ${params.session_label}`
      const body = { title: params.title, context: params.context, options: params.options, requester: params.requester,
        session_label: params.session_label, urgency: 'normal', client: 'other' }
      let status = 0
      for (let round = 0; round < 2; round++) {
        const answer = await call('POST', '/decisions', body), { ok, json } = answer
        status = answer.status
        if (ok && idOf(json)) return { decisionId: idOf(json), existing: false }
        const error = json?.error && typeof json.error === 'object' ? json.error : json ?? {}
        const open = [...error.decisions ?? [], ...error.existing ? [].concat(error.existing) : []]
          .find(item => item?.session_label === label && ['pending', 'held'].includes(item.status))
        if (open && idOf(open)) return { decisionId: idOf(open), existing: true }
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
  }
}
