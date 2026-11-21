import { createLoginBilling, createHandler, durableObjectStorage } from '@kitepon/login-billing/server'
import product from './product.json' with { type: 'json' }

const WIRE_PREFIX = '/auth/v1'
const CALLBACK_PATH = `${WIRE_PREFIX}/websignin/callback`
// Android App Links: the https return of a web sign-in is handed to the app only when this host serves the app's certificate list.
const ASSETLINKS_PATH = '/.well-known/assetlinks.json'
const APPLE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association'
const RETURN_PAGE_PATHS = ['/auth/return/android', '/auth/return/apple']
const PLAIN = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
// workerd refuses fetch's redirect "error" ("must be one of follow or manual"); the library asks for it on the provider's token exchange, so
// every web sign-in code exchange threw and ended in error=signin_failed (found on the first real run, 2026-11-22). Same meaning here:
// "manual", and a redirect answer is an error. A library defect (workerd), reported to Mint; drop this when the library asks for "manual" itself.
export async function workerdFetch(url, init) {
  if (init?.redirect !== 'error') return fetch(url, init)
  const response = await fetch(url, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw new TypeError('redirect refused')
  return response
}

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
    fetch: workerdFetch,
    // The operator's exempt accounts (K values): they get the product's entitlement whatever the store says (contract 2.3, the Owner's account).
    exemptK: list(env.LB_EXEMPT_K).map(k => k.toLowerCase()),
    billing: env.LB_BILLING === 'off' ? 'off' : 'store',
    // Installed apps still log devices in by the old handoff until every app carries the new sign-in (contract 1.20).
    oldHandoff: env.LB_OLD_HANDOFF === 'off' ? 'off' : 'on',
    ...webSignIn,
    storage,
    ...extra,
  }
}

// storage(env): the library's Storage (the Durable Object storage on Cloudflare). extra: test overrides for the library (fetch, now, stores).
// The per-caller limit on the anonymous paths is the library's (0.10.1, counted in its storage object, caller = CF-Connecting-IP): none here.
export function createLoginBillingWorker({ storage = env => durableObjectStorage(env.LB_STORAGE), extra = {} } = {}) {
  let service

  function configured(env) {
    if (service === undefined) {
      const config = loginBillingConfig(env, storage(env), extra)
      service = config ? createHandler(createLoginBilling(config), { prefix: WIRE_PREFIX, origins: [] }) : null
    }
    return service
  }

  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname
      // Apple: the same host list for universal links and for the https callback of ASWebAuthenticationSession (webcredentials).
      if (path === APPLE_ASSOCIATION_PATH && env.LB_APPLE_APP_SITE_ASSOCIATION) {
        if (request.method !== 'GET') return new Response('GETを使ってください。', { status: 405, headers: { Allow: 'GET' } })
        return new Response(env.LB_APPLE_APP_SITE_ASSOCIATION, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })
      }
      if (path === ASSETLINKS_PATH && env.LB_ASSETLINKS) {
        if (request.method !== 'GET') return new Response('GETを使ってください。', { status: 405, headers: { Allow: 'GET' } })
        return new Response(env.LB_ASSETLINKS, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })
      }
      // The fallback return (Android and Apple) for a browser that did not hand the link to the app: a page that carries nothing and says to go back to the app.
      if (RETURN_PAGE_PATHS.includes(path)) {
        if (request.method !== 'GET') return new Response('GETを使ってください。', { status: 405, headers: { Allow: 'GET' } })
        return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BellTeam</title><p>BellTeamアプリへ戻ってください。ログインがまだ終わっていなければ、アプリでやり直してください。</p>', { headers: { ...PLAIN, 'Content-Type': 'text/html; charset=utf-8' } })
      }
      if (!path.startsWith(`${WIRE_PREFIX}/`)) return new Response('見つかりません', { status: 404 })
      // Every wire route is POST except the provider's callback (contract 1.20), a GET.
      const method = path === CALLBACK_PATH ? 'GET' : 'POST'
      if (request.method !== method) return new Response(`${method}を使ってください。`, { status: 405, headers: { Allow: method } })
      const http = configured(env)
      if (!http) return Response.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
      return (await http.handle(request)) ?? new Response('見つかりません', { status: 404 })
    },
  }
}
