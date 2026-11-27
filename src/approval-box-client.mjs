// P1 backend (seat-approval-to-abx, Tronie 2026-11-28 ruling b): the body files, reads and cancels Approval Box cards as a plain client of the host's
// public Approval Box MCP (`approval-box mcp`, stdio), the way any AI does: no pairing, no hosted door, no body-as-receiver. Interface: execution/seat-approvals.md
// "Backend", approval-box-extension/seats-on-hosted-daemon.md P1 (file / read / cancel, typed kinds UNAVAILABLE / REFUSED / GONE, idempotent per session_label).
// The client is the seat user's (~/.approval-box is 0700, the body is uid 1001): every call is one short process run by seatRun, one MCP session per call.
import { join } from 'node:path'

export const PORT_ORIGINS = Object.freeze(['seat-approval', 'running-exclusions', 'lattice'])
const CALL_MS = 15_000
const OPEN = new Set(['pending', 'held'])
const idOf = value => value?.decision_id ?? value?.id
const fail = (kind, status) => Object.assign(new Error(`APPROVAL_BOX_PORT_${kind}`), { kind, code: `APPROVAL_BOX_PORT_${kind}`, status })

const session = (name, args) => [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bellteam-body', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
].map(line => JSON.stringify(line)).join('\n') + '\n'

// seatRun: createSeatProcessRunner (execFile-compatible). null (dev, tests): there is no client to run, every call is UNAVAILABLE.
export function createApprovalBoxClientPort({ seatRun = null, seatHome = process.env.APPROVAL_BOX_SEAT_HOME ?? '/home/bell' } = {}) {
  const entry = join(seatHome, '.approval-box', 'bin', 'approval-box')
  // The tool's structuredContent plus whether it was an error; anything the client did not answer cleanly is UNAVAILABLE (ends the caller's tick).
  async function call(name, args) {
    if (!seatRun) throw fail('UNAVAILABLE', 503)
    let stdout
    try { ({ stdout } = await seatRun(entry, ['mcp'], { input: session(name, args), signal: AbortSignal.timeout(CALL_MS), maxBuffer: 4 * 1024 * 1024 })) } catch { throw fail('UNAVAILABLE', 503) }
    for (const line of String(stdout).split('\n')) {
      let message; try { message = JSON.parse(line) } catch { continue }
      if (message?.id !== 2) continue
      const result = message.result
      if (!result) throw fail('UNAVAILABLE', 503)
      return { error: result.isError === true, json: result.structuredContent ?? {}, text: (result.content ?? []).map(part => part?.text ?? '').join('\n') }
    }
    throw fail('UNAVAILABLE', 503)
  }
  // A coded refusal of the client (not_found = the connection does not know the id; any other code on a known id = this request cannot be done).
  const refused = answer => answer.json?.error === 'not_found' ? fail('GONE', 404) : answer.json?.error ? fail('REFUSED', 409) : fail('UNAVAILABLE', 503)
  return {
    // origin only names the requester when the caller sent none; the caller sets session_label. An open card with the label is adopted, never filed twice.
    async file({ title, context, options, requester, session_label, origin }) {
      if (origin !== undefined && !PORT_ORIGINS.includes(origin)) throw fail('REFUSED', 400)
      if (typeof session_label !== 'string' || !session_label) throw fail('REFUSED', 400)
      const same = item => item?.session_label === session_label && OPEN.has(item.status) && idOf(item)
      const listed = await call('list_my_decisions', {})
      if (listed.error || !Array.isArray(listed.json?.items)) throw fail('UNAVAILABLE', 503)
      const known = listed.json.items.find(same)
      if (known) return { decisionId: idOf(known), existing: true }
      const body = { title, context, options, requester_name: requester ?? origin ?? '', session_label }
      for (let round = 0; round < 2; round++) {
        const answer = await call('request_decision', body)
        if (!answer.error && idOf(answer.json)) return { decisionId: idOf(answer.json), existing: false }
        const open = [].concat(answer.json?.decisions ?? [], answer.json?.existing ?? []).find(same)
        if (open) return { decisionId: idOf(open), existing: true }
        if (answer.json?.error !== 'confirm_required' || !answer.json.check_token) throw answer.json?.error ? fail('REFUSED', 409) : fail('UNAVAILABLE', 503)
        body.check_token = String(answer.json.check_token)
      }
      throw fail('UNAVAILABLE', 503)
    },
    async read(id) {
      const answer = await call('get_decision', { decision_id: id })
      if (answer.error) throw refused(answer)
      const json = answer.json
      if (idOf(json) !== id || !['pending', 'held', 'answered', 'cancelled'].includes(json.status)) throw fail('UNAVAILABLE', 503)
      const given = json.answer && typeof json.answer.option_id === 'string' ? json.answer.option_id : null
      // answer_text is the client's wake-up message to an AI, not the Owner's words: only the answer's own text counts.
      const text = typeof json.answer?.text === 'string' && json.answer.text ? json.answer.text : null
      return { status: json.status, ...(json.answer && { answer: { ...(given && { optionId: given }), ...(text && { text }) } }) }
    },
    // cancel of an answered or cancelled request is REFUSED, never success.
    async cancel(id, reason) {
      const answer = await call('cancel_decision', { decision_id: id, reason })
      if (answer.error) throw refused(answer)
      if (idOf(answer.json) !== id || answer.json.status !== 'cancelled') throw fail('UNAVAILABLE', 503)
      return { status: 'cancelled' }
    },
  }
}
