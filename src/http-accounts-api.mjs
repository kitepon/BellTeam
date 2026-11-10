import { json } from './http-response.mjs'

// Routes for the Claude 1st/2nd accounts (docs/architecture/modules/execution/harness-accounts.md, "Public HTTP").
// An engine without the 'accounts' owner answers EXECUTION_REQUEST_INVALID; that body does not support accounts.
const unsupported = error => error?.code === 'EXECUTION_REQUEST_INVALID'

// Bot item fields read synchronously from the engine: undefined (field absent) when this body/engine lacks the method,
// null when unset or on another failure, otherwise a copy of the object.
export function readSeatProjection(transport, method, botId) {
  if (typeof transport?.[method] !== 'function') return undefined
  try {
    const value = transport[method](botId)
    return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : null
  } catch (error) { return unsupported(error) ? undefined : null }
}

// 'account' (harness-accounts.md): the seat's slot. 'seatLaunch' (remote-seat.md): the last not-started remote launch.
export const readSeatAccount = (transport, botId) => readSeatProjection(transport, 'seatAccount', botId)
export const readSeatLaunch = (transport, botId) => readSeatProjection(transport, 'seatLaunch', botId)

export function createAccountsApi({ accounts }) {
  return async (request, response, url) => {
    if (url.pathname !== '/api/accounts') return false
    if (!accounts?.list) return json(response, 404, { error: 'NOT_FOUND' })
    if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    try { return json(response, 200, await accounts.list()) }
    catch (error) {
      if (unsupported(error)) return json(response, 404, { error: 'NOT_FOUND' })
      throw error
    }
  }
}
