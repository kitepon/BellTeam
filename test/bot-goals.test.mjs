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

function fixture({ result = native(), observe, admitWork, runningBots, goalTargets } = {}) {
  const calls = [], reports = []
  const transport = { session: bot => bot.session,
    runningBots: runningBots ?? (async bots => new Set(bots.map(bot => bot.id))),
    goalTargets: goalTargets ?? (async bots => {
      const running = runningBots ? await runningBots(bots) : new Set(bots.map(bot => bot.id))
      return new Map(bots.filter(bot => running.has(bot.id)).map(bot => [bot.id, { session_id: bot.session }]))
    }),
    observe: observe ?? (async () => ({ schema: 'aiterm.pty-observe-result.v1', session_id: 'owned-seat', exists: true, launch_id: launch })),
    client: { async call(...args) { calls.push(args); if (result instanceof Error) throw result; return { structuredContent: result } } },
  }
  return { calls, reports, service: new BotGoals({ transport, admitWork, reportError: async error => reports.push(error) }) }
}

test('全Goalは一度の現session一覧から閉席を除き、現存席は従来のlaunch検証を通す', async () => {
  const observed = [], listed = []
  const { service, calls } = fixture({
    runningBots: async bots => { listed.push(bots.map(bot => bot.id)); return new Set([bot.id]) },
    observe: async target => { observed.push(target.id); return { schema: 'aiterm.pty-observe-result.v1', session_id: target.session, exists: true, launch_id: launch } },
  })
  const closed = { ...bot, id: 'closed', session: 'closed-seat' }
  const result = await service.list([bot, closed])
  assert.equal(listed.length, 1)
  assert.deepEqual(observed, [bot.id])
  assert.equal(calls.length, 1)
  assert.equal(result[0].availability, 'available')
  assert.equal(result[1].availability, 'unavailable')
  assert.equal(result[1].binding, null)
  assert.equal(Object.hasOwn(result[1], 'goal'), false)
})

test('session一覧の取得失敗を空Goalや変更可能なsnapshotにしない', async () => {
  const { service, calls, reports } = fixture({ runningBots: async () => { throw Error('list unavailable') } })
  const result = await service.list([bot])
  assert.equal(result[0].availability, 'unavailable')
  assert.equal(result[0].binding, null)
  assert.equal(Object.hasOwn(result[0], 'goal'), false)
  assert.ok(Object.values(result[0].capabilities).every(value => value === false))
  assert.deepEqual(calls, [])
  assert.equal(reports.length, 1)
})

test('一覧のlaunch snapshotでnative inspectへ進み、null/不正/stale値は観測fallbackで昇格しない', async () => {
  for (const listed of [launch, null, 'invalid', 'f'.repeat(32)]) {
    let observations = 0
    const { service, calls } = fixture({
      goalTargets: async () => new Map([[bot.id, { session_id: bot.session, launch_id: listed }]]),
      observe: async () => { observations++; throw Error('must not observe') },
    })
    const [value] = await service.list([bot])
    assert.equal(value.availability, listed === launch ? 'available' : 'unavailable')
    assert.equal(observations, 0)
    assert.equal(calls.length, typeof listed === 'string' && listed.length === 32 ? 1 : 0)
    if (calls.length) assert.equal(calls[0][1].action, 'inspect')
  }
})

test('一覧snapshotの後にBotのsession対応が変われば古いGoalを確定表示しない', async () => {
  let session = bot.session, started, release
  const entered = new Promise(resolve => { started = resolve }), held = new Promise(resolve => { release = resolve })
  const { service, calls } = fixture({ goalTargets: async () => new Map([[bot.id, { session_id: bot.session, launch_id: launch }]]) })
  service.transport.session = () => session
  service.transport.client.call = async (...args) => { calls.push(args); started(); await held; return { structuredContent: native() } }
  const reading = service.list([bot])
  await entered; session = 'different-session'; release()
  assert.equal((await reading)[0].availability, 'unavailable')
  assert.equal(calls.length, 1)
  assert.equal((await service.list([bot]))[0].availability, 'unavailable')
  assert.equal(calls.length, 1, 'new session mismatch must be rejected before the native read')
})

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

test('native field能力を操作と状態で制限し、省略された旧結果だけ従来能力を使う', async () => {
  const fields = { create: { objective: true, token_budget: true }, edit: { objective: true, token_budget: true, combined: false } }
  const result = await fixture({ result: native({ field_capabilities: fields }) }).service.inspect(bot)
  assert.deepEqual(result.fieldCapabilities, { create: { objective: false, tokenBudget: false, combined: false }, edit: { objective: true, tokenBudget: true, combined: false } })
  const budgetOnly = await fixture({ result: native({ field_capabilities: { ...fields, edit: { objective: false, token_budget: true } } }) }).service.inspect(bot)
  assert.deepEqual(budgetOnly.fieldCapabilities.edit, { objective: false, tokenBudget: true, combined: false })
  const legacy = await fixture().service.inspect(bot)
  assert.deepEqual(legacy.fieldCapabilities.edit, { objective: true, tokenBudget: true, combined: true })
  const disabled = await fixture({ result: native({ capabilities: { ...native().capabilities, edit: false }, field_capabilities: fields }) }).service.inspect(bot)
  assert.deepEqual(disabled.fieldCapabilities.edit, { objective: false, tokenBudget: false, combined: false })
})

test('不正なfield能力を有効な旧契約へ読み替えず、取得不能として診断する', async () => {
  for (const fields of [null, {}, { create: { objective: true, token_budget: true }, edit: { objective: true, token_budget: true, combined: 'false' } }]) {
    const f = fixture({ result: native({ field_capabilities: fields }) })
    const result = await f.service.inspect(bot)
    assert.equal(result.availability, 'unavailable'); assert.equal(f.reports.length, 1)
    assert.deepEqual(result.fieldCapabilities.edit, { objective: false, tokenBudget: false, combined: false })
  }
})

test('予算だけの編集を目的文なしで一回渡し、nativeの複合拒否は再送しない', async () => {
  const fields = { create: { objective: false, token_budget: false }, edit: { objective: false, token_budget: true } }
  const f = fixture({ result: native({ outcome: 'applied', mutation: 'acknowledged', field_capabilities: fields }) })
  assert.equal((await f.service.mutate(bot, { action: 'edit', binding, tokenBudget: 10 }, { origin: 'user' })).outcome, 'confirmed')
  assert.equal(f.calls[0][1].token_budget, 10); assert.equal(Object.hasOwn(f.calls[0][1], 'objective'), false); assert.equal(f.calls.length, 1)
  const denied = fixture({ result: native({ outcome: 'unsupported', mutation: 'not_issued', field_capabilities: fields }) })
  await assert.rejects(denied.service.mutate(bot, { action: 'edit', binding, objective: '目的', tokenBudget: 10 }, { origin: 'user' }), { code: 'GOAL_UNAVAILABLE' })
  assert.equal(denied.calls.length, 1)
})

const claude = overrides => native({ schema: 'aiterm.agent-goal-result.v2', harness: 'claude-code',
  capabilities: { inspect: true, create: false, edit: false, pause: false, resume: false, clear: true },
  field_capabilities: { create: { objective: false, token_budget: false }, edit: { objective: false, token_budget: false } },
  goal: { kind: 'claude-code', phase: 'active', native: { type: 'goal_status', condition: 'Claudeの元の条件', met: false } }, ...overrides })

test('Claude V2はnative型のまま取り込み、欠測会計・turnsや変更能力を補わない', async () => {
  const response = claude()
  const { service } = fixture({ result: response })
  const current = await service.inspect({ ...bot, harness: 'claude' })
  assert.equal(current.availability, 'available'); assert.deepEqual(current.goal, response.goal)
  assert.deepEqual(current.capabilities, response.capabilities)
  assert.deepEqual(current.fieldCapabilities.edit, { objective: false, tokenBudget: false, combined: false })
  for (const key of ['tokenBudget', 'tokensUsed', 'timeUsedSeconds', 'reported_turns']) assert.equal(Object.hasOwn(current.goal, key), false)
})

test('Claude clearは現在nullと元条件cleared履歴を返し、達成やturn停止へ変えない', async () => {
  const history = { kind: 'claude-code', terminal: 'cleared', native: { type: 'goal_status', condition: '元の条件', met: true, sentinel: true } }
  const f = fixture({ result: claude({ goal: null, native_history: history, outcome: 'applied', mutation: 'acknowledged' }) })
  const result = await f.service.mutate({ ...bot, harness: 'claude' }, { action: 'clear', binding }, { origin: 'user' })
  assert.equal(result.outcome, 'confirmed'); assert.equal(result.snapshot.goal, null)
  assert.deepEqual(result.snapshot.nativeHistory, history)
  assert.ok(Object.values(result.snapshot.capabilities).every((value, i) => i === 0 || value === false))
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].action, 'clear')
})

test('V2の別native型・壊れた会計・clearを達成とした履歴は取得不能にする', async () => {
  const active = claude().goal
  for (const response of [claude({ harness: 'codex-cli' }), claude({ goal: { ...active, native: { ...active.native, tokens: null } } }),
    claude({ goal: { ...active, reported_turns: -1 } }), claude({ goal: null, native_history: {
      kind: 'claude-code', terminal: 'achieved', native: { type: 'goal_status', condition: '取消条件', met: true, sentinel: true },
    } })]) {
    const f = fixture({ result: response }); assert.equal((await f.service.inspect(bot)).availability, 'unavailable')
    assert.equal(f.reports.length, 1)
  }
})

test('Codex V2のnative wrapperでもthread照合とactive/paused操作maskを維持する', async () => {
  const result = await fixture({ result: native({ schema: 'aiterm.agent-goal-result.v2', goal: { kind: 'codex-cli', native: { ...goal, status: 'paused' } } }) }).service.inspect(bot)
  assert.equal(result.availability, 'available'); assert.equal(result.capabilities.pause, false)
  assert.equal(result.capabilities.resume, true); assert.equal(result.goal.native.objective, goal.objective)
  const wrong = fixture({ result: native({ schema: 'aiterm.agent-goal-result.v2', goal: { kind: 'codex-cli', native: { ...goal, threadId: 'other' } } }) })
  assert.equal((await wrong.service.inspect(bot)).availability, 'unavailable')
})

test('V2 MCP isErrorのunknownを保持し、goal省略をnullや成功にしない', async () => {
  const data = claude({ outcome: 'outcome_unknown', mutation: 'outcome_unknown', readback: 'failed' }); delete data.goal
  const client = new AitermClient({ env: {} }); client.connect = async () => {}
  client.client = { async callTool() { return { isError: true, structuredContent: data, content: [] } } }
  let error
  try { await client.call('agent_goal', {}) } catch (failure) { error = failure }
  assert.deepEqual(error.agentGoalResult, data)
  const f = fixture({ result: error })
  const result = await f.service.mutate(bot, { action: 'clear', binding }, { origin: 'user' })
  assert.equal(result.outcome, 'unconfirmed'); assert.equal(result.snapshot.availability, 'unavailable')
  assert.equal(Object.hasOwn(result.snapshot, 'goal'), false); assert.equal(f.calls.length, 1)
})
