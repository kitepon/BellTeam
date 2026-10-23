import { isDeepStrictEqual as same } from 'node:util'
import { stoppedError } from './bot-execution-errors.mjs'

// Keep the public cause strings while distinguishing a later uncertainty with
// the same cause. These identities are local to this transport, never wire IDs.
class UncertainSessionChanges extends Map {
  versions = new Map()
  set(id, cause, request = null) {
    this.versions.set(id, { request: structuredClone(request) })
    return super.set(id, cause)
  }
  delete(id) {
    this.versions.set(id, { request: null })
    return super.delete(id)
  }
  clear() {
    for (const id of this.keys()) this.versions.set(id, { request: null })
    super.clear()
  }
  version(id) { return this.versions.get(id) }
}

// BellTeam owns session-slot changes, their pending operations and uncertainty.
// Delivery/job state is supplied as observations; native execution stays in Aiterm.
export class BotSessionState {
  constructor({ assertWorkAllowed, executionBridge, call, invalidateRunning, activity }) {
    this.assertWorkAllowed = assertWorkAllowed
    this.bridge = executionBridge
    this.call = call
    this.invalidateRunning = invalidateRunning
    this.activity = activity
    this.sessions = new Map()
    this.stopVersions = new Map()
    this.stopSessions = new Map()
    this.sessionChanges = new Map()
    this.uncertainChanges = new UncertainSessionChanges()
  }

  get executionBridge() { return this.bridge() }

  requireStopVersion(botId, version) {
    this.assertWorkAllowed()
    if (this.stopVersions.get(botId) !== version) throw stoppedError()
  }

  captureStopVersion(bot) {
    if (this.executionBridge) this.stopSessions.set(bot.id, this.session(bot))
    return this.stopVersions.get(bot.id)
  }

  async awaitUnboundAdmission(bot, version, barrier = this.stopping) {
    while (barrier) {
      let result
      try { result = await barrier } catch (cause) {
        throw Object.assign(new Error('停止結果が未確認のため変更できません。', { cause }), { code: 'BOT_STOP_UNCONFIRMED', effect: 'not_started' })
      }
      if (barrier.rootIds?.has(bot.id) || result?.cascade?.targets.some(value => value.launch.session_id === this.session(bot)))
        throw Object.assign(stoppedError(), { effect: 'not_started' })
      barrier = this.stopping !== barrier ? this.stopping : null
    }
    if (this.stopVersions.get(bot.id) !== version) throw Object.assign(stoppedError(), { effect: 'not_started' })
    this.requireSessionKnown(bot.id)
  }

  changeSession(bot, name, args, options) {
    if (name !== 'pty_close') this.assertWorkAllowed()
    this.requireSessionKnown(bot.id)
    const { execution, ...clientOptions } = options ?? {}
    const version = this.captureStopVersion(bot), barrier = this.stopping
    let issued = false
    const invoke = () => {
      if (name !== 'pty_close') this.assertWorkAllowed()
      issued = true
      this.invalidateRunning()
      return execution ? execution.invoke(name, args, clientOptions) : this.call(name, args, options)
    }
    const pending = this.executionBridge && !execution ? (async () => {
      await this.awaitUnboundAdmission(bot, version, barrier)
      // A new stop can start between async admission and this continuation.
      while (this.stopping) await this.awaitUnboundAdmission(bot, version)
      if (this.stopVersions.get(bot.id) !== version) throw Object.assign(stoppedError(), { effect: 'not_started' })
      this.requireSessionKnown(bot.id)
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
    pending.then(clear, error => {
      // RPCのrejectは遠隔の変更を取り消さない。後から旧closeが届き得る同名の席を自動で再利用しない。
      if (issued && ((error?.effect !== 'not_started' && error?.aitermResponseReturned !== true && error?.launch?.schema !== 'aiterm.agent-launch-result.v1')
        || error?.executionError?.effect === 'possible'))
        this.uncertainChanges.set(bot.id, name, execution?.reservation?.request)
      clear()
    })
    return pending
  }

  requireSessionKnown(botId) {
    if (!this.uncertainChanges.has(botId)) return
    const error = new Error('メンバーの状態を確認できないため、送信できませんでした。')
    error.code = 'BOT_SESSION_UNCONFIRMED'
    error.publicMessage = error.message
    throw error
  }

  async reconcileLaunch(bot, request, target) {
    this.assertWorkAllowed()
    const session = this.session(bot) ?? bot.id
    const uncertainty = this.uncertainChanges.get(bot.id)
    const uncertaintyVersion = this.uncertainChanges.version(bot.id)
    const version = this.captureStopVersion(bot)
    const busy = () => this.stopping || this.sessionChanges.has(bot.id) || this.activity.configuration(bot.id)
      || this.activity.interruption(bot.id) || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
    if (!this.executionBridge || target?.session_id !== session || request?.target_session_id !== session
      || (uncertainty && uncertainty !== 'agent_launch'))
      throw Object.assign(new Error('起動結果を照合できません。'), { code: 'BOT_SESSION_UNCONFIRMED' })
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
      if (this.stopping || this.uncertainChanges.get(bot.id) !== uncertainty
        || this.uncertainChanges.version(bot.id) !== uncertaintyVersion
        || this.sessionChanges.get(bot.id) !== changes || changes.size !== 1
        || this.activity.hasJobs(bot.id))
        throw Object.assign(new Error('照合中に席の状態が変わりました。'), { code: 'BOT_SESSION_UNCONFIRMED' })
      if (!same(execution.binding?.target?.launch, target)) throw new Error('EXECUTION_UNCONFIRMED')
      this.sessions.set(bot.id, session)
      this.uncertainChanges.delete(bot.id)
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
    const uncertainty = this.uncertainChanges.get(bot.id)
    const uncertaintyVersion = this.uncertainChanges.version(bot.id)
    const version = this.captureStopVersion(bot)
    const busy = () => this.stopping || this.sessionChanges.has(bot.id) || this.activity.configuration(bot.id)
      || this.activity.interruption(bot.id) || this.activity.waking(bot.id)
      || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
    if (!this.executionBridge || target?.session_id !== session || request?.target_session_id !== session
      || (uncertainty !== undefined && (uncertainty !== 'agent_launch' || !same(uncertaintyVersion?.request, request))))
      throw Object.assign(new Error('起動結果を照合できません。'), { code: 'BOT_SESSION_UNCONFIRMED' })
    if (busy()) throw Object.assign(new Error('この席は処理中です。'), { code: 'EXECUTION_BUSY', effect: 'not_started' })
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
      if (this.stopping || this.uncertainChanges.version(bot.id) !== uncertaintyVersion
        || this.uncertainChanges.get(bot.id) !== uncertainty
        || this.sessionChanges.get(bot.id) !== changes || changes.size !== 1
        || this.activity.configuration(bot.id) || this.activity.interruption(bot.id) || this.activity.waking(bot.id)
        || this.activity.hasJobs(bot.id) || !this.activity.idle(bot.id)
        || (this.session(bot) ?? bot.id) !== session)
        throw Object.assign(new Error('照合中に席の状態が変わりました。'), { code: 'BOT_SESSION_UNCONFIRMED' })
      this.sessions.delete(bot.id)
      this.invalidateRunning()
      this.uncertainChanges.delete(bot.id)
      return receipt
    } catch (error) {
      // With no prior local fence (for example after reconnect), a missing or
      // malformed close response still must not authorize a new dispatch.
      if (uncertainty === undefined && error.effect !== 'not_started'
        && this.uncertainChanges.version(bot.id) === uncertaintyVersion)
        this.uncertainChanges.set(bot.id, 'close_launch', request)
      throw error
    } finally {
      changes.delete(pending)
      if (!changes.size && this.sessionChanges.get(bot.id) === changes) this.sessionChanges.delete(bot.id)
    }
  }

  session(bot) {
    return this.sessions.get(bot.id) ?? bot.session
  }
}
