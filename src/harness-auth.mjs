// 初期設定の後に、AIの公式認証をやり直す入口（オーナー裁定 2026-10-05、Approval Box K-UTA3UC）。
// AIの認証が切れると、その種類のメンバーは全員止まり、入り直しを頼める席も無くなる。
// 設置した人が設定の画面から自分で戻せるように、初期設定と同じ公式認証の進行をここでも渡す。
// 認証の画面の出し方と資格情報は、Aitermと公式CLIが持つ。BellTeamは進行を中継するだけで、資格情報に触れない。
import { isAbsolute } from 'node:path'
import { runtimeEnvironment } from './runtime-home.mjs'
import { HARNESS, HARNESSES } from './onboarding.mjs'
import { authUi, authResponse, authReceipt } from './auth-ui.mjs'

// 認証し直しを始める前に、利用者へ知らせる事。公式CLIの動きで、Aiterm 0.53.1 で確かめた範囲（エレグ、2026-10-06）。
// Codexの公式ログインは、始めた時点で今の資格情報を消す。ClaudeとCursorは、途中でやめれば残る。Grokは確かめられていない。
const START_WARNING = {
  codex: 'Codexは、認証し直しを始めた時点で今の認証が消えます。途中でやめても元に戻りません。認証が済むまで、Codexを使うメンバーは起動できません。',
  grok: 'Grokは、認証し直しを途中でやめた時に今の認証が残るかを確かめられていません。認証が済むまで、Grokを使うメンバーが起動できなくなる事があります。',
}

// 公式の状態を見ただけの時に、利用者へ出す文。Aitermの文は道具を呼ぶ側（AI）へ向けた物なので、設定の画面にはこちらを出す。
const STATUS_MESSAGE = {
  blocked: 'このAIは認証されていないか、認証の期限が切れています。「認証する」から公式サイトで認証してください。',
  failed: '認証の状態を確かめられませんでした（通信できないか、認証の期限が切れています）。「認証し直す」で入り直せます。',
}
// Claudeの公式CLIは、期限が切れた後も認証済みと答える（Aiterm 0.53.1 でも見分けられない）。
const CLAUDE_AUTHENTICATED_MESSAGE = 'Claudeは、認証の期限切れを見分けられない事があります。Claudeのメンバーが認証の誤りで止まる時は、認証し直してください。'

export class HarnessAuthError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status }
}

export function harnessAuthSlot(harness, slot = '1st') {
  if (!['1st', '2nd'].includes(slot) || harness !== 'claude' && slot !== '1st')
    throw new HarnessAuthError('HARNESS_AUTH_SLOT_INVALID', 400, '認証するアカウントを選んでください。')
  return slot
}
export const harnessAuthKey = (harness, slot) => slot === '2nd' ? `${harness}:2nd` : harness
export const harnessAuthStateKeyValid = key => Object.hasOwn(HARNESS, key) || key === 'claude:2nd'

export class HarnessAuth {
  constructor({ bots, client, accounts }) {
    this.bots = bots
    this.client = client
    this.accounts = accounts
    // 1st keeps the legacy key; only the second Claude slot adds a separate session.
    this.sessions = new Map()
    this.receipts = new Map()
    this.pending = Promise.resolve()
  }

  list() {
    const members = id => [...this.bots.values()].filter(bot => bot.harness === id).length
    return { harnesses: HARNESSES.map(({ id, name }) => ({ id, name, members: members(id), startWarning: START_WARNING[id] ?? null, reloginSupported: id !== 'antigravity' })) }
  }

  status(harness, options = {}, selected = options) {
    return this.change(async () => {
      this.require(harness)
      const slot = harnessAuthSlot(harness, selected?.slot)
      return this.observe(harness, slot)
    })
  }

  start(harness, options = {}, selected = options) {
    return this.change(async () => {
      this.require(harness)
      const slot = harnessAuthSlot(harness, selected?.slot), key = harnessAuthKey(harness, slot)
      const previous = this.receipts.get(key)
      if (this.sessions.has(key)) await this.end(harness, slot)
      // Antigravityは初回認証だけ。他のAIは、認証済みに見える時も公式ログインを始める。
      const receipt = await this.call(harness, 'start', { relogin: harness !== 'antigravity' }, slot, previous)
      // relogin を知らないAitermは引数を捨て、認証済みなら何も始めずに返す。始まっていない事を、認証済みと取り違えない。
      if (harness !== 'antigravity' && receipt.status === 'authenticated' && !receipt.session_id)
        throw new HarnessAuthError('HARNESS_AUTH_RELOGIN_UNSUPPORTED', 409, 'このサーバーのAitermは、認証済みのAIの認証のやり直しに対応していません。BellTeamを更新してください。')
      if (receipt.session_id) this.sessions.set(key, receipt.session_id)
      return this.snapshot(harness, receipt, slot)
    })
  }

  input(harness, input, options = {}, selected = options) {
    return this.change(async () => {
      this.require(harness)
      const slot = harnessAuthSlot(harness, selected?.slot), key = harnessAuthKey(harness, slot)
      const session = this.sessions.get(key)
      if (!session) throw new HarnessAuthError('HARNESS_AUTH_NOT_RUNNING', 409, '認証のやり直しを開始してください。')
      const responseOptions = authResponse(input, session, authUi(this.receipts.get(key) ?? {}, session))
      let receipt
      try { receipt = await this.call(harness, 'respond', responseOptions, slot) }
      catch (cause) {
        const error = new HarnessAuthError('HARNESS_AUTH_RESPONSE_UNCONFIRMED', 502, '認証結果を確認できませんでした。状態を更新してください。')
        error.cause = cause
        error.effect = cause.effect ?? 'unknown'
        if (cause.code === 'AUTH_RESPONSE_NOT_ISSUED') { error.code = cause.code; error.status = 409; error.message = cause.message }
        throw error
      }
      if (receipt.status === 'authenticated') await this.end(harness, slot)
      return this.snapshot(harness, receipt, slot)
    })
  }

  cancel(harness, options = {}, selected = options) {
    return this.change(async () => {
      this.require(harness)
      const slot = harnessAuthSlot(harness, selected?.slot), key = harnessAuthKey(harness, slot)
      if (this.sessions.has(key)) await this.end(harness, slot)
      return { harness, ...(harness === 'claude' ? { slot, account_label: null } : {}), auth: null }
    })
  }

  require(harness) {
    if (!Object.hasOwn(HARNESS, harness)) throw new HarnessAuthError('HARNESS_AUTH_HARNESS_INVALID', 400, 'AIの種類を選んでください。')
  }

  // 公式の状態を見る。進行中の認証が通っていたら、その端末を閉じる。
  async observe(harness, slot) {
    const key = harnessAuthKey(harness, slot)
    const receipt = await this.call(harness, 'status', {}, slot)
    if (receipt.status === 'authenticated' && this.sessions.has(key)) await this.end(harness, slot)
    return this.snapshot(harness, receipt, slot)
  }

  async end(harness, slot) {
    const key = harnessAuthKey(harness, slot)
    await this.call(harness, 'cancel', {}, slot)
    this.sessions.delete(key)
    this.receipts.delete(key)
  }

  async call(harness, action, options = {}, slot = '1st', previous = this.receipts.get(harnessAuthKey(harness, slot))) {
    const key = harnessAuthKey(harness, slot)
    let configurationRoot
    if (harness === 'claude') {
      try {
        if (!this.accounts?.prepare) throw new HarnessAuthError('HARNESS_AUTH_ACCOUNTS_UNAVAILABLE', 503, 'アカウントの保存場所を用意できませんでした。少し待ってから、もう一度お試しください。')
        const prepared = await this.accounts.prepare(harness, slot)
        if (typeof prepared?.configurationRoot !== 'string' || !isAbsolute(prepared.configurationRoot) || prepared.configurationRoot.includes('\0'))
          throw new HarnessAuthError('HARNESS_AUTH_ACCOUNTS_INVALID', 502, '認証先のアカウントを確認できませんでした。')
        configurationRoot = prepared.configurationRoot
      } catch (error) {
        if (slot === '1st' && ['HARNESS_AUTH_ACCOUNTS_UNAVAILABLE', 'EXECUTION_REQUEST_INVALID'].includes(error?.code)) configurationRoot = undefined
        else throw new HarnessAuthError('HARNESS_AUTH_ACCOUNTS_UNAVAILABLE', 503, 'アカウントの保存場所を用意できませんでした。少し待ってから、もう一度お試しください。')
      }
    }
    let account
    if (harness === 'claude' && action !== 'cancel') {
      // Login metadata enriches the display; its absence must not stop official auth.
      try {
        const accounts = await this.accounts?.list?.()
        account = accounts?.harnesses?.find(value => value.harness === harness)?.slots?.find(value => value.slot === slot)
      } catch {}
    }
    const session = this.sessions.get(key)
    const cwd = [...this.bots.values()].find(bot => bot.harness === harness)?.project
    const result = await this.client.call('agent_auth', {
      harness: HARNESS[harness], action, ...options,
      ...(configurationRoot ? { configuration_root: configurationRoot } : {}),
      ...(session ? { session_id: session } : {}),
      ...(cwd ? { cwd } : {}),
    }, this.client.authOptions?.() ?? { env: runtimeEnvironment() })
    const receipt = authReceipt(result, session, () => new HarnessAuthError('HARNESS_AUTH_RESPONSE_INVALID', 502, 'Aitermの公式認証の応答を読み取れません。'))
    if (harness === 'claude' && receipt.account_label !== undefined && receipt.account_label !== null && typeof receipt.account_label !== 'string')
      throw new HarnessAuthError('HARNESS_AUTH_RESPONSE_INVALID', 502, 'Aitermの公式認証の応答を読み取れません。')
    const active = action !== 'cancel' && receipt.status !== 'authenticated' && Boolean(session || receipt.session_id)
    const loggedIn = account?.loggedIn === true || active && (previous?.status === 'authenticated'
      || account?.loggedIn !== false && previous?.loggedIn === true)
    const relogin = active && loggedIn
    const value = harness === 'claude' ? { ...receipt, slot,
      status: relogin && receipt.status === 'blocked' ? 'waiting' : receipt.status,
      account_label: relogin ? account?.label ?? previous?.account_label ?? receipt.account_label ?? null : receipt.account_label ?? null,
      loggedIn: receipt.status === 'authenticated' || loggedIn } : receipt
    this.receipts.set(key, value)
    return value
  }

  // 初期設定の auth と同じ形。無い値はnull、input_required は必ず真偽で返す（アプリは初期設定と同じ型で読む）。
  // message は、公式認証が進行中ならAitermの案内をそのまま、状態を見ただけなら利用者向けの文にする。
  snapshot(harness, receipt, slot = '1st') {
    const key = harnessAuthKey(harness, slot)
    const message = this.sessions.has(key) ? receipt.message ?? null
      : receipt.status === 'authenticated' ? (harness === 'claude' ? CLAUDE_AUTHENTICATED_MESSAGE : null)
        : STATUS_MESSAGE[receipt.status] ?? receipt.message ?? null
    return { harness, ...(harness === 'claude' ? { slot, account_label: receipt.account_label ?? null } : {}), auth: {
      status: receipt.status, url: receipt.url ?? null, user_code: receipt.user_code ?? null,
      input_required: receipt.input_required === true, message,
      session_id: this.sessions.get(key) ?? null,
      auth_ui: authUi({ ...receipt, message }, this.sessions.get(key) ?? receipt.session_id),
    } }
  }

  change(run) { const result = this.pending.then(run, run); this.pending = result; return result }
}
