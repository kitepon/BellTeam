import { stopFailureReport } from './stop-failure-report.mjs'

// Botの設定変更・停止・削除の業務判断。HTTP APIと、HTTP経由で届く席MCPのupdate_self/update_bot/delete_botが
// 同じ判断を使う。応答の形と状態コードはHTTPが持ち、ここは保存と稼働中の席への反映の順序を決める。
export class BotAdministration {
  constructor({ bots, rooms, transport, writeLog = line => process.stderr.write(line) }) {
    this.bots = bots
    this.rooms = rooms
    this.transport = transport
    this.writeLog = writeLog
    this.applications = new Map()
  }

  view(bot) {
    const application = this.applications.get(bot.id)
    return application ? { ...bot, configurationApplication: structuredClone(application) } : bot
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
      .then(() => {
        if (this.applications.get(current.id) === application) application.state = 'accepted'
      })
      .catch(async error => {
        this.writeLog(`BellTeam reconfigure error: ${current.id}: ${error.stack ?? error.message}\n`)
        if (this.applications.get(current.id) !== application) return
        application.state = 'failed'
        const notStarted = error.effect === 'not_started'
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

  // 席を閉じ、部屋から外し、台帳から消す。応答は待たせない。
  remove(botId) {
    const bot = this.bots.get(botId)
    void (async () => {
      await this.transport.stop(bot)
      await this.rooms.removeBot(botId)
      await this.bots.remove(botId)
      this.applications.delete(botId)
    })().catch(error => this.writeLog(`BellTeam delete error: ${error.stack ?? error.message}\n`))
  }
}
