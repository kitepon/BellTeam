import { json, readJson } from './http-response.mjs'

// conversation/machine-stream.md: the Owner answers a seat's request and reads a stored raw line. Bots (internal port) get 403.
const answerRoute = /^\/api\/seat-requests\/([A-Za-z0-9_-]{1,200})\/answer$/u
const lineRoute = /^\/api\/bots\/([a-z0-9-]+)\/machine-events\/(\d{1,12})$/u
const status = { SEAT_REQUEST_NOT_FOUND: 404, SEAT_REQUEST_ANSWER_INVALID: 400, SEAT_REQUEST_CLOSED: 409, REQUEST_NOT_PENDING: 409,
  SEAT_REQUEST_ANSWER_FAILED: 502, MACHINE_EVENT_NOT_FOUND: 404 }

export function createSeatRequestApi({ machineStream, internal }) {
  return async (request, response, url) => {
    const answer = url.pathname.match(answerRoute), line = url.pathname.match(lineRoute)
    if (!answer && !line) return false
    if (internal) return json(response, 403, { error: 'SEAT_REQUEST_OWNER_REQUIRED' })
    if (request.method !== (answer ? 'POST' : 'GET')) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    if (!machineStream) return json(response, 404, { error: 'NOT_FOUND' })
    try {
      if (line) return json(response, 200, await machineStream.line(line[1], line[2]))
      return json(response, 200, { request: await machineStream.answer(answer[1], await readJson(request, 65536)) })
    } catch (error) {
      if (['INVALID_JSON', 'REQUEST_TOO_LARGE'].includes(error?.message)) return json(response, 400, { error: 'SEAT_REQUEST_ANSWER_INVALID' })
      const code = error?.code ?? error?.message
      // The request is already expired: the app refreshes from the body.
      if (code === 'REQUEST_NOT_PENDING') return json(response, 409, { error: code, request: machineStream.get(answer[1]) })
      if (status[code]) return json(response, status[code], { error: code })
      // An older execution engine does not know streamSend yet.
      if (code === 'EXECUTION_REQUEST_INVALID') return json(response, 503, { error: 'SEAT_REQUEST_UNAVAILABLE' })
      throw error
    }
  }
}
