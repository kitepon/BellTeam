#!/usr/bin/env node
// BellTeam DEV operator (a522, login-billing contract 1.25). The Worker's own mount with the library's testing entry as its fetch and stores:
// fake Apple/Google keys and fake App Store / Play, so app tests sign in and buy without a person. A local process, never a deployed origin.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryStorage } from '@kitepon/login-billing/server'
import { createTestKit } from '@kitepon/login-billing/testing'
import product from './product.json' with { type: 'json' }
import { createLoginBillingWorker } from './worker.mjs'

// The full form: since login-billing 0.18.2 the library completes a Google audience that does not end with .apps.googleusercontent.com.
export const DEV_GOOGLE_CLIENT = 'dev-google-client.apps.googleusercontent.com'

// http on loopback or a private address only (contract 1.25: the product refuses to start a dev server with a public origin).
// The library's Storage on one JSON file, so a restart (a body swap) keeps nonces, slots and above all the refused-pass and notBefore records a stop test relies on.
// shortcut: whole-file rewrite on every change and counters in memory only, fine for a dev operator's few records; not for a deployed origin.
class FileStorage extends MemoryStorage {
  constructor(file) {
    super()
    this.file = file
    this.rows = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : [])
    this.queued = false
  }
  save() {
    if (this.queued) return
    this.queued = true
    setImmediate(() => { this.queued = false; writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.rows)), { mode: 0o600 }) })
  }
  async get(key) { const row = this.rows.get(key); if (row && row.until > Date.now()) return row.value; this.rows.delete(key) }
  async put(key, value, ttlMs) { this.rows.set(key, { value, until: Date.now() + ttlMs }); this.save() }
  async delete(key) { this.rows.delete(key); this.save() }
  async take(key) { const value = await this.get(key); if (value !== undefined) { this.rows.delete(key); this.save() } return value }
}

export function assertPrivateHttp(publicUrl) {
  let url
  try { url = new URL(publicUrl) } catch { throw new Error(`PUBLIC_URL is not a URL: ${publicUrl}`) }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number)
  const private4 = octets && octets.every(n => n <= 255) &&
    (octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168))
  if (url.protocol !== 'http:' || !(host === 'localhost' || host === '::1' || private4)) {
    throw new Error(`the dev operator runs only on an http URL at a loopback or private address (got ${publicUrl}); it must never be deployed`)
  }
  return url
}

export async function startDevOperator({ port = 8790, publicUrl, dataDir = '.dev-operator', subject = 'dev-person', billing = 'store', log = line => console.log(`dev-operator: ${line}`) } = {}) {
  const origin = (publicUrl ?? `http://127.0.0.1:${port}`).replace(/\/$/, '')
  const url = assertPrivateHttp(origin)
  const dir = resolve(dataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Own keys, made once here and used nowhere else; kept so a restart keeps account numbers and unexpired passes.
  const keysFile = join(dir, 'dev-keys.json')
  const keys = existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, 'utf8'))
    : { k: randomBytes(32).toString('base64url'), pass: randomBytes(32).toString('base64url') }
  if (!existsSync(keysFile)) writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o600 })

  const kit = await createTestKit()
  const { google, apple } = kit.webClients()
  // The callback origin is the address a device sees: loopback (a port forward from another machine, contract 1.25); the library takes http for it only there.
  const webOrigin = /^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? origin : `http://127.0.0.1:${url.port || port}`
  const env = {
    LB_KKEY: keys.k, LB_PASS_KEY_CURRENT: keys.pass, LB_PASS_KEY_CURRENT_ID: 'dev',
    APPLE_SIGNIN_AUDIENCES: product.bundleId, GOOGLE_SIGNIN_AUDIENCES: DEV_GOOGLE_CLIENT,
    LB_BILLING: billing,
    LB_PUBLIC_ORIGIN: webOrigin,
    WEBSIGNIN_GOOGLE_CLIENT_ID: google.clientId, WEBSIGNIN_GOOGLE_CLIENT_SECRET: google.clientSecret,
    WEBSIGNIN_APPLE_SERVICES_ID: apple.servicesId, WEBSIGNIN_APPLE_TEAM_ID: apple.teamId, WEBSIGNIN_APPLE_KEY_ID: apple.keyId, WEBSIGNIN_APPLE_PRIVATE_KEY: apple.privateKey,
  }
  // An App Store lookup for a transaction id the kit does not hold is answered as a live 30-day subscription of this product, so the app's own purchase
  // (a local .storekit transaction on the simulator, signed by Xcode and unknown to the App Store) is read back through the real path. The lookup carries only the id.
  const lookup = /\/inApps\/v1\/transactions\/(\d+)$/
  const fakeFetch = (input, init) => {
    const id = lookup.exec(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname)?.[1]
    if (id && !kit.apple.transactions[id]) {
      kit.apple.transactions[id] = { transactionId: id, originalTransactionId: id, productId: product.productId, bundleId: product.bundleId, type: 'Auto-Renewable Subscription', expiresDate: Date.now() + 30 * 24 * 3600_000 }
    }
    return kit.fetch(input, init)
  }
  // storeAnswerMinutes 0: a store answer is never kept, so /dev/store-end shows at the next read (the library keeps one for 10 minutes by default).
  const storage = new FileStorage(join(dir, 'storage.json'))
  const worker = createLoginBillingWorker({
    storage: () => storage,
    extra: { storeAnswerMinutes: 0, fetch: fakeFetch, stores: { apple: kit.appleStore(product.bundleId), google: kit.googleStore(product.bundleId) } },
  })

  // Dev-only routes: the fake keys live in this process, so the id token for this server is made here.
  const dev = async request => {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST' || !['/dev/id-token', '/dev/websignin', '/dev/store-purchase', '/dev/store-end', '/dev/store-reset'].includes(path)) return undefined
    const body = await request.json().catch(() => ({}))
    if (path === '/dev/websignin') {
      if (typeof body.providerUrl !== 'string') return Response.json({ error: 'providerUrl' }, { status: 400 })
      return Response.json({ location: await kit.signInAtProvider(body.providerUrl, { sub: body.sub ?? subject }) })
    }
    if (path === '/dev/store-reset') {
      // Forgets every fake store record (not accounts or passes), so the next StoreKit-test id is read as a fresh live one without a restart.
      for (const table of [kit.apple.transactions, kit.apple.status, kit.apple.renewal, kit.google.subscriptions, kit.google.products]) for (const key of Object.keys(table)) delete table[key]
      return Response.json({ reset: true })
    }
    if (path === '/dev/store-end') {
      // The App Store now says "expired" for this transaction (status 2), so the server answers ended at the next read.
      if (typeof body.transactionId !== 'string' || !/^\d{1,32}$/.test(body.transactionId)) return Response.json({ error: 'transactionId' }, { status: 400 })
      kit.apple.status[body.transactionId] = 2
      return Response.json({ ended: body.transactionId })
    }
    if (body.provider !== 'apple' && body.provider !== 'google') return Response.json({ error: 'provider' }, { status: 400 })
    if (path === '/dev/store-purchase') {
      // A 30-day subscription in the fake store, in the shape the app sends to /auth/v1/receipt; k (from signin) binds it to that account.
      const id = randomBytes(8).readBigUInt64BE().toString().slice(0, 15).padStart(15, '1')
      const mark = typeof body.k === 'string' && body.k ? body.k : undefined
      const expires = Date.now() + 30 * 24 * 3600_000
      if (body.provider === 'apple') {
        kit.apple.transactions[id] = { transactionId: id, originalTransactionId: id, productId: product.productId, bundleId: product.bundleId, type: 'Auto-Renewable Subscription', expiresDate: expires, ...(mark ? { appAccountToken: mark } : {}) }
        return Response.json({ route: '/auth/v1/receipt', receipts: [{ store: 'apple', transactionId: id }] })
      }
      const token = `dev-token-${id}`
      kit.google.subscriptions[token] = {
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
        lineItems: [{ productId: product.productId, expiryTime: new Date(expires).toISOString() }],
        ...(mark ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: mark } } : {}),
      }
      return Response.json({ route: '/auth/v1/receipt', receipts: [{ store: 'google', productId: product.productId, purchaseToken: token }] })
    }
    const sub = body.sub ?? subject
    const aud = body.provider === 'google' ? DEV_GOOGLE_CLIENT : product.bundleId
    const make = body.provider === 'google' ? kit.googleIdToken : kit.appleIdToken
    return Response.json({ id_token: await make({ aud, sub, ...(body.nonce ? { nonce: body.nonce } : {}) }), provider: body.provider, aud, sub })
  }
  const handle = async request => (await dev(request)) ?? worker.fetch(request, env)

  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}), redirect: 'manual' })
      const response = await handle(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      log(`request failed: ${error.message}`)
      res.writeHead(500).end()
    }
  })
  // Listens on the host of PUBLIC_URL only (a private address or loopback), never on every interface.
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(Number(url.port || port), url.hostname.replace(/^\[|\]$/g, ''), ok) })
  const actual = server.address().port
  const base = origin.replace(/:\d+$/, '') + `:${actual}`
  log(`listening on ${base} (wire base ${base}/auth/v1; fake sign-in subject "${subject}"; Apple aud ${product.bundleId}, Google aud ${DEV_GOOGLE_CLIENT}; billing ${billing}; web sign-in callback ${webOrigin}; keys ${dir})`)
  return { url: base, close: () => new Promise(ok => { server.close(ok); server.closeAllConnections?.() }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  startDevOperator({
    ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
    ...(env.DEV_DATA ? { dataDir: env.DEV_DATA } : {}),
    ...(env.DEV_SUBJECT ? { subject: env.DEV_SUBJECT } : {}),
    ...(env.DEV_BILLING ? { billing: env.DEV_BILLING === 'off' ? 'off' : 'store' } : {}),
  }).catch(error => { console.error(`dev-operator: ${error.message}`); process.exit(1) })
}
