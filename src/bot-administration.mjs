import { randomUUID } from 'node:crypto'
import { configurationRequestFailure } from './configuration-request.mjs'
import { stopFailureReport } from './stop-failure-report.mjs'
import { startMemberRemoval } from './members/deletion.mjs'
import { executionFailureReport, reportExecutionFailure } from './execution-failure-report.mjs'
import { automaticConfigurationApplication, automaticConfigurationView, validConfigurationOperationId, configurationOperationError } from './automatic-configuration-application.mjs'

// Botの設定変更・停止・削除の業務判断。HTTP APIと、HTTP経由で届く席MCPのupdate_self/update_bot/delete_botが
// 同じ判断を使う。応答の形と状態コードはHTTPが持ち、ここは保存と稼働中の席への反映の順序を決める。
export class BotAdministration {
  constructor({ bots, rooms, transport, moduleOperations = null, writeLog = line => process.stderr.write(line), reportError = () => {}, trackCompletion = () => {} }) {
    this.bots = bots
    this.rooms = rooms
    this.transport = transport
    this.moduleOperations = moduleOperations
    this.writeLog = writeLog
    this.reportError = reportError
    this.trackCompletion = trackCompletion
    this.applications = new Map()
    this.applicationCompletions = new Map()
    this.automaticConfigurationOperations = new Map()
  }

  view(bot) {
    const application = this.applications.get(bot.id)
    const request = this.transport.configurationRequests?.view(bot.id)
    const automatic = automaticConfigurationView(this.automaticConfigurationOperations, bot.id)
    return { ...bot, ...(application ? { configurationApplication: structuredClone(application) } : {}),
      ...(request ? { configurationRequest: request } : {}),
      ...(automatic ? { automaticConfigurationApplication: automatic } : {}) }
  }

  readConfigurationOperation(botId, requestId) {
    if (!this.bots.get(botId)) throw configurationOperationError('BOT_NOT_FOUND', 404)
    if (!validConfigurationOperationId(requestId)) throw configurationOperationError('CONFIGURATION_OPERATION_ID_INVALID', 400)
    const live = this.handoff?.operations.get(requestId)
    if (live?.botId === botId) return this.handoff.read(live).catch(() => {
      throw configurationOperationError('CONFIGURATION_OPERATION_READ_UNAVAILABLE', 503)
    })
    try {
      const record = this.automaticConfigurationOperations.get(botId)?.records.get(requestId)
      if (!record) throw configurationOperationError('CONFIGURATION_OPERATION_NOT_RECORDED', 404)
      return automaticConfigurationApplication(record, requestId)
    } catch (error) {
      if (error?.code === 'CONFIGURATION_OPERATION_NOT_RECORDED') throw error
      throw configurationOperationError('CONFIGURATION_OPERATION_READ_UNAVAILABLE', 503)
    }
  }

  // 保存は先に返し、稼働中Botへの適用は現在の作業の後に並ぶ。
  async update(botId, changes, { waitForApplication = false, expected, admissionCheck, handoffIngress } = {}) {
    const current = this.bots.get(botId)
    const candidate = await this.bots.previewUpdate(botId, changes)
    const harnessChanged = candidate.harness !== current.harness
    const fastModeChanged = candidate.fastMode !== current.fastMode
    const differs = harnessChanged || candidate.model !== current.model
      || candidate.reasoningEffort !== current.reasoningEffort || fastModeChanged
    const previous = this.applications.get(botId)
    const reapply = !differs && previous?.state === 'failed' && previous.fields.some(key =>
      Object.hasOwn(changes, key) && candidate[key] === previous.requested[key])
    const configurationChanged = reapply || differs
    const wasRunning = configurationChanged ? this.handoff?.current(botId) ? true : await this.transport.isRunning(current) : false
    admissionCheck?.()
    if (expected && ['harness', 'model', 'reasoningEffort', 'fastMode'].some(key => this.bots.get(botId)?.[key] !== expected[key]))
      throw Object.assign(new Error('CONTINUATION_SUPERSEDED'), { code: 'CONTINUATION_SUPERSEDED', effect: 'not_started' })
    const bot = await this.bots.update(botId, changes)
    const applying = wasRunning ? this.apply(current, candidate, { fastModeChanged, reapply, admissionCheck, handoffIngress }) : null
    if (applying && waitForApplication) {
      await applying
      if (this.applications.get(botId)?.state !== 'accepted')
        try { this.writeLog('BellTeam configuration result: CONTINUATION_CONFIGURATION_UNCONFIRMED\n') } catch {}
    }
    if (!wasRunning && configurationChanged) this.applications.delete(botId)
    return { bot: this.view(bot), harnessChanged, configurationChanged, applying: wasRunning }
  }

  apply(current, candidate, { fastModeChanged, reapply, admissionCheck, handoffIngress }) {
    const application = { state: 'pending', fields: reapply ? [...this.applications.get(current.id).fields]
      : ['harness', 'model', 'reasoningEffort', 'fastMode'].filter(key => candidate[key] !== current[key]), requested: {
      harness: candidate.harness, model: candidate.model ?? '',
      reasoningEffort: candidate.reasoningEffort ?? '', fastMode: candidate.fastMode === true,
    } }
    const previousApplying = this.applicationCompletions.get(current.id)
    this.applications.set(current.id, application)
    const requestId = handoffIngress || this.handoff?.current(current.id) || previousApplying ? randomUUID() : null
    if (requestId) application.requestId = requestId
    const stopVersion = this.transport.captureStopVersion?.(current)
    const assertCurrent = () => {
      admissionCheck?.()
      if (!requestId) return
      this.transport.requireStopVersion?.(current.id, stopVersion)
      if (this.applications.get(current.id) !== application || Object.entries(application.requested).some(([key, value]) =>
        (key === 'fastMode' ? this.bots.get(current.id)?.[key] === true : this.bots.get(current.id)?.[key] ?? '') !== value)) throw Object.assign(new Error('AUTOMATIC_CONFIGURATION_SUPERSEDED'), { code: 'AUTOMATIC_CONFIGURATION_SUPERSEDED', effect: 'not_started' })
    }
    const pending = (async () => {
      const old = this.handoff?.current(current.id)
      if (old) {
        void this.handoff.revoke(old, 'superseded', requestId)
        handoffIngress?.resolve(null)
        await old.completion
      }
      if (requestId && previousApplying) await previousApplying
      if (handoffIngress?.open && this.handoff) {
        const prepared = await this.handoff.prepare({ botId: current.id, current, candidate,
          ingress: handoffIngress.context, requestId, assertCurrent,
          deadline: handoffIngress.deadline, windowSignal: handoffIngress.window.signal })
        if (prepared && handoffIngress.open) {
          prepared.assertCurrent = assertCurrent
          let operation
          try { operation = this.handoff.begin(prepared) }
          catch (error) {
            await this.handoff.requests.finishNotIssued(current.id, prepared.context.operation).catch(() => {})
            throw error
          }
          handoffIngress.resolve(prepared.metadata)
          const terminal = await operation.completion
          if (!terminal.resumed) throw Object.assign(new Error('AUTOMATIC_CONFIGURATION_REVOKED'), { effect: 'possible' })
          return
        }
      }
      handoffIngress?.resolve(null)
      assertCurrent()
      return this.transport.reconfigure(current, candidate, {
        ...(reapply ? { reapply: true } : {}), ...(requestId ? { admissionCheck: assertCurrent, requestId } : admissionCheck ? { admissionCheck } : {}),
      })
    })()

      .then(result => {
        if (this.applications.get(current.id) === application) {
          application.state = 'accepted'
          if (result?.configurationRequest) application.requestId = result.configurationRequest.binding.id
        }
      })
      .catch(async error => {
        handoffIngress?.resolve(null)
        void reportExecutionFailure(this.reportError, current.id, 'configuration', error)
        try { this.writeLog(`BellTeam reconfigure error: ${JSON.stringify(executionFailureReport(current.id, 'configuration', error))}\n`) }
        catch { /* Logging must not change the application result. */ }
        if (this.applications.get(current.id) !== application) return
        const request = configurationRequestFailure(error)
        if (request) application.requestId = request.binding.id
        application.state = 'failed'
        const notStarted = ['not_started', 'not_issued'].includes(error.effect)
          || error.agentConfigureResult?.outcome === 'not_applied' && error.agentConfigureResult?.effect === 'not_started'
        const notApplied = error.code === 'CONFIGURATION_NOT_APPLIED'
        application.outcome = notStarted || notApplied ? 'not_applied' : 'outcome_unknown'
        application.effect = notStarted ? 'not_started' : 'possible'
        application.message = notApplied
          ? ['設定変更は反映されませんでした。', typeof error.reason === 'string' ? error.reason : '',
            notStarted ? '' : '後から一部が反映される可能性は、まだ除けていません。',
            '保存した設定は、次に席を起こし直した時に使います。'].join('')
          : notStarted
          ? '今回の設定変更は開始前に拒否されました。現在の動作設定は未確認です。'
          : '設定変更の結果を確認できません。一部が反映された可能性があります。'
        // RPC失敗は遠隔変更を取り消さない。開始前の拒否を確認できた時だけ元の希望へ戻す。
        if (fastModeChanged && notStarted && this.bots.get(current.id)?.fastMode === candidate.fastMode) await this.bots.update(current.id, { fastMode: current.fastMode })
      })
      .catch(error => this.writeLog(`BellTeam fast mode restore error: ${error.stack ?? error.message}\n`))
    this.applicationCompletions.set(current.id, pending)
    const clear = () => { if (this.applicationCompletions.get(current.id) === pending) this.applicationCompletions.delete(current.id) }
    pending.then(clear, clear)
    this.trackCompletion(pending)
    return pending
  }

  async configureFromMcp(botId, changes, context) {
    let complete
    const metadata = new Promise(resolve => { complete = resolve })
    const window = new AbortController()
    const handoffIngress = { context, window, deadline: performance.now() + 5000, open: true,
      resolve: value => { if (handoffIngress.open) { handoffIngress.open = false; window.abort(); complete(value) } } }
    const timer = setTimeout(() => handoffIngress.resolve(null), 5000)
    const cancel = () => handoffIngress.resolve(null)
    context?.signal?.addEventListener?.('abort', cancel, { once: true })
    if (context?.signal?.aborted) cancel()
    try {
      const value = await this.update(botId, changes, { handoffIngress })
      if (!value.applying) handoffIngress.resolve(null)
      return { value, handoffMetadata: await metadata }
    } finally { handoffIngress.resolve(null); clearTimeout(timer); context?.signal?.removeEventListener?.('abort', cancel) }
  }

  async reconcile(botId, id) {
    await this.bots.refresh?.()
    const bot = this.bots.get(botId)
    if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { status: 404 })
    const result = await this.transport.reconcileConfiguration(bot, id)
    const application = this.applications.get(botId)
    if (result.localCompletion && application?.requestId === id) application.localCompletion = result.localCompletion
    if (result.fence === 'cleared' && application?.requestId === id) {
      if (result.configurationRequest.outcome === 'applied') {
        application.state = 'accepted'
        delete application.outcome; delete application.effect; delete application.message
      } else {
        application.outcome = result.configurationRequest.outcome
        application.effect = application.outcome === 'not_applied' ? 'not_started' : 'possible'
        application.message = '元要求からの後発作用を除外しました。現在の動作設定は未確認です。'
      }
    }
    return result
  }

  // 会話を残した現在処理の中断。確認できない結果は成功へ丸めず、報告を残して失敗にする。
  async stop(bot) {
    try {
      const result = await this.transport.interrupt(bot)
      if (result?.botId !== bot.id || !(result.status === 'stop_sent' || result.status === 'interrupted' && result.sessionPreserved === true))
        throw new Error('BOT_STOP_UNCONFIRMED')
      return result
    } catch (error) {
      try { this.writeLog(`BellTeam stop failure: ${JSON.stringify(stopFailureReport(bot.id, error))}\n`) }
      catch { /* Reporting must not change the stop response or retry it. */ }
      const failure = Object.assign(new Error('BOT_STOP_UNCONFIRMED', { cause: error }), { code: 'BOT_STOP_UNCONFIRMED' })
      try {
        const automatic = automaticConfigurationView(this.automaticConfigurationOperations, bot.id)
        if (automatic) failure.automaticConfigurationApplication = automatic
      } catch { /* Projection failure must not replace the original stop failure. */ }
      throw failure
    }
  }

  restart(bot) {
    const application = this.applications.get(bot.id)
    const pending = this.transport.restart(bot).then(() => {
      if (this.applications.get(bot.id) === application) this.applications.delete(bot.id)
    })
      .catch(error => this.writeLog(`BellTeam restart error: ${error.stack ?? error.message}\n`))
    this.trackCompletion(pending)
  }

  remove(botId) {
    return startMemberRemoval(botId, { bots: this.bots, rooms: this.rooms, transport: this.transport,
      writeLog: this.writeLog, trackCompletion: this.trackCompletion,
      onRemoved: id => { this.applications.delete(id); this.automaticConfigurationOperations.delete(id) }, moduleOperations: this.moduleOperations })
  }
}
