import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import endpoints from '../services/subscriptions/endpoints.json' with { type: 'json' }
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { developerAccessAllowed as profileDeveloperAccessAllowed } from './distribution-profile.mjs'

export class SubscriptionAccessError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

// 購入元（store）ごとの照会結果から、有効なものを優先して一つの状態にする。Google Playはここへ足す。
function combine(verifications) {
  const rank = item => Date.parse(item.validUntil ?? item.expiresAt)
  return Object.values(verifications).sort((a, b) => b.entitled - a.entitled || rank(b) - rank(a))[0] ?? null
}

// 保存先は利用者自身のサーバー。運営のCloudflareには購読情報を保存しない。
export class Subscriptions {
  constructor({ path, environment = 'Production', accessMode = 'subscription', developerAccessAllowed = profileDeveloperAccessAllowed, fetch: request = fetch, clock = Date.now, checkIntervalMs = 60 * 60 * 1000 }) {
    if (!Object.hasOwn(endpoints, environment)) throw new Error('SUBSCRIPTION_ENVIRONMENT_INVALID')
    if (!['subscription', 'developer'].includes(accessMode)) throw new Error('SUBSCRIPTION_ACCESS_MODE_INVALID')
    if (typeof developerAccessAllowed !== 'boolean') throw new Error('SUBSCRIPTION_DEVELOPER_ACCESS_INVALID')
    if (accessMode === 'developer' && !developerAccessAllowed) throw new Error('SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE')
    this.path = path
    this.environment = environment
    this.accessMode = accessMode
    this.request = request
    this.clock = clock
    this.checkIntervalMs = checkIntervalMs
    this.state = { schema: 'bellteam.subscription.v1', setupComplete: false, signedTransaction: null, stripeSubscriptionId: null, stripePendingSessionId: null, verifications: {}, verification: null, error: null }
    this.pending = Promise.resolve()
  }

  async initialize({ readOnly = false } = {}) {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'))
      if (state.schema !== this.state.schema || typeof state.setupComplete !== 'boolean'
        || !(state.signedTransaction === null || typeof state.signedTransaction === 'string')) throw new Error('SUBSCRIPTION_STATE_INVALID')
      if (state.verification && state.verification.environment !== this.environment) {
        state.verification = null
        state.signedTransaction = null
        state.stripeSubscriptionId = null
        state.stripePendingSessionId = null
        state.verifications = {}
        state.error = { code: 'SUBSCRIPTION_ENVIRONMENT_CHANGED', status: 409, message: '購読確認の実行環境を変更しました。アプリから購入情報を復元してください。' }
        this.state = state
        if (!readOnly) await this.save()
      }
      if (state.verification) this.validate(state.verification)
      if (state.error && (typeof state.error.code !== 'string' || typeof state.error.message !== 'string'
        || !Number.isInteger(state.error.status) || state.error.status < 400 || state.error.status > 599)) throw new Error('SUBSCRIPTION_STATE_INVALID')
      state.stripeSubscriptionId ??= null
      state.stripePendingSessionId ??= null
      // 旧い保存形式（Appleだけ）はAppleの結果として読む。
      state.verifications ??= state.verification && state.signedTransaction ? { apple: state.verification } : {}
      this.state = state
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  status() {
    const verification = this.state.verification
    const entitled = !this.state.error && verification?.entitled === true && Date.parse(verification.validUntil) > this.clock()
    const billingSources = this.billingSources()
    return {
      productId: product.productId,
      environment: this.environment,
      accessMode: this.accessMode,
      setupComplete: this.state.setupComplete,
      entitled,
      // Webと共有サーバーのAI利用は無料。Appleアプリの購入状態はentitledで返す。
      canUseAI: true,
      state: verification?.state ?? 'not_purchased',
      source: verification?.source ?? null,
      isTrial: verification?.isTrial ?? false,
      checkedAt: verification?.checkedAt ?? null,
      expiresAt: verification?.expiresAt ?? null,
      validUntil: verification?.validUntil ?? null,
      autoRenewing: verification?.autoRenewing ?? false,
      // 課金中の購入元（解約予約中の支払済み期間・支払い再試行を含む）。canPurchaseがfalseの間、各アプリは購入ボタンを出さない（二重請求の防止）。
      billingSources,
      canPurchase: this.accessMode === 'subscription' && billingSources.length === 0,
      error: this.state.error,
    }
  }

  // 守るもの：同じ人への二重請求。直近の照会結果で、まだ課金が続く購入元（Stripeの再試行中など支払い済みでなくても）を返す。
  billingSources() {
    return Object.entries(this.state.verifications)
      .filter(([, item]) => ['active', 'grace', 'billing_retry'].includes(item.state))
      .map(([source]) => source)
  }

  // 有効な判定の購入元の証拠を一つだけ返す（運営の中継が照会する用）。無い・開発者モードはnull。
  proof() {
    if (this.accessMode === 'developer' || !this.status().entitled) return null
    if (this.state.verification.source === 'stripe') return this.state.stripeSubscriptionId ? { stripeSubscriptionId: this.state.stripeSubscriptionId } : null
    return this.state.signedTransaction ? { signedTransaction: this.state.signedTransaction } : null
  }

  async current() {
    if (this.accessMode === 'developer') return this.status()
    try { return await this.refresh() }
    catch (error) {
      if (!(error instanceof SubscriptionAccessError)) throw error
      return this.status()
    }
  }

  assertSetupAllowed() {
    if (this.state.setupComplete) throw new SubscriptionAccessError('SETUP_ALREADY_COMPLETE', 409, '動作確認は完了しています。メンバーとの会話を始めてください。')
  }

  completeSetup(botId) {
    return this.change(async () => {
      this.state.setupComplete = true
      this.state.setup = { botId, completedAt: new Date(this.clock()).toISOString() }
      await this.save()
      return this.status()
    })
  }

  runSetupTest(botId, run) {
    return this.change(async () => {
      this.assertSetupAllowed()
      const reply = await run()
      if (typeof reply !== 'string' || !reply.trim()) throw new SubscriptionAccessError('SETUP_REPLY_MISSING', 502, 'AIからの返答を確認できませんでした。設定を確認してください。')
      this.state.setupComplete = true
      this.state.setup = { botId, completedAt: new Date(this.clock()).toISOString() }
      await this.save()
      return { subscription: this.status(), reply }
    })
  }

  install(signedTransaction) {
    if (this.accessMode === 'developer') throw new SubscriptionAccessError('SUBSCRIPTION_NOT_REQUIRED', 409, 'このサーバーは開発者用のため、購読の購入・復元は不要です。')
    if (typeof signedTransaction !== 'string' || !signedTransaction) throw new SubscriptionAccessError('INVALID_TRANSACTION', 400, 'Appleの署名付き購入情報が必要です。')
    return this.change(async () => {
      try {
        const verification = await this.verify({ signedTransaction })
        this.state.signedTransaction = signedTransaction
        this.state.verifications = { ...this.state.verifications, apple: verification }
        this.state.verification = combine(this.state.verifications)
        this.state.error = null
        await this.save()
        return this.status()
      } catch (error) { return this.fail(error) }
    })
  }

  installStripe(stripeSessionId) {
    if (this.accessMode === 'developer') throw new SubscriptionAccessError('SUBSCRIPTION_NOT_REQUIRED', 409, 'このサーバーは開発者用のため、購読の購入・復元は不要です。')
    if (typeof stripeSessionId !== 'string' || !stripeSessionId) throw new SubscriptionAccessError('INVALID_STRIPE_PROOF', 400, 'StripeのCheckout Session IDが必要です。')
    return this.change(async () => {
      try {
        await this.applyStripe(stripeSessionId)
        return this.status()
      } catch (error) { return this.fail(error) }
    })
  }

  async applyStripe(stripeSessionId) {
    const verification = await this.verify({ stripeSessionId })
    this.state.stripeSubscriptionId = verification.subscriptionId
    if (this.state.stripePendingSessionId === stripeSessionId) this.state.stripePendingSessionId = null
    this.state.verifications = { ...this.state.verifications, stripe: verification }
    this.state.verification = combine(this.state.verifications)
    this.state.error = null
    await this.save()
  }

  // Stripeの購入画面を作る。課金中の購読がある間は作らない。作ったSessionは開いたまま使い回し、二重に作らない。
  checkout() {
    if (this.accessMode === 'developer') throw new SubscriptionAccessError('SUBSCRIPTION_NOT_REQUIRED', 409, 'このサーバーは開発者用のため、購読の購入・復元は不要です。')
    const url = endpoints[this.environment].replace(/verify$/, 'stripe/checkout')
    return this.change(async () => {
      // 他の端末の購入や更新を取り込んでから判断する。照会できなければ作らず、そのエラーを返す（接続が戻れば再実行できる）。
      await this.refreshLocked({ force: true })
      const pending = this.state.stripePendingSessionId
      if (pending) {
        const session = await this.post(url, { sessionId: pending }, result => {
          if (!['open', 'complete', 'expired'].includes(result.status) || (result.status === 'open' && typeof result.url !== 'string')) throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスの応答の形式が一致しません。')
        })
        if (session.status === 'open') return { url: session.url, sessionId: pending }
        try {
          if (session.status === 'complete') await this.applyStripe(pending)
          else { this.state.stripePendingSessionId = null; await this.save() }
        } catch (error) { return this.fail(error) }
      }
      if (this.billingSources().length) throw new SubscriptionAccessError('SUBSCRIPTION_ALREADY_ACTIVE', 409, 'すでにBellTeamの購読があります。二重に購入しないよう、新しい購入は受け付けません。')
      const created = await this.post(url, {}, result => {
        if (typeof result.url !== 'string' || typeof result.sessionId !== 'string') throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスの応答の形式が一致しません。')
      })
      this.state.stripePendingSessionId = created.sessionId
      await this.save()
      return created
    })
  }

  // Stripeの顧客ポータル（解約・再開・支払い方法・請求書）のURLを返す。状態は変えない。
  manageStripe() {
    if (this.accessMode === 'developer') throw new SubscriptionAccessError('SUBSCRIPTION_NOT_REQUIRED', 409, 'このサーバーは開発者用のため、購読の購入・復元は不要です。')
    const stripeSubscriptionId = this.state.stripeSubscriptionId
    if (!stripeSubscriptionId) throw new SubscriptionAccessError('NO_STRIPE_SUBSCRIPTION', 409, 'Stripeで購入した購読がありません。App StoreやGoogle Playの購読は、それぞれのストアで管理してください。')
    return this.post(endpoints[this.environment].replace(/verify$/, 'stripe/portal'), { stripeSubscriptionId }, result => {
      if (typeof result.url !== 'string') throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスの応答の形式が一致しません。')
    })
  }

  refresh(options) {
    if (this.accessMode === 'developer') return Promise.resolve(this.status())
    return this.change(() => this.refreshLocked(options))
  }

  async refreshLocked({ force = false } = {}) {
    if (!(this.state.signedTransaction || this.state.stripeSubscriptionId) || (this.state.error && !force)) return this.status()
    const verification = this.state.verification
    const next = verification ? Math.min(
      Date.parse(verification.checkedAt) + this.checkIntervalMs,
      verification.entitled ? Date.parse(verification.validUntil) : Infinity,
    ) : 0
    if (!force && this.clock() < next) return this.status()
    try {
      // shortcut: 最初の失敗で全体を失敗にする。両方の購入元を持つ利用者は少ない。分けて扱う時はここで購入元ごとに握る。
      const verifications = { ...this.state.verifications }
      if (this.state.signedTransaction) verifications.apple = await this.verify({ signedTransaction: this.state.signedTransaction })
      if (this.state.stripeSubscriptionId) verifications.stripe = await this.verify({ stripeSubscriptionId: this.state.stripeSubscriptionId })
      this.state.verifications = verifications
      this.state.verification = combine(verifications)
      this.state.error = null
      await this.save()
      return this.status()
    } catch (error) { return this.fail(error) }
  }

  change(run) {
    const result = this.pending.then(run, run)
    this.pending = result
    return result
  }

  async fail(error) {
    if (!(error instanceof SubscriptionAccessError)) throw error
    this.state.error = { code: error.code, status: error.status, message: error.message }
    await this.save()
    throw error
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path + '.tmp', JSON.stringify(this.state) + '\n', { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }

  async verify(proof) {
    return this.post(endpoints[this.environment], proof, result => this.validate(result))
  }

  async post(url, body, check) {
    let response
    try {
      response = await this.request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      })
    } catch {
      throw new SubscriptionAccessError('SUBSCRIPTION_CONNECTION_FAILED', 503, '購読確認サービスへ接続できません。設定から再確認してください。')
    }
    let result
    try { result = await response.json() }
    catch { throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスの応答を読み取れませんでした。') }
    if (!response.ok) {
      if (typeof result?.error?.code !== 'string' || typeof result.error.message !== 'string') throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスのエラー形式が一致しません。')
      throw new SubscriptionAccessError(result.error.code, response.status, result.error.message)
    }
    check(result)
    return result
  }

  validate(result) {
    if (result.productId !== product.productId || result.environment !== this.environment
      || typeof result.entitled !== 'boolean' || typeof result.autoRenewing !== 'boolean'
      || !['active', 'grace', 'expired', 'billing_retry', 'revoked'].includes(result.state)
      || (result.entitled && !['active', 'grace'].includes(result.state))
      || !(result.source === undefined || ['apple', 'stripe'].includes(result.source))
      || !(result.isTrial === undefined || typeof result.isTrial === 'boolean')
      || (result.source === 'stripe' && typeof result.subscriptionId !== 'string')
      || !Number.isFinite(Date.parse(result.checkedAt)) || !Number.isFinite(Date.parse(result.expiresAt))
      || (result.entitled ? !Number.isFinite(Date.parse(result.validUntil)) : result.validUntil !== null)) {
      throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスのアプリ・環境・期限の形式が一致しません。')
    }
  }
}
