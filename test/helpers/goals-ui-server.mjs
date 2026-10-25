import { createServer } from 'node:http'

const full = process.env.GOALS_FIXTURE_FULL === '1'
const binding = id => ({ sessionId: `session-${id}`, launchId: '0123456789abcdef0123456789abcdef', threadId: `thread-${id}` })
const capabilities = (goal, available = true) => ({
  inspect: available,
  create: available && !goal && full,
  edit: available && !!goal && full,
  pause: available && goal?.status === 'active',
  resume: available && goal?.status === 'paused',
  clear: available && !!goal,
})
const fieldCapabilities = value => ({
  create: { objective: value.create, tokenBudget: value.create, combined: false },
  edit: { objective: value.edit, tokenBudget: value.edit, combined: false },
})
const activeGoal = { threadId: 'thread-bot-two', objective: '利用者に今日の進捗を届ける', status: 'active',
  tokenBudget: 12000, tokensUsed: 3400, timeUsedSeconds: 128, createdAt: 1, updatedAt: 1 }
const initialSnapshots = () => new Map([
  ['bot-one', { botId: 'bot-one', availability: 'available', binding: binding('bot-one'), goal: null,
    capabilities: capabilities(null), fieldCapabilities: fieldCapabilities(capabilities(null)),
    observedAt: '2026-10-25T00:00:00Z', message: null }],
  ['bot-two', { botId: 'bot-two', availability: 'available', binding: binding('bot-two'), goal: { ...activeGoal },
    capabilities: capabilities(activeGoal), fieldCapabilities: fieldCapabilities(capabilities(activeGoal)),
    observedAt: '2026-10-25T00:00:00Z', message: null }],
  ['bot-three', { botId: 'bot-three', availability: 'unsupported', binding: null,
    capabilities: capabilities(null, false), fieldCapabilities: fieldCapabilities(capabilities(null, false)),
    observedAt: '2026-10-25T00:00:00Z',
    message: 'このメンバーではゴール機能をまだ利用できません。' }],
])
let snapshots = initialSnapshots()
let writes = []
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/test/reset') { snapshots = initialSnapshots(); writes = []; return json(response, { ok: true }) }
  if (url.pathname === '/test/proof') return json(response, { writes })
  if (url.pathname === '/api/goals' && request.method === 'GET')
    return json(response, { goals: [...snapshots.values()] })
  const match = url.pathname.match(/^\/api\/bots\/(bot-[a-z]+)\/goal$/u)
  if (!match) return json(response, { error: 'NOT_FOUND' }, 404)
  const snapshot = snapshots.get(match[1])
  if (!snapshot) return json(response, { error: 'BOT_NOT_FOUND' }, 404)
  if (request.method === 'GET') return json(response, { snapshot })
  if (request.method !== 'POST') return json(response, { error: 'METHOD_NOT_ALLOWED' }, 405)
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!['sessionId', 'launchId', 'threadId'].every(key => input.binding?.[key] === snapshot.binding?.[key])
    || !snapshot.capabilities[input.action])
    return json(response, { error: 'GOAL_REJECTED', message: '現在のゴールを更新してください。' }, 409)
  if (['create', 'edit'].includes(input.action)
    && Object.hasOwn(input, 'objective') && Object.hasOwn(input, 'tokenBudget'))
    return json(response, { error: 'GOAL_FIELDS_CANNOT_COMBINE' }, 400)
  writes.push({ action: input.action, botId: snapshot.botId,
    objective: Object.hasOwn(input, 'objective'), tokenBudget: Object.hasOwn(input, 'tokenBudget') })
  if (input.action === 'pause') snapshot.goal.status = 'paused'
  if (input.action === 'resume') snapshot.goal.status = 'active'
  if (input.action === 'clear') snapshot.goal = null
  if (input.action === 'create') snapshot.goal = { ...activeGoal, threadId: snapshot.binding.threadId,
    objective: input.objective, tokenBudget: input.tokenBudget ?? null, tokensUsed: 0 }
  if (input.action === 'edit') snapshot.goal = { ...snapshot.goal,
    ...(Object.hasOwn(input, 'objective') ? { objective: input.objective } : {}),
    ...(Object.hasOwn(input, 'tokenBudget') ? { tokenBudget: input.tokenBudget } : {}) }
  snapshot.capabilities = capabilities(snapshot.goal)
  snapshot.fieldCapabilities = fieldCapabilities(snapshot.capabilities)
  snapshot.observedAt = new Date().toISOString()
  json(response, { outcome: 'confirmed', snapshot })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
