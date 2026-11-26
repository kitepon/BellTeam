// P1 Decision port of the 決裁箱拡張 module (docs/architecture/modules/approval-box-extension/seats-on-hosted-daemon.md, sections 1 and 1a).
// The one BellTeam interface for filing and reading Approval Box decisions. Parent-side (body process), over the module's own hosted connector (approval-box-daemon.mjs).
// Callers (Kiro: seat cards, running exclusions; Flora: read and cancel of legacy records) hold no token, no secret card and no connector: they get `approvals.decisions`.
// Every error carries a typed `kind`: UNAVAILABLE (not linked, 401, timeout, network, 5xx: ends the caller's tick), REFUSED (a 4xx on a known id: skip that request),
// GONE (read of an id the connection does not know or purged: the caller drops its record). Each call answers within 5 s or fails UNAVAILABLE.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { DAEMON_ENTRY } from './approval-box-daemon.mjs'

export const PORT_ORIGINS = Object.freeze(['seat-approval', 'running-exclusions', 'lattice'])
const CALL_MS = 5000
const idOf = value => value?.id ?? value?.decision_id

const fail = (kind, status) => Object.assign(new Error(`APPROVAL_BOX_PORT_${kind}`), { kind, code: `APPROVAL_BOX_PORT_${kind}`, status })
const failedBy = status => status >= 400 && status < 500 ? fail('REFUSED', 409) : fail('UNAVAILABLE', 503)

// The seats' runtime, not the daemon's, decides what a seat can do: pc.5 after install-runtime. Seats' profile first, the daemon's own entry as the fallback; unreadable = no capability.
// seatRun: the seat process runner (createSeatProcessRunner, Molly): the body is uid 1001 and the seats' ~/.approval-box is the seat user's (0700), so the seats' binary must run as the seat user.
const defaultCapabilities = ({ seatRun = null, seatHome = process.env.APPROVAL_BOX_SEAT_HOME ?? '/home/bell', node = process.execPath, entry = DAEMON_ENTRY } = {}) => async () => {
  const direct = promisify(execFile)
  const attempt = (run, file, args) => Promise.resolve().then(() => run(file, args, { signal: AbortSignal.timeout(CALL_MS), maxBuffer: 1024 * 1024 }))
    .then(({ stdout }) => { const list = JSON.parse(String(stdout)).capabilities; return Array.isArray(list) ? list.filter(item => typeof item === 'string').slice(0, 64) : null }, () => null).catch(() => null)
  return (seatRun ? await attempt(seatRun, join(seatHome, '.approval-box', 'bin', 'approval-box'), ['version', '--json']) : null) ?? await attempt(direct, node, [entry, 'version', '--json']) ?? []
}

export function createApprovalBoxPort({ daemon, seatRun = null, readCapabilities = defaultCapabilities({ seatRun }), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const linked = async () => Promise.resolve(daemon.status()).then(status => status?.daemon?.mode === 'pc', () => false)
  // {ok,status,json}: a coded daemon error keeps its status and its structured body (confirm_required carries check_token).
  async function call(method, path, body) {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimer(() => reject(Object.assign(new Error('timeout'), { status: 503 })), CALL_MS); timer?.unref?.() })
    try {
      const result = await Promise.race([daemon.route(method, path, body), timeout])
      return { ok: true, status: 200, json: result ?? {} }
    } catch (error) {
      return { ok: false, status: Number.isInteger(error?.status) ? error.status : 503, json: { error: { ...(error?.body ?? {}), code: typeof error?.code === 'string' ? error.code : 'unavailable' } } }
    } finally { clearTimer(timer) }
  }
  const needLinked = async () => { if (!(await linked())) throw fail('UNAVAILABLE', 503) }
  return {
    // `origin` only adds: it names the requester when the caller sent none, and never replaces the caller's requester or session_label. The caller sets session_label.
    async file({ title, context, options, requester, session_label, origin }) {
      if (origin !== undefined && !PORT_ORIGINS.includes(origin)) throw fail('REFUSED', 400)
      if (typeof session_label !== 'string' || !session_label) throw fail('REFUSED', 400)
      await needLinked()
      const same = item => item?.session_label === session_label && idOf(item)
      const listed = await call('GET', '/decisions')
      if (!listed.ok || !Array.isArray(listed.json?.items)) throw failedBy(listed.ok ? 502 : listed.status)
      const known = listed.json.items.find(same)
      if (known) return { decisionId: idOf(known), existing: true }
      const body = { title, context, options, requester: requester ?? origin ?? null, session_label, urgency: 'normal', client: 'other' }
      let status = 0
      for (let round = 0; round < 2; round++) {
        const answer = await call('POST', '/decisions', body)
        status = answer.status
        if (answer.ok && idOf(answer.json)) return { decisionId: idOf(answer.json), existing: false }
        const error = answer.json?.error && typeof answer.json.error === 'object' ? answer.json.error : answer.json ?? {}
        const open = [...error.decisions ?? [], ...error.existing ? [].concat(error.existing) : []].find(same)
        if (open) return { decisionId: idOf(open), existing: true }
        if (error.code !== 'confirm_required' || !error.check_token) break
        body.check_token = String(error.check_token)
      }
      throw failedBy(status)
    },
    // An answered request is marked collected inside read (otherwise its delivery stays "waiting"); a failed mark changes nothing for the caller.
    async read(id) {
      await needLinked()
      const { ok, status, json } = await call('GET', `/decisions/${encodeURIComponent(id)}`)
      if (!ok && status === 404) throw fail('GONE', 404)
      if (!ok) throw failedBy(status)
      if (idOf(json) !== id || !['pending', 'held', 'answered', 'cancelled'].includes(json.status)) throw fail('UNAVAILABLE', 503)
      const answer = json.answer ? { ...(typeof json.answer.option_id === 'string' && { optionId: json.answer.option_id }), ...(typeof json.answer.text === 'string' && { text: json.answer.text }) } : undefined
      if (json.status === 'answered') await call('POST', `/decisions/${encodeURIComponent(id)}/fetched`).catch(() => null)
      return { status: json.status, ...(answer && { answer }) }
    },
    // cancel of an answered or cancelled request answers 4xx: REFUSED, never success.
    async cancel(id, reason) {
      await needLinked()
      const { ok, status, json } = await call('POST', `/decisions/${encodeURIComponent(id)}/cancel`, { reason })
      if (!ok) throw status === 404 ? fail('GONE', 404) : failedBy(status)
      if (idOf(json) !== id || json.status !== 'cancelled') throw fail('UNAVAILABLE', 503)
      return { status: 'cancelled' }
    },
    capabilities: () => Promise.resolve(readCapabilities()).then(list => Array.isArray(list) ? list : [], () => []),
    async connection() {
      const status = await Promise.resolve(daemon.status()).catch(() => null)
      const d = status?.daemon ?? null
      return { linked: d?.mode === 'pc', mode: d?.mode ?? null, reason: d?.reason ?? null, version: d?.version ?? null, running: status?.running === true }
    },
  }
}
