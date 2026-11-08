import { CurrentWork } from './current-work.mjs'
import { randomUUID } from 'node:crypto'
import { MembersAdmission } from './members-admission.mjs'
import { configurationError } from './configuration-request.mjs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadBotEnvironment } from './bot-environment.mjs'
import { reserveExecution, dispatchExecution, interruptExecutions, sendStopOperations } from './execution-transport.mjs'
import { sendSessionStop, confirmedSessionClosure } from './session-interruption.mjs'
import { mcpRequestContext } from './mcp-request-context.mjs'
import { AitermClient, textResult } from './aiterm-client.mjs'
import { latestThroughlineHandoffContext } from './throughline-context.mjs'
import { runWaitProcess } from './aiterm-wait-process.mjs'
import { BotSessionState } from './bot-session-state.mjs'
import { DeliveryJob } from './delivery-job.mjs'
import { operationLease } from './aiterm-operation-lease.mjs'
import { SeatActivity, SeatTurnWatch } from './seat-activity.mjs'
import { executionFailureReport, reportExecutionFailure } from './execution-failure-report.mjs'
import { recoverableTurnFailure } from './capacity-continuation.mjs'
import { returnedMcpError } from './returned-mcp-error.mjs'
import { launchFailureDetails } from './agent-launch-error.mjs'
import { captureRuntime as captureSelectedRuntime } from './runtime-selection.mjs'
import { writeAtomic } from './json-file.mjs'

export { AitermClient } from './aiterm-client.mjs'
export { runWaitProcess } from './aiterm-wait-process.mjs'
export { completedThroughlineTurns, latestThroughlineHandoffContext, NIGHTLY_RESTART_TURNS } from './throughline-context.mjs'

const HARNESS = new Map([
  ['claude', 'claude-code'],
  ['codex', 'codex-cli'],
  ['grok', 'grok-cli'],
  ['cursor', 'cursor-cli'],
  ['antigravity', 'antigravity-cli'],
])
// 合間の言葉を取りに行く間隔。Aitermのpty_observeは画面本文を読まない軽い呼び出し。
const INTERIM_INTERVAL_MS = 3000
// 起こした直後の席へ同じ文を送る回数の上限（sendToWokenSession）。
const WOKEN_SEND_ATTEMPTS = 3
// Pre-input refusals of a live seat that clear by themselves (slow readiness, previous input still being taken).
const RESENDABLE = ['BOT_INPUT_NOT_READY', 'BOT_SEND_BUSY']
// The words may already be in the CLI: Aiterm or the RPC could not tell, or Aiterm says not to resend.
const outcomeUnknown = error => error.code === 'BOT_SEND_OUTCOME_UNKNOWN' || mcpRequestContext(error)?.outcome === 'unknown'
  || String(error.message).includes('再送しないでください')
// Aitermは、要求の_metaにこの印がある時だけ、BellTeamのための手がかりを結果へ足す（Aiterm ADR 0071・0122）。
const CALLER_META = { 'aiterm/caller': 'BellTeam' }

const configurationNeedsRestart = (current, next, reapply) => current.harness !== next.harness
  || (current.model && !next.model) || (current.reasoningEffort && !next.reasoningEffort)
  || (reapply && (!next.model || !next.reasoningEffort))

async function writeLocalImage(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
}

// Ordinary delivery uses Aiterm directly. Execution tracking never gates input.
// Stop forwarding uses the direct agent_stop control.
export function createManagedTransport({ client = new AitermClient(), ...options } = {}) {
  return new AitermTransport({ ...options, client, executionBridge: null, requestStop: (sessions, stopOptions) => sendSessionStop(client, sessions, stopOptions) })
}

// BellTeamとAitermの間。席の状態（BotSessionState）と席の活動（SeatActivity）を持ち、一回の配送（DeliveryJob）を進める。
// Aitermのnativeな実行判断はAitermに在り、ここは返却を事実として受け取る。
export class AitermTransport {
  constructor({ resolveBot = null, backgroundSummary = null, conversationAdmission = null, trackCompletion = () => {}, configurationRequests = null, membersAdmission = new MembersAdmission(), requireMember = async () => {}, client = new AitermClient(), executionBridge = null, requestStop = null, tempRoot = tmpdir(), writeTemporaryImage = writeLocalImage, removeTemporaryImage = path => rm(path, { force: true }), waitProcess = runWaitProcess, handoffContext = latestThroughlineHandoffContext, prepareStartup = async () => {}, updateSession = async () => {}, updateFastMode = async () => {}, requireAccess = async () => {}, assertWorkAllowed = () => {}, assertInputAllowed = () => {}, activeId = randomUUID, activityPath = null, captureRuntime = captureSelectedRuntime, runtimeLaunchesPath = null, now = () => new Date().toISOString(), interimInterval = INTERIM_INTERVAL_MS, reportError = () => {} } = {}) {
    this.backgroundSummary = backgroundSummary
    this.summaryJobs = new Set()
    this.latestSummaryInputs = new Map()
    this.conversationAdmission = conversationAdmission
    this.trackCompletion = trackCompletion
    this.resolveBot = resolveBot
    this.configurationRequests = configurationRequests
    this.membersAdmission = membersAdmission
    this.requireMember = requireMember
    this.client = client
    this.executionBridge = executionBridge
    this.requestStop = requestStop
    this.interimInterval = interimInterval
    this.tempRoot = tempRoot
    this.writeTemporaryImage = writeTemporaryImage
    this.removeTemporaryImage = removeTemporaryImage
    this.waitProcess = waitProcess
    this.reportError = reportError
    this.handoffContext = handoffContext
    this.prepareStartup = prepareStartup
    this.updateSession = updateSession
    this.updateFastMode = updateFastMode
    this.requireAccess = requireAccess
    this.assertWorkAllowed = assertWorkAllowed
    this.assertInputAllowed = assertInputAllowed
    this.captureRuntime = captureRuntime
    this.runtimeLaunchesPath = runtimeLaunchesPath
    this.runtimeLaunches = null
    this.runtimeLaunchQueue = Promise.resolve()
    this.activeId = activeId
    this.now = now
    this.retainedImages = new Map()
    this.activity = new SeatActivity()
    this.workState = new CurrentWork({ now, activityPath, reportActivity: () => this.reportError({ code: 'RESTART_ACTIVITY_UNAVAILABLE', module: 'execution' }), notify: id => this.activity.emit({ bot: { id } }) })
    this.restarts = new Map()
    this.sessionState = new BotSessionState({
      assertWorkAllowed: () => this.assertWorkAllowed(),
      executionBridge: () => this.executionBridge,
      call: (name, args, options) => this.client.call(name, args, options),
      invalidateRunning: () => { this.runningSnapshot = null },
      invalidateWork: id => { this.workState.invalidate(id); this.backgroundSummary?.invalidate(id) },
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
      // An engine handover may replace the registry with the predecessor's live one.
      get activity() { return transport.activity },
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

  // 履歴表示もscreen captureを使い、配送の共有読取位置を進めない。
  async screen(bot, { history = false } = {}) {
    let result
    try {
      result = await this.client.call('pty_read', {
        session_id: this.session(bot), screen: true, raw: true, timeout: 0, lines: history ? 10000 : 40,
      })
    } catch (error) {
      console.error('Screen read failed', error)
      return { online: false, screen: '' }
    }
    return { online: true, screen: cleanScreen(textResult(result), history ? 10000 : 25) }
  }

  async ensure(bot) {
    this.assertWorkAllowed()
    const version = this.captureStopVersion(bot)
    if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
    this.requireStopVersion(bot.id, version)
    const running = await this.isRunning(bot)
    this.requireStopVersion(bot.id, version)
    if (running) return this.session(bot)
    return this.wake(bot)
  }

  memberOperation(bot, operation, { membersLease, expected } = {}) {
    return this.membersAdmission.withLease(async lease => {
      await this.requireMember(bot, { membersLease: lease })
      this.membersAdmission.assertLease(lease)
      return operation(lease)
    }, { lease: membersLease, expected })
  }

  wake(bot, options = {}) {
    this.assertWorkAllowed()
    const version = this.captureStopVersion(bot)
    // setup.sh待ちはmembers leaseを取る前に行う。起動直後の一斉wakeでlease枠を埋めない。
    const ready = options.membersLease ? null : this.client.environmentReady?.(bot.project)
    return Promise.resolve(ready).then(() => this.memberOperation(bot, async membersLease => {
      this.requireStopVersion(bot.id, version)
      return this.activity.waking.track(bot.id, this.wakeNow(bot, { ...options, membersLease }))
    }, options))
  }

  async wakeNow(bot, { setupTest = false, execution = null, membersLease, admissionCheck } = {}) {
    if (!membersLease) return this.memberOperation(bot, lease => this.wakeNow(bot, { setupTest, execution, membersLease: lease, admissionCheck }))
    this.membersAdmission.assertLease(membersLease)
    const version = this.captureStopVersion(bot)
    if (this.executionBridge && !execution) await this.awaitUnboundAdmission(bot, version)
    await this.requireAccess({ setupTest, botId: bot.id })
    await mkdir(bot.project, { recursive: true })
    const harness = HARNESS.get(bot.harness)
    if (!harness) throw new Error(`HARNESS_UNSUPPORTED: ${bot.harness}`)
    const shortTermMemory = await this.handoffContext(bot.project)
    await this.prepareStartup(bot, shortTermMemory, { membersLease })
    this.membersAdmission.assertLease(membersLease)
    const runtime = await this.captureLaunchRuntime()
    const launchOptions = this.client.launchOptions
      ? await this.client.launchOptions(bot.project, runtime) : { env: await loadBotEnvironment(bot.project) }
    let launch
    try {
      this.requireStopVersion(bot.id, version)
      admissionCheck?.()
      launch = await this.changeSession(bot, 'agent_launch', {
        harness,
        cwd: bot.project,
        session_name: execution?.reservation.target.session_id ?? bot.id,
        trust_project: true,
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.reasoningEffort ? { reasoning_effort: bot.reasoningEffort } : {}),
        // 既定はファストモードを使わない（オーナー裁定 2026-10-12）。共有の設定に残った値で起きないよう、必ず真偽で渡す。
        fast: bot.fastMode === true,
      }, { ...launchOptions, ...(execution ? { execution } : {}) })
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
        error.publicMessage ??= reason === 'startup_dialog'
          ? 'このBotを起動できず、メッセージは送信されませんでした。AIが起動時の画面で止まりました。AIの認証が切れている可能性があります。'
          : `このBotを起動できず、メッセージは送信されませんでした（${reason ?? '理由不明'}）。`
      }
      throw error
    }
    const session = launch.structuredContent?.session_id
    if (typeof session !== 'string' || !session) throw new Error(`AITERM_LAUNCH_RECEIPT_INVALID: ${bot.id}`)
    this.sessions.set(bot.id, session)
    await this.recordRuntimeLaunch(session, runtime)
    try {
      this.membersAdmission.assertLease(membersLease)
      await this.updateSession(bot.id, session, { membersLease })
      this.membersAdmission.assertLease(membersLease)
      // Aitermは、ファストモードにできなかった席も通常の速度で起こし、実際の状態を返す（利用枠が尽きた時など）。
      // 保存が「有効」のまま実際は通常の速度、という食い違いを残さないよう、保存を実際へ合わせる。
      if (bot.fastMode === true && launch.structuredContent.fast === false) {
        const reason = launch.structuredContent.fast_error?.code
        process.stderr.write(`BellTeam Aiterm: ファストモードで起こせなかったため、通常の速度で起こしました: ${bot.id}${typeof reason === 'string' ? `（${reason}）` : ''}\n`)
        await this.updateFastMode(bot.id, false, { membersLease })
        this.membersAdmission.assertLease(membersLease)
      }
    } catch (error) {
      throw error
    }
    return session
  }

  async resumePreviouslyActive(bot, reference) {
    if (!['claude-code', 'codex-cli'].includes(reference.harness) || HARNESS.get(bot.harness) !== reference.harness
      || this.session(bot) !== reference.sessionId) return null
    await this.client.environmentReady?.(bot.project)
    return this.memberOperation(bot, async membersLease => {
        const version = this.captureStopVersion(bot)
      await this.requireAccess({ setupTest: false, botId: bot.id })
      this.requireStopVersion(bot.id, version)
      if (this.session(bot) !== reference.sessionId) return null
      // Resume is the same launch: keep the generation recorded for this session (none recorded = current).
      const runtime = await this.captureLaunchRuntime({ generation: await this.recordedRuntimeGeneration(reference.sessionId) })
      const options = this.client.launchOptions ? await this.client.launchOptions(bot.project, runtime) : { env: await loadBotEnvironment(bot.project) }
      this.requireStopVersion(bot.id, version)
      const result = await this.changeSession(bot, 'agent_launch', { harness: reference.harness, cwd: bot.project,
        session_name: reference.sessionId, require_existing_resume: true }, options)
      this.membersAdmission.assertLease(membersLease)
      this.requireStopVersion(bot.id, version)
      const receipt = result?.structuredContent
      if (receipt?.schema !== 'aiterm.agent-launch-result.v1' || receipt.session_id !== reference.sessionId
        || receipt.startup?.status !== 'ready' || receipt.initial_prompt?.status !== 'not_requested')
        await this.recordDeliveryFailure(bot.id, reference.launchId, 'RESTART_RESUME_UNCONFIRMED')
      return { sessionId: receipt.session_id, resumedAt: this.now() }
    })
  }

  // Z-b2 C1/C2 (docs/architecture/modules/execution/runtime-capture.md): one capture per logical launch.
  // RUNTIME_BINDING_UNAVAILABLE refuses only this launch and never falls back to builtin code.
  async captureLaunchRuntime(options) {
    try { return await this.captureRuntime(options) }
    catch (error) { throw Object.assign(error, { effect: 'not_started' }) }
  }

  async readRuntimeLaunches() {
    if (!this.runtimeLaunchesPath) return {}
    if (!this.runtimeLaunches) {
      // Absent or unreadable record = nothing recorded; resume then takes the current capture.
      try { this.runtimeLaunches = JSON.parse(await readFile(this.runtimeLaunchesPath, 'utf8')).launches ?? {} }
      catch { this.runtimeLaunches = {} }
    }
    return this.runtimeLaunches
  }

  async recordedRuntimeGeneration(sessionName) {
    return (await this.readRuntimeLaunches())[sessionName]?.generation
  }

  // D5 live reference. shortcut: entries are overwritten per session, not removed at close; P8 over-retains closed launches.
  recordRuntimeLaunch(sessionName, runtime) {
    if (!this.runtimeLaunchesPath) return
    this.runtimeLaunchQueue = this.runtimeLaunchQueue.then(async () => {
      const launches = await this.readRuntimeLaunches()
      launches[sessionName] = { generation: runtime.generation, capturedAt: this.now() }
      await mkdir(dirname(this.runtimeLaunchesPath), { recursive: true, mode: 0o700 })
      await writeAtomic(this.runtimeLaunchesPath, { schema: 'bellteam.runtime-launches.v1', launches })
    }).catch(() => this.reportError({ code: 'RUNTIME_LAUNCH_RECORD_UNAVAILABLE', module: 'execution' }))
    return this.runtimeLaunchQueue
  }

  async restart(bot, { membersLease } = {}) {
    const existing = this.restarts.get(bot.id)
    if (existing) return existing
    return this.membersAdmission.withLease(lease => this.restartWithLease(bot, lease), { lease: membersLease })
  }

  async restartWithLease(bot, membersLease) {
    this.membersAdmission.assertLease(membersLease)
    const existing = this.restarts.get(bot.id)
    if (existing) return existing
    this.assertWorkAllowed()
    // 明示再起動は、終了できないターンからも席を戻す操作。旧設定の
    // idle待ちを無効にし、旧CLIを閉じてから保存済み設定で起動する。
    this.sessionState.invalidate(bot.id)
    const version = this.captureStopVersion(bot)
    const previousJobs = [...this.activity.jobs].filter(job => job.bot.id === bot.id)
    const previousWatch = this.activity.watches.get(bot.id)
    const previousChanges = [...(this.sessionChanges.get(bot.id) ?? [])]
    const previousWake = this.activity.waking.get(bot.id)
    const pending = (async () => {
      await this.requireMember(bot, { membersLease })
      this.membersAdmission.assertLease(membersLease)
      if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
      // 発行済みの起動・設定RPCが後から新個体へ届かないよう、その返却だけを
      // 待つ。ターンの完了や、まだ発行していない旧idle待ちは待たない。
      await Promise.allSettled([...previousChanges, ...(previousWake ? [previousWake] : [])])
      this.requireStopVersion(bot.id, version)
      const session = await this.restartNow(bot, version, (closure, closedSession) => {
        if (!confirmedSessionClosure(closure, closedSession)) return
        for (const job of previousJobs) {
          if (job.nativeSession === closedSession) {
            if (job.receipt && job.conversationDelivery && job.nativeCompletion && !job.nativeTerminal)
              this.conversationAdmission?.confirmNativeClosure?.(job.conversationDelivery, job.receipt, closure)
            job.nativeClosure = structuredClone(closure.structuredContent)
            const release = () => { this.activity.release(job); job.native?.release() }
            job.completion.then(release, release)
          }
          job.markStopped()
        }
        previousWatch?.end()
      }, membersLease)
      return { botId: bot.id, session }
    })()
    this.restarts.set(bot.id, pending)
    const clear = () => { if (this.restarts.get(bot.id) === pending) this.restarts.delete(bot.id) }
    pending.then(clear, clear)
    return this.activity.configurationChanges.track(bot.id, pending)
  }

  reconfigure(current, next, options = {}) {
    if (configurationNeedsRestart(current, next, options.reapply))
      return this.activity.configurationChanges.track(current.id, this.reconfigureNow(current, next, options))
    const version = this.captureStopVersion(current)
    const turns = this.activity.of(current.id)
    let applying
    const apply = () => applying ??= Promise.resolve().then(() => {
      this.requireStopVersion(current.id, version)
      return this.reconfigureNow(current, next, options, false)
    })
    const pending = (async () => {
      await Promise.all(turns.map(turn => (turn.nativeCompletion ?? turn.completion).catch(() => {})))
      pending.boundaryReady = true
      const ordered = (this.activity.dispatches.get(current.id) ?? Promise.resolve()).then(apply)
      this.activity.dispatches.track(current.id, ordered.then(() => {}, () => {}))
      return ordered
    })()
    pending.deferredSettings = true
    pending.atBoundary = () => pending.boundaryReady || turns.every(turn => turn.nativeTerminal)
    pending.applyAtBoundary = apply
    return this.activity.configurationChanges.track(current.id, pending)
  }

  async reconfigureNow(current, next, { reapply = false, admissionCheck, requestId } = {}, waitForIdle = true) {
    const expected = this.membersAdmission.capture()
    this.membersAdmission.assertOpen(expected)
    this.assertWorkAllowed()
    const version = this.captureStopVersion(current)
    if (this.executionBridge) await this.awaitUnboundAdmission(current, version)
    await this.requireAccess({ setupTest: false, botId: next.id })
    const restarting = this.restarts.get(current.id)
    if (restarting) await restarting
    if (waitForIdle) await this.idle(current.id)
    return this.memberOperation(current, async membersLease => {
      admissionCheck?.()
      this.requireStopVersion(current.id, version)
      const requiresRestart = configurationNeedsRestart(current, next, reapply)
      if (requiresRestart) {
        const session = await this.restartNow(next, version, undefined, membersLease, admissionCheck)
        return { botId: next.id, session, mode: 'restart' }
      }
      const configuration = { session_id: this.session(next) }
      if (reapply || current.model !== next.model) configuration.model = next.model
      if (reapply || current.reasoningEffort !== next.reasoningEffort
        || current.model !== next.model && next.reasoningEffort) configuration.reasoning_effort = next.reasoningEffort
      if (reapply || (current.fastMode === true) !== (next.fastMode === true)) configuration.fast = next.fastMode === true
      if (next.harness === 'cursor' && configuration.reasoning_effort && !configuration.model) configuration.model = next.model
      const receipt = this.configurationRequests ? await this.applyConfigurationRequest(current, configuration, version, requestId)
        : await this.changeSession(current, 'agent_configure', configuration)
      return { botId: next.id, session: this.session(next), mode: 'configure',
        ...(this.configurationRequests ? { configurationRequest: receipt } : {}) }
    }, { expected })
  }

  async applyConfigurationRequest(bot, configuration, stopVersion, requestId, expectedLaunch) {
    this.requireStopVersion(bot.id, stopVersion)
    const { session_id, ...settings } = configuration
    const observed = expectedLaunch ? { launch_id: expectedLaunch } : await this.observe(bot)
    this.requireStopVersion(bot.id, stopVersion)
    if (!/^[a-f0-9]{32}$/u.test(observed?.launch_id ?? ''))
      return { request_state: 'not_recorded', outcome: 'outcome_unknown' }
    const receipt = await this.configurationRequests.apply(bot.id, session_id, observed.launch_id, settings, requestId)
    if (receipt?.request_state === 'terminal' && receipt.outcome === 'not_applied' && receipt.later_effect === 'excluded')
      throw configurationError('CONFIGURATION_NOT_APPLIED', 'not_started')
    return receipt
  }

  async reconcileConfiguration(bot, id) {
    if (!this.configurationRequests) throw configurationError('CONFIGURATION_UNAVAILABLE')
    const original = await this.configurationRequests.intents.read(bot.id, id)
    return this.membersAdmission.withLease(async membersLease => {
      await this.requireMember(bot, { membersLease })
      this.membersAdmission.assertLease(membersLease)
      const receipt = await this.configurationRequests.reconcile(bot.id, id)
      return { configurationRequest: receipt, fence: 'absent' }
    })
  }

  async stop(bot, version = this.captureStopVersion(bot), { membersLease, expected = this.membersAdmission.capture() } = {}) {
    if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
    await this.idle(bot.id)
    return this.memberOperation(bot, async () => {
      this.requireStopVersion(bot.id, version)
      const result = await this.changeSession(bot, 'pty_close', { session_id: this.session(bot) })
      await this.removeRetainedImages(bot.id)
      return result
    }, { membersLease, expected })
  }

  // 会話を残した現在処理の中断。通常の停止配送か旧追跡adapterを使う。
  interrupt(bot) {
    if (!this.requestStop && !this.executionBridge) {
      this.modelHandoff?.ownerStop(bot.id)
      return Promise.reject(Object.assign(new Error('処理の中断を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED' }))
    }
    return this.interruptMany([bot]).then(result => {
      if (result.unconfirmedBotIds.length) throw Object.assign(
        new Error('処理の中断を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED', cascade: result.cascade })
      return result.requestSent ? { botId: bot.id, status: 'stop_sent' }
        : { botId: bot.id, status: 'interrupted', sessionPreserved: true }
    })
  }

  interruptMany(bots, options = {}) {
    for (const bot of bots) this.modelHandoff?.ownerStop(bot.id)
    if (this.requestStop) {
      const stopping = sendStopOperations(this.seat, bots, options)
      return stopping
    }
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

  // A cursor belongs to the Aiterm generation that issued it. After a switch the chain restarts without it (aiterm-generation-pin.md).
  async observeChain(bot, previous = null) {
    const lease = operationLease(this.client)
    try {
      const generation = lease.generation ?? null
      const cursor = previous?.cursor && (previous.generation ?? null) === generation ? previous.cursor : null
      const result = await lease.client.call('pty_observe', { session_id: this.session(bot), ...(cursor ? { cursor } : {}) })
      return { observation: result.structuredContent, generation }
    } finally { lease.release() }
  }

  // Goal一覧の対象だけをまとめて読む。Goal本体と変更権限は、このsnapshotから作らない。
  async goalTargets(bots) {
    const result = (await this.client.call('pty_list')).structuredContent
    if (result?.schema !== 'aiterm.pty-list-result.v1' || !Array.isArray(result.sessions)
      || !Number.isFinite(Date.parse(result.observed_at))) throw new Error('GOAL_TARGETS_INVALID')
    const sessions = new Map()
    for (const row of result.sessions) {
      if (typeof row?.session_id !== 'string' || !row.session_id || sessions.has(row.session_id)) throw new Error('GOAL_TARGETS_INVALID')
      sessions.set(row.session_id, row)
    }
    return new Map(bots.flatMap(bot => {
      const session = this.session(bot), row = sessions.get(session)
      return row ? [[bot.id, { session_id: session, ...(Object.hasOwn(row, 'launch_id') ? { launch_id: row.launch_id } : {}) }]] : []
    }))
  }

  // 動いていない席を閉じる。配送中・配送待ちがあれば閉じない。閉じた後の配送は不達になり、通常の経路で起動し直す。
  closeIdle(bot) {
    if (!this.isIdle(bot.id) || this.activity.configurationChanges.has(bot.id)) return Promise.resolve(false)
    // 閉じている間の送信は、設定変更と同じ順序で、閉じ終わってから通常の不達復旧へ進める。
    return this.memberOperation(bot, () => this.activity.configurationChanges.track(bot.id, (async () => {
      await this.changeSession(bot, 'pty_close', { session_id: this.session(bot) })
      await this.removeRetainedImages(bot.id)
      return true
    })()))
  }

  stopForConfiguration(bot, { membersLease } = {}) {
    const expected = this.membersAdmission.capture()
    if (!membersLease) this.membersAdmission.assertOpen(expected)
    else this.membersAdmission.assertLease(membersLease)
    const version = this.captureStopVersion(bot)
    const barrier = this.executionStopping
    const run = async () => {
      if (this.executionBridge) await this.awaitUnboundAdmission(bot, version, barrier)
      return this.stop(bot, version, { membersLease, expected })
    }
    const previous = this.activity.configurationChanges.get(bot.id) ?? Promise.resolve()
    // This map orders pending operations; failure state belongs to sessionState/application.
    return this.activity.configurationChanges.track(bot.id, previous.then(run, run))
  }

  turn(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null, admissionCheck = () => {}, membersLease, conversationDelivery, summaryAuthority } = {}) {
    return this.submit(bot, message, { summaryAuthority, images, info: queue, onStatus, onInterim, admissionCheck, transcript: true, membersLease, conversationDelivery })
  }

  // BellTeamが追っているターンの合間の言葉を、完了まで数秒おきにAitermから受け取る。
  // stop()は最後にもう一度読んでターン末尾の言葉を拾い、エラーの知らせを受け取ったかを返す。
  // fromは読み始める位置（差し込みの返りと席の今のターンが返す値）。無い時は最後のdispatchから読む。
  // turnIdを渡すと、ほかのターンの言葉を出さない（読み始める位置より後は、次のターンの言葉も返るため）。
  followInterim(session, receipt, onInterim, { from = null, turnId = null, client = this.client } = {}) {
    let after = 0
    let stopped = false
    let broken = false
    let wake = null
    const seen = { error: false }
    const read = async () => {
      if (broken) return
      try {
        const data = await this.readInterim(session, after, from, client)
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
  async readInterim(session, after, from = null, client = this.client) {
    const result = await client.call('pty_observe', { session_id: session }, {
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
  notify(bot, message, options = {}) { return this.#notify(bot, message, options) }

  async #notify(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, executionSource, recoveredExecution, membersLease, conversationDelivery, admissionCheck, summaryAuthority } = {}, report = false) {
    const completion = this.submit(bot, message, { summaryAuthority, images, info: queue, onStatus, onInterim, onAnswer, onTurnEnd, executionSource, recoveredExecution, membersLease, conversationDelivery, admissionCheck })
    completion.catch(error => process.stderr.write(`BellTeam Aiterm delivery error: ${error.stack ?? error.message}\n`))
    if (!report) return completion.accepted
    return completion.accepted.catch(async error => {
      if (await completion.reportNotIssued) return { report: 'unavailable', reason: 'not_issued' }
      throw error
    })
  }

  notifyReport(bot, message, options = {}) {
    if (!options.conversationDelivery || !this.conversationAdmission?.isReport(options.conversationDelivery)
      || options.onTurnEnd || options.queue?.context !== 'report')
      throw Object.assign(new Error('CONVERSATION_REPORT_NOT_ALLOWED'), { code: 'CONVERSATION_REPORT_NOT_ALLOWED', status: 403, effect: 'not_started' })
    return this.#notify(bot, message, options, true)
  }

  async restartNow(bot, version = this.stopVersions.get(bot.id), onClosed = () => {}, membersLease, admissionCheck) {
    if (!membersLease) return this.memberOperation(bot, lease => this.restartNow(bot, version, onClosed, lease, admissionCheck))
    this.membersAdmission.assertLease(membersLease)
    await this.requireAccess({ setupTest: false, botId: bot.id })
    this.requireStopVersion(bot.id, version)
    admissionCheck?.()
    const closedSession = this.session(bot)
    let closure
    try { closure = await this.changeSession(bot, 'pty_close', { session_id: closedSession }) }
    catch (error) {
      if (['not_started', 'not_issued'].includes(error?.effect)) throw error
      await this.recordDeliveryFailure(bot.id, closedSession, 'BOT_LAUNCH_FAILED')
    }
    if (closure) onClosed(closure, closedSession)
    await this.removeRetainedImages(bot.id)
    this.requireStopVersion(bot.id, version)
    admissionCheck?.()
    return this.wake(bot, { membersLease, ...(admissionCheck ? { admissionCheck } : {}) })
  }

  // 一回の配送。受付（Aitermの受理）までと、受理したターンの終わりまでを一つのjobとして進める。
  // 続けてよいかはjobの停止結論と席の状態に聞き、停止の結論を決めるのはjob（DeliveryJob）だけ。
  submit(bot, message, { images = [], info = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, transcript = false, setupTest = false, admissionCheck = () => {}, executionSource, recoveredExecution = null, membersLease, conversationDelivery, summaryAuthority = null } = {}) {
    const recoveryVersion = this.captureStopVersion(bot)
    let recoverySession = this.session(bot)
    if (membersLease) this.membersAdmission.assertLease(membersLease)
    const job = new DeliveryJob({
      id: this.activeId(), bot, startedAt: this.now(),
      executionSource: executionSource ? structuredClone(executionSource) : null,
      info: { ...info, message: info.message ?? message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}) },
      stopping: () => this.executionStopping,
    })
    let conversationCallbacks = null
    if (conversationDelivery) {
      if (!this.conversationAdmission || onStatus || onInterim || onAnswer || onTurnEnd)
        throw Object.assign(new Error('CONVERSATION_NOT_ACCEPTED'), { code: 'CONVERSATION_NOT_ACCEPTED', status: 503, effect: 'not_started' })
      const kind = transcript ? 'turn' : this.conversationAdmission.isReport(conversationDelivery) ? 'report' : 'notify'
      this.conversationAdmission.claimNative(conversationDelivery, { deliveryId: info.groupId ?? job.id, target: bot.id, kind })
      job.conversationGeneration = conversationDelivery.generation
      job.conversationDelivery = conversationDelivery
      conversationCallbacks = this.conversationAdmission.callbacks(conversationDelivery)
      this.trackCompletion(this.conversationAdmission.deliveryCompletion(conversationDelivery))
      ;({ onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null } = conversationCallbacks)
    }
    // Every RPC of this delivery's chain goes to one Aiterm generation (aiterm-generation-pin.md).
    job.native = operationLease(this.client)
    this.activity.register(job)
    // Runs only before input is typed, so a body update hold (Z-c) refuses new input without touching running turns.
    const check = () => {
      job.assertNotStopped()
      this.assertWorkAllowed()
      this.assertInputAllowed()
      admissionCheck()
      if (membersLease) this.membersAdmission.assertLease(membersLease)
    }
    const parent = this.activity.latest(bot.id)
    let accept
    let rejectAcceptance
    const accepted = new Promise((resolve, reject) => { accept = resolve; rejectAcceptance = reject })
    accepted.catch(() => {})
    let acknowledged = false
    let endAdmission
    const admissionCompletion = new Promise(resolve => { endAdmission = resolve })
    if (membersLease) this.membersAdmission.trackCompletion(membersLease, admissionCompletion)
    let delivery, followed = false, dispatchStarted = false, failureStatusSaved = false, originalFailure
    const completion = (async () => {
      // 差し込んだ文を取ったターンの終わりまで追ったか。追えなかった差し込みの画像は、次のターンまで残す。
      try {
        this.latestSummaryInputs.set(bot.id, job.id)
        this.backgroundSummary?.invalidate(bot.id)
        await this.executionStopping?.catch(() => {})
        job.assertNotStopped()
        const configuration = this.activity.configurationChanges.get(bot.id)
        // Wait for ordering, then judge the target independently of setting failure.
        if (configuration && !configuration.deferredSettings) await configuration.catch(() => {})
        check()
        if (recoveredExecution) {
          if (recoveredExecution.reservation.request.kind !== 'delivery'
            || recoveredExecution.reservation.request.delivery_id !== info.groupId
            || recoveredExecution.binding?.target?.launch.session_id !== this.session(bot))
            throw Object.assign(new Error('EXECUTION_INVALID'), { code: 'EXECUTION_INVALID', effect: 'not_started' })
          job.execution = recoveredExecution
          job.executionWasPresent = true
        }
        check()
        this.activity.admit(job)
        await this.requireAccess({ setupTest, botId: bot.id })
        check()
        dispatchStarted = true
        delivery = await this.dispatchInOrder(bot, message, images, { setupTest, check, executionJob: job, membersLease })
        // 受理した。送信中に届いた停止の結果があれば、この受理と照らす。
        job.receipt = delivery.receipt
        job.restartActivity = this.workState.startedActivity(bot.id, HARNESS.get(bot.harness), delivery.session, delivery.receipt)
        job.nativeSession = delivery.session
        this.startWorkSummary(job, delivery, summaryAuthority, recoveryVersion)
        const tracking = this.followAcceptedDelivery(job, delivery)
        const { steered, follower } = tracking
        followed = tracking.followed
        if (followed) {
          job.nativeCompletion = this.waitUntilDone(delivery.receipt, job.controller.signal).then(async native => {
            job.nativeTerminal = true
            await job.finishExecution('completion')
            if (native.turn_id) this.activity.followedTurns.set(bot.id, native.turn_id)
            return native
          }, error => {
            job.nativeTerminal = error.turnCompleted === true
            if (!job.nativeTerminal) job.nativeUnconfirmed = error
            throw error
          })
          job.nativeCompletion.catch(() => {})
          if (conversationDelivery) {
            this.conversationAdmission.trackNativeContinuation(conversationDelivery, delivery.receipt, job.nativeCompletion, delivery.session)
            if (job.nativeClosure)
              this.conversationAdmission.confirmNativeClosure(conversationDelivery, delivery.receipt, { structuredContent: job.nativeClosure })
          }
        }
        await job.applyStopResult(job.executionStopResult)
        await job.checkpoint()
        await onStatus?.('running')
        await job.checkpoint()
        acknowledged = true
        // Only native-followed accepted turns may outlive an engine exchange (execution-dispatcher handover).
        if (followed) job.handoverReady = true
        this.activity.failed.delete(bot.id)
        accept({ delivery: steered ? 'steered' : 'running' })
        endAdmission()
        // 待つ手がかりを返さない差し込み（Aiterm 0.59.1まで）は、同じ席のjobの終わりを待つ。無ければ、終わりを知る道が無い。
        if (!followed) {
          if (parent) await parent.completion
          await job.checkpoint()
          await onStatus?.('delivered')
          return { delivery: 'steered' }
        }
        const completion = await this.waitForTurnCompletion(job, delivery, onInterim, job.nativeCompletion)
        await job.checkpoint()
        if (!job.nativeCompletion) await job.finishExecution('completion')
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
        const answer = transcript ? await this.readTurnAnswer(delivery, completion, job.native.client) : undefined
        await job.checkpoint()
        // 画面に出すだけの回答なので、読めなくても配送は完了として扱う。
        if (!transcript && onAnswer) {
          try {
            const text = await this.readTurnAnswer(delivery, completion, job.native.client)
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
        originalFailure = error
        // Accepted input remains accepted when only its completion tracking fails.
        const tracking = job.receipt && !job.stopped && !job.nativeTerminal && !error.turnCompleted
          ? [{ schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }] : []
        const stage = job.deliveryStage ?? 'BOT_DELIVERY_FAILED'
        // Same safe fields the conversation writer stores; built here so the execution closure imports no conversation file.
        const detail = returnedMcpError(error), launch = launchFailureDetails(error)
        const statusFailure = { code: stage, delivery_error: { code: stage },
          ...(detail ? { mcp_error: detail } : {}), ...(launch ? { native_launch: launch } : {}) }
        if (!job.receipt && !job.stopped) this.activity.recordFailure(job, stage)
        try {
          await onStatus?.(job.stopped ? 'stopped' : 'failed', statusFailure, ...tracking)
          failureStatusSaved = true
          if (!acknowledged && !job.stopped) await this.recordDeliveryFailure(bot.id, info.groupId ?? job.id, stage)
        } catch (callbackError) { if (!conversationDelivery) throw callbackError }
        finally { if (!acknowledged) rejectAcceptance(error) }
        throw error
      } finally {
        this.backgroundSummary?.invalidate(bot.id, job.id)
        this.summaryJobs.delete(job)
        endAdmission()
      }
    })()
    const release = async () => {
      try {
        if (job.nativeCompletion) await job.nativeCompletion.catch(() => {})
        if ((!job.nativeUnconfirmed || job.nativeClosure) && !this.retainUntrackedImages(job, delivery, followed, parent))
          await this.removeTemporaryImages(delivery?.imageFiles)
      } finally {
        if (!job.nativeUnconfirmed || job.nativeClosure) { this.activity.release(job); job.native.release() }
      }
    }
    const finishActivity = () => this.workState.finishedActivity(bot.id, job.restartActivity)
    completion.then(finishActivity, finishActivity)
    job.completion = completion.then(async value => { await release(); return value }, async error => { await release(); throw error })
    job.completion.catch(() => {})
    let result = conversationDelivery ? completion : job.completion
    if (conversationDelivery) {
      // submit yields before native work, so all real references exist before issuance.
      this.conversationAdmission.trackCompletion(conversationDelivery, job.completion)
      if (conversationCallbacks.userComplete) {
        result = completion.then(async reply => { await conversationCallbacks.userComplete(reply); return reply })
        this.conversationAdmission.trackCompletion(conversationDelivery, result)
      }
      const finish = () => this.conversationAdmission.finish(conversationDelivery)
      result.then(finish, finish)
    }
    if (conversationDelivery && this.conversationAdmission.isReport(conversationDelivery)) {
      // Only this captured job can prove local refusal; receipt absence after dispatch proves nothing.
      result.reportNotIssued = job.completion.then(() => false, error => !dispatchStarted
        && error === originalFailure && failureStatusSaved && job.unsent && !job.executionFinishUnconfirmed
        && job.conversationGeneration === this.conversationAdmission.capture().generation
        && !this.conversationAdmission.snapshot().unconfirmed)
    }
    result.accepted = accepted
    result.admissionCompletion = admissionCompletion
    job.completion.then(() => this.continuation?.succeeded(bot.id, info.groupId ?? job.id), error => {
      if (!error?.recoveryFailure || job.stopped || job.stopRequested
        || job.conversationGeneration && job.conversationGeneration !== this.conversationAdmission?.capture().generation) return
      this.continuation?.failed({ bot, deliveryId: info.groupId ?? job.id, failure: error.recoveryFailure,
        reconfigured: () => { this.requireStopVersion(bot.id, recoveryVersion); recoverySession = this.session(bot) },
        check: allowedMessage => {
          if (conversationDelivery) {
            if (job.conversationGeneration !== this.conversationAdmission.capture().generation)
              throw Object.assign(new Error('CONTINUATION_SUPERSEDED'), { code: 'CONTINUATION_SUPERSEDED', effect: 'not_started' })
            this.conversationAdmission.assertOpen()
          }
          this.assertConversationOccupation(bot.id)
          this.assertWorkAllowed()
          this.requireStopVersion(bot.id, recoveryVersion)
          if (this.session(bot) !== recoverySession || [...this.activity.jobs].some(other => other.bot.id === bot.id
            && !(allowedMessage && other.info.from === 'scheduler' && other.info.message === allowedMessage)))
            throw Object.assign(new Error('CONTINUATION_SUPERSEDED'), { code: 'CONTINUATION_SUPERSEDED', effect: 'not_started' })
        } })
    }).catch(() => {})
    return result
  }

  followAcceptedDelivery(job, delivery) {
    const steered = delivery.receipt.mode === 'agent_steer'
    const followed = !delivery.untracked && (!steered || delivery.steer !== null)
    // 次の送信もこの印を使うため、追跡担当の選択と設定は同期で行う。
    const follower = steered ? this.activity.follower(job.bot.id) : null
    job.follows = followed && !follower
    return { steered, followed, follower }
  }

  async readTurnAnswer(delivery, completion, client = this.client) {
    return transcriptText(await client.call('pty_read', {
      session_id: delivery.session,
      agent_transcript: true,
      ...(completion.operation_id ? { operation_id: completion.operation_id } : {}),
    }), completion)
  }

  retainUntrackedImages(job, delivery, followed, parent) {
    const temporary = delivery?.imageFiles.filter(file => file.temporary) ?? []
    if (job.stopped || delivery?.receipt.mode !== 'agent_steer' || followed || parent || !temporary.length) return false
    const retained = this.retainedImages.get(job.bot.id) ?? []
    retained.push(...temporary)
    this.retainedImages.set(job.bot.id, retained)
    return true
  }

  async waitForTurnCompletion(job, delivery, onInterim, nativeCompletion) {
    const interim = onInterim && job.follows
      ? this.followInterim(delivery.session, delivery.receipt, onInterim, { from: delivery.steer?.interimFrom, client: job.native?.client }) : null
    let completion
    try {
      completion = await (nativeCompletion ?? this.waitUntilDone(delivery.receipt, job.controller.signal))
    } catch (error) {
      void reportExecutionFailure(this.reportError, job.bot.id, 'delivery_wait', error, {
        jobId: job.id, groupId: job.info?.groupId, stopRequested: job.stopRequested,
        stopped: job.stopped, waitAborted: job.controller.signal.aborted,
      })
      job.waitFailure = error
      const seen = await interim?.stop()
      // 記録にエラーの知らせが無い時（Grok・Cursor、記録に残らない利用上限）は、Aitermが返した理由を代わりに出す。
      if (interim && !seen.error && String(error.message).startsWith('AITERM_TURN_'))
        await onInterim([{ text: error.message, kind: 'error' }])
      throw error
    }
    await interim?.stop()
    return completion
  }

  // その席のターンを終わりまで追っているjob（配送で始めたターン、追っている差し込み、見つけた席のターン）。
  follower(botId) {
    return this.activity.follower(botId)
  }

  startWorkSummary(job, delivery, authority, stopVersion) {
    const receipt = delivery.receipt, bot = job.bot
    if (!this.backgroundSummary || !authority || receipt?.schema !== 'aiterm.pty-send-result.v1'
      || receipt.session_id !== delivery.session || !/^[a-f0-9]{32}$/u.test(receipt.launch_id)
      || this.latestSummaryInputs.get(bot.id) !== job.id) return
    const input = { botId: bot.id, sessionId: delivery.session, launchId: receipt.launch_id, inputRevision: job.id,
      deliveryId: job.info.groupId, context: job.info.context, contextId: job.info.contextId }
    const assertCurrent = expected => {
      if (!Object.keys(input).every(key => expected[key] === input[key]) || job.stopped || job.stopRequested || job.nativeTerminal || job.nativeUnconfirmed
        || this.latestSummaryInputs.get(bot.id) !== job.id || this.session(bot) !== delivery.session
        || this.stopVersions.get(bot.id) !== stopVersion || this.sessionChanges.has(bot.id)) return false
      authority.assertCurrent()
      this.assertWorkAllowed()
      return true
    }
    this.summaryJobs.add(job)
    this.backgroundSummary.accept(input, { context: authority.context, assertCurrent })
  }

  currentWork(bot) {
    const snapshot = this.workState.snapshot(bot.id, this.session(bot), !this.sessionChanges.has(bot.id))
    return this.backgroundSummary ? this.backgroundSummary.snapshot(bot.id, this.session(bot), snapshot)
      : { ...snapshot, summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, source: null }
  }

  currentWorkBinding() { return null }

  updateWorkSummary() {
    throw Object.assign(new Error('CURRENT_WORK_FORBIDDEN'), { code: 'CURRENT_WORK_FORBIDDEN', status: 403 })
  }

  // 席の今のターン（Aiterm 0.60.0、ADR 0122）。席のsessionごとに、動いているターン・{ state: 'idle' }・null（分からない）。
  // All supported activity rows feed CurrentWork; only Codex supplies the legacy watch/wait contract.
  seatTurns(bots = []) { return this.#seatTurns(bots, this.client) }

  async #seatTurns(bots, client) {
    const read = this.workState.beginRead(bots.map(bot => {
      const session = this.session(bot), version = this.stopVersions.get(bot.id), harness = HARNESS.get(bot.harness)
      return { botId: bot.id, sessionId: session, harness, current: () => this.session(bot) === session
        && HARNESS.get(bot.harness) === harness && this.stopVersions.get(bot.id) === version && !this.sessionChanges.has(bot.id) }
    }))
    let result
    try { result = await client.call('pty_list', {}, { meta: CALLER_META })
    } catch (error) { this.workState.endRead(read, null); throw error }
    const data = result?._meta?.['aiterm/seat_turns']
    this.workState.endRead(read, data)
    if (!data) return null
    if (data.schema !== 'aiterm.seat-turns.v1' || data.error || !Array.isArray(data.seats))
      throw new Error(`AITERM_SEAT_TURNS_INVALID: ${data.error ?? data.schema}`)
    return new Map(data.seats.filter(seat => seat?.harness === 'codex-cli').map(seat => [seat.session_id, seat.turn]))
  }

  // BellTeamが始めていないターン（Aitermの子の結果で始まったターンなど）を見つけて追う。
  // 席の今のターンを返さない版のAitermではfalseを返す。
  async watchSeatTurns(bots, { onInterim = null, groupId = randomUUID, allowNew = () => true } = {}) {
    const versions = new Map(bots.map(bot => [bot.id, this.stopVersions.get(bot.id)]))
    // Turns read here carry this generation's wait process and interim offsets; each started watch holds it.
    const lease = operationLease(this.client)
    try { return await this.#watchSeatTurns(bots, versions, lease, { onInterim, groupId, allowNew }) }
    finally { lease.release() }
  }

  async #watchSeatTurns(bots, versions, lease, { onInterim, groupId, allowNew }) {
    const turns = await this.#seatTurns(bots, lease.client)
    if (!turns) return false
    for (const bot of bots) {
      if (versions.get(bot.id) !== this.stopVersions.get(bot.id)) continue
      const session = this.session(bot)
      const turn = turns.get(session)
      const watch = this.activity.watches.get(bot.id)
      // 追っているターンがもう動いていない。止められたターンでは、Aitermの待ちは返らない（完了の印だけを待つ）。
      // nullは「分からない」なので、追い続ける。
      if (watch && turn?.state === 'running' && turn.turn_id !== watch.turnId) {
        if (allowNew()) this.watchTurn(bot, session, turn, { onInterim, groupId, lease })
        watch.end()
        continue
      }
      if (watch && (turn === undefined || turn?.state === 'idle')) watch.end()
      if (allowNew() && turn?.state === 'running' && this.isIdle(bot.id) && this.activity.followedTurns.get(bot.id) !== turn.turn_id)
        this.watchTurn(bot, session, turn, { onInterim, groupId, lease })
    }
    return true
  }

  // 見つけたターンを終わりまで「処理中」に出し、合間の言葉を出す。
  // 回答は運ばない。席が自分で始めたターンの回答は、self-turns.mjsがThroughlineから出す（オーナー裁定 2026-10-01）。
  assertConversationOccupation(botId) {
    const generation = this.conversationAdmission?.capture().generation
    if (this.activity.of(botId).some(item => item.nativeUnconfirmed
      || item.conversationGeneration && item.conversationGeneration !== generation))
      throw Object.assign(new Error('CONVERSATION_NOT_ACCEPTED'), { code: 'CONVERSATION_NOT_ACCEPTED', status: 503, effect: 'not_started' })
  }

  watchTurn(bot, session, turn, { onInterim, groupId, lease = null }) {
    try { this.assertConversationOccupation(bot.id) } catch { return null }
    const watch = new SeatTurnWatch({ id: this.activeId(), bot, turn, groupId: groupId(), now: this.now() })
    let operationLease, conversationDelivery, words = onInterim
    if (this.conversationAdmission) {
      operationLease = this.conversationAdmission.tryEnter(undefined, watch.id)
      watch.conversationGeneration = operationLease?.generation
      if (!operationLease) return null
      try {
        conversationDelivery = this.conversationAdmission.registerDelivery(operationLease, {
          deliveryId: watch.info.groupId, target: bot.id, kinds: onInterim ? ['delivery.words'] : [],
          dispatch: (kind, params, binding) => onInterim(bot.id, watch.info.groupId, params.words, binding),
        })
        words = onInterim ? (botId, groupId, value) => this.conversationAdmission.invoke(conversationDelivery, 'delivery.words', { words: value }) : null
      } catch (error) { this.conversationAdmission.finish(operationLease); throw error }
    }
    this.activity.beginWatch(watch)
    watch.completion = (async () => {
      // The observer's lifetime is registered before the first native waiter/interim read.
      await Promise.resolve()
      const say = words ? async value => {
        await words(bot.id, watch.info.groupId, value)
        watch.shown.words.push(...value.filter(word => word.kind !== 'error').map(word => word.text.trim()).filter(Boolean))
      } : null
      const interim = say ? this.followInterim(session, turn, say, { from: turn.interim_from, turnId: turn.turn_id, client: lease?.client }) : null
      let turnCompleted = false
      try {
        let failure = null
        await Promise.race([watch.ended, this.waitUntilDone(turn, watch.stop.signal)
          .then(() => { turnCompleted = true }, error => { failure = error; turnCompleted = error.turnCompleted === true })])
        const seen = await interim?.stop()
        if (!failure || watch.stop.signal.aborted) return
        void reportExecutionFailure(this.reportError, bot.id, 'seat_watch', failure)
        // エラーや利用上限で終わったターンは、配送したターンと同じく、記録に知らせが無い時だけAitermが返した理由を出す。
        if (interim && !seen.error && /^AITERM_TURN_(ERROR|RATE_LIMITED)/u.test(failure.message))
          await say([{ text: failure.message, kind: 'error' }])
        else {
          try { process.stderr.write(`BellTeam seat turn: ${turnCompleted ? failure.message : JSON.stringify(executionFailureReport(bot.id, 'seat_watch', failure))}\n`) }
          catch { /* Logging must not end a running native turn. */ }
        }
      } catch (error) {
        void reportExecutionFailure(this.reportError, bot.id, 'seat_watch', error)
        try { process.stderr.write(`BellTeam seat turn error: ${JSON.stringify(executionFailureReport(bot.id, 'seat_watch', error))}\n`) }
        catch { /* Logging must not end a running native turn. */ }
      } finally {
        // A failed waiter does not prove native completion; the existing seat observer ends this watch.
        if (!turnCompleted && !watch.stop.signal.aborted) await watch.ended
        watch.shown.endedAt = Date.parse(this.now())
        this.activity.endWatch(watch)
      }
    })()
    if (lease) { const release = lease.hold(); watch.completion.then(release, release) }
    if (conversationDelivery) {
      this.conversationAdmission.trackCompletion(conversationDelivery, watch.completion)
      const finish = () => this.conversationAdmission.finish(conversationDelivery)
      watch.completion.then(finish, finish)
      this.conversationAdmission.finish(operationLease)
    }
    return watch
  }

  // 席が自分で始めたターンのうち、最後に追ったターンで合間の言葉として出した文と、追い終えた時刻。
  shownInSelfTurn(botId) {
    return this.activity.shownWords.get(botId) ?? null
  }

  consumeShownWords(botId, shown, prefix) {
    if (!Array.isArray(prefix) || prefix.some(word => typeof word !== 'string'))
      throw Object.assign(new Error('CONVERSATION_SHOWN_INVALID'), { code: 'CONVERSATION_SHOWN_INVALID' })
    if (!prefix.length || !shown || this.shownInSelfTurn(botId) !== shown
      || !prefix.every((word, index) => shown.words[index] === word)) return false
    shown.words.splice(0, prefix.length)
    return true
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

  deliveryBots() {
    return this.activity.stopTargets().map(job => job.bot)
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
    const run = async () => {
      options?.check?.()
      const configuration = this.activity.configurationChanges.get(bot.id)
      // A ready configuration may be queued behind this slot; apply it here, never wait on ourselves.
      if (configuration?.deferredSettings && configuration.atBoundary?.())
        await configuration.applyAtBoundary().catch(() => {})
      options?.check?.()
      return this.dispatch(bot, message, images, options)
    }
    const delivery = (this.activity.dispatches.get(bot.id) ?? Promise.resolve()).then(run)
    this.activity.dispatches.track(bot.id, delivery.then(() => {}, () => {}))
    return delivery
  }

  async recordDeliveryFailure(botId, deliveryId, code) {
    try {
      await this.reportError({ code: 'SERVER_TURN_TRACKING_FAILED', module: 'queue',
        diagnostic_log: JSON.stringify({ stage: 'delivery', botId, deliveryId, code }) })
    } catch { /* Diagnostic failure never changes admission. */ }
  }

  async observeForDispatch(bot, check) {
    let observed
    try { observed = await this.observe(bot) }
    catch { check(); return null }
    check()
    if (observed?.schema !== 'aiterm.pty-observe-result.v1' || observed.session_id !== this.session(bot)
      || typeof observed.exists !== 'boolean' || (observed.exists ? !/^[a-f0-9]{32}$/u.test(observed.launch_id ?? '') : observed.launch_id !== null))
      return null
    return observed
  }

  async dispatch(bot, message, images, { setupTest = false, check: checkAdmission = () => {}, executionJob, membersLease } = {}) {
    const check = checkAdmission
    bot = this.resolveBot?.(bot.id) ?? bot
    if (this.executionBridge) {
      const observed = await this.observeForDispatch(bot, check)
      if (!observed) throw Object.assign(new Error('BOT_OBSERVATION_FAILED'), { code: 'BOT_OBSERVATION_FAILED' })
      if (!executionJob.execution) await reserveExecution(this.seat, executionJob, observed)
      if (executionJob) executionJob.deliveryStage = observed.exists ? 'BOT_SEND_FAILED' : 'BOT_LAUNCH_FAILED'
      const delivery = await dispatchExecution(this.seat, executionJob, bot, message, images, { setupTest, check, membersLease })
      return { ...delivery, steer: delivery.receipt.mode === 'agent_steer' ? steerFollow(delivery.result) : null }
    }
    check()
    const imageFiles = await this.imageFiles(images)
    try {
      check()
      let session = this.session(bot)
      let result
      try {
        if (executionJob) executionJob.deliveryStage = 'BOT_SEND_FAILED'
        if (executionJob) executionJob.nativeSession = session
        result = await this.sendToSession(session, message, imageFiles, check, executionJob?.native?.client)
      } catch (error) {
        check()
        // Wake-first (docs/architecture/delivery-details.md). Kept failures and their exits are listed there.
        if (outcomeUnknown(error)) throw error
        const observed = await this.observeForDispatch(bot, check)
        const live = observed?.exists === true
        const turnRunning = live && (observed.state === 'busy' || observed.pending_child_deliveries > 0)
        let refusal = error
        // A live seat that is only slow or still taking the previous input gets the same words again first.
        if (live && observed.reason !== 'agent_failed' && RESENDABLE.includes(error.code) && !error.agentResumeResult) {
          try { result = await this.sendToWokenSession(bot, session, message, imageFiles, check, executionJob?.native?.client) }
          catch (again) { if (outcomeUnknown(again)) throw again; refusal = again }
        }
        if (!result) {
          // Never close a terminal whose turn is running; that turn ends and the next delivery is taken.
          if (turnRunning) throw refusal
          // Close what Aiterm still holds: a live terminal, or a launch record kept after its terminal vanished
          // (2026-11-08 body swap). An unreadable observation closes nothing; agent_launch refuses a live seat.
          const close = live || (observed && refusal.code !== 'AGENT_SESSION_REQUIRED')
          if (executionJob) executionJob.deliveryStage = 'BOT_LAUNCH_FAILED'
          session = await this.memberOperation(bot, async lease => {
            if (close) {
              process.stderr.write(`BellTeam Aiterm agent registration unavailable, restarting: ${bot.id}\n`)
              await this.changeSession(bot, 'pty_close', { session_id: session })
              await this.removeRetainedImages(bot.id)
            }
            check()
            return this.wake(bot, { setupTest, membersLease: lease })
          }, { membersLease })
          check()
          if (executionJob) executionJob.nativeSession = session
          result = await this.sendToWokenSession(bot, session, message, imageFiles, check, executionJob?.native?.client)
        }
      }
      // Aiterm accepted the words. A receipt without follow data stays accepted; only its completion is untracked.
      const receipt = result.structuredContent ?? {}
      const untracked = receipt.mode !== 'agent_steer'
        && (receipt.mode !== 'agent_dispatch' || !Number.isInteger(receipt.event_cursor) || !receipt.wait_process)
      if (untracked) process.stderr.write(`BellTeam Aiterm: accepted send without follow data: ${bot.id}\n`)
      if (receipt.mode === 'agent_dispatch') await this.removeRetainedImages(bot.id)
      return { receipt, imageFiles, session, untracked, steer: receipt.mode === 'agent_steer' ? steerFollow(result) : null }
    } catch (error) {
      await this.removeTemporaryImages(imageFiles)
      throw error
    }
  }

  // agent_launchのreadyとpty_sendの入力受付確認はAitermの中で別々の30秒予算。起こした直後の席は入力欄を描いた後も
  // 起動の仕事（MCP初期化・hook・履歴の描画）を続け、同時起動の負荷では二つ目の予算が尽きてAGENT_INPUT_NOT_READYで
  // 断られる（2026-11-07 20:18、起こした6席が全て、生きていた4席は全て通過）。Aitermは本文を送っておらず「少し後で再度
  // pty_send」と案内するので、このdispatchで起こした席だけ同じ文を送り直す。待ちはAitermの受付確認（最長30秒）が持つ。
  // shortcut: 上限3回（起動後およそ90秒）、同時起動の山でも足りない実測が出たら上限を見直す。
  async sendToWokenSession(bot, session, message, imageFiles, admissionCheck, client) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendToSession(session, message, imageFiles, admissionCheck, client)
      } catch (error) {
        if (error.code !== 'BOT_INPUT_NOT_READY' || error.agentResumeResult || attempt >= WOKEN_SEND_ATTEMPTS) throw error
        admissionCheck?.()
        process.stderr.write(`BellTeam Aiterm: woken seat not ready for input, sending again (${attempt}/${WOKEN_SEND_ATTEMPTS}): ${bot.id}\n`)
      }
    }
  }

  // 画像はaitermのimage引数へ渡す。harness別の添付手順（パスの先打鍵等）はaitermが吸収する（0.30.0）。
  // require_agentで、登録が無い席へ普通の端末として打たれる（mode=sent）のを止める。
  // BellTeamの印を付けると、差し込みの返りに、その文を取ったターンを追う手がかりが入る（Aiterm 0.60.0、ADR 0122）。
  async sendToSession(session, message, imageFiles, admissionCheck, client = this.client) {
    this.assertWorkAllowed()
    return client.call('pty_send', {
      session_id: session,
      text: message,
      require_agent: true,
      ...(imageFiles.length ? { image: imageFiles.map(file => file.path) } : {}),
    }, { meta: CALLER_META, ...(admissionCheck ? { admissionCheck } : {}) })
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
    const path = join(this.tempRoot, `bellteam-image-${randomUUID()}.${imageExtension(image.mime)}`)
    await this.writeTemporaryImage(path, Buffer.from(image.data, 'base64'))
    return { path, temporary: true }
  }

  // signalは、追うのをやめた時に待ちのprocessを止める（watchTurn）。
  async waitUntilDone(receipt, signal = null) {
    while (!signal?.aborted) {
      const result = await this.waitProcess(receipt.wait_process, signal)
      const recoveryFailure = recoverableTurnFailure(receipt, result)
      if (result.outcome === 'done') { this.workState.completedTurn(result); return result }
      if (result.outcome === 'timeout' || result.outcome === 'running') continue
      // error: harnessの記録でturnがAPIエラー等で打ち切られた（Aiterm 0.31.0）。本文を残して配送失敗にする。
      if (result.outcome === 'error') throw Object.assign(new Error(`AITERM_TURN_ERROR: ${result.error ?? 'unknown'}`), { waitOutcome: result.outcome, turnCompleted: true, ...(recoveryFailure ? { recoveryFailure } : {}) })
      // rate_limited: harnessの利用上限。Aitermが画面や記録から拾った上限の知らせを理由に残す。
      if (result.outcome === 'rate_limited' && result.rate_limit) throw Object.assign(new Error(`AITERM_TURN_RATE_LIMITED: ${result.rate_limit}`), { waitOutcome: result.outcome, turnCompleted: true, ...(recoveryFailure ? { recoveryFailure } : {}) })
      throw Object.assign(new Error(`AITERM_TURN_${String(result.outcome).toUpperCase()}`), { waitOutcome: result.outcome })
    }
    throw new Error('AITERM_WAIT_STOPPED')
  }

  async removeTemporaryImages(imageFiles = []) {
    await Promise.all(imageFiles.filter(file => file.temporary).map(file => this.removeTemporaryImage(file.path)))
  }

  async removeRetainedImages(botId) {
    const images = this.retainedImages.get(botId) ?? []
    this.retainedImages.delete(botId)
    await this.removeTemporaryImages(images)
  }

  async close() {
    const recovery = this.continuation?.close()
    for (const job of this.summaryJobs) this.backgroundSummary?.invalidate(job.bot.id, job.id)
    this.summaryJobs.clear()
    this.workState.close()
    for (const watch of this.activity.watches.values())
      if (!watch.conversationGeneration || watch.conversationGeneration === this.conversationAdmission?.capture().generation) watch.end()
    const botIds = new Set([...this.activity.active.values()].map(item => item.bot.id))
    await Promise.all([...botIds].map(botId => this.idle(botId)))
    await recovery
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
