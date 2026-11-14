// しばらく動いていない席のセッションを閉じる（オーナー裁定 2026-10-03）。
// 一度起きた席は次の再起動まで残り、動いていなくてもCLIと席ごとのMCPのメモリを持ち続ける。
// 閉じた席は、次の配送がAitermの不達を受けて起動し直す（docs/current-design.md「Botとプロジェクト」）。
// 動いているかはAitermの観測（pty_observe）だけで決める。BellTeamが配送していないターンも席は自分で始めるため。

// 続けて動きが無いと確かめられた時間がこれを超えたら閉じる。
export const IDLE_CLOSE_MS = 30 * 60_000
// 観測の間隔。閉じるのは、動きが止まってから30〜35分後になる。
const INTERVAL_MS = 5 * 60_000

export class IdleSessions {
  constructor({ bots, transport, pendingDecisions = approvalBoxWakeDecisions(), allowClose = () => true, idleMs = IDLE_CLOSE_MS, intervalMs = INTERVAL_MS, now = () => Date.now(), report = message => process.stderr.write(`${message}\n`) }) {
    this.bots = bots
    this.transport = transport
    // その席が出したApproval Boxの未決・保留の申請のうち、Aitermの観測では分からないものの数。分からない時はnull。
    this.allowClose = allowClose
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
    // bd03: the Approval Box capability is read once per check and shared by every Bot in it; the next check reads it again.
    this.pendingDecisions.begin?.()
    for (const bot of [...this.bots.values()]) {
      if (!this.allowClose()) break
      try {
        await this.checkBot(bot)
      } catch (error) {
        this.seen.delete(bot.id)
        this.report(`BellTeam idle sessions: ${bot.id} を観測できませんでした（${error.message}）`)
      }
    }
    // harness-accounts.md "Old seat exit" (a48): seats an account move left, only where no Approval Box answer can be waiting unseen.
    if (!this.allowClose() || !this.transport.closeOldSeats) return
    const bots = []
    for (const bot of this.bots.values()) if (await this.pendingDecisions(bot) === 0) bots.push(bot)
    try {
      for (const session of await this.transport.closeOldSeats(bots)) this.report(`BellTeam idle sessions: 古い席 ${session} を閉じました`)
    } catch (error) { this.report(`BellTeam idle sessions: 古い席を調べられませんでした（${error.message}）`) }
  }

  async checkBot(bot) {
    const previous = this.seen.get(bot.id)
    const { observation, generation } = await this.transport.observeChain(bot, previous)
    if (observation?.exists !== true) {
      this.seen.delete(bot.id)
      return
    }
    const now = this.now()
    const quiet = quietSession(observation) && this.transport.isIdle(bot.id)
    // 画面が前回の観測から変わっていれば、その間に動いていた。数え直す。
    const since = !quiet ? null
      : previous?.since != null && observation.activity.output_changed === false ? previous.since : now
    this.seen.set(bot.id, { cursor: observation.activity?.cursor, generation, since })
    if (since === null || now - since < this.idleMs) return
    // 答えを待っている席を閉じると、答えが出ても席が起きない（Approval Boxは閉じた席を起こさない）。
    if (await this.pendingDecisions(bot) !== 0) return
    if (!this.allowClose() || !await this.transport.closeIdle(bot)) return
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
    // a69: the harness's own unfinished background tasks (in-process agents) keep the seat; absent/null = not stated.
    && !(observation.activity?.background_tasks > 0)
}

// Approval Boxの答えを待つ申請がある席を閉じてよいか（bd03、ナユタの製品契約）。Approval Box 0.1.34以降は、受け手を失った
// BellTeam発の申請について申請者を公開sendmessageで一度起こしresume_decisionを促す。だから席ごとの件数もプロセス木も見ず、
// 入っている同梱物がその約束を持つかだけで決める：持てば0（閉じても失わない）、無い・読めない時はnull（閉じない）。
// 読むのは1回のcheck（tick）につき1回（同じcheckの全Botで同じ答え）。check()がbegin()で前の答えを捨てる。
export function approvalBoxWakeDecisions({ run = readApprovalBoxVersion } = {}) {
  let answer = null
  const decisions = async () => (await (answer ??= run().then(approvalBoxWakes, () => false))) ? 0 : null
  decisions.begin = () => { answer = null }
  return decisions
}

export function approvalBoxWakes(stdout) {
  try {
    const value = JSON.parse(stdout)
    return value?.schema === 'approval-box.version.v1' && Array.isArray(value.capabilities) && value.capabilities.includes('bellteam-requester-wake')
  } catch { return false }
}

async function readApprovalBoxVersion() {
  const { execFile } = await import('node:child_process')
  const { join } = await import('node:path')
  const { runtimeHome } = await import('./runtime-home.mjs')
  return new Promise((resolve, reject) => execFile(join(runtimeHome(), '.approval-box/bin/approval-box'), ['version', '--json'],
    { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}
