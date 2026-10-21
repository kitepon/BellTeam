import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadBotEnvironment } from './bot-environment.mjs'
import { runtimeEnvironment, runtimeEnvironmentKeys } from './runtime-home.mjs'
import { ExecutionBridge, returnedExecutionError, ERROR_META } from './execution-bridge.mjs'
import { reserveExecution, dispatchExecution, finishExecution, applyExecutionStop, applyExecutionCancellation, interruptExecutions } from './execution-transport.mjs'

const HARNESS = new Map([
  ['claude', 'claude-code'],
  ['codex', 'codex-cli'],
  ['grok', 'grok-cli'],
  ['cursor', 'cursor-cli'],
])
const execFileAsync = promisify(execFile)
// 合間の言葉を取りに行く間隔。Aitermのpty_observeは画面本文を読まない軽い呼び出し。
const INTERIM_INTERVAL_MS = 3000
// Aitermは、要求の_metaにこの印がある時だけ、BellTeamのための手がかりを結果へ足す（Aiterm ADR 0071・0122）。
const CALLER_META = { 'aiterm/caller': 'BellTeam' }
export const NIGHTLY_RESTART_TURNS = 20

// Supervisor uses one SDK client for normal dispatch, relation registration
// and interruption. An unavailable execution runtime must reject the request;
// it must not silently select the legacy dispatch/close path.
export function createManagedTransport({ client = new AitermClient(), ...options } = {}) {
  return new AitermTransport({ ...options, client, executionBridge: new ExecutionBridge(client) })
}

export async function completedThroughlineTurns(project, { run = execFileAsync } = {}) {
  const { stdout } = await run('throughline', [
    'observer-read', '--project', project, '--limit', String(NIGHTLY_RESTART_TURNS), '--json',
  ], { env: runtimeEnvironment() })
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.observer_read.v1' || !Array.isArray(result.turns))
    throw new Error('THROUGHLINE_OBSERVER_READ_INVALID')
  return result.turns.length
}

// 短期記憶は、直前の1セッションだけでなく直近の複数セッションから作る（オーナー裁定 2026-10-05、Approval Box K-8GPX8C）。
// `--sessions recent` は Throughline 0.15.0 から。それより前の版は終了コード2で止まり、席が起きない。
export async function latestThroughlineHandoffContext(project, { run = execFileAsync } = {}) {
  const { stdout } = await run('throughline', [
    'handoff-context', '--project', project, '--json', '--disclosure', 'silent', '--sessions', 'recent',
  ], { env: runtimeEnvironment() })
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.handoff_context.v1')
    throw new Error('THROUGHLINE_HANDOFF_CONTEXT_INVALID')
  if (result.status === 'empty' && result.sessionId === null && result.context === '') return ''
  if (result.status !== 'ready'
    || typeof result.sessionId !== 'string'
    || !result.sessionId
    || typeof result.context !== 'string'
    || !result.context.trim()) throw new Error('THROUGHLINE_HANDOFF_CONTEXT_INVALID')
  return result.context.trim()
}

export class AitermClient {
  constructor({ command = 'aiterm-mcp', args = [], env = runtimeEnvironment() } = {}) {
    this.command = command
    this.args = [...args]
    this.env = env
    this.client = null
    this.transport = null
    this.connecting = null
  }

  async connect() {
    if (this.connecting) return this.connecting
    if (this.client) return
    this.client = new Client({ name: 'bellteam', version: '0.1.0' }, { capabilities: {} })
    this.transport = new StdioClientTransport({ command: this.command, args: this.args, stderr: 'inherit', ...(this.env ? { env: this.env } : {}) })
    const client = this.client
    const transport = this.transport
    client.onclose = () => {
      if (this.client === client) {
        this.client = null
        this.transport = null
      }
    }
    // clientを作っただけでは初期化は終わっていない。同時の呼出しも同じ接続完了を待つ。
    this.connecting = (async () => {
      try {
        await client.connect(transport)
      } catch (error) {
        // 失敗した接続を次の要求へ持ち越さない。この要求そのものを自動再送はしない。
        await transport.close().catch(() => {})
        this.client = null
        this.transport = null
        throw error
      }
    })()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async call(name, args = {}, { env, meta } = {}) {
    if (env) {
      // Aitermは値ではなくMCPプロセスの変数名を受け取る。起動ごとに専用の短命接続を使う。
      const launcher = new AitermClient({ command: this.command, args: this.args, env })
      try {
        const env_vars = Object.keys(env).filter(key => runtimeEnvironmentKeys.includes(key) || env[key] !== process.env[key])
        return await launcher.call(name, { ...args, env_vars }, { meta })
      } finally {
        await launcher.close()
      }
    }
    await this.connect()
    const result = await this.client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
    if (result.isError) {
      const message = textResult(result) || `AITERM_TOOL_FAILED: ${name}`
      const error = new Error(message)
      // tool handlerがエラー結果を返し終えた事と、RPC timeout/通信断で結果が不明な事を区別する。
      error.aitermResponseReturned = true
      const executionError = returnedExecutionError(result._meta?.[ERROR_META])
      if (executionError) error.executionError = executionError
      // 起動の準備が終わらなかった時、Aitermは作った端末の名前と止まった理由を構造で返す（aiterm.agent-launch-result.v1）。
      if (name === 'agent_launch' && result.structuredContent?.schema === 'aiterm.agent-launch-result.v1')
        error.launch = result.structuredContent
      // Aitermが未送信を明示した入力受付の拒否は、その席の状態との衝突。
      // その他の送信失敗や受付後の不明な結果まで成功・未送信と決めない。
      if (name === 'pty_send'
        && message.startsWith(`aiterm: agent session '${args.session_id}' の `)
        && message.includes(' TUI が入力受付状態になりません。文字列は送信していません。')) {
        error.code = 'BOT_INPUT_NOT_READY'
        error.status = 409
        error.publicMessage = 'このBotは現在入力を受け付けられず、メッセージは送信されませんでした。Botの画面を確認してください。'
      }
      // 席の登録が無いsessionを、Aitermが打つ前に断った（require_agent、Aiterm 0.52.0）。送っていないので、起こし直して送り直せる。
      if (name === 'pty_send'
        && message.startsWith('aiterm: AGENT_SESSION_REQUIRED:')
        && message.includes('文字列は送信していません。')) error.code = 'AGENT_SESSION_REQUIRED'
      // 同じ席への先の送信が終わるのを待ち切れず、Aitermが打つ前に断った（Aiterm 0.52.1、待ちは60秒）。
      // 登録を確かめた後の断りなので席は生きている。送っていないので、後から送り直せる。
      if (name === 'pty_send'
        && message.startsWith(`aiterm: AGENT_SEND_BUSY: agent session '${args.session_id}' は`)
        && message.includes('文字列は送信していません。')) {
        error.code = 'BOT_SEND_BUSY'
        error.status = 409
        error.publicMessage = 'このBotは先に届いた送信を受け付けている途中で、メッセージは送信されませんでした。少し待ってから送り直してください。'
      }
      throw error
    }
    return result
  }

  async close() {
    await this.transport?.close()
    this.client = null
    this.transport = null
  }
}

export class AitermTransport {
  constructor({ client = new AitermClient(), executionBridge = null, tempRoot = tmpdir(), waitProcess = runWaitProcess, handoffContext = latestThroughlineHandoffContext, prepareStartup = async () => {}, updateSession = async () => {}, updateFastMode = async () => {}, requireAccess = async () => {}, assertWorkAllowed = () => {}, activeId = randomUUID, now = () => new Date().toISOString(), interimInterval = INTERIM_INTERVAL_MS } = {}) {
    this.client = client
    this.executionBridge = executionBridge
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
    this.active = new Map()
    this.retainedImages = new Map()
    this.queueListeners = new Set()
    this.sessions = new Map()
    this.configurationChanges = new Map()
    this.dispatches = new Map()
    this.jobs = new Set()
    this.interruptions = new Map()
    this.stopVersions = new Map()
    this.stopSessions = new Map()
    this.waking = new Map()
    this.sessionChanges = new Map()
    this.uncertainChanges = new Map()
    // 席ごとの、BellTeamが始めていないターンを追っている見張り（watchTurn）。
    this.watches = new Map()
    // 席ごとの、最後に終わりまで追ったターン。Aitermへ聞いた後に終わったターンを、もう一度追い始めない。
    this.followedTurns = new Map()
    // 席ごとの、最後に追ったターンで合間の言葉として出した文。そのターンの回答はself-turns.mjsがThroughlineから出し、
    // Throughlineはターンの文を全部つなげて返すので、先に出した分を回答の頭から外すのに使う。
    this.shownWords = new Map()
  }

  async isRunning(bot) {
    return (await this.runningBots([bot])).has(bot.id)
  }

  // 渡したBotのうち、席が動いているもののid。Aitermのpty_listは呼ぶたびにtmuxを1回起動するので、
  // 一覧のように何人も続けて調べる時は、Botごとに呼ばずこれを1回呼ぶ。
  async runningBots(bots) {
    const result = await this.client.call('pty_list')
    const sessions = new Set(textResult(result).split('\n').map(line => line.split('\t', 1)[0]))
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
    await this.interruptions.get(bot.id)
    this.requireStopVersion(bot.id, version)
    const running = await this.isRunning(bot)
    this.requireStopVersion(bot.id, version)
    if (running) return this.session(bot)
    return this.wake(bot)
  }

  wake(bot, options = {}) {
    this.assertWorkAllowed()
    this.requireSessionKnown(bot.id)
    const pending = this.wakeNow(bot, options)
    this.waking.set(bot.id, pending)
    const clear = () => { if (this.waking.get(bot.id) === pending) this.waking.delete(bot.id) }
    pending.then(clear, clear)
    return pending
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
    await this.interruptions.get(bot.id)
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
    await this.interruptions.get(current.id)
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

  // 会話を残した現在処理の中断。未対応環境でclose/キー直送へ戻さない。
  interrupt(bot) {
    if (!this.executionBridge) return Promise.reject(Object.assign(
      new Error('処理の中断を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED' }))
    return this.interruptMany([bot]).then(result => {
      if (result.unconfirmedBotIds.length) throw Object.assign(
        new Error('処理の中断を確認できませんでした。'), { code: 'BOT_STOP_UNCONFIRMED', cascade: result.cascade })
      return { botId: bot.id, status: 'interrupted', sessionPreserved: true }
    })
  }

  interruptMany(bots) {
    if (!this.executionBridge) throw Object.assign(new Error('EXECUTION_BRIDGE_REQUIRED'), { code: 'BOT_STOP_UNCONFIRMED' })
    return interruptExecutions(this, bots)
  }

  requireStopVersion(botId, version) {
    this.assertWorkAllowed()
    if (this.stopVersions.get(botId) !== version) throw stoppedError()
  }

  // session_idだけに作用する変更の発行と返却を追う。応答待ちのcloseを残したまま同じ席を起こさない。
  captureStopVersion(bot) {
    if (this.executionBridge) this.stopSessions.set(bot.id, this.session(bot))
    return this.stopVersions.get(bot.id)
  }

  async awaitUnboundAdmission(bot, version, barrier = this.executionStopping) {
    while (barrier) {
      let result
      try { result = await barrier } catch (cause) {
        throw Object.assign(new Error('停止結果が未確認のため変更できません。', { cause }), { code: 'BOT_STOP_UNCONFIRMED', effect: 'not_started' })
      }
      if (barrier.rootIds?.has(bot.id) || result?.cascade?.targets.some(value => value.launch.session_id === this.session(bot)))
        throw Object.assign(stoppedError(), { effect: 'not_started' })
      barrier = this.executionStopping !== barrier ? this.executionStopping : null
    }
    if (this.stopVersions.get(bot.id) !== version) throw Object.assign(stoppedError(), { effect: 'not_started' })
    this.requireSessionKnown(bot.id)
  }

  changeSession(bot, name, args, options) {
    if (name !== 'pty_close') this.assertWorkAllowed()
    this.requireSessionKnown(bot.id)
    const { execution, ...clientOptions } = options ?? {}
    const version = this.captureStopVersion(bot), barrier = this.executionStopping
    let issued = false
    const invoke = () => {
      if (name !== 'pty_close') this.assertWorkAllowed()
      issued = true
      return execution ? execution.invoke(name, args, clientOptions) : this.client.call(name, args, options)
    }
    const pending = this.executionBridge && !execution ? (async () => {
      await this.awaitUnboundAdmission(bot, version, barrier)
      // A new stop can start between async admission and this continuation.
      while (this.executionStopping) await this.awaitUnboundAdmission(bot, version)
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
      changes.delete(pending)
      if (!changes.size && this.sessionChanges.get(bot.id) === changes) this.sessionChanges.delete(bot.id)
    }
    pending.then(clear, error => {
      // RPCのrejectは遠隔の変更を取り消さない。後から旧closeが届き得る同名の席を自動で再利用しない。
      if (issued && ((error?.effect !== 'not_started' && error?.aitermResponseReturned !== true && error?.launch?.schema !== 'aiterm.agent-launch-result.v1')
        || error?.executionError?.effect === 'possible'))
        this.uncertainChanges.set(bot.id, name)
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

  // セッションの状態と活動をAitermに観測させる。cursorを渡すと、前回の観測からの変化も返る。
  async observe(bot, cursor) {
    const result = await this.client.call('pty_observe', { session_id: this.session(bot), ...(cursor ? { cursor } : {}) })
    return result.structuredContent
  }

  // 動いていない席を閉じる。配送中・配送待ちがあれば閉じない。閉じた後の配送は不達になり、通常の経路で起動し直す。
  async closeIdle(bot) {
    if (!this.isIdle(bot.id) || this.configurationChanges.has(bot.id) || this.interruptions.has(bot.id)) return false
    // 閉じている間の送信は、設定変更と同じ順序で、閉じ終わってから通常の不達復旧へ進める。
    const closing = (async () => {
      await this.changeSession(bot, 'pty_close', { session_id: this.session(bot) })
      await this.removeRetainedImages(bot.id)
      return true
    })()
    this.configurationChanges.set(bot.id, closing)
    try {
      return await closing
    } finally {
      if (this.configurationChanges.get(bot.id) === closing) this.configurationChanges.delete(bot.id)
    }
  }

  stopForConfiguration(bot) {
    const version = this.captureStopVersion(bot)
    const barrier = this.executionStopping
    const run = async () => {
      if (this.executionBridge) await this.awaitUnboundAdmission(bot, version, barrier)
      return this.stop(bot, version)
    }
    const previous = this.configurationChanges.get(bot.id) ?? Promise.resolve()
    const pending = previous.then(run, run)
    this.configurationChanges.set(bot.id, pending)
    // 失敗時は次の配送にもエラーを返し、利用者が設定を直すまで旧登録へ送らない。
    pending.then(() => {
      if (this.configurationChanges.get(bot.id) === pending) this.configurationChanges.delete(bot.id)
    }, () => {})
    return pending
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
  async notify(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, executionSource } = {}) {
    const completion = this.submit(bot, message, { images, info: queue, onStatus, onInterim, onAnswer, onTurnEnd, executionSource })
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

  submit(bot, message, { images = [], info = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, transcript = false, setupTest = false, admissionCheck = () => {}, executionSource } = {}) {
    const job = { id: this.activeId(), bot, controller: new AbortController(), executionSource: executionSource ? structuredClone(executionSource) : null, info: { ...info, message: info.message ?? message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}) }, startedAt: this.now() }
    this.jobs.add(job)
    const check = () => {
      if (job.stopRequested) throw stoppedError()
      this.assertWorkAllowed()
      admissionCheck()
      this.requireSessionKnown(bot.id)
    }
    // 既に受理されたsend/doneは保持して停止の結論を待つ。停止未確認なら通常の結果処理へ戻る。
    const checkpoint = async () => {
      await this.executionStopping?.catch(() => {})
      if (job.stopped) throw stoppedError()
      if (job.executionStopResult && job.receipt) job.stopRequested = false
      if (!job.stopRequested) return
      try { await job.interruption } catch (error) {
        if (!job.receipt) throw error
        job.stopRequested = false
        return
      }
      if (job.stopped) throw stoppedError()
    }
    const parent = [...this.active.values()].reverse().find(item => item.bot.id === bot.id)
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
        const interruption = this.interruptions.get(bot.id)
        if (interruption) await interruption
        if (job.stopRequested) throw stoppedError()
        const configuration = this.configurationChanges.get(bot.id)
        if (configuration) await configuration
        check()
        if (this.executionBridge) await reserveExecution(this, job)
        check()
        this.active.set(job.id, job)
        this.emitQueue()
        await this.requireAccess({ setupTest, botId: bot.id })
        check()
        delivery = await this.dispatchInOrder(bot, message, images, { setupTest, check, executionJob: job })
        job.receipt = delivery.receipt
        await applyExecutionStop(job)
        await checkpoint()
        const steered = delivery.receipt.mode === 'agent_steer'
        followed = !steered || delivery.steer !== null
        // 同じ席のターンをもう追っているjobが在れば、合間の言葉はそちらが出す（同じ言葉を2回出さない）。
        const follower = steered ? this.follower(bot.id) : null
        // 次の送信はこの印を見て決めるので、返りを受け取ってからここまでawaitを挟まない。
        job.follows = followed && !follower
        await onStatus?.('running')
        await checkpoint()
        acknowledged = true
        accept({ delivery: steered ? 'steered' : 'running' })
        // 待つ手がかりを返さない差し込み（Aiterm 0.59.1まで）は、同じ席のjobの終わりを待つ。無ければ、終わりを知る道が無い。
        if (!followed) {
          if (parent) await parent.completion
          await checkpoint()
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
        await checkpoint()
        await finishExecution(job, 'completion')
        if (completion.turn_id) this.followedTurns.set(bot.id, completion.turn_id)
        // 動いていたターンが取り込んだ差し込みは、そのターンの一部。回答は、そのターンを始めた側が出す
        // （BellTeamが始めたターンは元の配送、席が自分で始めたターンはself-turns.mjs）。
        // 取り込まれたかを見分けられなかった時（unknown）も、回答を2回出さないよう同じに扱う。
        if (steered && completion.steer?.placement !== 'next_turn') {
          await follower?.completion.catch(() => {})
          await checkpoint()
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
        await checkpoint()
        // 画面に出すだけの回答なので、読めなくても配送は完了として扱う。
        if (!transcript && onAnswer) {
          try {
            const text = await readAnswer()
            await checkpoint()
            if (typeof text === 'string' && text.trim()) await onAnswer(text)
          } catch (error) {
            process.stderr.write(`BellTeam answer read error: ${error.stack ?? error.message}\n`)
          }
        }
        await checkpoint()
        await onStatus?.('delivered')
        await checkpoint()
        onTurnEnd?.({ startedAt: job.startedAt, endedAt: this.now() })
        return transcript ? answer : { delivery: 'delivered' }
      } catch (error) {
        await this.executionStopping?.catch(() => {})
        applyExecutionCancellation(job, error)
        if (job.stopped) error = stoppedError()
        if (job.stopRequested) {
          try { await job.interruption } catch (stopError) { error = stopError }
          if (job.stopped) error = stoppedError()
        }
        if (['BOT_STOPPED', 'AI_GLOBAL_PAUSED'].includes(error.code) && !job.receipt) job.stopped = true
        if (job.execution && !job.receipt && !job.execution.issued.size) await finishExecution(job, 'not_sent')
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
        this.active.delete(job.id)
        this.jobs.delete(job)
        this.emitQueue()
      }
    })()
    job.completion = completion
    completion.accepted = accepted
    return completion
  }

  // その席のターンを終わりまで追っているjob（配送で始めたターン、追っている差し込み、見つけた席のターン）。
  follower(botId) {
    return [...this.active.values()].reverse().find(job => job.bot.id === botId && job.follows)
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
      if (this.interruptions.has(bot.id) || versions.get(bot.id) !== this.stopVersions.get(bot.id)) continue
      const session = this.session(bot)
      const turn = turns.get(session)
      const watch = this.watches.get(bot.id)
      // 追っているターンがもう動いていない。止められたターンでは、Aitermの待ちは返らない（完了の印だけを待つ）。
      // nullは「分からない」なので、追い続ける。
      if (watch && turn !== null && (turn?.state !== 'running' || turn.turn_id !== watch.turnId)) watch.end()
      if (turn?.state === 'running' && this.isIdle(bot.id) && this.followedTurns.get(bot.id) !== turn.turn_id)
        this.watchTurn(bot, session, turn, { onInterim, groupId })
    }
    return true
  }

  // 見つけたターンを終わりまで「処理中」に出し、合間の言葉を出す。
  // 回答は運ばない。席が自分で始めたターンの回答は、self-turns.mjsがThroughlineから出す（オーナー裁定 2026-10-01）。
  watchTurn(bot, session, turn, { onInterim, groupId }) {
    const group = groupId()
    const job = {
      id: this.activeId(), bot, follows: true, startedAt: turn.started_at ?? this.now(),
      info: { context: 'self', contextId: bot.id, groupId: group, target: bot.id },
    }
    const stop = new AbortController()
    const ended = new Promise(resolve => stop.signal.addEventListener('abort', resolve, { once: true }))
    const shown = { words: [], endedAt: null }
    this.followedTurns.set(bot.id, turn.turn_id)
    this.watches.set(bot.id, { turnId: turn.turn_id, end: () => stop.abort() })
    this.shownWords.set(bot.id, shown)
    this.active.set(job.id, job)
    this.emitQueue()
    job.completion = (async () => {
      const say = onInterim ? async words => {
        await onInterim(bot.id, group, words)
        shown.words.push(...words.filter(word => word.kind !== 'error').map(word => word.text.trim()).filter(Boolean))
      } : null
      const interim = say ? this.followInterim(session, turn, say, { from: turn.interim_from, turnId: turn.turn_id }) : null
      try {
        let failure = null
        await Promise.race([ended, this.waitUntilDone(turn, stop.signal).catch(error => { failure = error })])
        const seen = await interim?.stop()
        if (!failure || stop.signal.aborted) return
        // エラーや利用上限で終わったターンは、配送したターンと同じく、記録に知らせが無い時だけAitermが返した理由を出す。
        if (interim && !seen.error && /^AITERM_TURN_(ERROR|RATE_LIMITED)/u.test(failure.message))
          await say([{ text: failure.message, kind: 'error' }])
        else process.stderr.write(`BellTeam seat turn: ${bot.id} のターンを終わりまで追えませんでした（${failure.message}）\n`)
      } catch (error) {
        process.stderr.write(`BellTeam seat turn error: ${error.stack ?? error.message}\n`)
      } finally {
        shown.endedAt = Date.parse(this.now())
        this.watches.delete(bot.id)
        this.active.delete(job.id)
        this.emitQueue()
      }
    })()
  }

  // 席が自分で始めたターンのうち、最後に追ったターンで合間の言葉として出した文と、追い終えた時刻。
  shownInSelfTurn(botId) {
    return this.shownWords.get(botId) ?? null
  }

  async idle(botId) {
    while ([...this.active.values()].some(job => job.bot.id === botId))
      await Promise.all([...this.active.values()].filter(job => job.bot.id === botId).map(job => job.completion.catch(() => {})))
  }

  isIdle(botId) {
    return ![...this.active.values()].some(job => job.bot.id === botId)
  }

  restartIfIdle(bot) {
    if (!this.isIdle(bot.id)) return Promise.resolve({ restarted: false, reason: 'busy' })
    return this.restart(bot).then(result => ({ restarted: true, ...result }))
  }

  queueItems({ botId = null, roomId = null } = {}) {
    return [...this.active.values()]
      .filter(job => !botId || job.bot.id === botId)
      .filter(job => !roomId || (job.info.context === 'room' && job.info.contextId === roomId))
      .map(job => ({
        id: job.id, botId: job.bot.id, botName: job.bot.displayName ?? job.bot.name ?? job.bot.id,
        status: 'running', startedAt: job.startedAt, ...job.info,
      }))
  }

  watchQueue(listener) {
    this.queueListeners.add(listener)
    return () => this.queueListeners.delete(listener)
  }

  emitQueue() {
    for (const listener of this.queueListeners) listener()
  }

  // 同じ席への送信は、前の送信をAitermが受け付けてから始める。起こしている途中の席へ次の文が重なると、
  // Aitermは両方を新しいターンとして入力受付を待たせ、後の方を「未解決のturnがある」と断る（Aiterm 0.52.0）。
  // 受け付けた後なら、次の文は実行中のターンへの差し込みになる。
  dispatchInOrder(bot, message, images, options) {
    const run = () => { options?.check?.(); return this.dispatch(bot, message, images, options) }
    const delivery = (this.dispatches.get(bot.id) ?? Promise.resolve()).then(run)
    const settled = delivery.then(() => {}, () => {})
    this.dispatches.set(bot.id, settled)
    settled.then(() => {
      if (this.dispatches.get(bot.id) === settled) this.dispatches.delete(bot.id)
    })
    return delivery
  }

  async dispatch(bot, message, images, { setupTest = false, check = () => {}, executionJob } = {}) {
    if (this.executionBridge) {
      const delivery = await dispatchExecution(this, executionJob, bot, message, images, { setupTest, check })
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
    return this.sessions.get(bot.id) ?? bot.session
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
    for (const watch of this.watches.values()) watch.end()
    const botIds = new Set([...this.active.values()].map(job => job.bot.id))
    await Promise.all([...botIds].map(botId => this.idle(botId)))
    await this.client.close?.()
  }
}

function runWaitProcess(waitProcess, signal = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(waitProcess.executable, waitProcess.args, {
      env: runtimeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch {
        reject(new Error(`AITERM_WAIT_INVALID: ${stderr.trim()}`))
      }
    })
  })
}

function textResult(result) {
  return result?.content?.find(item => item.type === 'text')?.text ?? ''
}

function stoppedError() {
  const error = new Error('メンバーの動作を停止しました。')
  error.code = 'BOT_STOPPED'
  return error
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
