import { resolveSeatBotId, SEAT_HEADER } from './seat-mcp.mjs'

// The body end of the host door for seats on other hosts (a516m; docs/architecture/modules/runtime/approval-box-daemon.md,
// "The door for seats on other hosts"): one request line in, the hosted daemon's one reply line back. It keeps nothing.
export const APPROVAL_BOX_DOOR_PATH = '/api/seat-mcp/approval-box/local'
const MAX_LINE = 32 * 1024 * 1024
const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }

export function createApprovalBoxDoorRoute({ credentials, bots, daemon }) {
  const seatKey = SEAT_HEADER.toLowerCase()
  return async (request, response) => {
    if (request.method !== 'POST') return send(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    // As the seat MCP paths do (createRemoteSeatIngress): the bearer names the seat, a main seat's member must still resolve to it.
    const binding = await credentials.verify(request.headers.authorization)
    delete request.headers.authorization
    delete request.headers[seatKey]
    if (!binding) return send(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    if (binding.kind === 'fork') return send(response, 403, { error: 'APPROVAL_BOX_DOOR_NOT_ALLOWED' })
    request.headers[seatKey] = binding.sessionName
    let from
    try { from = await resolveSeatBotId(request, bots) } catch (error) { return send(response, error.status ?? 503, { error: error.code ?? 'MEMBERS_UNAVAILABLE' }) }
    if (from !== binding.botId) return send(response, 400, { error: 'BELLTEAM_SEAT_UNRESOLVED' })
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_LINE) { request.destroy(); return send(response, 413, { error: 'APPROVAL_BOX_DOOR_TOO_LARGE' }) }
      chunks.push(chunk)
    }
    let line
    try { line = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { line = null }
    if (!line || typeof line !== 'object' || Array.isArray(line) || typeof line.method !== 'string' || typeof line.path !== 'string') return send(response, 400, { error: 'APPROVAL_BOX_DOOR_REQUEST_INVALID' })
    return send(response, 200, await daemon.call(line.method, line.path, line.body))
  }
}
