import { createServer } from 'node:http'

const full = process.env.GOALS_FIXTURE_FULL === '1'
const tagged = process.env.GOALS_FIXTURE_TAGGED === '1'
const grok = process.env.GOALS_FIXTURE_GROK === '1'
const grokSignedTokens = process.env.GOALS_FIXTURE_GROK_SIGNED_TOKENS === '1'
const grokDetail = process.env.GOALS_FIXTURE_GROK_DETAIL === '1'
const grokClear = process.env.GOALS_FIXTURE_GROK_CLEAR === '1'
const grokActiveNoClear = process.env.GOALS_FIXTURE_GROK_ACTIVE_NO_CLEAR === '1'
const binding = id => ({ sessionId: `session-${id}`, launchId: '0123456789abcdef0123456789abcdef', threadId: `thread-${id}` })
const capabilities = (goal, available = true) => {
  const status = goal?.kind === 'codex-cli' ? goal.native.status : goal?.kind === 'claude-code' ? goal.phase : goal?.status
  const claude = goal?.kind === 'claude-code'
  return {
  inspect: available,
  create: available && !goal && full,
  edit: available && !!goal && full,
  pause: available && !claude && status === 'active',
  resume: available && !claude && status === 'paused',
  clear: available && !!goal,
  }
}
const fieldCapabilities = value => ({
  create: { objective: value.create, tokenBudget: value.create, combined: false },
  edit: { objective: value.edit, tokenBudget: value.edit, combined: false },
})
const activeGoal = { threadId: 'thread-bot-two', objective: '利用者に今日の進捗を届ける', status: 'active',
  tokenBudget: 12000, tokensUsed: 3400, timeUsedSeconds: 128, createdAt: 1, updatedAt: 1 }
const claudeGoal = () => ({ kind: 'claude-code', phase: 'active', native: {
  type: 'goal_status', condition: '資料を整理して報告する', met: false, tokens: 1234, durationMs: 5000, iterations: 3,
}, reported_turns: 2 })
const grokGoal = () => ({ kind: 'grok-cli', native: {
  goal_id: 'fixture-goal', objective: 'Grokの資料をまとめる', status: grokClear ? 'user_paused' : 'active',
  phase: grokDetail ? 'Idle' : 'Executing',
  token_budget: 20000, elapsed_ms: 910000, tokens_used_high_water: 19000,
}, current_status: grokDetail
  ? { source: 'goal detail', status: 'Active', phase: null, tokens_used: null,
    status_display: 'Active ⸬ · Planning', phase_display: 'Planning',
    budget_display: '4.9k / 1 tokens (100%)', elapsed_display: '26s' }
  : { source: '/goal status', status: grokActiveNoClear ? 'Active' : 'UserPaused', phase: 'Idle',
    tokens_used: grokSignedTokens ? -1 : 4906, elapsed_display: '14s' } })
const inspectOnly = { inspect: true, create: false, edit: false, pause: false, resume: false, clear: false }
const initialSnapshots = () => {
  const one = grok ? grokGoal() : tagged ? claudeGoal() : null
  const two = tagged || grok ? { kind: 'codex-cli', native: { ...activeGoal } } : { ...activeGoal }
  const oneCapabilities = grok ? { ...inspectOnly, clear: grokClear && !grokDetail && !grokActiveNoClear } : capabilities(one)
  return new Map([
  ['bot-one', { botId: 'bot-one', availability: 'available', binding: binding('bot-one'), goal: one,
    capabilities: oneCapabilities, fieldCapabilities: fieldCapabilities(oneCapabilities),
    observedAt: '2026-10-25T00:00:00Z', message: null }],
  ['bot-two', { botId: 'bot-two', availability: 'available', binding: binding('bot-two'), goal: two,
    capabilities: capabilities(two), fieldCapabilities: fieldCapabilities(capabilities(two)),
    observedAt: '2026-10-25T00:00:00Z', message: null }],
  ['bot-three', { botId: 'bot-three', availability: grok ? 'unavailable' : 'unsupported', binding: null,
    capabilities: capabilities(null, false), fieldCapabilities: fieldCapabilities(capabilities(null, false)),
    observedAt: '2026-10-25T00:00:00Z',
    message: grok ? '現在ゴールを取得できません。' : 'このメンバーではゴール機能をまだ利用できません。' }],
  ])
}
let snapshots = initialSnapshots()
let writes = [], reads = []
let nextOutcome = null
let holdNextList = false, heldLists = []
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/test/reset') {
    for (const held of heldLists) json(held.response, { error: 'FIXTURE_RESET' }, 503)
    snapshots = initialSnapshots(); writes = []; reads = []; nextOutcome = null
    holdNextList = false; heldLists = []
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/proof') return json(response, { writes, reads, heldLists: heldLists.length })
  if (url.pathname === '/test/grok-null-phase') {
    if (!grokDetail) return json(response, { error: 'WRONG_FIXTURE' }, 409)
    snapshots.get('bot-one').goal.current_status.phase_display = null
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/grok-detail-no-clear') {
    if (!grokActiveNoClear) return json(response, { error: 'WRONG_FIXTURE' }, 409)
    snapshots.get('bot-one').goal.current_status = {
      source: 'goal detail', status: 'Active', phase: null, tokens_used: null,
      status_display: 'Active ⸬ · Planning', phase_display: 'Planning',
      budget_display: '4.9k / 1 tokens (100%)', elapsed_display: '26s',
    }
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/hold-list') { holdNextList = true; return json(response, { ok: true }) }
  if (url.pathname === '/test/release-list') {
    const released = heldLists.length
    for (const held of heldLists) json(held.response, { goals: held.goals })
    heldLists = []
    return json(response, { released })
  }
  if (url.pathname === '/test/next') {
    if (!['unconfirmed', 'drop-response'].includes(url.searchParams.get('mode'))) return json(response, { error: 'UNKNOWN_MODE' }, 400)
    nextOutcome = url.searchParams.get('mode')
    return json(response, { ok: true })
  }
  if (url.pathname === '/test/fields') {
    const snapshot = snapshots.get(url.searchParams.get('bot'))
    if (!snapshot) return json(response, { error: 'BOT_NOT_FOUND' }, 404)
    if (url.searchParams.get('mode') !== 'objective-only') return json(response, { error: 'UNKNOWN_MODE' }, 400)
    snapshot.fieldCapabilities.edit = { objective: true, tokenBudget: false, combined: false }
    snapshot.observedAt = new Date().toISOString()
    return json(response, { ok: true })
  }
  if (url.pathname === '/api/goals' && request.method === 'GET') {
    if (holdNextList) {
      holdNextList = false
      heldLists.push({ response, goals: structuredClone([...snapshots.values()]) })
      return
    }
    return json(response, { goals: [...snapshots.values()] })
  }
  const match = url.pathname.match(/^\/api\/bots\/(bot-[a-z]+)\/goal$/u)
  if (!match) return json(response, { error: 'NOT_FOUND' }, 404)
  const snapshot = snapshots.get(match[1])
  if (!snapshot) return json(response, { error: 'BOT_NOT_FOUND' }, 404)
  if (request.method === 'GET') { reads.push(snapshot.botId); return json(response, { snapshot }) }
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
  if (nextOutcome === 'unconfirmed') { nextOutcome = null; return json(response, { outcome: 'unconfirmed', snapshot }, 202) }
  const currentGoal = snapshot.goal?.kind === 'codex-cli' ? snapshot.goal.native : snapshot.goal
  if (input.action === 'pause') currentGoal.status = 'paused'
  if (input.action === 'resume') currentGoal.status = 'active'
  if (input.action === 'clear') {
    if (snapshot.goal?.kind === 'claude-code') snapshot.nativeHistory = { kind: 'claude-code', terminal: 'cleared',
      native: { ...snapshot.goal.native, met: true, sentinel: true } }
    snapshot.goal = null
  }
  if (input.action === 'create') snapshot.goal = { ...activeGoal, threadId: snapshot.binding.threadId,
    objective: input.objective, tokenBudget: input.tokenBudget ?? null, tokensUsed: 0 }
  if (input.action === 'edit') snapshot.goal = { ...snapshot.goal,
    ...(Object.hasOwn(input, 'objective') ? { objective: input.objective } : {}),
    ...(Object.hasOwn(input, 'tokenBudget') ? { tokenBudget: input.tokenBudget } : {}) }
  snapshot.capabilities = capabilities(snapshot.goal)
  snapshot.fieldCapabilities = fieldCapabilities(snapshot.capabilities)
  snapshot.observedAt = new Date().toISOString()
  if (nextOutcome === 'drop-response') { nextOutcome = null; request.socket.destroy(); return }
  json(response, { outcome: 'confirmed', snapshot })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
