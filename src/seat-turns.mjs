// BellTeamが始めていないターンを見つけて、会話画面のランプ・「処理中」・合間の言葉に出す。
// Aitermは、子の結果を親の席へ渡す時、BellTeamを通らずに次のターンを始める。BellTeamは配送したターンしか見ていないので、
// そのターンの間は何も出なかった（2026-10-13、リリーバイスの席。子の結果で始まったターンへオーナーの文が3通入った）。
// 席の今のターンは、Aitermがハーネスの記録から読んで返す（Aiterm 0.60.0、ADR 0122。まずCodexの席だけ）。
// 回答は運ばない。そのターンの最後の回答は、self-turns.mjsがThroughlineから出す。

// 席の今のターンを聞く間隔。Aitermは画面を読まず、席ごとに記録の増えた分だけを読む。
const INTERVAL_MS = 5000

export class SeatTurns {
  constructor({ bots, transport, appendInterimWords, report = message => process.stderr.write(`${message}\n`), intervalMs = INTERVAL_MS }) {
    this.bots = bots
    this.transport = transport
    this.appendInterimWords = appendInterimWords
    this.report = report
    this.intervalMs = intervalMs
    this.supported = true
    this.timer = null
    this.running = null
  }

  start() {
    const tick = async () => {
      this.running = this.poll().catch(error => this.report(`BellTeam seat turns: ${error.message}`))
      await this.running
      if (this.timer && this.supported) this.timer = setTimeout(tick, this.intervalMs)
    }
    this.timer = setTimeout(tick, 0)
  }

  async stop() {
    clearTimeout(this.timer)
    this.timer = null
    await this.running
  }

  async poll() {
    this.supported = await this.transport.watchSeatTurns([...this.bots.values()], { onInterim: this.appendInterimWords })
    // 席の今のターンを返さない版のAitermには、聞き続けない。Aitermの版が替わるのは、BellTeamごと起こし直す時だけ。
    if (!this.supported) this.report('BellTeam seat turns: このAitermは席の今のターンを返さないので、聞くのをやめます')
  }
}
