import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import product from '../services/subscriptions/product.json' with { type: 'json' }

export class SubscriptionAccessError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

// a540: billing is checked by the apps only. This module keeps the setup-complete flag (the guide's end) and answers the one fixed
// "not gated" shape that installed apps already read. It checks, keeps and refuses nothing about money.
// The file keeps its old keys (null/empty) so a rolled-back usage still reads it.
// shortcut: the fixed answer exists for installed apps (accessMode developer = no purchase UI); remove it when the 1.0.x apps are gone.
export class Subscriptions {
  constructor({ path, environment = 'Production', clock = Date.now }) {
    this.path = path
    this.environment = environment
    this.clock = clock
    this.state = { schema: 'bellteam.subscription.v1', setupComplete: false, signedTransaction: null, stripeSubscriptionId: null, googlePurchaseToken: null, stripePendingSessionId: null, verifications: {}, verification: null, error: null }
    this.pending = Promise.resolve()
  }

  async initialize() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'))
      if (state.schema !== this.state.schema || typeof state.setupComplete !== 'boolean') throw new Error('SUBSCRIPTION_STATE_INVALID')
      this.state = { ...this.state, setupComplete: state.setupComplete, ...(state.setup ? { setup: state.setup } : {}) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  status() {
    return {
      productId: product.productId,
      environment: this.environment,
      accessMode: 'developer',
      setupComplete: this.state.setupComplete,
      entitled: false,
      entitlementState: 'active',
      canUseAI: true,
      state: 'not_purchased',
      source: null,
      isTrial: false,
      checkedAt: null,
      expiresAt: null,
      validUntil: null,
      autoRenewing: false,
      billingSources: [],
      canPurchase: false,
      error: null,
    }
  }

  async current() { return this.status() }

  refresh() { return Promise.resolve(this.status()) }

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

  change(run) {
    const result = this.pending.then(run, run)
    this.pending = result
    return result
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path + '.tmp', JSON.stringify(this.state) + '\n', { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }
}
