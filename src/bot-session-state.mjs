import { isDeepStrictEqual as same } from 'node:util'
import { stoppedError } from './bot-execution-errors.mjs'

// Only typed status fields cross into logs; launch text can contain credentials.
function changeReport(bot, name, args, result, error) {
  const value = result?.structuredContent ?? error?.launch
  const select = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null
  return {
    at: new Date().toISOString(), botId: select(bot.id, /^[A-Za-z0-9_-]{1,64}$/u), tool: name,
    session: select(args.session_id ?? args.session_name, /^[A-Za-z0-9_-]{1,64}$/u),
    returned: error === undefined || error?.aitermResponseReturned === true,
    isError: error === undefined ? result?.isError === true : error?.aitermResponseReturned === true ? true : null,
    schema: select(value?.schema, /^aiterm\.(?:pty-close|agent-launch)-result\.v1$/u),
    session_id: select(value?.session_id, /^[A-Za-z0-9_-]{1,64}$/u),
    launch_id: select(value?.launch_id, /^[a-f0-9]{32}$/u),
    outcome: select(value?.outcome, /^(?:closed|already_closed)$/u),
    startup: select(value?.startup?.status, /^(?:ready|not_checked|blocked)$/u),
    initial_prompt: select(value?.initial_prompt?.status, /^(?:not_requested|not_sent|submitted_unconfirmed|started)$/u),
  }
}

// BellTeam owns session-slot changes and their pending operations.
// Delivery/job state is supplied as observations; native execution stays in Aiterm.
export class BotSessionState {
  constructor({ assertWorkAllowed, executionBridge, call, invalidateRunning, invalidateWork = () => {}, activity, writeLog = line => process.stderr.write(line) }) {
    this.assertWorkAllowed = assertWorkAllowed
    this.bridge = executionBridge
    this.call = call
    this.invalidateRunning = invalidateRunning
    this.invalidateWork = invalidateWork
    this.activity = activity
    this.writeLog = writeLog
    this.sessions = new Map()
    this.stopVersions = new Map()
    this.stopSessions = new Map()
    this.sessionChanges = new Map()
  }

  get executionBridge() { return this.bridge() }

  requireStopVersion(botId, version) {
    this.assertWorkAllowed()
    if (this.stopVersions.get(botId) !== version) throw stoppedError()
  }

  // 停止世代を進める。進める前に捕まえた世代で待っている変更・起動・配送は、停止として終わる。
  invalidate(botId) {
    this.stopVersions.set(botId, (this.stopVersions.get(botId) ?? 0) + 1)
    this.invalidateWork(botId)
  }

  // 停止が届いた席名を捕まえていたBotを返し、根ではないものの世代も進める（子孫の席もBellTeamのメンバーであり得る）。
  invalidateReached(reached, rootIds) {
    const bots = new Set()
    for (const [id, session] of this.stopSessions) if (reached(session)) {
      bots.add(id)
      if (!rootIds.has(id)) this.invalidate(id)
    }
    return bots
  }

  captureStopVersion(bot) {
    if (this.executionBridge) this.stopSessions.set(bot.id, this.session(bot))
    return this.stopVersions.get(bot.id)
  }

  async awaitUnboundAdmission(bot, version, barrier = this.stopping) {
    while (barrier) {
      let result
      try { result = await barrier } catch (cause) {
        try { this.writeLog('BellTeam stop result: BOT_STOP_UNCONFIRMED\n') } catch {}
      }
      if (barrier.rootIds?.has(bot.id) || result?.cascade?.targets.some(value => value.launch.session_id === this.session(bot)))
        throw Object.assign(stoppedError(), { effect: 'not_started' })
      barrier = this.stopping !== barrier ? this.stopping : null
    }
    if (this.stopVersions.get(bot.id) !== version) throw Object.assign(stoppedError(), { effect: 'not_started' })
  }

  changeSession(bot, name, args, options) {
    if (name !== 'pty_close') this.assertWorkAllowed()
    const { execution, configurationRequest: _auditBinding, ...clientOptions } = options ?? {}
    const version = this.captureStopVersion(bot), barrier = this.stopping
    let issued = false
    const invoke = () => {
      if (name !== 'pty_close') this.assertWorkAllowed()
      if (['pty_close', 'agent_launch'].includes(name)) this.invalidateWork(bot.id)
      issued = true
      this.invalidateRunning()
      return execution ? execution.invoke(name, args, clientOptions) : this.call(name, args, clientOptions)
    }
    const pending = this.executionBridge && !execution ? (async () => {
      await this.awaitUnboundAdmission(bot, version, barrier)
      // A new stop can start between async admission and this continuation.
      while (this.stopping) await this.awaitUnboundAdmission(bot, version)
      if (this.stopVersions.get(bot.id) !== version) throw Object.assign(stoppedError(), { effect: 'not_started' })
      return invoke()
    })() : Promise.resolve(invoke())
    pending.executionBound = Boolean(execution)
    Object.defineProperty(pending, 'executionIssued', { get: () => issued })
    pending.executionSession = args.session_id ?? args.session_name
    const changes = this.sessionChanges.get(bot.id) ?? new Set()
    changes.add(pending)
    this.sessionChanges.set(bot.id, changes)
    const clear = () => {
      this.invalidateRunning()
      changes.delete(pending)
      if (!changes.size && this.sessionChanges.get(bot.id) === changes) this.sessionChanges.delete(bot.id)
    }
    const report = (result, error) => {
      if (!['pty_close', 'agent_launch'].includes(name) || !issued) return
      // Logging is observational and must not change the operation's outcome.
      try { this.writeLog(`BellTeam session result: ${JSON.stringify(changeReport(bot, name, args, result, error))}\n`) } catch {}
    }
    pending.then(result => { report(result); clear() }, error => {
      report(undefined, error)
      clear()
    })
    return pending
  }

  async reconcileLaunch(bot, request, target) {
    this.assertWorkAllowed()
    const session = this.session(bot) ?? bot.id
    const version = this.captureStopVersion(bot)
    const busy = () => this.stopping || this.sessionChanges.has(bot.id) || this.activity.configuration(bot.id)
      || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
    if (target?.session_id !== session || request?.target_session_id !== session)
      throw Object.assign(new Error('回復対象の席が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
    // Normal configuration (no bridge): the saved delivery is redelivered on the ordinary path, which wakes the seat
    // and keeps per-seat order. There is no registered execution to reconcile.
    if (!this.executionBridge) return null
    if (busy()) throw Object.assign(new Error('この席は処理中です。'), { code: 'EXECUTION_BUSY', effect: 'not_started' })
    // 既存の席変更一覧へ載せ、照合と設定変更・停止が交差しても不明を勝手に解除しない。
    const pending = this.executionBridge.reconcileLaunch(request, target)
    pending.executionBound = true
    pending.executionIssued = true
    pending.executionSession = session
    const changes = new Set([pending])
    this.sessionChanges.set(bot.id, changes)
    try {
      const execution = await pending
      this.requireStopVersion(bot.id, version)
      if (this.stopping || this.sessionChanges.get(bot.id) !== changes || changes.size !== 1
        || this.activity.hasJobs(bot.id))
        throw Object.assign(new Error('回復対象の席が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
      if (!same(execution.binding?.target?.launch, target)) throw Object.assign(new Error('回復対象の起動世代が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
      this.sessions.set(bot.id, session)
      return execution
    } finally {
      changes.delete(pending)
      if (!changes.size && this.sessionChanges.get(bot.id) === changes) this.sessionChanges.delete(bot.id)
    }
  }

  async closeLaunch(bot, inputRequest, inputTarget) {
    const { request, target } = structuredClone({ request: inputRequest, target: inputTarget })
    this.assertWorkAllowed()
    const session = this.session(bot) ?? bot.id
    const version = this.captureStopVersion(bot)
    const busy = () => this.stopping || this.sessionChanges.has(bot.id) || this.activity.configuration(bot.id)
      || this.activity.waking(bot.id) || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
    if (target?.session_id !== session || request?.target_session_id !== session)
      throw Object.assign(new Error('回復対象の席が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
    // Never close a seat whose turn is running; the turn ends and the close can be asked again.
    if (busy()) throw Object.assign(new Error('この席は処理中です。'), { code: 'EXECUTION_BUSY', effect: 'not_started' })
    // Normal configuration (no bridge): close the seat's terminal and launch record; the next delivery wakes it.
    if (!this.executionBridge) {
      const receipt = await this.changeSession(bot, 'pty_close', { session_id: session })
      this.sessions.delete(bot.id)
      return receipt?.structuredContent ?? { session_id: session, outcome: 'closed' }
    }
    // No session-only close, registration or body dispatch belongs here. The
    // product owns atomic original-request / expected-generation validation.
    const pending = this.executionBridge.closeLaunch(request, target)
    pending.executionBound = true
    pending.executionIssued = true
    pending.executionSession = session
    const changes = new Set([pending])
    this.sessionChanges.set(bot.id, changes)
    try {
      const receipt = await pending
      this.requireStopVersion(bot.id, version)
      if (this.stopping || this.sessionChanges.get(bot.id) !== changes || changes.size !== 1
        || this.activity.configuration(bot.id) || this.activity.waking(bot.id)
        || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
        || (this.session(bot) ?? bot.id) !== session)
        throw Object.assign(new Error('回復対象の席が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
      this.sessions.delete(bot.id)
      this.invalidateRunning()
      return receipt
    } finally {
      changes.delete(pending)
      if (!changes.size && this.sessionChanges.get(bot.id) === changes) this.sessionChanges.delete(bot.id)
    }
  }

  session(bot) {
    return this.sessions.get(bot.id) ?? bot.session ?? bot.id
  }
}
