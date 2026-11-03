import { configurationRequestFailure } from './configuration-request.mjs'
import { stopFailureReport } from './stop-failure-report.mjs'
import { startMemberRemoval } from './members/deletion.mjs'
import { executionFailureReport, reportExecutionFailure } from './execution-failure-report.mjs'

// Botの設定変更・停止・削除の業務判断。HTTP APIと、HTTP経由で届く席MCPのupdate_self/update_bot/delete_botが
// 同じ判断を使う。応答の形と状態コードはHTTPが持ち、ここは保存と稼働中の席への反映の順序を決める。
export class BotAdministration {
  constructor({ bots, rooms, transport, writeLog = line => process.stderr.write(line), reportError = () => {} }) {
    this.bots = bots
    this.rooms = rooms
    this.transport = transport
    this.writeLog = writeLog
    this.reportError = reportError
    this.applications = new Map()
  }

  view(bot) {
    const application = this.applications.get(bot.id)
    const request = this.transport.configurationRequests?.view(bot.id)
    return { ...bot, ...(application ? { configurationApplication: structuredClone(application) } : {}),
      ...(request ? { configurationRequest: request } : {}) }
  }

  // 保存は先に返し、稼働中Botへの適用は現在の作業の後に並ぶ。
  async update(botId, changes) {
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
    const wasRunning = configurationChanged ? await this.transport.isRunning(current) : false
    const bot = await this.bots.update(botId, changes)
    if (wasRunning) this.apply(current, candidate, { fastModeChanged, reapply })
    else if (configurationChanged) this.applications.delete(botId)
    return { bot: this.view(bot), harnessChanged, configurationChanged, applying: wasRunning }
  }

  apply(current, candidate, { fastModeChanged, reapply }) {
    const application = { state: 'pending', fields: reapply ? [...this.applications.get(current.id).fields]
      : ['harness', 'model', 'reasoningEffort', 'fastMode'].filter(key => candidate[key] !== current[key]), requested: {
      harness: candidate.harness, model: candidate.model ?? '',
      reasoningEffort: candidate.reasoningEffort ?? '', fastMode: candidate.fastMode === true,
    } }
    this.applications.set(current.id, application)
    this.transport.reconfigure(current, candidate, reapply ? { reapply: true } : undefined)
      .then(result => {
        if (this.applications.get(current.id) === application) {
          application.state = 'accepted'
          if (result?.configurationRequest) application.requestId = result.configurationRequest.binding.id
        }
      })
      .catch(async error => {
        void reportExecutionFailure(this.reportError, current.id, 'configuration', error)
        try { this.writeLog(`BellTeam reconfigure error: ${JSON.stringify(executionFailureReport(current.id, 'configuration', error))}\n`) }
        catch { /* Logging must not change the application result. */ }
        if (this.applications.get(current.id) !== application) return
        const request = configurationRequestFailure(error)
        if (request) application.requestId = request.binding.id
        application.state = 'failed'
        const notStarted = ['not_started', 'not_issued'].includes(error.effect)
          || error.agentConfigureResult?.outcome === 'not_applied' && error.agentConfigureResult?.effect === 'not_started'
        application.outcome = notStarted ? 'not_applied' : 'outcome_unknown'
        application.effect = notStarted ? 'not_started' : 'possible'
        application.message = notStarted
          ? '今回の設定変更は開始前に拒否されました。現在の動作設定は未確認です。'
          : '設定変更の結果を確認できません。一部が反映された可能性があります。'
        // RPC失敗は遠隔変更を取り消さない。開始前の拒否を確認できた時だけ元の希望へ戻す。
        if (fastModeChanged && notStarted && this.bots.get(current.id)?.fastMode === candidate.fastMode) await this.bots.update(current.id, { fastMode: current.fastMode })
      })
      .catch(error => this.writeLog(`BellTeam fast mode restore error: ${error.stack ?? error.message}\n`))
  }

  async reconcile(botId, id) {
    await this.bots.refresh?.()
    const bot = this.bots.get(botId)
    if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { status: 404 })
    const result = await this.transport.reconcileConfiguration(bot, id)
    const application = this.applications.get(botId)
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
      throw Object.assign(new Error('BOT_STOP_UNCONFIRMED', { cause: error }), { code: 'BOT_STOP_UNCONFIRMED' })
    }
  }

  restart(bot) {
    const application = this.applications.get(bot.id)
    this.transport.restart(bot).then(() => {
      if (this.applications.get(bot.id) === application) this.applications.delete(bot.id)
    })
      .catch(error => this.writeLog(`BellTeam restart error: ${error.stack ?? error.message}\n`))
  }

  remove(botId) {
    return startMemberRemoval(botId, { bots: this.bots, rooms: this.rooms, transport: this.transport,
      writeLog: this.writeLog, onRemoved: id => this.applications.delete(id) })
  }
}
