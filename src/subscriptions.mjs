import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import endpoints from '../services/subscriptions/endpoints.json' with { type: 'json' }
import product from '../services/subscriptions/product.json' with { type: 'json' }
import { developerAccessAllowed } from './distribution-profile.mjs'

export class SubscriptionAccessError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

// 保存先は利用者自身のサーバー。運営のCloudflareには購読情報を保存しない。
export class Subscriptions {
  constructor({ path, environment = 'Production', accessMode = 'subscription', fetch: request = fetch, clock = Date.now, checkIntervalMs = 60 * 60 * 1000 }) {
    if (!Object.hasOwn(endpoints, environment)) throw new Error('SUBSCRIPTION_ENVIRONMENT_INVALID')
    if (!['subscription', 'developer'].includes(accessMode)) throw new Error('SUBSCRIPTION_ACCESS_MODE_INVALID')
    if (accessMode === 'developer' && !developerAccessAllowed) throw new Error('SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE')
    this.path = path
    this.environment = environment
    this.accessMode = accessMode
    this.request = request
    this.clock = clock
    this.checkIntervalMs = checkIntervalMs
    this.state = { schema: 'bellteam.subscription.v1', setupComplete: false, signedTransaction: null, verification: null, error: null }
    this.pending = Promise.resolve()
  }

  async initialize() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'))
      if (state.schema !== this.state.schema || typeof state.setupComplete !== 'boolean'
        || !(state.signedTransaction === null || typeof state.signedTransaction === 'string')) throw new Error('SUBSCRIPTION_STATE_INVALID')
      if (state.verification && state.verification.environment !== this.environment) {
        state.verification = null
        state.signedTransaction = null
        state.error = { code: 'SUBSCRIPTION_ENVIRONMENT_CHANGED', status: 409, message: '購読確認の実行環境を変更しました。アプリから購入情報を復元してください。' }
        this.state = state
        await this.save()
      }
      if (state.verification) this.validate(state.verification)
      if (state.error && (typeof state.error.code !== 'string' || typeof state.error.message !== 'string'
        || !Number.isInteger(state.error.status) || state.error.status < 400 || state.error.status > 599)) throw new Error('SUBSCRIPTION_STATE_INVALID')
      this.state = state
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  status() {
    const verification = this.state.verification
    const entitled = !this.state.error && verification?.entitled === true && Date.parse(verification.validUntil) > this.clock()
    return {
      productId: product.productId,
      environment: this.environment,
      accessMode: this.accessMode,
      setupComplete: this.state.setupComplete,
      entitled,
      // Webと共有サーバーのAI利用は無料。Appleアプリの購入状態はentitledで返す。
      canUseAI: true,
      state: verification?.state ?? 'not_purchased',
      checkedAt: verification?.checkedAt ?? null,
      expiresAt: verification?.expiresAt ?? null,
      validUntil: verification?.validUntil ?? null,
      autoRenewing: verification?.autoRenewing ?? false,
      error: this.state.error,
    }
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
        const verification = await this.verify(signedTransaction)
        this.state.signedTransaction = signedTransaction
        this.state.verification = verification
        this.state.error = null
        await this.save()
        return this.status()
      } catch (error) { return this.fail(error) }
    })
  }

  refresh({ force = false } = {}) {
    if (this.accessMode === 'developer') return Promise.resolve(this.status())
    return this.change(async () => {
      if (!this.state.signedTransaction || (this.state.error && !force)) return this.status()
      const verification = this.state.verification
      const next = verification ? Math.min(
        Date.parse(verification.checkedAt) + this.checkIntervalMs,
        verification.entitled ? Date.parse(verification.validUntil) : Infinity,
      ) : 0
      if (!force && this.clock() < next) return this.status()
      try {
        this.state.verification = await this.verify(this.state.signedTransaction)
        this.state.error = null
        await this.save()
        return this.status()
      } catch (error) { return this.fail(error) }
    })
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

  async verify(signedTransaction) {
    let response
    try {
      response = await this.request(endpoints[this.environment], {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTransaction }), signal: AbortSignal.timeout(20000),
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
    this.validate(result)
    return result
  }

  validate(result) {
    if (result.productId !== product.productId || result.environment !== this.environment
      || typeof result.entitled !== 'boolean' || typeof result.autoRenewing !== 'boolean'
      || !['active', 'grace', 'expired', 'billing_retry', 'revoked'].includes(result.state)
      || (result.entitled && !['active', 'grace'].includes(result.state))
      || !Number.isFinite(Date.parse(result.checkedAt)) || !Number.isFinite(Date.parse(result.expiresAt))
      || (result.entitled ? !Number.isFinite(Date.parse(result.validUntil)) : result.validUntil !== null)) {
      throw new SubscriptionAccessError('SUBSCRIPTION_RESPONSE_INVALID', 502, '購読確認サービスのアプリ・環境・期限の形式が一致しません。')
    }
  }
}
