// しばらく動いていない席のセッションを閉じる（オーナー裁定 2026-10-03）。
// 一度起きた席は次の再起動まで残り、動いていなくてもCLIと席ごとのMCPのメモリを持ち続ける。
// 閉じた席は、次の配送がAitermの不達を受けて起動し直す（docs/current-design.md「Botとプロジェクト」）。
// 動いているかはAitermの観測（pty_observe）だけで決める。BellTeamが配送していないターンも席は自分で始めるため。

// 続けて動きが無いと確かめられた時間がこれを超えたら閉じる。
export const IDLE_CLOSE_MS = 30 * 60_000
// 観測の間隔。閉じるのは、動きが止まってから30〜35分後になる。
const INTERVAL_MS = 5 * 60_000

export class IdleSessions {
  constructor({ bots, transport, pendingDecisions = pendingDecisionsByHarness, idleMs = IDLE_CLOSE_MS, intervalMs = INTERVAL_MS, now = () => Date.now(), report = message => process.stderr.write(`${message}\n`) }) {
    this.bots = bots
    this.transport = transport
    // その席が出したApproval Boxの未決・保留の申請のうち、Aitermの観測では分からないものの数。分からない時はnull。
    this.pendingDecisions = pendingDecisions
    this.idleMs = idleMs
    this.intervalMs = intervalMs
    this.now = now
    this.report = report
    // 席ごとの、前回の観測の続き（cursor）と、動きが無くなった時刻。再起動で消えてよい（その時は席も閉じている）。
    this.seen = new Map()
    this.timer = null
    this.running = null
  }

  start() {
    const tick = async () => {
      this.running = this.check().catch(error => this.report(`BellTeam idle sessions: ${error.message}`))
      await this.running
      if (this.timer) this.timer = setTimeout(tick, this.intervalMs)
    }
    this.timer = setTimeout(tick, this.intervalMs)
  }

  async stop() {
    clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  async check() {
    for (const bot of [...this.bots.values()]) {
      try {
        await this.checkBot(bot)
      } catch (error) {
        this.seen.delete(bot.id)
        this.report(`BellTeam idle sessions: ${bot.id} を観測できませんでした（${error.message}）`)
      }
    }
  }

  async checkBot(bot) {
    const previous = this.seen.get(bot.id)
    const observation = await this.transport.observe(bot, previous?.cursor)
    if (observation?.exists !== true) {
      this.seen.delete(bot.id)
      return
    }
    const now = this.now()
    const quiet = quietSession(observation) && this.transport.isIdle(bot.id)
    // 画面が前回の観測から変わっていれば、その間に動いていた。数え直す。
    const since = !quiet ? null
      : previous?.since != null && observation.activity.output_changed === false ? previous.since : now
    this.seen.set(bot.id, { cursor: observation.activity?.cursor, since })
    if (since === null || now - since < this.idleMs) return
    // 答えを待っている席を閉じると、答えが出ても席が起きない（Approval Boxは閉じた席を起こさない）。
    if (await this.pendingDecisions(bot) !== 0) return
    if (!await this.transport.closeIdle(bot)) return
    this.seen.delete(bot.id)
    this.report(`BellTeam idle sessions: ${bot.id} を閉じました（${Math.round((now - since) / 60_000)}分動きなし）`)
  }
}

// 閉じてよいのは、入力待ちで、起動の後に立ったプロセス（裏の作業・答えや子の結果を待つhook）も、
// 親として待っている子エージェントの配送も無い席だけ。
// どちらかの数を返さないAiterm（0.48.0以前、またはそれが起動した席）では判断できないので、閉じない。
export function quietSession(observation) {
  return observation.state === 'idle' && observation.reason === 'composer_ready'
    && observation.activity?.post_startup_process_count === 0
    && observation.pending_child_deliveries === 0
}

// Approval Boxの答えを待っている席かどうか。Claude Codeは待つ間hookのプロセスがCLIの下に立つので、
// 上の数で分かる。ほかのハーネスは待ち受けが立たないことがあり、席ごとに確かめる口も無いので「分からない」。
export function pendingDecisionsByHarness(bot) {
  return bot.harness === 'claude' ? 0 : null
}
