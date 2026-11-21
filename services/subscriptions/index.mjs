import { LoginBillingStorageObject } from '@kitepon/login-billing/server'
import { createLoginBillingWorker } from './worker.mjs'
import { publicPageResponse } from './public-pages.mjs'

// The library's only storage on Cloudflare (contract 1.20): nonces, handoff slots, web-login records, proof codes, refused pass ids and
// notBefore records, each with an expiry. One object, one request at a time, so take(key) is one read-and-delete.
export class LBStorage extends LoginBillingStorageObject {}

const worker = createLoginBillingWorker()

export default {
  fetch(request, env) {
    return publicPageResponse(request) ?? worker.fetch(request, env)
  },
}
