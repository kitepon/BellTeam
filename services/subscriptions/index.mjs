import { DurableObject } from 'cloudflare:workers'
import { createSubscriptionWorker } from './worker.mjs'
import { publicPageResponse } from './public-pages.mjs'

// 購読情報を保存せず、Appleの照会と署名検証だけを実行する。
export class SubscriptionVerifier extends DurableObject {
  verification = createSubscriptionWorker()

  fetch(request) {
    return this.verification.fetch(request, this.env)
  }
}

export default {
  fetch(request, env) {
    return publicPageResponse(request) ?? env.SUBSCRIPTION_VERIFIER.getByName('subscriptions').fetch(request)
  },
}
