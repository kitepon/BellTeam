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
    if (result?.schema !== 'aiterm.agent-goal-result.v1' || result.session_id !== args.session_id || result.launch_id !== args.launch_id
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
    if (Object.hasOwn(result, 'goal') && !validGoal(result.goal, binding?.thread_id)) throw new Error('GOAL_STATE_INVALID')
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
      capabilities.pause &&= result.goal?.status === 'active'
      capabilities.resume &&= result.goal?.status === 'paused'
    }
    return { botId: bot.id, availability, capabilities, fieldCapabilities: fieldCapabilities(capabilities, result.field_capabilities),
      binding: result.binding ? { sessionId: result.binding.session_id, launchId: result.binding.launch_id, threadId: result.binding.thread_id } : null,
      ...(Object.hasOwn(result, 'goal') ? { goal: structuredClone(result.goal) } : {}),
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
