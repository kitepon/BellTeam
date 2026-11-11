import { CurrentWork, watchCurrentTurn, interimStartCursor } from './current-work.mjs'
import { createHash, randomUUID } from 'node:crypto'
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
import { SeatActivity, SeatTurnWatch } from './seat-activity.mjs'
import { executionFailureReport, reportExecutionFailure } from './execution-failure-report.mjs'
import { recoverableTurnFailure } from './capacity-continuation.mjs'
import { isLimitText } from './claude-limit-text.mjs'
import { ACCOUNT_SLOTS } from './harness-accounts.mjs'
import { returnedMcpError } from './returned-mcp-error.mjs'
import { launchFailureDetails } from './agent-launch-error.mjs'
import { captureRuntime as captureSelectedRuntime } from './runtime-selection.mjs'
import { writeAtomic } from './json-file.mjs'
import { isRemoteBot, seatTarget, KEY_RELOAD, remoteSeatNotStarted } from './remote-seats.mjs'

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
const explicitlyUnsent = error => !outcomeUnknown(error)
  && (['AGENT_SESSION_REQUIRED', ...RESENDABLE].includes(error.code) || String(error.message).includes('送信していません'))
// A conversation lease or an execution generation closed under the job (module swap).
const SWAP_CODES = ['CONVERSATION_NOT_ACCEPTED', 'EXECUTION_GENERATION_RETIRED']
// Typed "not started" for a job a module swap ended before any words could reach the CLI; the record owner requeues it.
const swapNotStarted = () => ({ schema: 'aiterm.execution-error.v1', code: 'EXECUTION_STALE_GENERATION', effect: 'not_started', follow_up: 'none' })
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

// One native.pin() for an execution operation and the operations bound to its native values
// (docs/architecture/modules/execution/aiterm-generation-pin.md). The pin is released once, when the
// owner and every hold have ended. A client without pin() is used as is.
export function operationLease(client) {
  const pin = typeof client?.pin === 'function' ? client.pin() : null
  let holds = 1
  const drop = () => { if (--holds === 0) pin?.release() }
  const once = release => { let done = false; return () => { if (!done) { done = true; release() } } }
  return {
    client: pin ?? client,
    generation: pin ? pin.generation : undefined,
    hold() {
      if (holds === 0) throw Object.assign(new Error('AITERM_LEASE_RELEASED'), { code: 'AITERM_LEASE_RELEASED' })
      holds++
      return once(drop)
    },
    release: once(drop),
  }
}

// BellTeamとAitermの間。席の状態（BotSessionState）と席の活動（SeatActivity）を持ち、一回の配送（DeliveryJob）を進める。
// Aitermのnativeな実行判断はAitermに在り、ここは返却を事実として受け取る。
const SCREEN_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'C-c', ...'0123456789'])
const screenFailure = (code, status) => Object.assign(new Error(code), { code, status, effect: 'not_started' })

export class AitermTransport {
  constructor({ resolveBot = null, backgroundSummary = null, conversationAdmission = null, trackCompletion = () => {}, configurationRequests = null, membersAdmission = new MembersAdmission(), requireMember = async () => {}, client = new AitermClient(), executionBridge = null, requestStop = null, tempRoot = tmpdir(), writeTemporaryImage = writeLocalImage, removeTemporaryImage = path => rm(path, { force: true }), waitProcess = runWaitProcess, handoffContext = latestThroughlineHandoffContext, prepareStartup = async () => {}, updateSession = async () => {}, updateFastMode = async () => {}, requireAccess = async () => {}, assertWorkAllowed = () => {}, assertInputAllowed = () => {}, activeId = randomUUID, activityPath = null, captureRuntime = captureSelectedRuntime, runtimeLaunchesPath = null, now = () => new Date().toISOString(), interimInterval = INTERIM_INTERVAL_MS, reportError = () => {}, accounts = null, remoteSeats = null } = {}) {
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
    // Harness of the seat this transport launched per Bot, for the current-work read (current-work.md A-1).
    this.seatHarnesses = new Map()
    this.activity.groupReleased = groupId => this.backgroundSummary?.forgetRequest?.(groupId)
    // Claude 1st/2nd accounts (harness-accounts.md). Null keeps every launch on the default root.
    this.accounts = accounts
    this.remoteSeats = remoteSeats
    this.accountMoves = new Map()
    // Members whose account recovery is sending their continuation: the observer keeps their old watch until it is sent.
    this.accountRecoveries = new Set()
    this.reviewedRecovery = null
    this.holdReleasePollMs = 300
    // Limit holds this engine pressed (`<session>@<limit_end.at>`): never a second Esc on one hold.
    this.pressedHolds = new Set()
    this.accountsUnsubscribe = accounts?.watch(() => {
      this.activity.emitChange({ all: false, topics: ['accounts'], botIds: [], roomIds: [] })
      void this.reviewAccounts()
    }) ?? null
    this.unconfirmedJobs = new Map() // job -> {botId, session, seq, retire}: accepted deliveries whose completion is unknown
    this.workState = new CurrentWork({ now, activityPath, reportActivity: () => this.reportError({ code: 'RESTART_ACTIVITY_UNAVAILABLE', module: 'execution' }), notify: id => this.activity.emit({ bot: { id } }), observed: () => this.retireSettledUnconfirmed() })
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

  // N5 screen input (screen-input.md): one Owner key or approval answer into the seat the screen view shows.
  async screenKey(bot, key) {
    if (!SCREEN_KEYS.has(key)) throw screenFailure('SCREEN_KEY_INVALID', 400)
    if (!await this.isRunning(bot)) throw screenFailure('SCREEN_SEAT_ABSENT', 409)
    try { await this.client.call('pty_key', { session_id: this.session(bot), key }) }
    catch { throw screenFailure('SCREEN_INPUT_FAILED', 502) }
    return { key, outcome: 'accepted' }
  }

  async screenApproval(bot, { action, decision, promptDigest } = {}) {
    const tool = { claude: 'claude_approval', codex: 'agent_approval' }[bot.harness]
    const digest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
    if (action === 'respond' && (!['approve_once', 'deny'].includes(decision) || !digest(promptDigest))) throw screenFailure('SCREEN_APPROVAL_INVALID', 400)
    if (!['inspect', 'respond'].includes(action)) throw screenFailure('SCREEN_APPROVAL_INVALID', 400)
    if (!await this.isRunning(bot)) throw screenFailure('SCREEN_SEAT_ABSENT', 409)
    if (!tool) {
      if (action === 'inspect') return { status: 'none' }
      throw screenFailure('SCREEN_APPROVAL_UNSUPPORTED', 422)
    }
    const session_id = this.session(bot)
    if (action === 'inspect') {
      let result
      // No dialog on screen comes back as a tool refusal; the view then shows only the key bar.
      try { result = (await this.client.call(tool, { action: 'inspect', session_id }))?.structuredContent } catch { return { status: 'none' } }
      if (result?.status !== 'approval_required' || !digest(result.prompt_digest) || !Array.isArray(result.choices)) return { status: 'none' }
      return { status: 'approval_required', promptDigest: result.prompt_digest,
        choices: result.choices.filter(choice => ['approve_once', 'deny'].includes(choice?.decision) && typeof choice.label === 'string')
          .map(choice => ({ decision: choice.decision, label: choice.label.slice(0, 200) })) }
    }
    let result
    try { result = (await this.client.call(tool, { action: 'respond', session_id, approval_choice: decision, observed_prompt_digest: promptDigest }))?.structuredContent }
    catch { throw screenFailure('SCREEN_APPROVAL_CHANGED', 409) }
    if (result?.status !== 'submitted') throw screenFailure('SCREEN_INPUT_FAILED', 502)
    return { status: 'submitted', decision }
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

  async wakeNow(bot, { setupTest = false, execution = null, membersLease, admissionCheck, sessionName = null } = {}) {
    if (!membersLease) return this.memberOperation(bot, lease => this.wakeNow(bot, { setupTest, execution, membersLease: lease, admissionCheck, sessionName }))
    this.membersAdmission.assertLease(membersLease)
    const version = this.captureStopVersion(bot)
    if (this.executionBridge && !execution) await this.awaitUnboundAdmission(bot, version)
    await this.requireAccess({ setupTest, botId: bot.id })
    await mkdir(bot.project, { recursive: true })
    const harness = HARNESS.get(bot.harness)
    if (!harness) throw new Error(`HARNESS_UNSUPPORTED: ${bot.harness}`)
    const shortTermMemory = isRemoteBot(bot) && this.remoteSeats
      ? await this.remoteSeats.handoffContext(bot.id) : await this.handoffContext(bot.project)
    await this.prepareStartup(bot, shortTermMemory, { membersLease })
    this.membersAdmission.assertLease(membersLease)
    const runtime = await this.captureLaunchRuntime()
    // Protects the wrong target: a terminal-bound member never starts in the server folder. Exit: an engine with the
    // terminals ports (next body start) drains the same queued ID.
    if (isRemoteBot(bot) && !this.remoteSeats) throw Object.assign(new Error('TERMINALS_UNAVAILABLE'), { code: 'TERMINALS_UNAVAILABLE', effect: 'not_started', status: 503 })
    const launchOptions = this.client.launchOptions
      ? await this.client.launchOptions(bot.project, runtime) : { env: await loadBotEnvironment(bot.project) }
    let launch
    // harness-accounts.md: every seat runs on the 1st root; a 2nd seat differs only in the login the CLI gets (env token).
    const account = harness === 'claude-code' && this.accounts ? await this.accounts.selection('claude', bot.model) : null
    let remote = null, issuedLaunch = false
    try {
      this.requireStopVersion(bot.id, version)
      admissionCheck?.()
      let launchArgs = {
        harness,
        cwd: bot.project,
        // An account seat (harness-accounts.md) keeps its own name; any other fresh launch uses the Bot id as before.
        session_name: execution?.reservation.target.session_id ?? sessionName
          ?? (this.session(bot).startsWith(`${bot.id}-`) ? this.session(bot) : bot.id),
        trust_project: true,
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.reasoningEffort ? { reasoning_effort: bot.reasoningEffort } : {}),
        // 既定はファストモードを使わない（オーナー裁定 2026-10-12）。共有の設定に残った値で起きないよう、必ず真偽で渡す。
        fast: bot.fastMode === true,
      }
      // remote-seat.md (one launch path): a member bound to a terminal gets the terminal target, its folder, the launch context
      // and the seat MCP config on the same agent_launch; the existing checkpoint reruns after that async preparation.
      // One login per slot (harness-accounts.md 2026-11-11): every slot passes its login; legacy 1st adds nothing in the launcher.
      let claudeLogin = account?.slot ?? null
      if (isRemoteBot(bot)) {
        remote = await this.remoteSeats.prepare(bot, launchArgs, { shortTermMemory, context: { membersLease }, slot: account?.slot ?? null, harness })
        launchArgs = remote.args
        claudeLogin = remote.claudeLogin
        this.membersAdmission.assertLease(membersLease)
        this.requireStopVersion(bot.id, version)
        admissionCheck?.()
      }
      issuedLaunch = true
      const launchWith = args => this.changeSession(bot, 'agent_launch', args, { ...launchOptions,
        ...(claudeLogin ? { claudeLogin } : {}), ...(remote ? { privateEnv: remote.privateEnv } : {}), ...(execution ? { execution } : {}) })
      try { launch = await launchWith(launchArgs) } catch (error) {
        // remote-seat.md R13: Aiterm's key agent was gone or older; load the key again and launch once more.
        if (!remote || !KEY_RELOAD.has(error?.code)) throw error
        // Aiterm refused before contacting the terminal: nothing was launched with this seat credential yet.
        issuedLaunch = false
        const terminal = await remote.reloadKey()
        // The existing checkpoint again: a stop or admission change during the reload starts nothing.
        this.membersAdmission.assertLease(membersLease)
        this.requireStopVersion(bot.id, version)
        admissionCheck?.()
        issuedLaunch = true
        launch = await launchWith({ ...launchArgs, terminal })
      }
      if (remote) this.remoteSeats.launched(bot, launch?.structuredContent)
      if (account) void this.accounts.setSeat(bot.id, account.slot, account.stamp ?? null).catch(() => {})
    } catch (error) {
      // A credential issued for a launch that was never issued is revoked; a launch possibly running keeps its own.
      // Aiterm's connectivity codes keep the message queued and arm terminals' observer (remote-seat.md "Pending delivery").
      if (remote) this.remoteSeats.launchFailed(bot, error)
      if (remote && (!issuedLaunch || ['not_started', 'not_issued'].includes(error?.effect))) await remote.revoke()
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
    this.seatHarnesses.set(bot.id, { session, harness })
    await this.recordRuntimeLaunch(session, runtime, harness,
      remote ? { target: seatTarget(bot), botId: bot.id, launchId: launch.structuredContent.launch_id ?? null } : {})
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
    // A remote seat survives on its terminal; the normal wake takes it over there (remote-seat.md).
    if (isRemoteBot(bot)) return null
    // A working seat that cannot be resumed here is not left down: the typed refusal sends it the fresh continuation.
    const notResumable = () => Object.assign(new Error('RESUME_CAPABILITY_UNAVAILABLE'), { code: 'RESUME_CAPABILITY_UNAVAILABLE', effect: 'not_started' })
    if (!['claude-code', 'codex-cli'].includes(reference.harness) || HARNESS.get(bot.harness) !== reference.harness
      || this.session(bot) !== reference.sessionId) throw notResumable()
    await this.client.environmentReady?.(bot.project)
    return this.memberOperation(bot, async membersLease => {
        const version = this.captureStopVersion(bot)
      await this.requireAccess({ setupTest: false, botId: bot.id })
      this.requireStopVersion(bot.id, version)
      if (this.session(bot) !== reference.sessionId) throw notResumable()
      // Resume is the same launch: keep the generation recorded for this session (none recorded = current).
      const runtime = await this.captureLaunchRuntime({ generation: await this.recordedRuntimeGeneration(reference.sessionId) })
      const options = this.client.launchOptions ? await this.client.launchOptions(bot.project, runtime) : { env: await loadBotEnvironment(bot.project) }
      this.requireStopVersion(bot.id, version)
      // E7: the resume takes the slot's current token from this launch's env, never the recipe's older one.
      // The seat's login proof follows the token this resume really carries, so a later E6 signs that token out (not 'stale').
      const claudeLogin = reference.harness === 'claude-code' && this.claudeAccountBot(bot) ? this.accounts.seatSlot(bot.id) ?? '1st' : null
      const stamp = claudeLogin ? await this.accounts.stamp('claude', claudeLogin) : null
      const result = await this.changeSession(bot, 'agent_launch', { harness: reference.harness, cwd: bot.project,
        session_name: reference.sessionId, require_existing_resume: true }, { ...options, ...(claudeLogin ? { claudeLogin } : {}) })
      if (claudeLogin) await this.accounts.setSeat(bot.id, claudeLogin, stamp).catch(() => {})
      this.membersAdmission.assertLease(membersLease)
      this.requireStopVersion(bot.id, version)
      const receipt = result?.structuredContent
      if (receipt?.schema !== 'aiterm.agent-launch-result.v1' || receipt.session_id !== reference.sessionId
        || receipt.startup?.status !== 'ready' || receipt.initial_prompt?.status !== 'not_requested')
        await this.recordDeliveryFailure(bot.id, reference.launchId, 'RESTART_RESUME_UNCONFIRMED')
      this.seatHarnesses.set(bot.id, { session: reference.sessionId, harness: reference.harness })
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
  recordRuntimeLaunch(sessionName, runtime, harness = null, seat = {}) {
    if (!this.runtimeLaunchesPath) return
    this.runtimeLaunchQueue = this.runtimeLaunchQueue.then(async () => {
      const launches = await this.readRuntimeLaunches()
      launches[sessionName] = { generation: runtime.generation, capturedAt: this.now(), ...(harness ? { harness } : {}), ...seat }
      await mkdir(dirname(this.runtimeLaunchesPath), { recursive: true, mode: 0o700 })
      await writeAtomic(this.runtimeLaunchesPath, { schema: 'bellteam.runtime-launches.v1', launches })
    }).catch(() => this.reportError({ code: 'RUNTIME_LAUNCH_RECORD_UNAVAILABLE', module: 'execution' }))
    return this.runtimeLaunchQueue
  }

  // remote-seat.md: the recorded target of the running session ('' = local) differs from the member's terminal/folder now.
  // No record (launched before records) = unchanged.
  async seatTargetChanged(bot) {
    const recorded = (await this.readRuntimeLaunches())[this.session(bot)]
    return recorded ? (recorded.target ?? '') !== seatTarget(bot) : false
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
      // A model change keeps the seat; its account follows the new model's limit state at the next idle boundary.
      if (configuration.model !== undefined && this.claudeAccountBot(next) && !this.accountMoves.has(next.id)) this.moveAtBoundary(next.id)
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
    return this.configurationRequests.apply(bot.id, session_id, observed.launch_id, settings, requestId)
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

  async stop(bot, version = this.captureStopVersion(bot), { membersLease, expected = this.membersAdmission.capture(), allSessions = false } = {}) {
    if (this.executionBridge) await this.awaitUnboundAdmission(bot, version)
    // harness-accounts.md: a stop ends the member's interrupted turn, so no continuation is sent for it later.
    if (this.claudeAccountBot(bot)) await this.accounts.setStopped(bot.id).catch(() => {})
    await this.idle(bot.id)
    return this.memberOperation(bot, async () => {
      this.requireStopVersion(bot.id, version)
      const current = this.session(bot)
      const result = await this.changeSession(bot, 'pty_close', { session_id: current })
      await this.removeRetainedImages(bot.id)
      if (allSessions) await this.closeMemberSessions(bot, current)
      return result
    }, { membersLease, expected })
  }

  // harness-accounts.md "Member DELETE": a deleted member leaves no seat on any terminal, also the one an account move left.
  async closeMemberSessions(bot, closed) {
    const own = id => typeof id === 'string' && id !== closed && (id === bot.id || id.startsWith(`${bot.id}-`))
    const sessions = new Set(Object.entries(await this.readRuntimeLaunches()).filter(([, seat]) => seat?.botId === bot.id).map(([id]) => id))
    try { for (const row of (await this.client.call('pty_list')).structuredContent?.sessions ?? []) sessions.add(row?.session_id) }
    catch (error) { process.stderr.write(`BellTeam delete: local seats unreadable: ${bot.id}: ${error?.code ?? error?.message}\n`) }
    for (const session_id of [...sessions].filter(own)) {
      // A seat already gone also lands here; its exit is Aiterm's idle clock, and the deletion goes on.
      try { await this.client.call('pty_close', { session_id }) }
      catch (error) { process.stderr.write(`BellTeam delete: seat not closed: ${bot.id} ${session_id}: ${error?.code ?? error?.message}\n`) }
    }
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
      // control-details.md: a close Aiterm answered as failed keeps the old seat, so nothing is launched (it would meet the
      // same name or add a second seat). A close with no answer stays today's recorded unknown and launches.
      if (error?.aitermResponseReturned === true) throw Object.assign(new Error('RESTART_CLOSE_FAILED', { cause: error }), { code: 'RESTART_CLOSE_FAILED', effect: 'not_started',
        reason: String(error?.message ?? '').split('\n', 1)[0].slice(0, 300) })
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
          // An ordinary recovery (normal configuration) is redelivered by ordinary dispatch.
          if (!recoveredExecution.ordinary) { job.execution = recoveredExecution; job.executionWasPresent = true }
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
        this.startRequestSummary(job, summaryAuthority)
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
            if (!job.nativeTerminal) {
              job.nativeUnconfirmed = error
              // control-details.md "受付後の追跡失敗の自己退役": the next valid read showing no turn on this session retires it.
              this.unconfirmedJobs.set(job, { botId: bot.id, session: delivery.session, seq: this.workState.seq, retire: async () => {
                if (job.conversationDelivery) this.conversationAdmission?.confirmNativeSettled?.(job.conversationDelivery, delivery.receipt)
                this.activity.release(job); job.native.release()
                if (!this.retainUntrackedImages(job, delivery, followed, parent)) await this.removeTemporaryImages(delivery?.imageFiles)
              } })
            }
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
        job.step = 'answer'
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
        job.step = 'delivered'
        await onStatus?.('delivered')
        await job.checkpoint()
        job.step = 'turn_end'
        onTurnEnd?.({ startedAt: job.startedAt, endedAt: this.now() })
        return transcript ? answer : { delivery: 'delivered' }
      } catch (cause) {
        // Accepted, then failed before its end: the conversation side only sees the delivery stage, so name the step here.
        if (acknowledged && !job.waitFailure && !job.stopped)
          void reportExecutionFailure(this.reportError, bot.id, 'delivery_completion', cause, { jobId: job.id, groupId: info.groupId, step: job.step })
        const error = await job.failure(cause)
        originalFailure = error
        // Ended by a module swap before any words could reach the CLI: the usual failed status is kept for every
        // caller (each has its exit: explicit resume), and the error carries the typed not-started marker so a
        // requeuing record owner (durable receipts) can deliver the same ID after the swap.
        if (!job.receipt && !job.stopped && !job.inputMayHaveStarted && SWAP_CODES.includes(error.code))
          error.executionError = swapNotStarted()
        // remote-seat.md "Remote-seat not-started proof": the launch never reached the CLI, so the receipt may queue the same ID.
        const remoteProof = !job.receipt && !job.stopped && !job.inputMayHaveStarted
          ? remoteSeatNotStarted(this.resolveBot?.(bot.id) ?? bot, info.groupId, error) : null
        if (remoteProof) error.remoteSeatNotStarted = remoteProof
        // Accepted input remains accepted when only its completion tracking fails.
        const tracking = job.receipt && !job.stopped && !job.nativeTerminal && !error.turnCompleted
          ? [{ schema: 'bellteam.delivery-tracking.v1', admission: 'accepted', completion: 'unknown' }] : []
        const stage = job.deliveryStage ?? 'BOT_DELIVERY_FAILED'
        // Same safe fields the conversation writer stores; built here so the execution closure imports no conversation file.
        const detail = returnedMcpError(error), launch = launchFailureDetails(error)
        const statusFailure = { code: stage, delivery_error: { code: stage },
          ...(detail ? { mcp_error: detail } : {}), ...(launch ? { native_launch: launch } : {}),
          ...(error.turnCompleted === true ? { turnCompleted: true } : {}) }
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
    job.completion.then(() => {
      this.continuation?.succeeded(bot.id, info.groupId ?? job.id)
      this.accountTurnDone(bot)
    }, error => {
      const accountLimit = this.recordAccountLimit(bot, error) ?? this.recordAccountSignedOut(bot, error)
      // An account limit continues on the other account even without Aiterm's terminal-failure proof (harness-accounts.md).
      if (!(error?.recoveryFailure || accountLimit) || job.stopped || job.stopRequested
        || job.conversationGeneration && job.conversationGeneration !== this.conversationAdmission?.capture().generation) return
      this.continuation?.failed({ bot, deliveryId: info.groupId ?? job.id, failure: error.recoveryFailure ?? null, accountLimit,
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
    const { event_cursor: cursor, launch_id: launchId } = delivery.receipt
    // current-work.md "Non-Codex word watch": a span whose start token is not past this cursor holds this sent turn.
    if (Number.isInteger(cursor)) this.activity.sentCursors.set(job.bot.id, { launchId, cursor })
    // Aiterm dispatches only to an idle seat, so a word watch's turn is over; its token reads would take this turn's words.
    if (!steered) { const watch = this.activity.watches.get(job.bot.id); if (watch?.wordsOnly) watch.end() }
    return { steered, followed, follower }
  }

  async readTurnAnswer(delivery, completion, client = this.client) {
    // Bind the read to this delivery's Claude input: a next input to the seat must not change which answer is read (wait-contract.md).
    const inputId = !completion.operation_id && /^[a-f0-9]{32}$/u.test(delivery.receipt?.input_id ?? '') ? delivery.receipt.input_id : null
    return transcriptText(await client.call('pty_read', {
      session_id: delivery.session,
      agent_transcript: true,
      ...(completion.operation_id ? { operation_id: completion.operation_id } : {}),
      ...(inputId ? { input_id: inputId } : {}),
    }), completion)
  }

  retainUntrackedImages(job, delivery, followed, parent) {
    const temporary = delivery?.imageFiles.filter(file => file.temporary) ?? []
    // An accepted send whose end cannot be followed (untracked dispatch) keeps its images until the seat's next dispatch.
    if (job.stopped || (delivery?.receipt.mode !== 'agent_steer' && !delivery?.untracked) || followed || parent || !temporary.length) return false
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
      this.assertWorkAllowed()
      return true
    }
    this.summaryJobs.add(job)
    // The sender's request (and its leases) ends at acceptance; the summary lives as long as this job, so it
    // keeps only who sent it. Its read runs in its own short operation (current-work.md).
    const context = Object.freeze({ actor: authority.context.actor, rootMethod: authority.context.rootMethod })
    this.backgroundSummary.accept(input, { context, assertCurrent })
  }

  // One summary per Bot-to-Bot delivery group; the room responders of one post share it (current-work.md "Request summary").
  startRequestSummary(job, authority) {
    const groupId = job.info.groupId
    if (typeof this.backgroundSummary?.request !== 'function' || authority?.context?.actor?.kind !== 'bot'
      || !['direct', 'room'].includes(job.info.context) || typeof groupId !== 'string' || !groupId) return
    const jobs = () => [...this.activity.active.values()].filter(item => item.info?.groupId === groupId)
    this.backgroundSummary.request(groupId, job.info.message, {
      current: () => jobs().length > 0,
      ready: () => { for (const item of jobs()) this.activity.emit(item) },
    })
  }

  currentWork(bot) {
    const snapshot = this.workState.snapshot(bot.id, this.session(bot), !this.sessionChanges.has(bot.id))
    return this.backgroundSummary ? this.backgroundSummary.snapshot(bot.id, this.session(bot), snapshot)
      : { ...snapshot, summary: null, summaryStatus: 'missing', summaryUpdatedAt: null, source: null }
  }

  currentWorkBinding() { return null }

  currentTurn(botId, options) { return this.workState.turn(botId, options) }

  // The same after_turn stream for the managed (no execution factory) path; the facade wraps the engine instead.
  watchCurrentTurn(listener) { return watchCurrentTurn(listener => this.watchQueue(listener), botId => this.currentTurn(botId, { startedAt: true }), listener) }

  updateWorkSummary() {
    throw Object.assign(new Error('CURRENT_WORK_FORBIDDEN'), { code: 'CURRENT_WORK_FORBIDDEN', status: 403 })
  }

  // 席の今のターン（Aiterm 0.60.0、ADR 0122）。席のsessionごとに、動いているターン・{ state: 'idle' }・null（分からない）。
  // All supported activity rows feed CurrentWork; only Codex supplies the legacy watch/wait contract.
  seatTurns(bots = []) { return this.#seatTurns(bots, this.client) }

  // The live seat's harness until a relaunch replaces it; a saved harness change applies from that relaunch.
  // After an engine exchange the in-memory record is empty; the launch record (D5) keeps the last launch's harness.
  seatHarness(bot) {
    const session = this.session(bot), seat = this.seatHarnesses.get(bot.id)
    if (seat?.session === session) return seat.harness
    const recorded = this.runtimeLaunches?.[session]?.harness
    return [...HARNESS.values()].includes(recorded) ? recorded : HARNESS.get(bot.harness)
  }

  async #seatTurns(bots, client) {
    await this.readRuntimeLaunches()
    const read = this.workState.beginRead(bots.map(bot => {
      const session = this.session(bot), version = this.stopVersions.get(bot.id), harness = this.seatHarness(bot)
      return { botId: bot.id, sessionId: session, harness, current: () => this.session(bot) === session
        && this.seatHarness(bot) === harness && this.stopVersions.get(bot.id) === version && !this.sessionChanges.has(bot.id) }
    }))
    let result
    try { result = await client.call('pty_list', {}, { meta: CALLER_META })
    } catch (error) { this.workState.endRead(read, null); throw error }
    const data = result?._meta?.['aiterm/seat_turns']
    this.workState.endRead(read, data)
    if (!data) return null
    if (data.schema !== 'aiterm.seat-turns.v1' || data.error || !Array.isArray(data.seats))
      throw new Error(`AITERM_SEAT_TURNS_INVALID: ${data.error ?? data.schema}`)
    // Codex rows keep the watch/wait contract; other rows carry their launch for the word-watch start check.
    return new Map(data.seats.filter(seat => seat?.session_id).map(seat => [seat.session_id, seat.harness === 'codex-cli' || !seat.turn
      ? seat.turn : { ...seat.turn, codex: false, launch_id: seat.launch_id }]))
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
      if (versions.get(bot.id) !== this.stopVersions.get(bot.id) || this.accountRecoveries.has(bot.id)) continue
      const session = this.session(bot)
      const turn = turns.get(session)
      const watch = this.activity.watches.get(bot.id)
      // 追っているターンがもう動いていない。止められたターンでは、Aitermの待ちは返らない（完了の印だけを待つ）。
      // nullは「分からない」なので、追い続ける。
      const watchable = turn?.state === 'running' && (turn.codex !== false || this.wordWatchable(bot.id, turn))
      if (watch && turn?.state === 'running' && turn.turn_id !== watch.turnId) {
        if (allowNew() && watchable) this.watchTurn(bot, session, turn, { onInterim, groupId, lease })
        watch.end()
        continue
      }
      if (watch && (turn === undefined || turn?.state === 'idle')) watch.end()
      if (allowNew() && watchable && this.isIdle(bot.id) && this.activity.followedTurns.get(bot.id) !== turn.turn_id)
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

  // current-work.md "Non-Codex word watch": a start token, and no BellTeam-sent turn of this launch inside the span.
  wordWatchable(botId, turn) {
    const start = interimStartCursor(turn.interim_from), sent = this.activity.sentCursors.get(botId)
    return start !== null && !(sent && sent.launchId === turn.launch_id && sent.cursor >= start)
  }

  watchTurn(bot, session, turn, { onInterim, groupId, lease = null }) {
    try { this.assertConversationOccupation(bot.id) } catch { return null }
    const watch = new SeatTurnWatch({ id: this.activeId(), bot, turn, groupId: groupId(), now: this.now() })
    // A non-Codex span has no waiter; its readInterim answer carries the token's cursor instead of the null event_cursor.
    const wordsOnly = watch.wordsOnly = turn.codex === false
    const receipt = wordsOnly ? { ...turn, event_cursor: interimStartCursor(turn.interim_from) } : turn
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
        // harness-accounts.md: a self-started turn's limit reaches BellTeam only as this word (no wait result).
        const limit = this.claudeAccountBot(bot) ? value.find(word => word.kind === 'error' && isLimitText(word.text)) : null
        if (limit) void this.accounts.recordLimit({ harness: 'claude', slot: this.accounts.seatSlot(bot.id) ?? '1st', model: bot.model, text: limit.text }).catch(() => {})
        await words(bot.id, watch.info.groupId, value)
        watch.shown.words.push(...value.filter(word => word.kind !== 'error').map(word => word.text.trim()).filter(Boolean))
      } : null
      const interim = say ? this.followInterim(session, receipt, say, { from: turn.interim_from, turnId: turn.turn_id, client: lease?.client }) : null
      let turnCompleted = false
      try {
        let failure = null
        await Promise.race([watch.ended, wordsOnly ? watch.ended : this.waitUntilDone(turn, watch.stop.signal)
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

  // requestSummary: the 相関図 edge label (current-work.md "Request summary"); null until ready, on failure, or on an older body.
  queueItems(filter = {}) {
    const forks = [...(this.activity.forks?.values() ?? [])].map(fork => fork.row).filter(row => !filter.botId || row.botId === filter.botId)
      .filter(row => !filter.roomId || (row.context === 'room' && row.contextId === filter.roomId))
    const items = [...this.activity.items(filter), ...forks], summary = this.backgroundSummary
    if (typeof summary?.requestSummary !== 'function') return items
    return items.map(item => ({ ...item, requestSummary: item.status === 'running' && item.groupId ? summary.requestSummary(item.groupId) : null }))
  }

  watchQueue(listener) {
    return this.activity.watch(listener)
  }

  // execution/fork.md SK01: {botId, forkId} of a running fork seat, else null.
  forkSeat(sessionName) {
    const fork = this.activity.forks?.get(sessionName)
    return fork ? { botId: fork.botId, forkId: fork.forkId } : null
  }

  // execution/fork.md: a disposable fork of the main seat's latest saved conversation. Never the main queue, stop
  // version, steer or wake. Resolves once the fork accepted its first input; the turn is followed in the background.
  retireSettledUnconfirmed() {
    for (const [job, mark] of this.unconfirmedJobs) {
      if (job.nativeClosure) { this.unconfirmedJobs.delete(job); continue }
      if (!this.workState.settledAfter(mark.botId, mark.session, mark.seq)) continue
      this.unconfirmedJobs.delete(job)
      job.nativeSettled = true
      void mark.retire().catch(() => {})
    }
  }

  async forkInquiry(bot, envelope, { forkId, deliveryId = null, queue = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null,
    conversationDelivery = null, membersLease = null, admissionCheck = null } = {}) {
    if (typeof forkId !== 'string' || !forkId || forkId.length > 200 || typeof envelope !== 'string' || !envelope.trim())
      throw Object.assign(new Error('FORK_INVALID'), { code: 'FORK_INVALID', effect: 'not_started', status: 400 })
    // fork.md B7: from the conversation child the callbacks and the lifetime are the registered delivery's, as for notify.
    let finishDelivery = () => {}
    if (conversationDelivery) {
      if (!this.conversationAdmission || onStatus || onInterim || onAnswer || onTurnEnd)
        throw Object.assign(new Error('CONVERSATION_NOT_ACCEPTED'), { code: 'CONVERSATION_NOT_ACCEPTED', status: 503, effect: 'not_started' })
      this.conversationAdmission.claimNative(conversationDelivery, { deliveryId, target: bot.id, kind: 'notify' })
      ;({ onStatus = null, onInterim = null, onAnswer = null } = this.conversationAdmission.callbacks(conversationDelivery))
      finishDelivery = () => this.conversationAdmission.finish(conversationDelivery)
    }
    const check = () => {
      this.assertWorkAllowed()
      admissionCheck?.()
      if (membersLease) this.membersAdmission.assertLease(membersLease)
    }
    try { check() } catch (error) { finishDelivery(); throw error }
    const harness = HARNESS.get(bot.harness)
    const main = this.session(bot)
    const sessionName = `${main}-fork-${createHash('sha256').update(forkId).digest('hex').slice(0, 12)}`
    const startedAt = this.now()
    const row = { id: sessionName, botId: bot.id, botName: bot.displayName ?? bot.name ?? bot.id, status: 'running', startedAt,
      context: 'direct', contextId: bot.id, groupId: deliveryId, target: bot.id, ...queue, steered: false, seat: { kind: 'fork', forkId } }
    if (this.activity.forks.has(sessionName)) {
      finishDelivery()
      throw Object.assign(new Error('FORK_INVALID: fork_id is running'), { code: 'FORK_INVALID', effect: 'not_started', status: 409 })
    }
    // Registered before the launch: the fork's MCP calls in its first turn resolve as this Bot's fork (SK01).
    this.activity.forks.set(sessionName, { botId: bot.id, forkId, row })
    let remote = null, issued = false, receipt
    const close = async () => {
      if (issued) await this.client.call('pty_close', { session_id: sessionName }).catch(error =>
        process.stderr.write(`BellTeam fork: close failed: ${sessionName}: ${error.message}\n`))
      await remote?.revoke()
      this.activity.forks.delete(sessionName)
      this.activity.emit({ bot })
    }
    try {
      const runtime = await this.captureLaunchRuntime()
      const launchOptions = this.client.launchOptions
        ? await this.client.launchOptions(bot.project, runtime) : { env: await loadBotEnvironment(bot.project) }
      // The main's account: a 2nd-slot seat gets the same login (harness-accounts.md); Aiterm keeps the main's root.
      const slot = this.claudeAccountBot(bot) ? this.accounts.seatSlot(bot.id) : null
      let claudeLogin = slot ?? null
      // cwd = the main's folder: Aiterm accepts the same real path, the seat launcher requires it.
      let args = { harness, cwd: bot.project, session_name: sessionName, prompt: envelope, fork_from: { session_id: main, fork_id: forkId } }
      if (isRemoteBot(bot)) {
        if (!this.remoteSeats) throw Object.assign(new Error('TERMINALS_UNAVAILABLE'), { code: 'TERMINALS_UNAVAILABLE', effect: 'not_started', status: 503 })
        remote = await this.remoteSeats.prepare(bot, args, { shortTermMemory: '', context: {}, slot, harness, kind: 'fork' })
        args = remote.args
        claudeLogin = remote.claudeLogin
      }
      check()
      issued = true
      const launch = await this.client.call('agent_launch', args, { ...launchOptions,
        ...(claudeLogin ? { claudeLogin } : {}), ...(remote ? { privateEnv: remote.privateEnv } : {}) })
      receipt = launch?.structuredContent
      // Protects the project folder: only a launch Aiterm proved write-banned counts as a fork.
      if (!receipt?.fork_of?.write_ban || !receipt.wait_process) throw forkUnavailable()
      await onStatus?.('running')
    } catch (error) {
      // A receipt means a seat exists, whatever the error: it is closed.
      if (!receipt && (error?.effect === 'not_started' || error?.effect === 'not_issued')) issued = false
      await close()
      finishDelivery()
      if (error?.code === 'FORK_UNAVAILABLE') throw error
      throw /READONLY_UNENFORCEABLE/u.test(`${error?.code} ${error?.aitermErrorCode} ${error?.message}`) ? forkUnavailable(error) : error
    }
    const background = (async () => {
      const interim = onInterim ? this.followInterim(sessionName, receipt, onInterim) : null
      try {
        const completion = await this.waitUntilDone(receipt).finally(() => interim?.stop())
        const text = await this.readTurnAnswer({ session: sessionName, receipt }, completion)
        if (typeof text === 'string' && text.trim()) await onAnswer?.(text)
        await onStatus?.('delivered')
        onTurnEnd?.({ startedAt, endedAt: this.now() })
      } catch (error) {
        process.stderr.write(`BellTeam fork: turn failed: ${sessionName}: ${error.message}\n`)
        await Promise.resolve(onStatus?.('failed', { code: 'FORK_FAILED', delivery_error: { code: 'FORK_FAILED' }, reason: error?.code ?? error?.message ?? 'unknown' }))
          .catch(() => {})
      } finally {
        // remote-seat.md C7: the fork's transcript once, labelled from the launch receipt, before its seat closes.
        if (remote) await this.remoteSeats.forward({ sessionName, botId: bot.id, terminalId: bot.terminalId, projectRoot: bot.projectRoot,
          launchId: typeof receipt.launch_id === 'string' ? receipt.launch_id : null, cursor: null,
          fork: { parentSessionId: receipt.fork_of.vendor_session_id, forkId } })
        await close()
      }
    })()
    this.trackCompletion(background)
    if (conversationDelivery) {
      this.conversationAdmission.trackCompletion(conversationDelivery, background)
      background.then(finishDelivery, finishDelivery)
    }
    this.activity.emit({ bot })
    return { delivery: 'running', forkId }
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
      // remote-seat.md "Target revision": every member update path (HTTP administration or members' MCP update_bot) reaches
      // this delivery, so the move happens here. An idle seat on another terminal/folder (or local <-> remote) is closed
      // and woken on the new target; a running turn keeps today's delivery and the next delivery moves it.
      if (await this.seatTargetChanged(bot)) {
        const observed = await this.observeForDispatch(bot, check)
        if (!(observed?.exists === true && (observed.state === 'busy' || observed.pending_child_deliveries > 0))) {
          if (executionJob) executionJob.deliveryStage = 'BOT_LAUNCH_FAILED'
          session = await this.memberOperation(bot, async lease => {
            if (observed?.exists === true) {
              await this.changeSession(bot, 'pty_close', { session_id: session })
              await this.removeRetainedImages(bot.id)
            }
            check()
            return this.wake(bot, { setupTest, membersLease: lease })
          }, { membersLease })
          check()
        }
      }
      try {
        if (executionJob) executionJob.deliveryStage = 'BOT_SEND_FAILED'
        if (executionJob) executionJob.nativeSession = session
        result = await this.sendToSession(session, message, imageFiles, check, executionJob?.native?.client, executionJob)
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
          try { result = await this.sendToWokenSession(bot, session, message, imageFiles, check, executionJob?.native?.client, executionJob) }
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
          result = await this.sendToWokenSession(bot, session, message, imageFiles, check, executionJob?.native?.client, executionJob)
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
  async sendToWokenSession(bot, session, message, imageFiles, admissionCheck, client, job = null) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendToSession(session, message, imageFiles, admissionCheck, client, job)
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
  // job.inputMayHaveStarted: once a pty_send was issued and not refused with an explicit not-sent answer, the words
  // may be in the CLI, and the job never claims "not started" again.
  async sendToSession(session, message, imageFiles, admissionCheck, client = this.client, job = null) {
    this.assertWorkAllowed()
    let issued = false
    const issue = () => { admissionCheck?.(); issued = true }
    try {
      const result = await client.call('pty_send', {
        session_id: session,
        text: message,
        require_agent: true,
        ...(imageFiles.length ? { image: imageFiles.map(file => file.path) } : {}),
      }, { meta: CALLER_META, ...(admissionCheck || job ? { admissionCheck: issue } : {}) })
      if (job) job.inputMayHaveStarted = true
      return result
    } catch (error) {
      if (job && issued && !explicitlyUnsent(error)) job.inputMayHaveStarted = true
      throw error
    }
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
      // failureCategory/limitText: the seat's own limit line for the account registry (harness-accounts.md).
      const limit = { failureCategory: result.failure?.category ?? null, limitText: result.rate_limit ?? result.error ?? null }
      if (result.outcome === 'error') throw Object.assign(new Error(`AITERM_TURN_ERROR: ${result.error ?? 'unknown'}`), { waitOutcome: result.outcome, turnCompleted: true, ...limit, ...(recoveryFailure ? { recoveryFailure } : {}) })
      // rate_limited: harnessの利用上限。Aitermが画面や記録から拾った上限の知らせを理由に残す。
      if (result.outcome === 'rate_limited' && result.rate_limit) throw Object.assign(new Error(`AITERM_TURN_RATE_LIMITED: ${result.rate_limit}`), { waitOutcome: result.outcome, turnCompleted: true, ...limit, ...(recoveryFailure ? { recoveryFailure } : {}) })
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

  claudeAccountBot(bot) { return Boolean(this.accounts && bot && HARNESS.get(bot.harness) === 'claude-code') }

  // A seat's own limit signal -> registry entry for the slot it runs on. Returns {slot, recorded} or null.
  recordAccountLimit(bot, error) {
    if (!this.claudeAccountBot(bot) || !(error?.waitOutcome === 'rate_limited' || error?.failureCategory === 'rate_limited'
      || error?.recoveryFailure?.category === 'rate_limited')) return null
    const slot = this.accounts.seatSlot(bot.id) ?? '1st'
    const recorded = this.accounts.recordLimit({ harness: 'claude', slot, model: bot.model, text: error.limitText ?? error.message })
    recorded.catch(() => {})
    return { slot, recorded }
  }

  // E6: the seat's login failed. Marks the slot signed out (or only this seat, when it ran an older token) and continues
  // like a limit: a new seat on a usable slot plus the continuation message (harness-accounts.md "Signed out").
  recordAccountSignedOut(bot, error) {
    if (!this.claudeAccountBot(bot) || !(error?.failureCategory === 'authentication' || error?.recoveryFailure?.category === 'authentication')) return null
    const slot = this.accounts.seatSlot(bot.id) ?? '1st'
    const recorded = this.accounts.recordSignedOut({ harness: 'claude', slot, botId: bot.id, text: error.limitText ?? error.message })
    recorded.catch(() => {})
    return { slot, recorded, kind: 'authentication' }
  }

  accountTurnDone(bot) {
    if (!this.claudeAccountBot(bot)) return
    void this.accounts.turnSucceeded('claude', this.accounts.seatSlot(bot.id) ?? '1st', bot.model).catch(() => {})
  }

  // remote-seat.md "Launch notice": the latest not-started remote launch of this member, or null.
  seatLaunch(botId) {
    return this.remoteSeats?.launchNotice(this.resolveBot?.(botId)) ?? null
  }

  seatAccount(botId) {
    const bot = this.resolveBot?.(botId), slot = this.claudeAccountBot(bot) ? this.accounts.seatSlot(botId) : null
    // shortcut: preferredSlot is always '1st' (no rules); drop it once Web, Apple and Windows stop reading it.
    return slot ? { harness: 'claude', slot, preferredSlot: '1st' } : null
  }

  // harness-accounts.md: a new seat on the selected slot; the old seat is left as it is (Owner 2026-11-09, "1stは放置").
  // It cannot use its limited slot anyway, and its background processes keep running until Aiterm's idle clock ends it.
  switchAccount(bot, { admissionCheck } = {}) {
    const run = () => this.memberOperation(bot, async membersLease => {
      admissionCheck?.()
      const account = await this.accounts.selection('claude', bot.model)
      if ((this.accounts.seatSlot(bot.id) ?? '1st') === account.slot && !await this.accounts.renewDue(bot.id, 'claude', bot.model))
        return { botId: bot.id, session: this.session(bot), slot: account.slot }
      const running = await this.isRunning(bot)
      const session = `${bot.id}-${account.slot}-${Date.now().toString(36)}`
      // Running: launch the new seat now (wakeNow records the name after the launch). Not running: its next delivery does.
      if (running) await this.wakeNow(bot, { membersLease, sessionName: session, ...(admissionCheck ? { admissionCheck } : {}) })
      else { this.sessions.set(bot.id, session); await this.updateSession(bot.id, session, { membersLease }) }
      await this.accounts.setSeat(bot.id, account.slot, account.stamp ?? null).catch(() => {})
      return { botId: bot.id, session, slot: account.slot }
    })
    const previous = this.activity.configurationChanges.get(bot.id) ?? Promise.resolve()
    return this.activity.configurationChanges.track(bot.id, previous.then(run, run))
  }

  // After a registry change: seats whose effective slot differs move at their next idle boundary. A running turn is never stopped.
  // Limit-ended members get the account recovery (harness-accounts.md "limit end"), from one pty_list per review.
  reviewAccounts() {
    // One review at a time: a second one during the list would move a member twice.
    const run = (this.accountReview ?? Promise.resolve()).then(() => this.reviewAccountsNow())
    this.accountReview = run.catch(() => {})
    return run
  }

  async reviewAccountsNow() {
    // An engine that is not running (starting, quiescing, handed over) leaves moves to the running one.
    if (!this.accounts || this.accountRecoveryAllowed?.() === false) return
    const ends = await this.limitEnds().catch(error => {
      process.stderr.write(`BellTeam accounts: limit end review unavailable: ${error?.code ?? error?.message ?? 'UNKNOWN'}\n`)
      return new Map()
    })
    for (const botId of new Set([...Object.keys(this.accounts.state.seats), ...ends.keys()])) {
      const bot = this.resolveBot?.(botId)
      // Every recorded seat, also one launched by an earlier engine (the session map starts empty after an exchange).
      if (!this.claudeAccountBot(bot) || this.accountMoves.has(botId)) continue
      const seats = ends.get(botId) ?? []
      if (this.recoveryDue(botId, seats) || (this.accounts.seatSlot(botId) ?? '1st') !== await this.accounts.effectiveSlot('claude', bot.model)
        || await this.accounts.renewDue(botId, 'claude', bot.model)) this.moveAtBoundary(botId, seats)
    }
  }

  // A member's turn ended on an account limit (CapacityContinuation): its recovery now or when a slot frees.
  recoverAccount(botId) {
    if (this.accountMoves.has(botId)) return
    const run = this.limitEnds().then(ends => ends.get(botId) ?? [], () => [])
    this.accountMoves.set(botId, run)
    void run.then(seats => { this.accountMoves.delete(botId); this.moveAtBoundary(botId, seats) })
  }

  // Aiterm 0.70.26 limit end (harness-accounts.md): the Claude rows of account members, current and old seats, by member.
  // Seat names: <botId> or <botId>-<slot>-<base36>. A row without the fields (older Aiterm) gives nothing: no screen inference.
  async limitEnds() {
    const listed = (await this.client.call('pty_list', {}))?.structuredContent?.sessions
    if (!Array.isArray(listed)) throw Object.assign(new Error('AITERM_SESSIONS_UNAVAILABLE'), { code: 'AITERM_SESSIONS_UNAVAILABLE' })
    const ends = new Map(), suffix = new RegExp(`^(.+)-(?:${ACCOUNT_SLOTS.join('|')})-[a-z0-9]+$`, 'u')
    for (const seat of listed) {
      if (seat?.harness !== 'claude-code' || typeof seat.session_id !== 'string' || !('limit_end' in seat)) continue
      const botId = suffix.exec(seat.session_id)?.[1] ?? seat.session_id
      if (!this.claudeAccountBot(this.resolveBot?.(botId))) continue
      ends.set(botId, [...(ends.get(botId) ?? []), { session: seat.session_id, lastInputAt: seat.last_input_at ?? null, end: seat.limit_end ?? null }])
    }
    return ends
  }

  // An armed hold to cancel, or a last turn (greatest last_input_at) cut by a limit with nothing after it and no stop since.
  recoveryDue(botId, seats) {
    if (seats.some(seat => seat.end?.hold === 'armed' && !this.pressedHolds.has(`${seat.session}@${seat.end.at}`))) return true
    return this.continuationDue(botId, lastTurn(seats)?.end)
  }

  continuationDue(botId, end) {
    return Boolean(end && !end.continued && this.accounts.resumedAt(botId) !== end.at
      && !(Date.parse(this.accounts.stoppedAt(botId) ?? '') >= Date.parse(end.at)))
  }

  moveAtBoundary(botId, seats = []) {
    const pending = (async () => {
      for (;;) {
        const bot = this.resolveBot?.(botId)
        // A handed-over engine (quiescing) stops here: its registry copy is stale, and the successor reviews the member itself
        // (production 2026-11-12 01:14 JST: the retiring dc4b63be engine launched a second seat for Elegg next to the successor's).
        if (!this.claudeAccountBot(bot) || this.accountRecoveryAllowed?.() === false) return
        // No usable slot is free: nothing moves. A hold continues at its own reset, a move would only leave it behind,
        // and the next registry change reviews again.
        const slot = await this.accounts.freeSlot('claude', bot.model)
        if (!slot) return
        if (this.recoveryDue(botId, seats)) return await this.recoverMember(bot, slot, seats)
        if ((this.accounts.seatSlot(botId) ?? '1st') === slot && !await this.accounts.renewDue(botId, 'claude', bot.model)) return
        if (this.isIdle(botId) && !this.activity.configurationChanges.has(botId)) return await this.switchAccount(bot)
        await Promise.all(this.activity.of(botId).map(turn => (turn.nativeCompletion ?? turn.completion)?.catch(() => {})))
        await this.activity.configurationChanges.get(botId)?.catch(() => {})
      }
    })().catch(error => process.stderr.write(`BellTeam accounts: seat move unconfirmed: ${botId} ${error?.code ?? 'UNKNOWN'}\n`))
      .finally(() => this.accountMoves.delete(botId))
    this.accountMoves.set(botId, pending)
  }

  // harness-accounts.md "account recovery" with a free slot. Aiterm closed the limit-ended turn, so the seat is at a boundary.
  async recoverMember(bot, slot, seats) {
    // One Esc per armed hold and engine (two open Claude Code's rewind menu); Aiterm's next list confirms it.
    const allowed = () => this.accountRecoveryAllowed?.() !== false
    const armed = seats.filter(seat => seat.end?.hold === 'armed' && !this.pressedHolds.has(`${seat.session}@${seat.end.at}`))
    for (const seat of armed) {
      if (!allowed()) return
      this.pressedHolds.add(`${seat.session}@${seat.end.at}`)
      await this.client.call('pty_key', { session_id: seat.session, key: 'Escape' })
        .catch(error => process.stderr.write(`BellTeam accounts: limit hold key not sent: ${seat.session} ${error?.code ?? error?.message ?? 'UNKNOWN'}\n`))
    }
    let rows = seats
    for (let read = 0; armed.length && read < 10 && (read === 0 || rows.some(seat => seat.end?.hold === 'armed')); read++) {
      await new Promise(resolve => setTimeout(resolve, this.holdReleasePollMs))
      rows = (await this.limitEnds()).get(bot.id) ?? []
    }
    // A hold still armed would continue its turn at its reset next to the continuation: none now (two turns over one work).
    if (rows.some(seat => seat.end?.hold === 'armed')) {
      process.stderr.write(`BellTeam accounts: limit hold still armed, no continuation: ${bot.id}\n`)
      return
    }
    const end = lastTurn(rows)?.end
    if (!this.continuationDue(bot.id, end) || !allowed()) return
    this.accountRecoveries.add(bot.id)
    try {
      if ((this.accounts.seatSlot(bot.id) ?? '1st') !== slot || await this.accounts.renewDue(bot.id, 'claude', bot.model)) await this.switchAccount(bot)
      if (!allowed()) return
      await this.accounts.setResumed(bot.id, end.at)
      await this.continuation?.resume(bot, { slot, deliveryId: this.continuation.states.get(bot.id)?.deliveryId ?? null })
    } finally { this.accountRecoveries.delete(bot.id) }
  }

  async close() {
    this.accountsUnsubscribe?.()
    this.accounts?.close()
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

const forkUnavailable = cause => Object.assign(new Error('FORK_UNAVAILABLE: readonly_unenforceable', cause ? { cause } : {}),
  { code: 'FORK_UNAVAILABLE', reason: 'readonly_unenforceable', effect: 'not_started', status: 503 })

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

// harness-accounts.md "limit end": the member's last turn is its seat with the greatest last_input_at (null is oldest).
function lastTurn(seats) {
  return seats.reduce((last, seat) => !last || Date.parse(seat.lastInputAt ?? '') > Date.parse(last.lastInputAt ?? '') || (!last.lastInputAt && seat.lastInputAt) ? seat : last, null)
}
