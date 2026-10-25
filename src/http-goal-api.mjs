import { json, readJson } from './http-response.mjs'

const actions = new Set(['create', 'edit', 'pause', 'resume', 'clear'])
const invalid = response => json(response, 400, { error: 'GOAL_INPUT_INVALID', message: 'ゴールの入力を確認してください。' })

// The injected service owns native binding, capabilities and readback. HTTP
// routes select registered Bots and preserve explicit Owner action provenance.
export function createGoalApi({ bots, goals, aiControl, notify, ownerActions = true }) {
  return async (request, response, url) => {
    const match = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/goal$/u)
    if (url.pathname !== '/api/goals' && !match) return false
    if (!['GET', 'POST'].includes(request.method) || url.pathname === '/api/goals' && request.method !== 'GET')
      return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    const bot = match ? bots.get(match[1]) : null
    if (match && !bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
    // Loopback seat ingress does not assert an explicit Owner UI action.
    if (request.method === 'POST' && !ownerActions)
      return json(response, 403, { error: 'GOAL_OWNER_ACTION_REQUIRED' })
    if (!goals) return json(response, 503, { error: 'GOALS_UNAVAILABLE', message: 'ゴールの状態を取得できません。' })
    if (request.method === 'GET') return json(response, 200, match
      ? { snapshot: await goals.inspect(bot) }
      : { goals: await goals.list([...bots.values()]) })

    const input = await readJson(request)
    if (!input || Array.isArray(input) || typeof input !== 'object' || !actions.has(input.action)
      || Object.keys(input).some(key => !['action', 'binding', 'objective', 'tokenBudget'].includes(key))) return invalid(response)
    if (!input.binding || typeof input.binding !== 'object' || Array.isArray(input.binding)) return invalid(response)
    const editing = input.action === 'create' || input.action === 'edit'
    if (!editing && (Object.hasOwn(input, 'objective') || Object.hasOwn(input, 'tokenBudget'))) return invalid(response)
    if (Object.hasOwn(input, 'objective') && (typeof input.objective !== 'string' || !input.objective.trim() || [...input.objective].length > 4000)) return invalid(response)
    if (Object.hasOwn(input, 'tokenBudget') && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1)) return invalid(response)
    if (input.action === 'create' && !Object.hasOwn(input, 'objective')) return invalid(response)
    if (input.action === 'edit' && !Object.hasOwn(input, 'objective') && !Object.hasOwn(input, 'tokenBudget')) return invalid(response)
    if (['create', 'edit', 'resume'].includes(input.action)) aiControl?.assertEnabled()
    const result = await goals.mutate(bot, input, { origin: 'user' })
    notify({ type: 'goals', botId: bot.id })
    return json(response, result.outcome === 'confirmed' ? 200 : 202, result)
  }
}
