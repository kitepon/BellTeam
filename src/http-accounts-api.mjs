import { json } from './http-response.mjs'

// Routes for the Claude 1st/2nd accounts (docs/architecture/modules/execution/harness-accounts.md, "Public HTTP").
// An engine without the 'accounts' owner answers EXECUTION_REQUEST_INVALID; that body does not support accounts.
const unsupported = error => error?.code === 'EXECUTION_REQUEST_INVALID'

// Bot item 'account': the seat's slot, null for a seat without one, undefined when this body/engine has no accounts.
export function readSeatAccount(transport, botId) {
  if (typeof transport?.seatAccount !== 'function') return undefined
  try {
    const value = transport.seatAccount(botId)
    return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : null
  } catch (error) { return unsupported(error) ? undefined : null }
}

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
