import { json, readJson } from './http-response.mjs'

// seat-approvals.md: the Owner's entry for a seat stopped on a tool approval. The internal (Bot) port gets 403.
const answerRoute = /^\/api\/seat-approvals\/(sa-[a-z0-9-]+)\/answer$/u
const codes = new Set(['SEAT_APPROVAL_INVALID', 'SEAT_APPROVAL_NOT_FOUND', 'SEAT_APPROVAL_CLOSED', 'SCREEN_APPROVAL_INVALID', 'SCREEN_APPROVAL_UNSUPPORTED', 'SCREEN_INPUT_FAILED'])

export function createSeatApprovalsApi({ seatApprovals, internal }) {
  return async (request, response, url) => {
    const answer = url.pathname.match(answerRoute)
    if (url.pathname !== '/api/seat-approvals' && !answer) return false
    if (internal) return json(response, 403, { error: 'SEAT_APPROVAL_OWNER_REQUIRED' })
    if (!seatApprovals) return json(response, 503, { error: 'SEAT_APPROVAL_UNAVAILABLE' })
    if (request.method !== (answer ? 'POST' : 'GET')) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    try {
      if (!answer) return json(response, 200, { approvals: await seatApprovals.list() })
      return json(response, 200, await seatApprovals.answer(answer[1], (await readJson(request, 1024))?.decision))
    } catch (error) {
      if (['INVALID_JSON', 'REQUEST_TOO_LARGE'].includes(error?.message)) return json(response, 400, { error: 'SEAT_APPROVAL_INVALID' })
      if (codes.has(error?.code)) return json(response, error.status ?? 502, { error: error.code })
      if (error?.code === 'EXECUTION_REQUEST_INVALID') return json(response, 503, { error: 'SEAT_APPROVAL_UNAVAILABLE' })
      throw error
    }
  }
}
