import { json, readJson } from './http-response.mjs'

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

export function createAccountsApi({ accounts, internal }) {
  return async (request, response, url) => {
    if (url.pathname !== '/api/accounts' && url.pathname !== '/api/accounts/rules') return false
    if (!accounts?.list) return json(response, 404, { error: 'NOT_FOUND' })
    try {
      if (url.pathname === '/api/accounts') {
        if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return json(response, 200, await accounts.list())
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      if (internal) return json(response, 403, { error: 'ACCOUNT_RULE_OWNER_REQUIRED' })
      let input
      try { input = await readJson(request, 4096) }
      catch { return json(response, 400, { error: 'ACCOUNT_RULE_INVALID' }) }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return json(response, 400, { error: 'ACCOUNT_RULE_INVALID' })
      const { harness, modelPrefix, slot } = input
      return json(response, 200, await accounts.setRule({ harness, modelPrefix, slot }))
    } catch (error) {
      if (unsupported(error)) return json(response, 404, { error: 'NOT_FOUND' })
      throw error
    }
  }
}
