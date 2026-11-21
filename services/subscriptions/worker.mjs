import { createLoginBilling, createHandler, durableObjectStorage } from '@kitepon/login-billing/server'
import product from './product.json' with { type: 'json' }

const WIRE_PREFIX = '/auth/v1'
const CALLBACK_PATH = `${WIRE_PREFIX}/websignin/callback`
// The anonymous paths that write to storage or spend a code without a pass (library duty): per caller, in this isolate's memory.
// shortcut: per-isolate counters (the storage budgets are the backstop), move to a Durable Object counter if abuse appears.
const LIMITED = ['signin/nonce', 'handoff/start', 'websignin/start', 'prove/take', 'ticket/check'].map(name => `${WIRE_PREFIX}/${name}`)
const LIMIT_PER_MINUTE = 30

const base64Url = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean)

// Reads the Worker's secrets and vars. A missing key means an unconfigured Worker, never a free path:
// billing is "store" unless the var LB_BILLING is "off", which only the test Worker sets (contract 1.13, option c).
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
  // Web sign-in (contract 1.20) is on only when the Worker has its own public origin and at least one provider client.
  const google = env.WEBSIGNIN_GOOGLE_CLIENT_ID && env.WEBSIGNIN_GOOGLE_CLIENT_SECRET
    ? { google: { clientId: env.WEBSIGNIN_GOOGLE_CLIENT_ID, clientSecret: env.WEBSIGNIN_GOOGLE_CLIENT_SECRET } } : {}
  const apple = env.WEBSIGNIN_APPLE_SERVICES_ID && env.WEBSIGNIN_APPLE_TEAM_ID && env.WEBSIGNIN_APPLE_KEY_ID && env.WEBSIGNIN_APPLE_PRIVATE_KEY
    ? { apple: { servicesId: env.WEBSIGNIN_APPLE_SERVICES_ID, teamId: env.WEBSIGNIN_APPLE_TEAM_ID, keyId: env.WEBSIGNIN_APPLE_KEY_ID, privateKey: env.WEBSIGNIN_APPLE_PRIVATE_KEY } } : {}
  const webSignIn = env.LB_PUBLIC_ORIGIN && (google.google || apple.apple)
    ? { webSignIn: { publicOrigin: env.LB_PUBLIC_ORIGIN, ...google, ...apple, returns: { loopback: true, links: list(env.LB_RETURN_LINKS), sessionSchemes: list(env.LB_RETURN_SCHEMES) } } } : {}
  return {
    signIn: { apple: list(env.APPLE_SIGNIN_AUDIENCES), google: list(env.GOOGLE_SIGNIN_AUDIENCES) },
    stores,
    products: [
      { productId: product.productId, store: 'apple', kind: 'subscription' },
      { productId: product.productId, store: 'google', kind: 'subscription' },
    ],
    kKey: base64Url(env.LB_KKEY),
    passKeys: { current: { id: env.LB_PASS_KEY_CURRENT_ID, key: base64Url(env.LB_PASS_KEY_CURRENT) }, ...previous },
    billing: env.LB_BILLING === 'off' ? 'off' : 'store',
    // Installed apps still log devices in by the old handoff until every app carries the new sign-in (contract 1.20).
    oldHandoff: env.LB_OLD_HANDOFF === 'off' ? 'off' : 'on',
    ...webSignIn,
    storage,
    ...extra,
  }
}

// The caller key is a hash of the connecting address; it is never stored or logged.
async function callerKey(request) {
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address))
  return Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('')
}

// storage(env): the library's Storage (the Durable Object storage on Cloudflare). extra: test overrides for the library (fetch, now, stores).
export function createLoginBillingWorker({ storage = env => durableObjectStorage(env.LB_STORAGE), extra = {}, clock = Date.now } = {}) {
  let service
  const counters = new Map()

  function configured(env) {
    if (service === undefined) {
      const config = loginBillingConfig(env, storage(env), extra)
      service = config ? createHandler(createLoginBilling(config), { prefix: WIRE_PREFIX, origins: [] }) : null
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

  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname
      if (!path.startsWith(`${WIRE_PREFIX}/`)) return new Response('見つかりません', { status: 404 })
      // Every wire route is POST except the provider's callback (contract 1.20), a GET.
      const method = path === CALLBACK_PATH ? 'GET' : 'POST'
      if (request.method !== method) return new Response(`${method}を使ってください。`, { status: 405, headers: { Allow: method } })
      const http = configured(env)
      if (!http) return Response.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      if (await limited(request, path)) return http.errorResponse('rate_limited')
      return (await http.handle(request)) ?? new Response('見つかりません', { status: 404 })
    },
  }
}
