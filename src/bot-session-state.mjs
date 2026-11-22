import { stoppedError } from './bot-execution-errors.mjs'

// Only typed status fields cross into logs; launch text can contain credentials.
function changeReport(bot, name, args, result, error) {
  const value = result?.structuredContent ?? error?.launch
  const select = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null
  return {
    at: new Date().toISOString(), botId: select(bot.id, /^[A-Za-z0-9_-]{1,64}$/u), tool: name,
    session: select(args.session_id ?? args.session_name, /^[A-Za-z0-9_-]{1,64}$/u),
    returned: error === undefined || error?.aitermResponseReturned === true,
    // An Aiterm error result (isError) carries its code only as the text's leading token ("AGENT_RESUME_CONFLICT: ...").
    code: select(error?.code ?? (result?.isError === true ? String(result.content?.[0]?.text ?? '').split(':')[0] : undefined), /^(?:AGENT|AITERM|ACCOUNT)_[A-Z_]{2,60}$/u),
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
  constructor({ assertWorkAllowed, call, invalidateRunning, invalidateWork = () => {}, activity, writeLog = line => process.stderr.write(line) }) {
    this.assertWorkAllowed = assertWorkAllowed
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
    return this.stopVersions.get(bot.id)
  }

  changeSession(bot, name, args, options) {
    if (name !== 'pty_close') this.assertWorkAllowed()
    const { execution, configurationRequest: _auditBinding, ...clientOptions } = options ?? {}
    let issued = false
    const invoke = () => {
      if (name !== 'pty_close') this.assertWorkAllowed()
      if (['pty_close', 'agent_launch'].includes(name)) this.invalidateWork(bot.id)
      issued = true
      this.invalidateRunning()
      return execution ? execution.invoke(name, args, clientOptions) : this.call(name, args, clientOptions)
    }
    const pending = Promise.resolve(invoke())
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
    if (target?.session_id !== session || request?.target_session_id !== session)
      throw Object.assign(new Error('回復対象の席が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
    // The ordinary path: the saved delivery is redelivered on the ordinary path, which wakes the seat
    // and keeps per-seat order. The value carries the identity the parent seam checks (binding.target.launch) and
    // tells submit to take ordinary dispatch; there is no registered execution to reconcile.
    return { ordinary: true, reservation: { request: structuredClone(request) }, binding: { target: { launch: structuredClone(target) } } }
  }

  async closeLaunch(bot, inputRequest, inputTarget) {
    const { request, target } = structuredClone({ request: inputRequest, target: inputTarget })
    this.assertWorkAllowed()
    const session = this.session(bot) ?? bot.id
    const busy = () => this.stopping || this.sessionChanges.has(bot.id) || this.activity.configuration(bot.id)
      || this.activity.waking(bot.id) || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
    if (target?.session_id !== session || request?.target_session_id !== session)
      throw Object.assign(new Error('回復対象の席が一致しません。'), { code: 'BOT_RECOVERY_TARGET_INVALID' })
    // Never close a seat whose turn is running; the turn ends and the close can be asked again.
    if (busy()) throw Object.assign(new Error('この席は処理中です。'), { code: 'EXECUTION_BUSY', effect: 'not_started' })
    // Close the seat's terminal and launch record; the next delivery wakes it.
    const receipt = await this.changeSession(bot, 'pty_close', { session_id: session })
    this.sessions.delete(bot.id)
    return receipt?.structuredContent ?? { session_id: session, outcome: 'closed' }
  }

  session(bot) {
    return this.sessions.get(bot.id) ?? bot.session ?? bot.id
  }
}
