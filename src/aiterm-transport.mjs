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

const HARNESS = new Map([
  ['claude', 'claude-code'],
  ['codex', 'codex-cli'],
  ['grok', 'grok-cli'],
  ['cursor', 'cursor-cli'],
])
const execFileAsync = promisify(execFile)
// 合間の言葉を取りに行く間隔。Aitermのpty_observeは画面本文を読まない軽い呼び出し。
const INTERIM_INTERVAL_MS = 3000
export const NIGHTLY_RESTART_TURNS = 20

export async function completedThroughlineTurns(project, { run = execFileAsync } = {}) {
  const { stdout } = await run('throughline', [
    'observer-read', '--project', project, '--limit', String(NIGHTLY_RESTART_TURNS), '--json',
  ], { env: runtimeEnvironment() })
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.observer_read.v1' || !Array.isArray(result.turns))
    throw new Error('THROUGHLINE_OBSERVER_READ_INVALID')
  return result.turns.length
}

export async function latestThroughlineHandoffContext(project, { run = execFileAsync } = {}) {
  const { stdout } = await run('throughline', [
    'handoff-context', '--project', project, '--json', '--disclosure', 'silent',
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
  constructor({ command = 'aiterm-mcp', env = runtimeEnvironment() } = {}) {
    this.command = command
    this.env = env
    this.client = null
    this.transport = null
  }

  async connect() {
    if (this.client) return
    this.client = new Client({ name: 'bellteam', version: '0.1.0' }, { capabilities: {} })
    this.transport = new StdioClientTransport({ command: this.command, stderr: 'inherit', ...(this.env ? { env: this.env } : {}) })
    await this.client.connect(this.transport)
  }

  async call(name, args = {}, { env, meta } = {}) {
    if (env) {
      // Aitermは値ではなくMCPプロセスの変数名を受け取る。起動ごとに専用の短命接続を使う。
      const launcher = new AitermClient({ command: this.command, env })
      try {
        const env_vars = Object.keys(env).filter(key => runtimeEnvironmentKeys.includes(key) || env[key] !== process.env[key])
        return await launcher.call(name, { ...args, env_vars })
      } finally {
        await launcher.close()
      }
    }
    await this.connect()
    const result = await this.client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
    if (result.isError) {
      const message = textResult(result) || `AITERM_TOOL_FAILED: ${name}`
      const error = new Error(message)
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
  constructor({ client = new AitermClient(), tempRoot = tmpdir(), waitProcess = runWaitProcess, handoffContext = latestThroughlineHandoffContext, prepareStartup = async () => {}, updateSession = async () => {}, requireAccess = async () => {}, activeId = randomUUID, now = () => new Date().toISOString(), interimInterval = INTERIM_INTERVAL_MS } = {}) {
    this.client = client
    this.interimInterval = interimInterval
    this.tempRoot = tempRoot
    this.waitProcess = waitProcess
    this.handoffContext = handoffContext
    this.prepareStartup = prepareStartup
    this.updateSession = updateSession
    this.requireAccess = requireAccess
    this.activeId = activeId
    this.now = now
    this.active = new Map()
    this.retainedImages = new Map()
    this.queueListeners = new Set()
    this.sessions = new Map()
    this.configurationChanges = new Map()
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
    if (await this.isRunning(bot)) return this.session(bot)
    return this.wake(bot)
  }

  async wake(bot, { setupTest = false } = {}) {
    await this.requireAccess({ setupTest, botId: bot.id })
    await mkdir(bot.project, { recursive: true })
    const harness = HARNESS.get(bot.harness)
    if (!harness) throw new Error(`HARNESS_UNSUPPORTED: ${bot.harness}`)
    const shortTermMemory = await this.handoffContext(bot.project)
    await this.prepareStartup(bot, shortTermMemory)
    const env = await loadBotEnvironment(bot.project)
    const launch = await this.client.call('agent_launch', {
      harness,
      cwd: bot.project,
      session_name: bot.id,
      trust_project: true,
      ...(bot.model ? { model: bot.model } : {}),
      ...(bot.reasoningEffort ? { reasoning_effort: bot.reasoningEffort } : {}),
    }, { env })
    const session = launch.structuredContent?.session_id
    if (typeof session !== 'string' || !session) throw new Error(`AITERM_LAUNCH_RECEIPT_INVALID: ${bot.id}`)
    this.sessions.set(bot.id, session)
    await this.updateSession(bot.id, session)
    return session
  }

  async restart(bot) {
    await this.idle(bot.id)
    const session = await this.restartNow(bot)
    return { botId: bot.id, session }
  }

  async reconfigure(current, next) {
    await this.requireAccess({ setupTest: false, botId: next.id })
    await this.idle(current.id)
    const requiresRestart = current.harness !== next.harness
      || (current.model && !next.model)
      || (current.reasoningEffort && !next.reasoningEffort)
    if (requiresRestart) {
      const session = await this.restartNow(next)
      return { botId: next.id, session, mode: 'restart' }
    }
    const configuration = { session_id: this.session(next) }
    if (current.model !== next.model) configuration.model = next.model
    if (current.reasoningEffort !== next.reasoningEffort) configuration.reasoning_effort = next.reasoningEffort
    if (next.harness === 'cursor' && configuration.reasoning_effort && !configuration.model) configuration.model = next.model
    await this.client.call('agent_configure', configuration)
    return { botId: next.id, session: this.session(next), mode: 'configure' }
  }

  async stop(bot) {
    await this.idle(bot.id)
    const result = await this.client.call('pty_close', { session_id: this.session(bot) })
    await this.removeRetainedImages(bot.id)
    return result
  }

  // セッションの状態と活動をAitermに観測させる。cursorを渡すと、前回の観測からの変化も返る。
  async observe(bot, cursor) {
    const result = await this.client.call('pty_observe', { session_id: this.session(bot), ...(cursor ? { cursor } : {}) })
    return result.structuredContent
  }

  // 動いていない席を閉じる。配送中・配送待ちがあれば閉じない。閉じた後の配送は不達になり、通常の経路で起動し直す。
  async closeIdle(bot) {
    if (!this.isIdle(bot.id) || this.configurationChanges.has(bot.id)) return false
    // 閉じている間の送信は、設定変更と同じ順序で、閉じ終わってから通常の不達復旧へ進める。
    const closing = (async () => {
      await this.client.call('pty_close', { session_id: this.session(bot) })
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
    const run = () => this.stop(bot)
    const previous = this.configurationChanges.get(bot.id) ?? Promise.resolve()
    const pending = previous.then(run, run)
    this.configurationChanges.set(bot.id, pending)
    // 失敗時は次の配送にもエラーを返し、利用者が設定を直すまで旧登録へ送らない。
    pending.then(() => {
      if (this.configurationChanges.get(bot.id) === pending) this.configurationChanges.delete(bot.id)
    }, () => {})
    return pending
  }

  turn(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null } = {}) {
    return this.submit(bot, message, { images, info: queue, onStatus, onInterim, transcript: true })
  }

  // BellTeamが始めたターンの合間の言葉を、完了まで数秒おきにAitermから受け取る。
  // stop()は最後にもう一度読んでターン末尾の言葉を拾い、エラーの知らせを受け取ったかを返す。
  followInterim(session, receipt, onInterim) {
    let after = 0
    let stopped = false
    let broken = false
    let wake = null
    const seen = { error: false }
    const read = async () => {
      if (broken) return
      try {
        const data = await this.readInterim(session, after)
        if (!data || data.event_cursor !== receipt.event_cursor) return
        const words = data.words.filter(word => word.seq > after)
        if (!words.length) return
        after = words.at(-1).seq
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
  async readInterim(session, after) {
    const result = await this.client.call('pty_observe', { session_id: session }, {
      meta: { 'aiterm/caller': 'BellTeam', 'aiterm/interim_after': after },
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
  async notify(bot, message, { images = [], queue = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null } = {}) {
    const completion = this.submit(bot, message, { images, info: queue, onStatus, onInterim, onAnswer, onTurnEnd })
    completion.catch(error => process.stderr.write(`BellTeam Aiterm delivery error: ${error.stack ?? error.message}\n`))
    return completion.accepted
  }

  async restartNow(bot) {
    await this.requireAccess({ setupTest: false, botId: bot.id })
    await this.client.call('pty_close', { session_id: this.session(bot) })
    await this.removeRetainedImages(bot.id)
    return this.wake(bot)
  }

  submit(bot, message, { images = [], info = {}, onStatus = null, onInterim = null, onAnswer = null, onTurnEnd = null, transcript = false, setupTest = false } = {}) {
    const job = { id: this.activeId(), bot, info: { ...info, message: info.message ?? message, image: images.length > 0, ...(images.length ? { image_count: images.length } : {}) }, startedAt: this.now() }
    const parent = [...this.active.values()].reverse().find(item => item.bot.id === bot.id)
    let accept
    let rejectAcceptance
    const accepted = new Promise((resolve, reject) => { accept = resolve; rejectAcceptance = reject })
    accepted.catch(() => {})
    let acknowledged = false
    const completion = (async () => {
      let delivery
      try {
        const configuration = this.configurationChanges.get(bot.id)
        if (configuration) await configuration
        this.active.set(job.id, job)
        this.emitQueue()
        await this.requireAccess({ setupTest, botId: bot.id })
        delivery = await this.dispatch(bot, message, images, { setupTest })
        job.receipt = delivery.receipt
        await onStatus?.('running')
        acknowledged = true
        accept({ delivery: delivery.receipt.mode === 'agent_steer' ? 'steered' : 'running' })
        if (delivery.receipt.mode === 'agent_steer') {
          if (parent) await parent.completion
          await onStatus?.('delivered')
          return { delivery: 'steered' }
        }
        const interim = onInterim ? this.followInterim(delivery.session, delivery.receipt, onInterim) : null
        let completion
        try {
          completion = await this.waitUntilDone(delivery.receipt)
        } catch (error) {
          const seen = await interim?.stop()
          // 記録にエラーの知らせが無い時（Grok・Cursor、記録に残らない利用上限）は、Aitermが返した理由を代わりに出す。
          if (interim && !seen.error && String(error.message).startsWith('AITERM_TURN_'))
            await onInterim([{ text: error.message, kind: 'error' }])
          throw error
        }
        await interim?.stop()
        const readAnswer = async () => transcriptText(await this.client.call('pty_read', {
          session_id: delivery.session,
          agent_transcript: true,
          ...(completion.operation_id ? { operation_id: completion.operation_id } : {}),
        }), completion)
        const answer = transcript ? await readAnswer() : undefined
        // 画面に出すだけの回答なので、読めなくても配送は完了として扱う。
        if (!transcript && onAnswer) {
          try {
            const text = await readAnswer()
            if (typeof text === 'string' && text.trim()) await onAnswer(text)
          } catch (error) {
            process.stderr.write(`BellTeam answer read error: ${error.stack ?? error.message}\n`)
          }
        }
        await onStatus?.('delivered')
        onTurnEnd?.({ startedAt: job.startedAt, endedAt: this.now() })
        return transcript ? answer : { delivery: 'delivered' }
      } catch (error) {
        if (!acknowledged) rejectAcceptance(error)
        await onStatus?.('failed')
        throw error
      } finally {
        const temporary = delivery?.imageFiles.filter(file => file.temporary) ?? []
        if (delivery?.receipt.mode === 'agent_steer' && !parent && temporary.length) {
          const retained = this.retainedImages.get(bot.id) ?? []
          retained.push(...temporary)
          this.retainedImages.set(bot.id, retained)
        } else await this.removeTemporaryImages(delivery?.imageFiles)
        this.active.delete(job.id)
        this.emitQueue()
      }
    })()
    job.completion = completion
    completion.accepted = accepted
    return completion
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

  async dispatch(bot, message, images, { setupTest = false } = {}) {
    const imageFiles = await this.imageFiles(images)
    try {
      let session = this.session(bot)
      let result
      try {
        result = await this.sendToSession(session, message, imageFiles)
      } catch (error) {
        // 画面は残り登録だけ消えた席は、起動もできない。閉じてから起こし直し、同じ文を1回だけ送る。
        if (error.code === 'AGENT_SESSION_REQUIRED') {
          process.stderr.write(`BellTeam Aiterm agent registration lost, restarting: ${bot.id}\n`)
          await this.client.call('pty_close', { session_id: session })
          await this.removeRetainedImages(bot.id)
        } else if (await this.isRunning(bot)) throw error
        session = await this.wake(bot, { setupTest })
        result = await this.sendToSession(session, message, imageFiles)
      }
      const receipt = result.structuredContent
      if (receipt?.mode !== 'agent_steer'
        && (receipt?.mode !== 'agent_dispatch' || !Number.isInteger(receipt.event_cursor) || !receipt.wait_process))
        throw new Error(`AITERM_DISPATCH_RECEIPT_INVALID: ${bot.id}`)
      if (receipt.mode === 'agent_dispatch') await this.removeRetainedImages(bot.id)
      return { receipt, imageFiles, session }
    } catch (error) {
      await this.removeTemporaryImages(imageFiles)
      throw error
    }
  }

  // 画像はaitermのimage引数へ渡す。harness別の添付手順（パスの先打鍵等）はaitermが吸収する（0.30.0）。
  // require_agentで、登録が無い席へ普通の端末として打たれる（mode=sent）のを止める。
  async sendToSession(session, message, imageFiles) {
    return this.client.call('pty_send', {
      session_id: session,
      text: message,
      require_agent: true,
      ...(imageFiles.length ? { image: imageFiles.map(file => file.path) } : {}),
    })
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

  async waitUntilDone(receipt) {
    while (true) {
      const result = await this.waitProcess(receipt.wait_process)
      if (result.outcome === 'done') return result
      if (result.outcome === 'timeout' || result.outcome === 'running') continue
      // error: harnessの記録でturnがAPIエラー等で打ち切られた（Aiterm 0.31.0）。本文を残して配送失敗にする。
      if (result.outcome === 'error') throw new Error(`AITERM_TURN_ERROR: ${result.error ?? 'unknown'}`)
      // rate_limited: harnessの利用上限。Aitermが画面や記録から拾った上限の知らせを理由に残す。
      if (result.outcome === 'rate_limited' && result.rate_limit) throw new Error(`AITERM_TURN_RATE_LIMITED: ${result.rate_limit}`)
      throw new Error(`AITERM_TURN_${String(result.outcome).toUpperCase()}`)
    }
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
    const botIds = new Set([...this.active.values()].map(job => job.bot.id))
    await Promise.all([...botIds].map(botId => this.idle(botId)))
    await this.client.close?.()
  }
}

function runWaitProcess(waitProcess) {
  return new Promise((resolve, reject) => {
    const child = spawn(waitProcess.executable, waitProcess.args, { env: runtimeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
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
