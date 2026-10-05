// Botのハーネスが自分から始めたターンの最後の回答を、Throughlineの記録から拾ってオーナーの会話画面へ出す（オーナー裁定 2026-10-01）。
// Claude Code・Grok・Cursorは、裏で動かした作業が終わると、BellTeamを通らずに次のターンを始める。
// BellTeamは配送したターンしか見ていないので、そのターンの報告がオーナーへ届かなかった（2026-10-01 ラプンツェル）。
// Throughlineはどう始まったターンもStop hookで記録し、turn_startで始まり方を返す（0.10.22、--wire v2）。
// BellTeamが配送したターン（prompt）は配送の側で画面に出しているので、ここでは自分から始まったターン（self）だけを出す。
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { runtimeEnvironment, runtimeHome } from './runtime-home.mjs'

const execFileAsync = promisify(execFile)
// 記録の変化を見に行く間隔。変化が無ければThroughlineを呼ばない。
const INTERVAL_MS = 5000
// thread_switched（/clearなど）で読み終えた分がまた届くので、Botごとに最近の鍵を覚えて重複を落とす。
const SEEN_LIMIT = 500

export class SelfTurns {
  constructor({ bots, statePath, appendAnswer, afterTurn = () => {}, read = readObserverTurns, changed = throughlineChanged(), report = message => process.stderr.write(`${message}\n`), groupId = randomUUID, intervalMs = INTERVAL_MS }) {
    this.bots = bots
    this.statePath = statePath
    this.appendAnswer = appendAnswer
    this.afterTurn = afterTurn
    this.read = read
    this.changed = changed
    this.report = report
    this.groupId = groupId
    this.intervalMs = intervalMs
    this.state = {}
    this.pending = new Set()
    this.timer = null
    this.running = null
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
    const tick = async () => {
      this.running = this.poll().catch(error => this.report(`BellTeam self turns: ${error.message}`))
      await this.running
      if (this.timer) this.timer = setTimeout(tick, this.intervalMs)
    }
    this.timer = setTimeout(tick, 0)
  }

  async stop() {
    clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  // 記録が変わった時と、書きかけ（projection_pending）で読み残したBotがある時だけ読む。
  async poll() {
    if (!await this.changed() && !this.pending.size) return
    for (const bot of [...this.bots.values()]) {
      try {
        await this.follow(bot)
      } catch (error) {
        this.report(`BellTeam self turns: ${bot.id} を読めませんでした（${error.message}）`)
      }
    }
    await this.save()
  }

  async follow(bot) {
    const current = this.state[bot.id]
    // 初めて見るBotは今の位置から始め、過去のターンを画面へ流し込まない。
    if (!current?.cursor) return this.reset(bot)
    let throughCursor = null
    let pageToken = null
    do {
      const result = await this.read({ project: bot.project, afterCursor: current.cursor, throughCursor, pageToken })
      if (result.status === 'resync_required') {
        this.report(`BellTeam self turns: ${bot.id} の読んだ位置が古くなったので、今の位置から読み直します`)
        return this.resync(bot, current)
      }
      if (result.status === 'projection_pending') {
        this.pending.add(bot.id)
        return
      }
      if (result.status === 'error') throw new Error(result.code ?? 'THROUGHLINE_OBSERVER_READ_FAILED')
      for (const turn of result.turns ?? []) await this.accept(bot, current, turn)
      throughCursor = result.throughCursor ?? throughCursor
      pageToken = result.page?.complete === false ? result.page.nextToken : null
    } while (pageToken)
    if (throughCursor) current.cursor = throughCursor
    this.pending.delete(bot.id)
  }

  async accept(bot, current, turn) {
    const key = turn.source_sha256
    if (!key || current.seen.includes(key)) return
    current.seen = [...current.seen, key].slice(-SEEN_LIMIT)
    const startedAt = current.lastCompletedAt
    const completedAt = Number.isFinite(turn.completed_at) ? turn.completed_at : Date.now()
    current.lastCompletedAt = Math.max(current.lastCompletedAt ?? 0, completedAt)
    const text = typeof turn.assistant === 'string' ? turn.assistant.trim() : ''
    if (turn.turn_start !== 'self' || !text) return
    await this.appendAnswer(bot.id, this.groupId(), text)
    // 自分から始まったターンも、配送したターンと同じく報告漏れを確かめる。幅は前のターンの終わりから、いま画面へ出した回答まで。
    this.afterTurn({
      botId: bot.id, context: 'self',
      startedAt: new Date(startedAt ?? completedAt).toISOString(),
      endedAt: new Date(Math.max(completedAt, Date.now())).toISOString(),
    })
  }

  // 位置が無効になっても、その間に終わったターンは落とさない。読み直した中で、最後に見たターンより新しい分だけを受け取る。
  // Throughline 0.14.3 は、Claudeの席の完了ターンの控えが256件を超えると、ターンが1つ増えるたびに前の位置を無効にする。
  // 読み直しのたびに捨てていたので、その席が自分から始めたターンの回答が画面へ出なかった（2026-10-05、トロニーの席で2回）。
  async resync(bot, current) {
    // どこまで見たか分からない時は、初めて見るBotと同じく今の位置から始める（過去のターンを流し込まない）。
    if (!Number.isFinite(current.lastCompletedAt)) return this.reset(bot)
    const result = await this.read({ project: bot.project })
    if (result.status === 'error') throw new Error(result.code ?? 'THROUGHLINE_OBSERVER_READ_FAILED')
    if (result.status === 'projection_pending') {
      this.pending.add(bot.id)
      return
    }
    const since = current.lastCompletedAt
    for (const turn of result.turns ?? []) {
      if (Number.isFinite(turn.completed_at) && turn.completed_at > since) await this.accept(bot, current, turn)
      else if (turn.source_sha256 && !current.seen.includes(turn.source_sha256))
        current.seen = [...current.seen, turn.source_sha256].slice(-SEEN_LIMIT)
    }
    current.cursor = result.throughCursor ?? null
    this.pending.delete(bot.id)
  }

  async reset(bot) {
    const result = await this.read({ project: bot.project })
    if (result.status === 'error') throw new Error(result.code ?? 'THROUGHLINE_OBSERVER_READ_FAILED')
    const turns = result.turns ?? []
    this.state[bot.id] = {
      cursor: result.throughCursor ?? null,
      seen: turns.map(turn => turn.source_sha256).filter(Boolean).slice(-SEEN_LIMIT),
      lastCompletedAt: Math.max(0, ...turns.map(turn => turn.completed_at).filter(Number.isFinite)) || null,
    }
    this.pending.delete(bot.id)
  }

  async save() {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ schema: 'bellteam.self-turns.v1', bots: this.state })}\n`, { mode: 0o600 })
    await rename(temporary, this.statePath)
  }
}

export async function readObserverTurns({ project, afterCursor, throughCursor, pageToken }, { run = execFileAsync } = {}) {
  const args = ['observer-read', '--project', project, '--wire', 'v2', '--limit', '100', '--json']
  if (afterCursor) args.push('--after-cursor', afterCursor)
  if (throughCursor) args.push('--through-cursor', throughCursor)
  if (pageToken) args.push('--page-token', pageToken)
  const { stdout } = await run('throughline', args, { env: runtimeEnvironment(), maxBuffer: 16 * 1024 * 1024 })
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.observer_read.v2') throw new Error(`THROUGHLINE_OBSERVER_READ_INVALID: ${result.schema}`)
  return result
}

// ThroughlineのDB（WALを含む）の更新時刻が変わったかを見る。最初の1回は変わったとみなす。
export function throughlineChanged(root = join(runtimeHome(), '.throughline')) {
  let last = null
  return async () => {
    const times = await Promise.all(['throughline.db', 'throughline.db-wal'].map(name =>
      stat(join(root, name)).then(info => info.mtimeMs, () => 0)))
    const next = times.join(':')
    const changed = next !== last
    last = next
    return changed
  }
}
