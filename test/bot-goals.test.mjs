import assert from 'node:assert/strict'
import test from 'node:test'
import { BotGoals } from '../src/bot-goals.mjs'
import { AitermClient } from '../src/aiterm-client.mjs'

const launch = 'a'.repeat(32)
const bot = { id: 'bot-a', session: 'owned-seat', harness: 'codex' }
const binding = { sessionId: 'owned-seat', launchId: launch, threadId: 'native-thread' }
const goal = { threadId: 'native-thread', objective: '人工の目的', status: 'active', tokenBudget: null, tokensUsed: 12, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 }
const native = (overrides = {}) => ({ schema: 'aiterm.agent-goal-result.v1', session_id: 'owned-seat', launch_id: launch, harness: 'codex-cli',
  binding: { session_id: 'owned-seat', launch_id: launch, thread_id: 'native-thread' }, availability: 'available',
  capabilities: { inspect: true, create: true, edit: true, pause: true, resume: true, clear: true },
  outcome: 'observed', mutation: 'not_requested', readback: 'confirmed', goal,
  reason: 'native_goal_observed', observed_at: '2026-10-25T06:00:00Z', ...overrides })

function fixture({ result = native(), observe, admitWork } = {}) {
  const calls = [], reports = []
  const transport = { session: bot => bot.session,
    observe: observe ?? (async () => ({ schema: 'aiterm.pty-observe-result.v1', session_id: 'owned-seat', exists: true, launch_id: launch })),
    client: { async call(...args) { calls.push(args); if (result instanceof Error) throw result; return { structuredContent: result } } },
  }
  return { calls, reports, service: new BotGoals({ transport, admitWork, reportError: async error => reports.push(error) }) }
}

test('既存Bot.sessionのlaunchを観測し、同scopeのagent_goalからnative値を取得する', async () => {
  const { service, calls } = fixture()
  const snapshot = await service.inspect(bot)
  assert.deepEqual(snapshot.binding, binding)
  assert.deepEqual(snapshot.goal, goal)
  assert.equal(snapshot.availability, 'available')
  assert.deepEqual(calls, [['agent_goal', { session_id: 'owned-seat', launch_id: launch, action: 'inspect' }, {}]])
  assert.equal(snapshot.capabilities.pause, true)
  assert.equal(snapshot.capabilities.resume, false)
  assert.equal(snapshot.capabilities.create, false)
})

test('availableの明示nullだけがゴールなし、未知・未対応・終了launchは別に保持する', async () => {
  const empty = await fixture({ result: native({ goal: null }) }).service.inspect(bot)
  assert.equal(empty.goal, null); assert.equal(empty.availability, 'available'); assert.equal(empty.capabilities.create, true)
  const unknownResult = native({ availability: 'unavailable', outcome: 'unavailable', binding: null }); delete unknownResult.goal
  const unknown = await fixture({ result: unknownResult }).service.inspect(bot)
  assert.equal(Object.hasOwn(unknown, 'goal'), false); assert.equal(unknown.availability, 'unavailable')
  const unsupported = await fixture({ result: native({ availability: 'unsupported', outcome: 'unsupported', binding: null, goal: null }) }).service.inspect(bot)
  assert.equal(unsupported.availability, 'unsupported'); assert.ok(Object.values(unsupported.capabilities).every(value => !value))
  const ended = fixture({ observe: async () => ({ schema: 'aiterm.pty-observe-result.v1', session_id: 'owned-seat', exists: false, launch_id: null }) })
  assert.equal((await ended.service.inspect(bot)).availability, 'unavailable'); assert.deepEqual(ended.calls, [])
})

test('明示Owner操作だけがhost metadataになり、目的と指定予算をnativeへ一度渡す', async () => {
  const { service, calls } = fixture({ result: native({ outcome: 'applied', mutation: 'acknowledged' }) })
  await assert.rejects(service.mutate(bot, { action: 'edit', binding, objective: '新目的' }), { code: 'GOAL_OWNER_ACTION_REQUIRED' })
  assert.deepEqual(calls, [])
  const result = await service.mutate(bot, { action: 'edit', binding, objective: '新目的', tokenBudget: 1000 }, { origin: 'user' })
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(calls, [['agent_goal', { session_id: 'owned-seat', launch_id: launch, action: 'edit', expected_thread_id: 'native-thread', objective: '新目的', token_budget: 1000 }, { meta: { 'aiterm/goal': { origin: 'user' } } }]])
})

test('古いlaunch・別sessionを変更せず、非同期の観測後も全体停止の入場状態を確認する', async () => {
  const f = fixture()
  for (const wrong of [{ ...binding, launchId: 'b'.repeat(32) }, { ...binding, sessionId: 'other-seat' }])
    await assert.rejects(f.service.mutate(bot, { action: 'pause', binding: wrong }, { origin: 'user' }), { code: 'GOAL_BINDING_CHANGED' })
  assert.deepEqual(f.calls, [])
  const paused = fixture({ admitWork: () => () => { throw Object.assign(new Error('paused'), { code: 'AI_GLOBAL_PAUSED', status: 423 }) } })
  await assert.rejects(paused.service.mutate(bot, { action: 'resume', binding }, { origin: 'user' }), { code: 'AI_GLOBAL_PAUSED' })
  assert.deepEqual(paused.calls, [])
})

test('MCP isErrorのtyped結果を失わず、応答不明は成功にも再送にもしない', async () => {
  const data = native({ outcome: 'outcome_unknown', mutation: 'outcome_unknown', readback: 'failed' }); delete data.goal
  const client = new AitermClient({ env: {} }); client.connect = async () => {}
  client.client = { async callTool() { return { isError: true, structuredContent: data, content: [{ type: 'text', text: 'unconfirmed' }] } } }
  let returned
  try { await client.call('agent_goal', {}) } catch (error) { returned = error }
  assert.deepEqual(returned.agentGoalResult, data)
  const f = fixture({ result: returned })
  const result = await f.service.mutate(bot, { action: 'pause', binding }, { origin: 'user' })
  assert.equal(result.outcome, 'unconfirmed'); assert.equal(result.snapshot.availability, 'unavailable')
  assert.equal(Object.hasOwn(result.snapshot, 'goal'), false); assert.equal(f.calls.length, 1)
})

test('native拒否と取得不能は具体的に返し、壊れた返却は診断と不明状態へ残す', async () => {
  const rejected = fixture({ result: Object.assign(new Error('rejected'), { agentGoalResult: native({ outcome: 'rejected', mutation: 'rejected' }) }) })
  await assert.rejects(rejected.service.mutate(bot, { action: 'resume', binding }, { origin: 'user' }), { code: 'GOAL_REJECTED', status: 409 })
  const invalid = fixture({ result: native({ goal: { ...goal, threadId: 'foreign-thread' } }) })
  assert.equal((await invalid.service.inspect(bot)).availability, 'unavailable')
  assert.equal(invalid.reports.length, 1)
  const lost = fixture({ result: new Error('transport disconnected') })
  assert.equal((await lost.service.mutate(bot, { action: 'clear', binding }, { origin: 'user' })).outcome, 'unconfirmed')
  assert.equal(lost.calls.length, 1); assert.equal(lost.reports.length, 1)
})
