// Approval Box extension: the child's own HTTPS client to approval-box.kitepon.dev (docs/bellteam-client.md). The session is passed per call and never logged.
export const APPROVAL_BOX_BASE = 'https://approval-box.kitepon.dev'
const unavailable = () => Object.assign(new Error('APPROVALS_UNAVAILABLE'), { code: 'APPROVALS_UNAVAILABLE', status: 503 })

export function createApprovalBoxClient({ fetchImpl = fetch, base = APPROVAL_BOX_BASE } = {}) {
  const send = async (url, init, timeoutMs) => {
    try { return await fetchImpl(`${base}${url}`, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) }) } catch { throw unavailable() }
  }
  const body = async (response, raw) => {
    if (raw && response.ok) return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) }
    return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) }
  }
  return {
    // method, path ('/v1/...'), {json?, headers?, raw?} -> {status, headers, json | bytes}
    async call(token, method, path, { json, headers = {}, raw = false } = {}) {
      return body(await send(path, { method, headers: { authorization: `Bearer ${token}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: json === undefined ? undefined : JSON.stringify(json) }, 30_000), raw)
    },
    async startPairing() {
      const response = await body(await send('/connector/v1/pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_name: 'BellTeam', client: 'bellteam' }) }, 20_000))
      if (response.status !== 200 && response.status !== 201 || !response.json?.pairing_id) throw unavailable()
      return response.json
    },
    // long poll (~25 s on the server): one answer {status: waiting|claimed|delivered|rejected|expired, session?, expires_at?}
    async pollPairing(id, secret) {
      const response = await body(await send(`/connector/v1/pairing/${encodeURIComponent(id)}`, { method: 'GET', headers: { 'x-poll-secret': secret } }, 40_000))
      if (response.status === 404) return { status: 'expired' }
      if (response.status !== 200 || typeof response.json?.status !== 'string') throw unavailable()
      return response.json
    },
  }
}
