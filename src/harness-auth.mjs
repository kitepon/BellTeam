// 初期設定の後に、AIの公式認証をやり直す入口（オーナー裁定 2026-10-05、Approval Box K-UTA3UC）。
// AIの認証が切れると、その種類のメンバーは全員止まり、入り直しを頼める席も無くなる。
// 設置した人が設定の画面から自分で戻せるように、初期設定と同じ公式認証の進行をここでも渡す。
// 認証の画面の出し方と資格情報は、Aitermと公式CLIが持つ。BellTeamは進行を中継するだけで、資格情報に触れない。
import { runtimeEnvironment } from './runtime-home.mjs'
import { HARNESS, HARNESSES } from './onboarding.mjs'

export class HarnessAuthError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status }
}

export class HarnessAuth {
  constructor({ bots, client }) {
    this.bots = bots
    this.client = client
    // 進行中の公式認証（Aitermの端末）。AIの種類ごとに1つ。
    this.sessions = new Map()
    this.pending = Promise.resolve()
  }

  list() {
    const members = id => [...this.bots.values()].filter(bot => bot.harness === id).length
    return { harnesses: HARNESSES.map(({ id, name }) => ({ id, name, members: members(id) })) }
  }

  status(harness) {
    return this.change(async () => {
      this.require(harness)
      return this.observe(harness)
    })
  }

  start(harness) {
    return this.change(async () => {
      this.require(harness)
      if (this.sessions.has(harness)) await this.end(harness)
      // 公式の状態が認証済みでも、公式のログイン画面を起こす（Aitermの relogin）。
      // 認証が切れたのに認証済みと見える時と、別のアカウントで入り直す時のため。
      const receipt = await this.call(harness, 'start', { relogin: true })
      // relogin を知らないAitermは引数を捨て、認証済みなら何も始めずに返す。始まっていない事を、認証済みと取り違えない。
      if (receipt.status === 'authenticated' && !receipt.session_id)
        throw new HarnessAuthError('HARNESS_AUTH_RELOGIN_UNSUPPORTED', 409, 'このサーバーのAitermは、認証済みのAIの認証のやり直しに対応していません。BellTeamを更新してください。')
      if (receipt.session_id) this.sessions.set(harness, receipt.session_id)
      return this.snapshot(harness, receipt)
    })
  }

  input(harness, { text, key } = {}) {
    return this.change(async () => {
      this.require(harness)
      const session = this.sessions.get(harness)
      if (!session) throw new HarnessAuthError('HARNESS_AUTH_NOT_RUNNING', 409, '認証のやり直しを開始してください。')
      if ((typeof text === 'string') === (typeof key === 'string')) throw new HarnessAuthError('HARNESS_AUTH_INPUT_INVALID', 400, '認証の入力またはキーを指定してください。')
      if (text !== undefined) await this.client.call('pty_send', { session_id: session, text, enter: true, raw: true })
      else await this.client.call('pty_key', { session_id: session, key })
      return this.observe(harness)
    })
  }

  cancel(harness) {
    return this.change(async () => {
      this.require(harness)
      if (this.sessions.has(harness)) await this.end(harness)
      return { harness, auth: null }
    })
  }

  require(harness) {
    if (!Object.hasOwn(HARNESS, harness)) throw new HarnessAuthError('HARNESS_AUTH_HARNESS_INVALID', 400, 'AIの種類を選んでください。')
  }

  // 公式の状態を見る。進行中の認証が通っていたら、その端末を閉じる。
  async observe(harness) {
    const receipt = await this.call(harness, 'status')
    if (receipt.status === 'authenticated' && this.sessions.has(harness)) await this.end(harness)
    return this.snapshot(harness, receipt)
  }

  async end(harness) {
    await this.call(harness, 'cancel')
    this.sessions.delete(harness)
  }

  async call(harness, action, options = {}) {
    const session = this.sessions.get(harness)
    const cwd = [...this.bots.values()].find(bot => bot.harness === harness)?.project
    const result = await this.client.call('agent_auth', {
      harness: HARNESS[harness], action, ...options,
      ...(session ? { session_id: session } : {}),
      ...(cwd ? { cwd } : {}),
    }, { env: runtimeEnvironment() })
    const receipt = result.structuredContent
    if (receipt?.schema !== 'aiterm.agent-auth-result.v1' || !['waiting', 'authenticated', 'blocked', 'failed'].includes(receipt.status))
      throw new HarnessAuthError('HARNESS_AUTH_RESPONSE_INVALID', 502, 'Aitermの公式認証の応答を読み取れません。')
    return receipt
  }

  // 初期設定の auth と同じ形。無い値はnull、input_required は必ず真偽で返す（アプリは初期設定と同じ型で読む）。
  snapshot(harness, receipt) {
    return { harness, auth: {
      status: receipt.status, url: receipt.url ?? null, user_code: receipt.user_code ?? null,
      input_required: receipt.input_required === true, message: receipt.message ?? null,
    } }
  }

  change(run) { const result = this.pending.then(run, run); this.pending = result; return result }
}
