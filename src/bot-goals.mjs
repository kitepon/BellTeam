// Native CLI state is authoritative. No goal file or continuation loop lives here.
const actions = ['inspect', 'create', 'edit', 'pause', 'resume', 'clear']
const statuses = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'])
const noCapabilities = () => Object.fromEntries(actions.map(action => [action, false]))
const fieldCapabilities = (capabilities, fields) => Object.fromEntries(['create', 'edit'].map(action => [action, {
  objective: capabilities[action] && (fields ? fields[action].objective : true),
  tokenBudget: capabilities[action] && (fields ? fields[action].token_budget : true),
  combined: capabilities[action] && (fields ? fields[action].objective && fields[action].token_budget && fields[action].combined !== false : true),
}]))
const failure = (code, status, message) => Object.assign(new Error(message), { code, status, publicMessage: message })
const validLaunch = id => typeof id === 'string' && /^[0-9a-f]{32}$/u.test(id)
const validGoal = (goal, thread) => goal === null || goal && goal.threadId === thread
  && typeof goal.objective === 'string' && goal.objective.trim() && statuses.has(goal.status)
  && (goal.tokenBudget === null || Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0)
  && Number.isSafeInteger(goal.tokensUsed) && goal.tokensUsed >= 0
  && ['timeUsedSeconds', 'createdAt', 'updatedAt'].every(key => Number.isFinite(goal[key]) && goal[key] >= 0)
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
const natural = value => Number.isSafeInteger(value) && value >= 0
const claudeStatus = native => keysOnly(native, ['type', 'condition', 'met', 'sentinel', 'reason', 'iterations', 'durationMs', 'tokens'])
  && native.type === 'goal_status' && typeof native.condition === 'string' && native.condition.length > 0 && typeof native.met === 'boolean'
  && (!Object.hasOwn(native, 'sentinel') || typeof native.sentinel === 'boolean')
  && (!Object.hasOwn(native, 'reason') || typeof native.reason === 'string')
  && ['iterations', 'tokens'].every(key => !Object.hasOwn(native, key) || natural(native[key]))
  && (!Object.hasOwn(native, 'durationMs') || Number.isFinite(native.durationMs) && native.durationMs >= 0)
const grokPhases = ['Idle', 'Planning', 'Executing']
const grokCounters = ['elapsed_ms', 'total_worker_rounds', 'total_verify_rounds', 'token_baseline', 'tokens_used_high_water',
  'parent_tokens_spent', 'last_session_tokens_seen', 'evaluator_blocked_streak', 'classifier_runs_attempted',
  'rounds_since_verify', 'classifier_stall_count', 'consecutive_not_achieved', 'last_strategist_fired_at', 'strategist_cap_bonus']
const grokSnapshot = native => keysOnly(native, ['goal_id', 'objective', 'status', 'phase', 'token_budget', 'created_at',
  'current_subagent_id', 'current_subagent_role', 'history', 'verifier_id', ...grokCounters])
  && typeof native.goal_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(native.goal_id)
  && typeof native.objective === 'string' && native.objective.length > 0
  && ['active', 'user_paused'].includes(native.status) && grokPhases.includes(native.phase)
  && Number.isSafeInteger(native.token_budget) && native.token_budget > 0
  && typeof native.created_at === 'string' && Number.isFinite(Date.parse(native.created_at))
  && ['current_subagent_id', 'current_subagent_role'].every(key => native[key] === null || typeof native[key] === 'string')
  && typeof native.verifier_id === 'string' && native.verifier_id.length > 0
  && grokCounters.every(key => natural(native[key]))
  && Array.isArray(native.history) && native.history.every(row => keysOnly(row, ['timestamp', 'event', 'detail'])
    && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) && typeof row.event === 'string'
    && (!Object.hasOwn(row, 'detail') || typeof row.detail === 'string'))
// The persisted phase and accounting are not the current worker observation.
const grokDisplay = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const grokElapsed = value => typeof value === 'string' && value.length <= 64
  && /^(?:\d+s|\d+m[0-5]\ds|\d+h[0-5]\dm)$/u.test(value)
const grokCurrent = current => (
  keysOnly(current, ['source', 'status', 'phase', 'tokens_used', 'elapsed_display'])
    && current.source === '/goal status' && ['Active', 'UserPaused'].includes(current.status) && grokPhases.includes(current.phase)
    && Number.isSafeInteger(current.tokens_used)
  || keysOnly(current, ['source', 'status', 'phase', 'tokens_used', 'status_display', 'phase_display', 'budget_display', 'elapsed_display'])
    && current.source === 'goal detail' && ['Active', 'Paused'].includes(current.status)
    && current.phase === null && current.tokens_used === null && grokDisplay(current.status_display, 128)
    && (current.phase_display === null || grokDisplay(current.phase_display, 64)) && grokDisplay(current.budget_display, 128)
) && grokElapsed(current.elapsed_display)
const validNativeGoal = (goal, result) => goal === null || (
  goal?.kind === 'codex-cli' && result.harness === 'codex-cli' && keysOnly(goal, ['kind', 'native'])
    && keysOnly(goal.native, ['threadId', 'objective', 'status', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'])
    && validGoal(goal.native, result.binding?.thread_id)
    && goal.native !== null
  || goal?.kind === 'claude-code' && result.harness === 'claude-code' && keysOnly(goal, ['kind', 'phase', 'native', 'reported_turns'])
    && goal.phase === 'active' && claudeStatus(goal.native) && goal.native.met === false
    && (!Object.hasOwn(goal, 'reported_turns') || natural(goal.reported_turns))
  || goal?.kind === 'grok-cli' && result.harness === 'grok-cli' && keysOnly(goal, ['kind', 'native', 'current_status'])
    && grokSnapshot(goal.native) && grokCurrent(goal.current_status)
)
const goalStatus = goal => goal?.kind === 'codex-cli' ? goal.native.status : goal?.kind === 'claude-code' ? goal.phase
  : goal?.kind === 'grok-cli' ? ['UserPaused', 'Paused'].includes(goal.current_status.status) ? 'paused' : 'active' : goal?.status

export class BotGoals {
  constructor({ transport, admitWork = () => () => {}, reportError = async () => {}, now = () => new Date().toISOString() }) {
    this.transport = transport; this.admitWork = admitWork; this.reportError = reportError; this.now = now
  }
  unavailable(bot, message = 'ゴールの状態を取得できません。更新して確認してください。') {
    const capabilities = noCapabilities()
    return { botId: bot.id, availability: 'unavailable', capabilities, fieldCapabilities: fieldCapabilities(capabilities), binding: null, observedAt: this.now(), message }
  }
  async list(bots) { return Promise.all(bots.map(bot => this.inspect(bot))) }

  async generation(bot) {
    const session = this.transport.session(bot)
    // Normal pty_observe reads an existing launch. It does not wake a Bot.
    const observation = await this.transport.observe(bot)
    if (observation?.schema !== 'aiterm.pty-observe-result.v1' || observation.session_id !== session
      || observation.exists !== true || !validLaunch(observation.launch_id)) throw failure('GOAL_UNAVAILABLE', 503, 'このメンバーのゴールを現在取得できません。')
    return { session_id: session, launch_id: observation.launch_id }
  }
  async call(args, ownerAction = false) {
    let result
    try {
      const response = await this.transport.client.call('agent_goal', args, ownerAction ? { meta: { 'aiterm/goal': { origin: 'user' } } } : {})
      result = response?.structuredContent
    } catch (error) {
      if (!error.agentGoalResult) throw error
      result = error.agentGoalResult
    }
    if (!['aiterm.agent-goal-result.v1', 'aiterm.agent-goal-result.v2'].includes(result?.schema) || result.session_id !== args.session_id || result.launch_id !== args.launch_id
      || !['available', 'unsupported', 'unavailable'].includes(result.availability)
      || !['observed', 'applied', 'rejected', 'outcome_unknown', 'unavailable', 'unsupported'].includes(result.outcome)
      || !['not_requested', 'not_issued', 'acknowledged', 'rejected', 'outcome_unknown'].includes(result.mutation)
      || !['confirmed', 'not_attempted', 'failed', 'mismatch'].includes(result.readback)
      || !actions.every(action => typeof result.capabilities?.[action] === 'boolean')
      || typeof result.reason !== 'string' || !Number.isFinite(Date.parse(result.observed_at))) throw new Error('GOAL_RESULT_INVALID')
    if (Object.hasOwn(result, 'field_capabilities') && !['create', 'edit'].every(action => {
      const fields = result.field_capabilities?.[action]
      return fields && typeof fields.objective === 'boolean' && typeof fields.token_budget === 'boolean'
        && (!Object.hasOwn(fields, 'combined') || typeof fields.combined === 'boolean')
    })) throw new Error('GOAL_FIELD_CAPABILITIES_INVALID')
    const binding = result.binding
    if (binding !== null && (!binding || binding.session_id !== args.session_id || binding.launch_id !== args.launch_id
      || typeof binding.thread_id !== 'string' || !binding.thread_id
      || args.expected_thread_id && binding.thread_id !== args.expected_thread_id)) throw new Error('GOAL_BINDING_INVALID')
    if (Object.hasOwn(result, 'goal') && !(result.schema === 'aiterm.agent-goal-result.v2'
      ? validNativeGoal(result.goal, result) : validGoal(result.goal, binding?.thread_id))) throw new Error('GOAL_STATE_INVALID')
    if (Object.hasOwn(result, 'native_history')) {
      const history = result.native_history
      if (result.schema !== 'aiterm.agent-goal-result.v2' || result.harness !== 'claude-code'
        || !keysOnly(history, ['kind', 'terminal', 'native']) || history.kind !== 'claude-code'
        || !claudeStatus(history.native) || history.native.met !== true
        || (history.terminal === 'cleared' ? history.native.sentinel !== true
          : history.terminal !== 'achieved' || history.native.sentinel === true)) throw new Error('GOAL_HISTORY_INVALID')
    }
    return result
  }
  snapshot(bot, result) {
    const known = result.availability === 'available' && result.binding && Object.hasOwn(result, 'goal')
    const availability = known ? 'available' : result.availability === 'unsupported' ? 'unsupported' : 'unavailable'
    const capabilities = known ? { ...result.capabilities } : noCapabilities()
    if (known) {
      capabilities.create &&= result.goal === null
      capabilities.edit &&= result.goal !== null
      capabilities.clear &&= result.goal !== null
      capabilities.pause &&= goalStatus(result.goal) === 'active'
      capabilities.resume &&= goalStatus(result.goal) === 'paused'
    }
    return { botId: bot.id, availability, capabilities, fieldCapabilities: fieldCapabilities(capabilities, result.field_capabilities),
      binding: result.binding ? { sessionId: result.binding.session_id, launchId: result.binding.launch_id, threadId: result.binding.thread_id } : null,
      ...(Object.hasOwn(result, 'goal') ? { goal: structuredClone(result.goal) } : {}),
      ...(Object.hasOwn(result, 'native_history') ? { nativeHistory: structuredClone(result.native_history) } : {}),
      observedAt: result.observed_at,
      message: availability === 'available' ? null : availability === 'unsupported'
        ? 'このメンバーではゴール機能をまだ利用できません。' : 'ゴールの状態を取得できません。更新して確認してください。' }
  }
  async inspect(bot) {
    try { return this.snapshot(bot, await this.call({ ...await this.generation(bot), action: 'inspect' })) }
    catch (error) {
      if (error.code !== 'GOAL_UNAVAILABLE') await this.reportError(error)
      return this.unavailable(bot)
    }
  }
  async mutate(bot, input, { origin } = {}) {
    if (origin !== 'user') throw failure('GOAL_OWNER_ACTION_REQUIRED', 403, 'オーナーの操作が必要です。')
    const stillAllowed = ['create', 'edit', 'resume'].includes(input.action) ? this.admitWork() : () => {}
    const target = await this.generation(bot)
    const expected = input.binding
    if (expected?.sessionId !== target.session_id || expected.launchId !== target.launch_id || typeof expected.threadId !== 'string' || !expected.threadId)
      throw failure('GOAL_BINDING_CHANGED', 409, 'メンバーの会話が変わりました。ゴールを更新して確認してください。')
    stillAllowed()
    const args = { ...target, action: input.action, expected_thread_id: expected.threadId,
      ...(Object.hasOwn(input, 'objective') ? { objective: input.objective } : {}),
      ...(Object.hasOwn(input, 'tokenBudget') ? { token_budget: input.tokenBudget } : {}) }
    let result
    try { result = await this.call(args, true) }
    catch (error) { await this.reportError(error); return { outcome: 'unconfirmed', snapshot: this.unavailable(bot) } }
    if (result.outcome === 'rejected') throw failure('GOAL_REJECTED', 409, 'このゴールの状態では操作できません。更新して確認してください。')
    if (['unavailable', 'unsupported'].includes(result.outcome)) throw failure('GOAL_UNAVAILABLE', 503, 'このメンバーのゴールを現在操作できません。')
    const confirmed = result.outcome === 'applied' && result.mutation === 'acknowledged' && result.readback === 'confirmed'
    return { outcome: confirmed ? 'confirmed' : 'unconfirmed', snapshot: this.snapshot(bot, result) }
  }
}
