import { DurableObject } from 'cloudflare:workers'
import { createLoginBillingWorker, libraryStorage } from './worker.mjs'
import { createSqlStorage } from './sql-storage.mjs'
import { publicPageResponse } from './public-pages.mjs'

// The library's only storage: nonces, handoff slots, refused pass ids and notBefore records, each with an expiry.
export class LoginBillingStorage extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.kv = createSqlStorage(ctx.storage.sql)
  }
  get(key) { return this.kv.get(key) }
  put(key, value, ttlMs) { return this.kv.put(key, value, ttlMs) }
  delete(key) { return this.kv.delete(key) }
}

let worker
function login(env) {
  worker ??= createLoginBillingWorker({ storage: libraryStorage(() => env.LOGIN_BILLING_STORAGE.getByName('login-billing')) })
  return worker
}

export default {
  fetch(request, env) {
    return publicPageResponse(request) ?? login(env).fetch(request, env)
  },
}
