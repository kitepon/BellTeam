import { json, readJson } from './http-response.mjs'

// N5 (execution/screen-input.md): Owner key / approval input from the Bot screen view. Bots (internal port) get 403.
const route = /^\/api\/bots\/([a-z0-9-]+)\/screen\/(key|approval)$/u
const codes = new Set(['SCREEN_KEY_INVALID', 'SCREEN_SEAT_ABSENT', 'SCREEN_INPUT_FAILED', 'SCREEN_APPROVAL_INVALID',
  'SCREEN_APPROVAL_CHANGED', 'SCREEN_APPROVAL_UNSUPPORTED'])

export function createScreenInputApi({ bots, transport, internal }) {
  return async (request, response, url) => {
    const match = url.pathname.match(route)
    if (!match) return false
    const [, botId, kind] = match
    if (internal) return json(response, 403, { error: 'SCREEN_INPUT_OWNER_REQUIRED' })
    if (!(kind === 'key' ? ['POST'] : ['GET', 'POST']).includes(request.method)) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    const bot = bots.get(botId)
    if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
    try {
      if (kind === 'key') return json(response, 200, await transport.screenKey(bot, (await readJson(request, 1024))?.key))
      if (request.method === 'GET') return json(response, 200, await transport.screenApproval(bot, { action: 'inspect' }))
      const body = await readJson(request, 1024)
      return json(response, 200, await transport.screenApproval(bot, { action: 'respond', decision: body?.decision, promptDigest: body?.promptDigest }))
    } catch (error) {
      if (['INVALID_JSON', 'REQUEST_TOO_LARGE'].includes(error?.message))
        return json(response, 400, { error: kind === 'key' ? 'SCREEN_KEY_INVALID' : 'SCREEN_APPROVAL_INVALID' })
      if (codes.has(error?.code)) return json(response, error.status, { error: error.code })
      // An older execution engine does not know these methods yet.
      if (error?.code === 'EXECUTION_REQUEST_INVALID' || typeof transport.screenKey !== 'function') return json(response, 503, { error: 'SCREEN_INPUT_UNAVAILABLE' })
      throw error
    }
  }
}
