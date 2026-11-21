import { createLoginBilling, createHandler, LoginBillingError, StorageFull } from '@kitepon/login-billing/server'
import product from './product.json' with { type: 'json' }

const WIRE_PREFIX = '/auth/v1'
const ENTITLEMENT_PATH = '/v1/entitlement'
// The two anonymous routes that write to storage without a pass (library duty): per caller, in this isolate's memory.
// shortcut: per-isolate counters (the cap in storage is the backstop), move to a Durable Object counter if abuse appears.
const LIMITED = [`${WIRE_PREFIX}/signin/nonce`, `${WIRE_PREFIX}/handoff/start`]
const LIMIT_PER_MINUTE = 30

const base64Url = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean)
const json = (body, status = 200, headers) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })

// Reads the Worker's secrets and vars; a missing key is an unconfigured Worker, never a free path (billing stays "store").
export function loginBillingConfig(env, storage, extra = {}) {
  if (!env.LB_KKEY || !env.LB_PASS_KEY_CURRENT || !env.LB_PASS_KEY_CURRENT_ID) return null
  const stores = {}
  if (env.APPLE_ISSUER_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    stores.apple = { bundleId: product.bundleId, issuerId: env.APPLE_ISSUER_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY }
  }
  if (env.GOOGLE_PLAY_SERVICE_ACCOUNT) {
    stores.google = { packageName: product.bundleId, serviceAccount: JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT) }
  }
  const previous = env.LB_PASS_KEY_PREVIOUS && env.LB_PASS_KEY_PREVIOUS_ID
    ? { previous: { id: env.LB_PASS_KEY_PREVIOUS_ID, key: base64Url(env.LB_PASS_KEY_PREVIOUS) } } : {}
  return {
    signIn: { apple: list(env.APPLE_SIGNIN_AUDIENCES), google: list(env.GOOGLE_SIGNIN_AUDIENCES) },
    stores,
    products: [
      { productId: product.productId, store: 'apple', kind: 'subscription' },
      { productId: product.productId, store: 'google', kind: 'subscription' },
    ],
    kKey: base64Url(env.LB_KKEY),
    passKeys: { current: { id: env.LB_PASS_KEY_CURRENT_ID, key: base64Url(env.LB_PASS_KEY_CURRENT) }, ...previous },
    billing: 'store',
    storage,
    ...extra,
  }
}

// The library's Storage over a store that answers 'full' at its cap (an error object does not cross a Durable Object call as one).
// `target()` returns the store, local or a Durable Object stub; it is looked up on every call.
export function libraryStorage(target) {
  return {
    async get(key) { return (await target().get(key)) ?? undefined },
    async put(key, value, ttlMs) { if ((await target().put(key, value, ttlMs)) === 'full') throw new StorageFull() },
    async delete(key) { await target().delete(key) },
  }
}

// The caller key is a hash of the connecting address; it is never stored or logged.
async function callerKey(request) {
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address))
  return Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('')
}

// storage: the library's Storage (get/put/delete with an expiry). extra: test overrides for the library (fetch, now).
export function createLoginBillingWorker({ storage, extra = {}, clock = Date.now }) {
  let service
  const counters = new Map()

  function configured(env) {
    if (service === undefined) {
      const config = loginBillingConfig(env, storage, extra)
      service = config ? (() => { const lb = createLoginBilling(config); return { lb, http: createHandler(lb, { prefix: WIRE_PREFIX, origins: [] }) } })() : null
    }
    return service
  }

  async function limited(request, path) {
    if (!LIMITED.includes(path)) return false
    const key = `${path}:${await callerKey(request)}`
    const now = clock()
    for (const [name, entry] of counters) if (entry.resetAt <= now) counters.delete(name)
    const entry = counters.get(key) ?? { count: 0, resetAt: now + 60_000 }
    entry.count += 1
    counters.set(key, entry)
    return entry.count > LIMIT_PER_MINUTE
  }

  // What a pass entitles: a live BellTeam subscription of the pass's account, from the store, nothing kept.
  async function entitlement(request, { http }) {
    try {
      const checked = await http.authenticate(request)
      const live = checked.entitlements.filter(item => item.productId === product.productId && (item.store === 'apple' || item.store === 'google'))
      if (live.length === 0) return json({ entitled: false }, 200, checked.headers)
      const end = item => (item.expiresAt ? Date.parse(item.expiresAt) : 0)
      const best = live.reduce((a, b) => (end(b) > end(a) ? b : a))
      return json({ entitled: true, source: best.store, ...(best.expiresAt ? { validUntil: best.expiresAt } : {}) }, 200, checked.headers)
    } catch (error) {
      if (error instanceof LoginBillingError) return http.errorResponse(error.code, request)
      if (error instanceof StorageFull) return http.errorResponse('rate_limited')
      return http.errorResponse('internal')
    }
  }

  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname
      if (!path.startsWith(`${WIRE_PREFIX}/`) && path !== ENTITLEMENT_PATH) return new Response('見つかりません', { status: 404 })
      if (request.method !== 'POST') return new Response('POSTを使ってください。', { status: 405, headers: { Allow: 'POST' } })
      const current = configured(env)
      if (!current) return json({ error: 'not_configured' }, 503)
      if (await limited(request, path)) return current.http.errorResponse('rate_limited')
      if (path === ENTITLEMENT_PATH) return entitlement(request, current)
      return (await current.http.handle(request)) ?? new Response('見つかりません', { status: 404 })
    },
  }
}
