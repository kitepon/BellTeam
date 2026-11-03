// Botのハーネスが自分から始めたターンの最後の回答を、Throughlineの記録から拾ってオーナーの会話画面へ出す（オーナー裁定 2026-10-01）。
// Claude Code・Grok・Cursorは、裏で動かした作業が終わると、BellTeamを通らずに次のターンを始める。
// BellTeamは配送したターンしか見ていないので、そのターンの報告がオーナーへ届かなかった（2026-10-01 ラプンツェル）。
// Throughlineはどう始まったターンもStop hookで記録し、turn_startで始まり方を返す（0.10.22、--wire v2）。
// BellTeamが配送したターン（prompt）は配送の側で画面に出しているので、ここでは自分から始まったターン（self）を出す。
// Aitermが子の結果を親の席へ渡して始めたターンも、記録ではpromptになる。BellTeamは配送していないので、selfと同じく出す
// （2026-10-13、リリーバイスの席で、子の結果で始まったターンの回答がオーナーの画面に出なかった）。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runtimeEnvironment } from './runtime-home.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'
import { checkObserverProjects, observerCheckRequests, validateObserverCheckResult, runObserverCommand } from './observer-check.mjs'

// 公開checkと読み残しを確認する一巡の終了後から次巡までの間隔。
const INTERVAL_MS = 5000
// thread_switched（/clearなど）で読み終えた分がまた届くので、Botごとに最近の鍵を覚えて重複を落とす。
const SEEN_LIMIT = 500
// Aitermが子の結果を渡す文の頭（aiterm-mcp の src/parent-delivery.ts の answerMessage）。
// 配送したターンの途中に子の結果が差し込まれた時は、頭が配送した文になるので当たらない。
const CHILD_RESULT_PREFACE = 'Aitermの子エージェントからの実行結果です。'

// 追ったターンの終わり（Aitermの待ちが返った時刻）と、Throughlineの記録の終わりを、同じターンとみなす幅。
const SAME_TURN_MS = 60_000

// 合間の言葉として先に画面へ出した文が、回答の頭に順番どおり全部並んでいる時だけ、その分を外す。
// Throughlineはターンの文を全部つなげて返すので、外さないと同じ文が2回出る（2026-10-14、Codexの席）。
// 1つでも合わない時、別のターンの分の時、外すと何も残らない時は、回答をそのまま出す。
function withoutShownWords(text, shown, completedAt) {
  if (!shown?.words.length) return text
  if (shown.endedAt !== null && Math.abs(completedAt - shown.endedAt) > SAME_TURN_MS) return text
  let rest = text
  for (const word of shown.words) {
    if (!rest.startsWith(word)) return text
    rest = rest.slice(word.length).trimStart()
  }
  return rest || text
}

function startedOutsideDelivery(turn) {
  if (turn.turn_start === 'self') return true
  return turn.turn_start === 'prompt' && typeof turn.user === 'string' && turn.user.trimStart().startsWith(CHILD_RESULT_PREFACE)
}

export class SelfTurns {
  constructor({ bots, statePath, appendAnswer, afterTurn = () => {}, shown = () => null, read = readObserverTurns, check = checkObserverProjects, report = message => process.stderr.write(`${message}\n`), groupId = randomUUID, intervalMs = INTERVAL_MS }) {
    this.bots = bots
    this.statePath = statePath
    this.appendAnswer = appendAnswer
    this.afterTurn = afterTurn
    this.shown = shown
    this.read = read
    this.check = check
    this.report = report
    this.groupId = groupId
    this.intervalMs = intervalMs
    this.state = {}
    this.pending = new Set()
    this.timer = null
    this.running = null
    this.controller = null
    this.stopped = false
  }

  async initialize() {
    try {
      this.state = JSON.parse(await readFile(this.statePath, 'utf8')).bots ?? {}
    } catch (error) {
      if (error.code !== 'ENOENT') this.report(`BellTeam self turns: 読んだ位置を読めませんでした（${error.message}）`)
      this.state = {}
    }
    return this
  }

  start() {
    if (this.timer) return
    this.stopped = false
    const tick = async () => {
      await this.poll().catch(() => this.report('BellTeam self turns: OBSERVER_POLL_FAILED'))
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs)
    }
    this.timer = setTimeout(tick, 0)
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
    this.controller?.abort()
    await this.running
  }

  poll() {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    this.controller = new AbortController()
    const running = this.pollBots(this.controller.signal).finally(() => {
      this.running = null
      this.controller = null
    })
    this.running = running
    return running
  }

  stateFor(bot) {
    const current = this.state[bot.id]
    if (current?.project === bot.project) return current
    return this.state[bot.id] = { project: bot.project, cursor: null, seen: [], lastCompletedAt: null, checkToken: null }
  }

  assertCurrent(bot, signal) {
    signal?.throwIfAborted()
    if (this.bots.get(bot.id)?.project !== bot.project) throw new Error('OBSERVER_PROJECT_CHANGED')
  }

  async pollBots(signal) {
    const bots = [...this.bots.values()].map(({ id, project }) => ({ id, project }))
    const pending = new Set(this.pending)
    for (const bot of bots.filter(bot => pending.has(bot.id))) {
      if (signal.aborted) return
      await this.consume(bot, undefined, signal)
    }
    if (signal.aborted) return
    const remaining = bots.filter(bot => !pending.has(bot.id))
    const requests = observerCheckRequests(remaining.map(bot => ({
      id: bot.id, projectPath: bot.project, after: this.stateFor(bot).checkToken ?? null,
    })))
    for (const request of requests) {
      if (signal.aborted) return
      let results
      try {
        const result = await this.check(request, { signal })
        signal.throwIfAborted()
        results = validateObserverCheckResult(result, request)
      } catch {
        for (const item of request.projects) this.pending.add(item.id)
        if (!signal.aborted) this.report('BellTeam self turns: THROUGHLINE_OBSERVER_CHECK_FAILED')
        continue
      }
      for (const [index, result] of results.entries()) {
        if (signal.aborted) return
        if (result.status === 'unchanged') continue
        const item = request.projects[index]
        await this.consume({ id: item.id, project: item.projectPath },
          result.status === 'changed' ? result.token : result.status === 'resync_required' ? null : undefined, signal)
      }
    }
  }

  async consume(bot, token, signal) {
    const current = this.stateFor(bot)
    const cursor = current.cursor, checkToken = current.checkToken
    this.pending.add(bot.id)
    try {
      this.assertCurrent(bot, signal)
      const complete = await this.follow(bot, signal)
      this.assertCurrent(bot, signal)
      if (complete && token !== undefined) current.checkToken = token
      await this.save(signal)
      if (complete) this.pending.delete(bot.id)
    } catch {
      current.cursor = cursor
      current.checkToken = checkToken
      if (!signal.aborted) this.report(`BellTeam self turns: ${bot.id} OBSERVER_CONSUME_FAILED`)
    }
  }

  async follow(bot, signal) {
    const current = this.stateFor(bot)
    // 初めて見るBotは今の位置から始め、過去のターンを画面へ流し込まない。
    if (!current?.cursor) return this.reset(bot, signal)
    let throughCursor = null
    let pageToken = null
    do {
      this.assertCurrent(bot, signal)
      const result = await this.read({ project: bot.project, afterCursor: current.cursor, throughCursor, pageToken }, { signal })
      this.assertCurrent(bot, signal)
      if (result.status === 'resync_required') {
        this.report(`BellTeam self turns: ${bot.id} の読んだ位置が古くなったので、今の位置から読み直します`)
        return this.resync(bot, current, signal)
      }
      if (result.status === 'projection_pending' || result.status === 'ambiguous_parent') {
        this.pending.add(bot.id)
        return false
      }
      if (result.status === 'error') throw new Error(result.code ?? 'THROUGHLINE_OBSERVER_READ_FAILED')
      requireReadPage(result)
      if (throughCursor && result.throughCursor !== throughCursor) throw new Error('THROUGHLINE_OBSERVER_READ_INVALID')
      for (const turn of result.turns) await this.accept(bot, current, turn, signal)
      throughCursor = result.throughCursor ?? throughCursor
      pageToken = result.page?.complete === false ? result.page.nextToken : null
    } while (pageToken)
    if (throughCursor) current.cursor = throughCursor
    return true
  }

  async accept(bot, current, turn, signal) {
    this.assertCurrent(bot, signal)
    const key = turn.source_sha256
    if (!key || current.seen.includes(key)) return
    const startedAt = current.lastCompletedAt
    const completedAt = Number.isFinite(turn.completed_at) ? turn.completed_at : Date.now()
    const whole = typeof turn.assistant === 'string' ? turn.assistant.trim() : ''
    if (startedOutsideDelivery(turn) && whole) {
      const shown = this.shown(bot.id)
      const text = withoutShownWords(whole, shown, completedAt)
      await this.appendAnswer(bot.id, this.groupId(), text)
      if (text !== whole) shown.words.length = 0
      current.seen = [...current.seen, key].slice(-SEEN_LIMIT)
      current.lastCompletedAt = Math.max(current.lastCompletedAt ?? 0, completedAt)
      this.afterTurn({ botId: bot.id, context: 'self',
        startedAt: new Date(startedAt ?? completedAt).toISOString(),
        endedAt: new Date(Math.max(completedAt, Date.now())).toISOString() })
    } else {
      current.seen = [...current.seen, key].slice(-SEEN_LIMIT)
      current.lastCompletedAt = Math.max(current.lastCompletedAt ?? 0, completedAt)
    }
  }

  // 位置が無効になっても、その間に終わったターンは落とさない。読み直した中で、最後に見たターンより新しい分だけを受け取る。
  // Throughline 0.14.3 は、Claudeの席の完了ターンの控えが256件を超えると、ターンが1つ増えるたびに前の位置を無効にする。
  // 読み直しのたびに捨てていたので、その席が自分から始めたターンの回答が画面へ出なかった（2026-10-05、トロニーの席で2回）。
  // 読み直しで返るのは、その席で最後にターンが終わった1つの会話の直近100件だけ。別の会話（子のAIなど）のターンが
  // 後から終わっていると、元の会話の未読は返らず、ここでは拾えない（Throughlineが位置の不具合を直すまで残る）。
  async resync(bot, current, signal) {
    // どこまで見たか分からない時は、初めて見るBotと同じく今の位置から始める（過去のターンを流し込まない）。
    if (!Number.isFinite(current.lastCompletedAt)) return this.reset(bot, signal)
    this.assertCurrent(bot, signal)
    const result = await this.read({ project: bot.project }, { signal })
    this.assertCurrent(bot, signal)
    if (result.status === 'error') throw new Error(result.code ?? 'THROUGHLINE_OBSERVER_READ_FAILED')
    if (result.status === 'projection_pending' || result.status === 'ambiguous_parent') {
      this.pending.add(bot.id)
      return false
    }
    requireReadPage(result)
    const since = current.lastCompletedAt
    for (const turn of result.turns ?? []) {
      if (Number.isFinite(turn.completed_at) && turn.completed_at > since) await this.accept(bot, current, turn, signal)
      else if (turn.source_sha256 && !current.seen.includes(turn.source_sha256))
        current.seen = [...current.seen, turn.source_sha256].slice(-SEEN_LIMIT)
    }
    current.cursor = result.throughCursor ?? null
    return true
  }

  async reset(bot, signal) {
    this.assertCurrent(bot, signal)
    const result = await this.read({ project: bot.project }, { signal })
    this.assertCurrent(bot, signal)
    if (result.status === 'error') throw new Error(result.code ?? 'THROUGHLINE_OBSERVER_READ_FAILED')
    if (result.status === 'projection_pending' || result.status === 'ambiguous_parent') return false
    if (result.status === 'resync_required') throw new Error('THROUGHLINE_OBSERVER_READ_INVALID')
    requireReadPage(result)
    const turns = result.turns
    Object.assign(this.stateFor(bot), {
      cursor: result.throughCursor ?? null,
      seen: turns.map(turn => turn.source_sha256).filter(Boolean).slice(-SEEN_LIMIT),
      lastCompletedAt: Math.max(0, ...turns.map(turn => turn.completed_at).filter(Number.isFinite)) || null,
    })
    return true
  }

  async save(signal) {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${process.pid}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ schema: 'bellteam.self-turns.v1', bots: this.state })}\n`, { mode: 0o600 })
      signal?.throwIfAborted()
      await rename(temporary, this.statePath)
    } finally { await rm(temporary, { force: true }) }
  }
}

function requireReadPage(result) {
  if (!['snapshot', 'delta', 'thread_switched', 'host_switched'].includes(result?.status)
    || !Array.isArray(result.turns) || typeof result.throughCursor !== 'string' || !result.throughCursor
    || result.page?.complete === false && (typeof result.page.nextToken !== 'string' || !result.page.nextToken))
    throw new Error('THROUGHLINE_OBSERVER_READ_INVALID')
}

export async function readObserverTurns({ project, afterCursor, throughCursor, pageToken }, { run, seatCommands = false, signal } = {}) {
  const args = ['observer-read', '--project', project, '--wire', 'v2', '--limit', '100', '--json']
  if (afterCursor) args.push('--after-cursor', afterCursor)
  if (throughCursor) args.push('--through-cursor', throughCursor)
  if (pageToken) args.push('--page-token', pageToken)
  signal?.throwIfAborted()
  const execute = run ?? (seatCommands ? createSeatProcessRunner(project) : runObserverCommand)
  const { stdout } = await execute('throughline', args, { signal, ...(seatCommands ? {} : { env: runtimeEnvironment() }), maxBuffer: 16 * 1024 * 1024 })
  signal?.throwIfAborted()
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.observer_read.v2') throw new Error(`THROUGHLINE_OBSERVER_READ_INVALID: ${result.schema}`)
  return result
}
