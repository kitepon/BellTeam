import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadBotEnvironment } from './bot-environment.mjs'
import { reserveExecution, dispatchExecution, interruptExecutions, sendStopOperations } from './execution-transport.mjs'
import { sendSessionStop } from './session-interruption.mjs'
import { AitermClient, textResult } from './aiterm-client.mjs'
import { latestThroughlineHandoffContext } from './throughline-context.mjs'
import { runWaitProcess } from './aiterm-wait-process.mjs'
import { BotSessionState } from './bot-session-state.mjs'
import { DeliveryJob } from './delivery-job.mjs'
import { SeatActivity, SeatTurnWatch } from './seat-activity.mjs'

export { AitermClient } from './aiterm-client.mjs'
export { completedThroughlineTurns, latestThroughlineHandoffContext, NIGHTLY_RESTART_TURNS } from './throughline-context.mjs'

const HARNESS = new Map([
  ['claude', 'claude-code'],
  ['codex', 'codex-cli'],
  ['grok', 'grok-cli'],
  ['cursor', 'cursor-cli'],
])
// 合間の言葉を取りに行く間隔。Aitermのpty_observeは画面本文を読まない軽い呼び出し。
const INTERIM_INTERVAL_MS = 3000
// Aitermは、要求の_metaにこの印がある時だけ、BellTeamのための手がかりを結果へ足す（Aiterm ADR 0071・0122）。
const CALLER_META = { 'aiterm/caller': 'BellTeam' }

// Ordinary delivery uses Aiterm directly. Execution tracking never gates input.
// Stop forwarding uses the direct agent_stop control.
export function createManagedTransport({ client = new AitermClient(), ...options } = {}) {
  return new AitermTransport({ ...options, client, executionBridge: null, requestStop: (sessions, stopOptions) => sendSessionStop(client, sessions, stopOptions) })
}

// BellTeamとAitermの間。席の状態（BotSessionState）と席の活動（SeatActivity）を持ち、一回の配送（DeliveryJob）を進める。
// Aitermのnativeな実行判断はAitermに在り、ここは返却を事実として受け取る。
export class AitermTransport {
  constructor({ client = new AitermClient(), executionBridge = null, requestStop = null, tempRoot = tmpdir(), waitProcess = runWaitProcess, handoffContext = latestThroughlineHandoffContext, prepareStartup = async () => {}, updateSession = async () => {}, updateFastMode = async () => {}, requireAccess = async () => {}, assertWorkAllowed = () => {}, activeId = randomUUID, now = () => new Date().toISOString(), interimInterval = INTERIM_INTERVAL_MS } = {}) {
    this.client = client
    this.executionBridge = executionBridge
    this.requestStop = requestStop
    this.interimInterval = interimInterval
    this.tempRoot = tempRoot
    this.waitProcess = waitProcess
    this.handoffContext = handoffContext
    this.prepareStartup = prepareStartup
    this.updateSession = updateSession
    this.updateFastMode = updateFastMode
    this.requireAccess = requireAccess
    this.assertWorkAllowed = assertWorkAllowed
    this.activeId = activeId
    this.now = now
    this.retainedImages = new Map()
    this.activity = new SeatActivity()
    this.sessionState = new BotSessionState({
      assertWorkAllowed: () => this.assertWorkAllowed(),
      executionBridge: () => this.executionBridge,
      call: (name, args, options) => this.client.call(name, args, options),
      invalidateRunning: () => { this.runningSnapshot = null },
      activity: {
        configuration: id => this.activity.configurationChanges.has(id),
        waking: id => this.activity.waking.has(id),
        hasJobs: id => this.activity.hasJobs(id),
        idle: id => this.activity.idle(id),
      },
    })
    // Aitermへ向く処理（execution-transport）に渡す席の窓口。transport全体ではなく、使う操作だけ。
    const transport = this
    this.seat = {
      sessionState: this.sessionState,
      activity: this.activity,
      get executionBridge() { return transport.executionBridge },
      requestStop: (sessions, options) => this.requestStop(sessions, options),
      session: bot => this.session(bot),
      observe: bot => this.observe(bot),
      wake: (bot, options) => this.wake(bot, options),
      imageFiles: images => this.imageFiles(images),
      removeTemporaryImages: files => this.removeTemporaryImages(files),
    }
    // Compatibility references share the components' actual state, never copies.
    this.sessions = this.sessionState.sessions
    this.stopVersions = this.sessionState.stopVersions
    this.stopSessions = this.sessionState.stopSessions
    this.sessionChanges = this.sessionState.sessionChanges
    this.uncertainChanges = this.sessionState.uncertainChanges
    this.active = this.activity.active
    this.jobs = this.activity.jobs
    this.watches = this.activity.watches
    this.followedTurns = this.activity.followedTurns
    this.configurationChanges = this.activity.configurationChanges
    this.dispatches = this.activity.dispatches
    this.waking = this.activity.waking
  }

  get executionStopping() { return this.sessionState.stopping }
  set executionStopping(value) { this.sessionState.stopping = value }

  async isRunning(bot) {
    return (await this.runningBots([bot])).has(bot.id)
  }

  // 渡したBotのうち、席が動いているもののid。Aitermのpty_listは呼ぶたびにtmuxを1回起動するので、
  // 一覧のように何人も続けて調べる時は、Botごとに呼ばずこれを1回呼ぶ。
  async runningBots(bots) {
    const pending = this.runningSnapshot ??= Promise.resolve().then(() => this.client.call('pty_list'))
      .then(result => new Set(textResult(result).split('\n').map(line => line.split('\t', 1)[0])))
    let sessions
    try { sessions = await pending }
    finally { if (this.runningSnapshot === pending) this.runningSnapshot = null }
    return new Set(bots.filter(bot => sessions.has(this.session(bot))).map(bot => bot.id))
  }

  // Botが動いているか止まっているかを人が見るための、CLI画面の末尾そのまま。
  async screen(bot) {
    if (!await this.isRunning(bot)) return { online: false, screen: '' }
    const result = await this.client.call('pty_read', {
      session_id: this.session(bot), screen: true, raw: true, timeout: 0, lines: 40,
    })
    return { online: true, screen: cleanScreen(textResult(result)) }
  }

  async ensure(bot) {
    this.assertWorkAllowed()
    this.requireSessionKnown(bot.id)
    const version = this.captureStopVersion(bot)
    if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
    this.requireStopVersion(bot.id, version)
    const running = await this.isRunning(bot)
    this.requireStopVersion(bot.id, version)
    if (running) return this.session(bot)
    return this.wake(bot)
  }

  wake(bot, options = {}) {
    this.assertWorkAllowed()
    this.requireSessionKnown(bot.id)
    return this.activity.waking.track(bot.id, this.wakeNow(bot, options))
  }

  async wakeNow(bot, { setupTest = false, execution = null } = {}) {
    const version = this.captureStopVersion(bot)
    if (this.executionBridge && !execution) await this.awaitUnboundAdmission(bot, version)
    await this.requireAccess({ setupTest, botId: bot.id })
    await mkdir(bot.project, { recursive: true })
    const harness = HARNESS.get(bot.harness)
    if (!harness) throw new Error(`HARNESS_UNSUPPORTED: ${bot.harness}`)
    const shortTermMemory = await this.handoffContext(bot.project)
    await this.prepareStartup(bot, shortTermMemory)
    const env = await loadBotEnvironment(bot.project)
    let launch
    try {
      this.requireStopVersion(bot.id, version)
      launch = await this.changeSession(bot, 'agent_launch', {
        harness,
        cwd: bot.project,
        session_name: execution?.reservation.target.session_id ?? bot.id,
        trust_project: true,
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.reasoningEffort ? { reasoning_effort: bot.reasoningEffort } : {}),
        // 既定はファストモードを使わない（オーナー裁定 2026-10-12）。共有の設定に残った値で起きないよう、必ず真偽で渡す。
        fast: bot.fastMode === true,
      }, { env, ...(execution ? { execution } : {}) })
    } catch (error) {
      // 起動の準備が終わらなかった席は、Aitermの端末だけが残る（認証が切れたCLIがサインインの画面で止まった時など。2026-10-05、Codex）。
      // 残すと席が「動いている」扱いになり、次の送信から起こし直せず、入力も受け付けない。BellTeamの席には、その画面へ答える人が居ない。
      // 残った端末を閉じて、次の送信がもう一度起こせるようにする。ここでは起こし直しも送り直しもしない（オーナー裁定 K-UTA3UC）。
      const leftover = error.launch?.session_id
      if (!execution && typeof leftover === 'string' && leftover) {
        try {
          await this.changeSession(bot, 'pty_close', { session_id: leftover })
        } catch (closeError) {
          process.stderr.write(`BellTeam Aiterm: 起動に失敗した席を閉じられませんでした: ${bot.id}: ${closeError.message}\n`)
        }
        const reason = error.launch.startup?.reason
        error.publicMessage = reason === 'startup_dialog'
          ? 'このBotを起動できず、メッセージは送信されませんでした。AIが起動時の画面で止まりました。AIの認証が切れている可能性があります。'
          : `このBotを起動できず、メッセージは送信されませんでした（${reason ?? '理由不明'}）。`
      }
      throw error
    }
    const session = launch.structuredContent?.session_id
    if (typeof session !== 'string' || !session) throw new Error(`AITERM_LAUNCH_RECEIPT_INVALID: ${bot.id}`)
    this.sessions.set(bot.id, session)
    await this.updateSession(bot.id, session)
    // Aitermは、ファストモードにできなかった席も通常の速度で起こし、実際の状態を返す（利用枠が尽きた時など）。
    // 保存が「有効」のまま実際は通常の速度、という食い違いを残さないよう、保存を実際へ合わせる。
    if (bot.fastMode === true && launch.structuredContent.fast === false) {
      const reason = launch.structuredContent.fast_error?.code
      process.stderr.write(`BellTeam Aiterm: ファストモードで起こせなかったため、通常の速度で起こしました: ${bot.id}${typeof reason === 'string' ? `（${reason}）` : ''}\n`)
      await this.updateFastMode(bot.id, false)
    }
    return session
  }

  async restart(bot) {
    this.assertWorkAllowed()
    this.requireSessionKnown(bot.id)
    const version = this.captureStopVersion(bot)
    if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
    await this.idle(bot.id)
    this.requireStopVersion(bot.id, version)
    const session = await this.restartNow(bot, version)
    return { botId: bot.id, session }
  }

  async reconfigure(current, next) {
    this.assertWorkAllowed()
    this.requireSessionKnown(current.id)
    const version = this.captureStopVersion(current)
    if (this.executionBridge) await this.awaitUnboundAdmission(current, version)
    await this.requireAccess({ setupTest: false, botId: next.id })
    await this.idle(current.id)
    this.requireStopVersion(current.id, version)
    const requiresRestart = current.harness !== next.harness
      || (current.model && !next.model)
      || (current.reasoningEffort && !next.reasoningEffort)
    if (requiresRestart) {
      const session = await this.restartNow(next, version)
      return { botId: next.id, session, mode: 'restart' }
    }
    const configuration = { session_id: this.session(next) }
    if (current.model !== next.model) configuration.model = next.model
    if (current.reasoningEffort !== next.reasoningEffort) configuration.reasoning_effort = next.reasoningEffort
    if ((current.fastMode === true) !== (next.fastMode === true)) configuration.fast = next.fastMode === true
    if (next.harness === 'cursor' && configuration.reasoning_effort && !configuration.model) configuration.model = next.model
    await this.changeSession(current, 'agent_configure', configuration)
    return { botId: next.id, session: this.session(next), mode: 'configure' }
  }

  async stop(bot, version = this.captureStopVersion(bot)) {
    if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
    await this.idle(bot.id)
    this.requireStopVersion(bot.id, version)
    const result = await this.changeSession(bot, 'pty_close', { session_id: this.session(bot) })
    await this.removeRetainedImages(bot.id)
    return result
  }

  // 会話を残した現在処理の中断。通常の停止配送か旧追跡adapterを使う。
  interrupt(bot) {
    if (!this.requestStop && !this.executionBridge) return Promise.reject(Object.assign(
      new Error('処理の中断を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED' }))
    return this.interruptMany([bot]).then(result => {
      if (result.unconfirmedBotIds.length) throw Object.assign(
        new Error('処理の中断を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED', cascade: result.cascade })
      return result.requestSent ? { botId: bot.id, status: 'stop_sent' }
        : { botId: bot.id, status: 'interrupted', sessionPreserved: true }
    })
  }

  interruptMany(bots, options = {}) {
    if (this.requestStop) return sendStopOperations(this.seat, bots, options)
    if (!this.executionBridge) throw Object.assign(new Error('EXECUTION_BRIDGE_REQUIRED'), { code: 'BOT_STOP_UNCONFIRMED' })
    const stopping = interruptExecutions(this.seat, bots)
    // The historical adapter still interrupts the turn, but cannot confirm
    // native goal pause. Keep the owner's global stop visibly unconfirmed.
    return options.pauseGoals ? stopping.then(result => ({ ...result, unconfirmedBotIds: [...new Set(bots.map(bot => bot.id))] })) : stopping
  }

  requireStopVersion(botId, version) {
    return this.sessionState.requireStopVersion(botId, version)
  }

  // session_idだけに作用する変更の発行と返却を追う。応答待ちのcloseを残したまま同じ席を起こさない。
  captureStopVersion(bot) {
    return this.sessionState.captureStopVersion(bot)
  }

  awaitUnboundAdmission(bot, version, barrier) {
    return this.sessionState.awaitUnboundAdmission(bot, version, barrier)
  }

  changeSession(bot, name, args, options) {
    return this.sessionState.changeSession(bot, name, args, options)
  }

  requireSessionKnown(botId) {
    return this.sessionState.requireSessionKnown(botId)
  }

  reconcileLaunch(bot, request, target) {
    return this.sessionState.reconcileLaunch(bot, request, target)
  }

  closeLaunch(bot, inputRequest, inputTarget) {
    return this.sessionState.closeLaunch(bot, inputRequest, inputTarget)
  }

  // セッションの状態と活動をAitermに観測させる。cursorを渡すと、前回の観測からの変化も返る。
  async observe(bot, cursor) {
    const result = await this.client.call('pty_observe', { session_id: this.session(bot), ...(cursor ? { cursor } : {}) })
    return result.structuredContent
  }

  // 動いていない席を閉じる。配送中・配送待ちがあれば閉じない。閉じた後の配送は不達になり、通常の経路で起動し直す。
  closeIdle(bot) {
    if (!this.isIdle(bot.id) || this.activity.configurationChanges.has(bot.id)) return Promise.resolve(false)
    // 閉じている間の送信は、設定変更と同じ順序で、閉じ終わってから通常の不達復旧へ進める。
    return this.activity.configurationChanges.track(bot.id, (async () => {
      await this.changeSession(bot, 'pty_close', { session_id: this.session(bot) })
      await this.removeRetainedImages(bot.id)
      return true
    })())
  }

  stopForConfiguration(bot) {
    const version = this.captureStopVersion(bot)
    const barrier = this.executionStopping
    const run = async () => {
      if (this.executionBridge) await this.awaitUnboundAdmission(bot, version, barrier)
      return this.stop(bot, version)
    }
    const previous = this.activity.configurationChanges.get(bot.id) ?? Promise.resolve()
    // 失敗時は次の配送にもエラーを返し、利用者が設定を直すまで旧登録へ送らない。
    return this.activity.configurationChanges.track(bot.id, previous.then(run, run), { clearOnFailure: false })
  }

  turn(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null, admissionCheck = () => {} } = {}) {
    return this.submit(bot, message, { images, info: queue, onStatus, onInterim, admissionCheck, transcript: true })
  }

  // BellTeamが追っているターンの合間の言葉を、完了まで数秒おきにAitermから受け取る。
  // stop()は最後にもう一度読んでターン末尾の言葉を拾い、エラーの知らせを受け取ったかを返す。
  // fromは読み始める位置（差し込みの返りと席の今のターンが返す値）。無い時は最後のdispatchから読む。
  // turnIdを渡すと、ほかのターンの言葉を出さない（読み始める位置より後は、次のターンの言葉も返るため）。
  followInterim(session, receipt, onInterim, { from = null, turnId = null } = {}) {
    let after = 0
    let stopped = false
    let broken = false
    let wake = null
    const seen = { error: false }
    const read = async () => {
      if (broken) return
      try {
        const data = await this.readInterim(session, after, from)
        if (!data || data.event_cursor !== receipt.event_cursor) return
        const fresh = data.words.filter(word => word.seq > after)
        if (!fresh.length) return
        after = fresh.at(-1).seq
        const words = turnId ? fresh.filter(word => !word.turn_id || word.turn_id === turnId) : fresh
        if (!words.length) return
        if (words.some(word => word.kind === 'error')) seen.error = true
        await onInterim(words.map(word => ({ text: word.text, kind: word.kind, ...(word.at ? { at: word.at } : {}) })))
      } catch (error) {
        broken = true
        process.stderr.write(`BellTeam interim words error: ${error.stack ?? error.message}\n`)
      }
    }
    const loop = (async () => {
      while (!stopped) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, this.interimInterval)
          wake = () => { clearTimeout(timer); resolve() }
        })
        if (!stopped) await read()
      }
    })()
    return {
      stop: async () => {
        stopped = true
        wake?.()
        await loop
        await read()
        return seen
      },
    }
  }

  // Aitermはpty_observeの_metaに"aiterm/caller": "BellTeam"がある時だけ、結果の_metaへ合間の言葉を付ける（Aiterm ADR 0071）。
  async readInterim(session, after, from = null) {
    const result = await this.client.call('pty_observe', { session_id: session }, {
      meta: { ...CALLER_META, 'aiterm/interim_after': after, ...(from ? { 'aiterm/interim_from': from } : {}) },
    })
    const data = result?._meta?.['aiterm/interim_words']
    if (!data) return null
    if (data.schema !== 'aiterm.interim-words.v1' || data.error || !Array.isArray(data.words))
      throw new Error(`AITERM_INTERIM_WORDS_INVALID: ${data.error ?? data.schema}`)
    return data
  }

  setupTest(bot) {
    return this.submit(bot, 'BellTeamのセットアップの動作確認です。「接続できました」と一文で返答してください。ツールで他のメンバーへ連絡する必要はありません。', { transcript: true, setupTest: true })
  }

  // 通知で始まったターンの最後の回答は誰にも配送しない。onAnswerがあれば、そのBotの会話画面へ出すために渡す。
  // onTurnEndは、差し込みではなく新しく始まったターンが終わった時だけ、その時間の幅を渡して呼ぶ。
  async notify(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, executionSource, recoveredExecution } = {}) {
    const completion = this.submit(bot, message, { images, info: queue, onStatus, onInterim, onAnswer, onTurnEnd, executionSource, recoveredExecution })
    completion.catch(error => process.stderr.write(`BellTeam Aiterm delivery error: ${error.stack ?? error.message}\n`))
    return completion.accepted
  }

  async restartNow(bot, version = this.stopVersions.get(bot.id)) {
    await this.requireAccess({ setupTest: false, botId: bot.id })
    this.requireStopVersion(bot.id, version)
    await this.changeSession(bot, 'pty_close', { session_id: this.session(bot) })
    await this.removeRetainedImages(bot.id)
    this.requireStopVersion(bot.id, version)
    return this.wake(bot)
  }

  // 一回の配送。受付（Aitermの受理）までと、受理したターンの終わりまでを一つのjobとして進める。
  // 続けてよいかはjobの停止結論と席の状態に聞き、停止の結論を決めるのはjob（DeliveryJob）だけ。
  submit(bot, message, { images = [], info = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, transcript = false, setupTest = false, admissionCheck = () => {}, executionSource, recoveredExecution = null } = {}) {
    const job = new DeliveryJob({
      id: this.activeId(), bot, startedAt: this.now(),
      executionSource: executionSource ? structuredClone(executionSource) : null,
      info: { ...info, message: info.message ?? message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}) },
      stopping: () => this.executionStopping,
    })
    this.activity.register(job)
    const check = () => {
      job.assertNotStopped()
      this.assertWorkAllowed()
      admissionCheck()
      this.requireSessionKnown(bot.id)
    }
    const parent = this.activity.latest(bot.id)
    let accept
    let rejectAcceptance
    const accepted = new Promise((resolve, reject) => { accept = resolve; rejectAcceptance = reject })
    accepted.catch(() => {})
    let acknowledged = false
    const completion = (async () => {
      let delivery
      // 差し込んだ文を取ったターンの終わりまで追ったか。追えなかった差し込みの画像は、次のターンまで残す。
      let followed = false
      try {
        await this.executionStopping?.catch(() => {})
        job.assertNotStopped()
        const configuration = this.activity.configurationChanges.get(bot.id)
        if (configuration) await configuration
        check()
        if (recoveredExecution) {
          if (recoveredExecution.reservation.request.kind !== 'delivery'
            || recoveredExecution.reservation.request.delivery_id !== info.groupId
            || recoveredExecution.binding?.target?.launch.session_id !== this.session(bot))
            throw Object.assign(new Error('EXECUTION_INVALID'), { code: 'EXECUTION_INVALID', effect: 'not_started' })
          job.execution = recoveredExecution
          job.executionWasPresent = true
        } else if (this.executionBridge) await reserveExecution(this.seat, job)
        check()
        this.activity.admit(job)
        await this.requireAccess({ setupTest, botId: bot.id })
        check()
        delivery = await this.dispatchInOrder(bot, message, images, { setupTest, check, executionJob: job })
        // 受理した。送信中に届いた停止の結果があれば、この受理と照らす。
        job.receipt = delivery.receipt
        await job.applyStopResult(job.executionStopResult)
        await job.checkpoint()
        const steered = delivery.receipt.mode === 'agent_steer'
        followed = !steered || delivery.steer !== null
        // 同じ席のターンをもう追っているjobが在れば、合間の言葉はそちらが出す（同じ言葉を2回出さない）。
        const follower = steered ? this.activity.follower(bot.id) : null
        // 次の送信はこの印を見て決めるので、返りを受け取ってからここまでawaitを挟まない。
        job.follows = followed && !follower
        await onStatus?.('running')
        await job.checkpoint()
        acknowledged = true
        accept({ delivery: steered ? 'steered' : 'running' })
        // 待つ手がかりを返さない差し込み（Aiterm 0.59.1まで）は、同じ席のjobの終わりを待つ。無ければ、終わりを知る道が無い。
        if (!followed) {
          if (parent) await parent.completion
          await job.checkpoint()
          await onStatus?.('delivered')
          return { delivery: 'steered' }
        }
        const interim = onInterim && job.follows
          ? this.followInterim(delivery.session, delivery.receipt, onInterim, { from: delivery.steer?.interimFrom }) : null
        let completion
        try {
          completion = await this.waitUntilDone(delivery.receipt, job.controller.signal)
        } catch (error) {
          const seen = await interim?.stop()
          // 記録にエラーの知らせが無い時（Grok・Cursor、記録に残らない利用上限）は、Aitermが返した理由を代わりに出す。
          if (interim && !seen.error && String(error.message).startsWith('AITERM_TURN_'))
            await onInterim([{ text: error.message, kind: 'error' }])
          throw error
        }
        await interim?.stop()
        await job.checkpoint()
        await job.finishExecution('completion')
        if (completion.turn_id) this.activity.followedTurns.set(bot.id, completion.turn_id)
        // 動いていたターンが取り込んだ差し込みは、そのターンの一部。回答は、そのターンを始めた側が出す
        // （BellTeamが始めたターンは元の配送、席が自分で始めたターンはself-turns.mjs）。
        // 取り込まれたかを見分けられなかった時（unknown）も、回答を2回出さないよう同じに扱う。
        if (steered && completion.steer?.placement !== 'next_turn') {
          await follower?.completion.catch(() => {})
          await job.checkpoint()
          await onStatus?.('delivered')
          return { delivery: 'steered' }
        }
        // ここから先は、この文が始めたターン（前のターンが終わった後で新しいターンになった差し込みも含む）。
        const readAnswer = async () => transcriptText(await this.client.call('pty_read', {
          session_id: delivery.session,
          agent_transcript: true,
          ...(completion.operation_id ? { operation_id: completion.operation_id } : {}),
        }), completion)
        const answer = transcript ? await readAnswer() : undefined
        await job.checkpoint()
        // 画面に出すだけの回答なので、読めなくても配送は完了として扱う。
        if (!transcript && onAnswer) {
          try {
            const text = await readAnswer()
            await job.checkpoint()
            if (typeof text === 'string' && text.trim()) await onAnswer(text)
          } catch (error) {
            process.stderr.write(`BellTeam answer read error: ${error.stack ?? error.message}\n`)
          }
        }
        await job.checkpoint()
        await onStatus?.('delivered')
        await job.checkpoint()
        onTurnEnd?.({ startedAt: job.startedAt, endedAt: this.now() })
        return transcript ? answer : { delivery: 'delivered' }
      } catch (cause) {
        const error = await job.failure(cause)
        if (!acknowledged) rejectAcceptance(error)
        await onStatus?.(job.stopped ? 'stopped' : 'failed')
        throw error
      } finally {
        const temporary = delivery?.imageFiles.filter(file => file.temporary) ?? []
        if (!job.stopped && delivery?.receipt.mode === 'agent_steer' && !followed && !parent && temporary.length) {
          const retained = this.retainedImages.get(bot.id) ?? []
          retained.push(...temporary)
          this.retainedImages.set(bot.id, retained)
        } else await this.removeTemporaryImages(delivery?.imageFiles)
        this.activity.release(job)
      }
    })()
    job.completion = completion
    completion.accepted = accepted
    return completion
  }

  // その席のターンを終わりまで追っているjob（配送で始めたターン、追っている差し込み、見つけた席のターン）。
  follower(botId) {
    return this.activity.follower(botId)
  }

  // 席の今のターン（Aiterm 0.60.0、ADR 0122）。席のsessionごとに、動いているターン・{ state: 'idle' }・null（分からない）。
  // まずCodexの席だけが返り、ほかのハーネスはnull。返さない版のAitermではnullを返す。画面は読まない。
  async seatTurns() {
    const result = await this.client.call('pty_list', {}, { meta: CALLER_META })
    const data = result?._meta?.['aiterm/seat_turns']
    if (!data) return null
    if (data.schema !== 'aiterm.seat-turns.v1' || data.error || !Array.isArray(data.seats))
      throw new Error(`AITERM_SEAT_TURNS_INVALID: ${data.error ?? data.schema}`)
    return new Map(data.seats.map(seat => [seat.session_id, seat.turn]))
  }

  // BellTeamが始めていないターン（Aitermの子の結果で始まったターンなど）を見つけて追う。
  // 席の今のターンを返さない版のAitermではfalseを返す。
  async watchSeatTurns(bots, { onInterim = null, groupId = randomUUID } = {}) {
    const versions = new Map(bots.map(bot => [bot.id, this.stopVersions.get(bot.id)]))
    const turns = await this.seatTurns()
    if (!turns) return false
    for (const bot of bots) {
      if (versions.get(bot.id) !== this.stopVersions.get(bot.id)) continue
      const session = this.session(bot)
      const turn = turns.get(session)
      const watch = this.activity.watches.get(bot.id)
      // 追っているターンがもう動いていない。止められたターンでは、Aitermの待ちは返らない（完了の印だけを待つ）。
      // nullは「分からない」なので、追い続ける。
      if (watch && turn !== null && (turn?.state !== 'running' || turn.turn_id !== watch.turnId)) watch.end()
      if (turn?.state === 'running' && this.isIdle(bot.id) && this.activity.followedTurns.get(bot.id) !== turn.turn_id)
        this.watchTurn(bot, session, turn, { onInterim, groupId })
    }
    return true
  }

  // 見つけたターンを終わりまで「処理中」に出し、合間の言葉を出す。
  // 回答は運ばない。席が自分で始めたターンの回答は、self-turns.mjsがThroughlineから出す（オーナー裁定 2026-10-01）。
  watchTurn(bot, session, turn, { onInterim, groupId }) {
    const watch = new SeatTurnWatch({ id: this.activeId(), bot, turn, groupId: groupId(), now: this.now() })
    this.activity.beginWatch(watch)
    watch.completion = (async () => {
      const say = onInterim ? async words => {
        await onInterim(bot.id, watch.info.groupId, words)
        watch.shown.words.push(...words.filter(word => word.kind !== 'error').map(word => word.text.trim()).filter(Boolean))
      } : null
      const interim = say ? this.followInterim(session, turn, say, { from: turn.interim_from, turnId: turn.turn_id }) : null
      try {
        let failure = null
        await Promise.race([watch.ended, this.waitUntilDone(turn, watch.stop.signal).catch(error => { failure = error })])
        const seen = await interim?.stop()
        if (!failure || watch.stop.signal.aborted) return
        // エラーや利用上限で終わったターンは、配送したターンと同じく、記録に知らせが無い時だけAitermが返した理由を出す。
        if (interim && !seen.error && /^AITERM_TURN_(ERROR|RATE_LIMITED)/u.test(failure.message))
          await say([{ text: failure.message, kind: 'error' }])
        else process.stderr.write(`BellTeam seat turn: ${bot.id} のターンを終わりまで追えませんでした（${failure.message}）\n`)
      } catch (error) {
        process.stderr.write(`BellTeam seat turn error: ${error.stack ?? error.message}\n`)
      } finally {
        watch.shown.endedAt = Date.parse(this.now())
        this.activity.endWatch(watch)
      }
    })()
  }

  // 席が自分で始めたターンのうち、最後に追ったターンで合間の言葉として出した文と、追い終えた時刻。
  shownInSelfTurn(botId) {
    return this.activity.shownWords.get(botId) ?? null
  }

  idle(botId) {
    return this.activity.whenIdle(botId)
  }

  isIdle(botId) {
    return this.activity.idle(botId)
  }

  restartIfIdle(bot) {
    if (!this.isIdle(bot.id)) return Promise.resolve({ restarted: false, reason: 'busy' })
    return this.restart(bot).then(result => ({ restarted: true, ...result }))
  }

  queueItems(filter) {
    return this.activity.items(filter)
  }

  watchQueue(listener) {
    return this.activity.watch(listener)
  }

  emitQueue(item) {
    this.activity.emit(item)
  }

  // 同じ席への送信は、前の送信をAitermが受け付けてから始める。起こしている途中の席へ次の文が重なると、
  // Aitermは両方を新しいターンとして入力受付を待たせ、後の方を「未解決のturnがある」と断る（Aiterm 0.52.0）。
  // 受け付けた後なら、次の文は実行中のターンへの差し込みになる。
  dispatchInOrder(bot, message, images, options) {
    const run = () => { options?.check?.(); return this.dispatch(bot, message, images, options) }
    const delivery = (this.activity.dispatches.get(bot.id) ?? Promise.resolve()).then(run)
    this.activity.dispatches.track(bot.id, delivery.then(() => {}, () => {}))
    return delivery
  }

  async dispatch(bot, message, images, { setupTest = false, check = () => {}, executionJob } = {}) {
    if (this.executionBridge) {
      const delivery = await dispatchExecution(this.seat, executionJob, bot, message, images, { setupTest, check })
      return { ...delivery, steer: delivery.receipt.mode === 'agent_steer' ? steerFollow(delivery.result) : null }
    }
    check()
    const imageFiles = await this.imageFiles(images)
    try {
      check()
      let session = this.session(bot)
      let result
      try {
        result = await this.sendToSession(session, message, imageFiles)
      } catch (error) {
        check()
        const running = await this.isRunning(bot)
        check()
        if (running && error.code !== 'AGENT_SESSION_REQUIRED') throw error
        // Aitermは画面が無い席も同じ符号で断る（0.52.0）。画面が残っている時だけが登録の消失。
        // 画面は残り登録だけ消えた席は、起動もできない。閉じてから起こし直し、同じ文を1回だけ送る。
        if (running) {
          process.stderr.write(`BellTeam Aiterm agent registration lost, restarting: ${bot.id}\n`)
          await this.changeSession(bot, 'pty_close', { session_id: session })
          await this.removeRetainedImages(bot.id)
        }
        check()
        session = await this.wake(bot, { setupTest })
        check()
        result = await this.sendToSession(session, message, imageFiles)
      }
      const receipt = result.structuredContent
      if (receipt?.mode !== 'agent_steer'
        && (receipt?.mode !== 'agent_dispatch' || !Number.isInteger(receipt.event_cursor) || !receipt.wait_process))
        throw new Error(`AITERM_DISPATCH_RECEIPT_INVALID: ${bot.id}`)
      if (receipt.mode === 'agent_dispatch') await this.removeRetainedImages(bot.id)
      return { receipt, imageFiles, session, steer: receipt.mode === 'agent_steer' ? steerFollow(result) : null }
    } catch (error) {
      await this.removeTemporaryImages(imageFiles)
      throw error
    }
  }

  // 画像はaitermのimage引数へ渡す。harness別の添付手順（パスの先打鍵等）はaitermが吸収する（0.30.0）。
  // require_agentで、登録が無い席へ普通の端末として打たれる（mode=sent）のを止める。
  // BellTeamの印を付けると、差し込みの返りに、その文を取ったターンを追う手がかりが入る（Aiterm 0.60.0、ADR 0122）。
  async sendToSession(session, message, imageFiles) {
    this.assertWorkAllowed()
    return this.client.call('pty_send', {
      session_id: session,
      text: message,
      require_agent: true,
      ...(imageFiles.length ? { image: imageFiles.map(file => file.path) } : {}),
    }, { meta: CALLER_META })
  }

  session(bot) {
    return this.sessionState.session(bot)
  }

  async imageFiles(images) {
    const files = []
    try {
      for (const image of images) files.push(await this.imageFile(image))
      return files
    } catch (error) {
      await this.removeTemporaryImages(files)
      throw error
    }
  }

  async imageFile(image) {
    if (typeof image.path === 'string') return { path: image.path, temporary: false }
    if (typeof image.data !== 'string') throw new Error('IMAGE_INVALID')
    await mkdir(this.tempRoot, { recursive: true })
    const path = join(this.tempRoot, `bellteam-image-${randomUUID()}.${imageExtension(image.mime)}`)
    await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return { path, temporary: true }
  }

  // signalは、追うのをやめた時に待ちのprocessを止める（watchTurn）。
  async waitUntilDone(receipt, signal = null) {
    while (!signal?.aborted) {
      const result = await this.waitProcess(receipt.wait_process, signal)
      if (result.outcome === 'done') return result
      if (result.outcome === 'timeout' || result.outcome === 'running') continue
      // error: harnessの記録でturnがAPIエラー等で打ち切られた（Aiterm 0.31.0）。本文を残して配送失敗にする。
      if (result.outcome === 'error') throw new Error(`AITERM_TURN_ERROR: ${result.error ?? 'unknown'}`)
      // rate_limited: harnessの利用上限。Aitermが画面や記録から拾った上限の知らせを理由に残す。
      if (result.outcome === 'rate_limited' && result.rate_limit) throw new Error(`AITERM_TURN_RATE_LIMITED: ${result.rate_limit}`)
      throw new Error(`AITERM_TURN_${String(result.outcome).toUpperCase()}`)
    }
    throw new Error('AITERM_WAIT_STOPPED')
  }

  async removeTemporaryImages(imageFiles = []) {
    await Promise.all(imageFiles.filter(file => file.temporary).map(file => rm(file.path, { force: true })))
  }

  async removeRetainedImages(botId) {
    const images = this.retainedImages.get(botId) ?? []
    this.retainedImages.delete(botId)
    await this.removeTemporaryImages(images)
  }

  async close() {
    for (const watch of this.activity.watches.values()) watch.end()
    const botIds = new Set([...this.activity.active.values()].map(item => item.bot.id))
    await Promise.all([...botIds].map(botId => this.idle(botId)))
    await this.client.close?.()
  }
}



// 差し込みの返りにある、その文を取ったターンを追う手がかり（Aiterm 0.60.0、ADR 0122）。
// Aitermは、差し込みの控えを取れた時だけ、完了の位置・待ち・合間の言葉の読み始めをそろえて返す。
// そろっていない返り（0.59.1まで、控えを取れなかった時）は、追わずに今までどおり扱う。
function steerFollow(result) {
  const receipt = result.structuredContent
  const reference = result._meta?.['aiterm/steer']
  if (!Number.isInteger(receipt.event_cursor) || !receipt.wait_process) return null
  if (reference?.schema !== 'aiterm.steer-ref.v1' || typeof reference.interim_from !== 'string') return null
  return { interimFrom: reference.interim_from }
}

function transcriptText(result, completion) {
  if (result?.structuredContent?.schema === 'aiterm.pty-read-result.v1'
    && result.structuredContent.mode === 'agent_transcript') {
    if (completion.turn_id && result.structuredContent.turn_id !== completion.turn_id)
      throw new Error('AITERM_TRANSCRIPT_TURN_MISMATCH')
    return result.structuredContent.text
  }
  return textResult(result)
}

function imageExtension(mime) {
  const extension = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'],
  ]).get(mime)
  if (!extension) throw new Error('IMAGE_INVALID')
  return extension
}

// 人が見るための画面整形。起動時のシェルコマンドの塊（プロンプト行から起動引数の終わりまで）を落とし、
// 行末の空白を削り、連続する空行を1行にまとめ、末尾だけを返す。
export function cleanScreen(text, maxLines = 25) {
  const lines = String(text).replace(/\r/g, '').split('\n').map(line => line.replace(/\s+$/u, ''))
  const launchStart = lines.findIndex(line => /^[^\s]+@[^\s]+:[^\s]*\$ cd '/u.test(line))
  if (launchStart >= 0) {
    const launchEnd = lines.findIndex((line, index) => index >= launchStart && /<\/aiterm_subagent_context>'?\s*$/u.test(line))
    lines.splice(launchStart, (launchEnd >= launchStart ? launchEnd : launchStart) - launchStart + 1)
  }
  const collapsed = []
  for (const line of lines) {
    if (line === '' && collapsed.at(-1) === '') continue
    collapsed.push(line)
  }
  while (collapsed.at(-1) === '') collapsed.pop()
  while (collapsed[0] === '') collapsed.shift()
  return collapsed.slice(-maxLines).join('\n')
}
