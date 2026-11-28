// The credentialed request (README F14): the module makes the request and adds the credential; only the response leaves. The origin and path prefix come from the item
// (written by Sakura in 1Password), never from the caller. Item fields are lower-case on purpose: the exec transports only return upper-case labels, so none of them ever leaves.
import { createHash, sign as cryptoSign } from 'node:crypto'
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const SAFE_REQUEST_HEADER = /^(?:accept|accept-language|content-type|idempotency-key|if-match|if-none-match|if-modified-since|user-agent|stripe-version|x-request-id|x-correlation-id)$/u
const SHOWN_RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'location', 'retry-after', 'last-modified', 'cache-control', 'x-request-id', 'request-id']
const SHOWN_RATE_HEADER = /^(?:x-)?ratelimit-[a-z-]{1,40}$/u // quota headers the caller needs for its own backoff
// 9 MiB in, 11 MiB out (raw): base64 of either stays under the 16 MiB module payload limit.
export const REQUEST_BODY_MAX = 9 << 20, RESPONSE_BODY_MAX = 11 << 20
const TOKEN_BODY_MAX = 65536, TOKEN_DEFAULT_SECONDS = 3000
const refuse = message => Object.assign(new Error(message), { code: 'HTTP_REFUSED' })

// 127.0.0.0/8, 10/8, 172.16/12, 192.168/16 as dotted IPv4 literals.
const privateAddress = host => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host); if (!m || m.slice(1).some(n => Number(n) > 255 || String(Number(n)) !== n)) return false; const [a, b] = m.slice(1).map(Number); return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) }

function target(fields, request) {
  let base
  try { base = new URL(fields.http_base) } catch { throw refuse('The key item has no usable base URL.') }
  const plainOk = base.protocol === 'http:' && fields.http_allow_plain === '1' && privateAddress(base.hostname) // shortcut: IPv4 literals only, no names (a name could be repointed); upgrade if an owner needs a LAN host name
  if ((base.protocol !== 'https:' && !plainOk) || base.username || base.password || base.search || base.hash) throw refuse('The key item has no usable base URL.')
  const methods = (fields.http_methods ?? 'GET').toUpperCase().split(/[\s,]+/u).filter(Boolean)
  if (!METHODS.includes(request.method) || !methods.includes(request.method)) throw refuse('This method is not allowed for this key.')
  // An encoded slash, backslash, NUL or dot could be read as a separator by the server but not by the URL check below: a path that hides a separator is refused outright.
  if (!/^\/[^\s#\\]*$/u.test(request.path) || /%(?:2f|5c|00|2e|3f|23)/iu.test(request.path.split('?')[0])) throw refuse('The path is not usable.')
  const url = fields.http_auth === 'none' && request.path === '/' ? new URL(base) : new URL(request.path, base) // none: the secret is in the base URL, path '/' means exactly that URL
  const prefix = base.pathname.replace(/\/$/u, '')
  if (url.origin !== base.origin || (url.pathname + '/').slice(0, prefix.length + 1) !== prefix + '/') throw refuse('The path leaves the key\'s API.')
  return url
}

// On the item's passthrough paths the caller's own Authorization header goes instead of the module's credential (a token the caller derived; the key is never added there).
const underPath = (pathname, prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
const passthrough = (fields, url) => (fields.http_passthrough_paths ?? '').split(',').map(p => p.trim()).filter(p => p.startsWith('/')).some(p => underPath(url.pathname, p))

// credential: how the item says it is added. Returns the secret values to scrub; may set a header, a query parameter or form fields.
function addCredential(fields, url, headers, request) {
  const how = fields.http_auth ?? '', secret = fields.http_secret
  if (how === 'none') return { secrets: [...new URL(fields.http_base).pathname.split('/'), ...new URL(fields.http_base).searchParams.values()].filter(s => s.length >= 16) } // the base URL itself is the credential: scrub it from what is shown
  if (how === 'jwt-es256') return jwt(fields, headers)
  if (how === 'form') {
    const pairs = new URLSearchParams(fields.http_form_fields ?? '')
    if (![...pairs.keys()].length) throw refuse('The key item has no credential.')
    return { secrets: [...pairs.values()], form: pairs }
  }
  if (!secret) throw refuse('The key item has no credential.')
  if (how === 'bearer') headers.authorization = `Bearer ${secret}`
  else if (how === 'basic') headers.authorization = `Basic ${Buffer.from(secret).toString('base64')}`
  else if (/^header:[A-Za-z0-9-]{1,64}$/u.test(how)) headers[how.slice(7).toLowerCase()] = secret
  else if (/^query:[A-Za-z0-9_.-]{1,64}$/u.test(how)) url.searchParams.set(how.slice(6), secret)
  else throw refuse('The key item names no way to add the credential.')
  return { secrets: [secret] }
}

// ES256 JWT for the item's key (Apple, Google service accounts): signed here, sent as a bearer, never shown.
function jwt(fields, headers) {
  const key = fields.http_jwt_key, kid = fields.http_jwt_kid
  if (!key || !kid) throw refuse('The key item has no credential.')
  const ttl = Math.min(Math.max(Number(fields.http_jwt_ttl) || 600, 60), 3600), now = Math.floor(Date.now() / 1000)
  let extra = {}
  try { extra = fields.http_jwt_claims ? JSON.parse(fields.http_jwt_claims) : {} } catch { throw refuse('The key item has no usable claims.') }
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = { ...extra, ...(fields.http_jwt_iss ? { iss: fields.http_jwt_iss } : {}), ...(fields.http_jwt_aud ? { aud: fields.http_jwt_aud } : {}), iat: now, exp: now + ttl }
  const data = part({ alg: 'ES256', kid, typ: 'JWT' }) + '.' + part(claims)
  let token
  try { token = data + '.' + cryptoSign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') } catch { throw refuse('The key item has no usable key.') }
  headers.authorization = 'Bearer ' + token
  return { secrets: [token] }
}

// OAuth2 password grant kept in the module: the item names the token path and the form fields (username, password). The token stays in memory only and is renewed on 401.
const tokens = new Map()
async function bearerFor(fields, fetchImpl, fresh) {
  const key = createHash('sha256').update(JSON.stringify([fields.http_base, fields.http_token_path, fields.http_token_fields])).digest('hex')
  const kept = tokens.get(key)
  if (!fresh && kept && kept.until > Date.now()) return { token: kept.token, secrets: kept.secrets, drop: () => tokens.delete(key) }
  const pairs = new URLSearchParams(fields.http_token_fields ?? '')
  const tokenPath = fields.http_token_path ?? ''
  if (!/^\/[^\s#?\\]*$/u.test(tokenPath) || ![...pairs.keys()].length) throw refuse('The key item has no credential.')
  const url = new URL(tokenPath, new URL(fields.http_base).origin)
  const secrets = [...pairs.values()]
  let response, text
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: pairs.toString(), redirect: 'manual', signal: AbortSignal.timeout(20000) })
    text = (await response.text()).slice(0, TOKEN_BODY_MAX)
  } catch { throw Object.assign(new Error('The token request failed.'), { code: 'HTTP_FAILED' }) }
  let parsed = null; try { parsed = JSON.parse(text) } catch {}
  if (!response.ok || typeof parsed?.access_token !== 'string' || !parsed.access_token) throw Object.assign(new Error('The token request failed.'), { code: 'HTTP_FAILED' })
  let seconds = Number.isFinite(parsed.expires_in) ? Math.min(Math.max(parsed.expires_in - 120, 0), 86400) : TOKEN_DEFAULT_SECONDS
  if (fields.cache_seconds !== undefined && Number.isFinite(Number(fields.cache_seconds))) seconds = Math.min(seconds, Number(fields.cache_seconds)) // the item's own cache period also bounds the token (0 = never kept)
  const entry = { token: parsed.access_token, secrets: [...secrets, parsed.access_token], until: Date.now() + seconds * 1000 }
  if (seconds > 0) tokens.set(key, entry)
  return { token: entry.token, secrets: entry.secrets, drop: () => tokens.delete(key) }
}
export const forgetTokens = () => tokens.clear()

// Replaces the credential and its base64 form (basic auth) wherever the response shows it.
const scrubText = (text, secret) => secret.length < 6 ? text : [secret, Buffer.from(secret).toString('base64')].reduce((out, s) => out.split(s).join('[redacted]'), text)
const scrubAll = (text, secrets) => secrets.reduce((out, s) => scrubText(out, s), text)
const scrub = (buffer, secrets) => Buffer.from(scrubAll(buffer.toString('latin1'), secrets), 'latin1')

export async function callHttp(fields, request, fetchImpl = fetch) {
  const url = target(fields, request)
  const headers = {}
  const allowed = (fields.http_allow_headers ?? '').split(',').map(h => h.trim().toLowerCase()).filter(h => /^[a-z0-9-]{1,64}$/u.test(h) && h !== 'authorization' && h !== 'host' && h !== 'content-length') // item-listed extra caller headers
  for (const [name, value] of Object.entries(request.headers ?? {})) if ((SAFE_REQUEST_HEADER.test(name.toLowerCase()) || allowed.includes(name.toLowerCase())) && typeof value === 'string') headers[name.toLowerCase()] = value
  let body = request.body === undefined ? undefined : Buffer.from(request.body, 'base64')
  let secrets = [], oauth = null
  if (passthrough(fields, url)) {
    // the caller's own short-lived token, only on the listed paths; the module adds nothing
    const own = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
    if (typeof own !== 'string' || !/^[\x21-\x7e ]{1,2048}$/u.test(own)) throw refuse('This path needs your own Authorization header.')
    headers.authorization = own; secrets = [own.replace(/^\S+ /u, '')]
  } else {
    if (/^query:/u.test(fields.http_auth ?? '')) url.searchParams.delete(fields.http_auth.slice(6))
    let added
    if (fields.http_auth === 'oauth2-password') { oauth = await bearerFor(fields, fetchImpl, false); headers.authorization = 'Bearer ' + oauth.token; added = { secrets: oauth.secrets } }
    else added = addCredential(fields, url, headers, request) // after the caller's headers, so it always wins
    secrets = added.secrets
    if (added.form) {
      // OAuth-style token exchange: the module appends its fields to the caller's urlencoded body (never to another content type)
      const type = (headers['content-type'] ?? 'application/x-www-form-urlencoded').split(';')[0].trim().toLowerCase()
      if (type !== 'application/x-www-form-urlencoded' || ['GET', 'HEAD'].includes(request.method)) throw refuse('This key needs a form-encoded body.')
      const own = new URLSearchParams(body?.toString('utf8') ?? '')
      for (const key of added.form.keys()) own.delete(key) // the caller cannot set the module's fields
      for (const [key, value] of added.form) own.append(key, value)
      headers['content-type'] = 'application/x-www-form-urlencoded'; body = Buffer.from(own.toString())
    }
    // Item-fixed extra headers (an API version, a tenant id): JSON object, set last so the caller cannot override them.
    if (fields.http_extra_headers) {
      let extra; try { extra = JSON.parse(fields.http_extra_headers) } catch { throw refuse('The key item has no usable headers.') }
      for (const [name, value] of Object.entries(extra ?? {})) if (/^[A-Za-z0-9-]{1,64}$/u.test(name) && typeof value === 'string' && !/[\r\n\0]/u.test(value) && !/^(?:host|content-length|transfer-encoding)$/iu.test(name)) { headers[name.toLowerCase()] = value; secrets.push(value) }
    }
  }
  if (body && (body.length > REQUEST_BODY_MAX || ['GET', 'HEAD'].includes(request.method))) throw refuse('The body is not allowed.')
  const send = async () => {
    try { return await fetchImpl(url, { method: request.method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout((request.timeoutSec ?? 30) * 1000) }) }
    catch (error) { throw Object.assign(new Error(error?.name === 'TimeoutError' ? 'The request timed out.' : 'The request failed.'), { code: 'HTTP_FAILED' }) }
  }
  const read = async response => {
    const chunks = []; let size = 0, truncated = false
    if (response.body) for await (const chunk of response.body) {
      if (size + chunk.length > RESPONSE_BODY_MAX) { chunks.push(chunk.subarray(0, RESPONSE_BODY_MAX - size)); truncated = true; break }
      chunks.push(chunk); size += chunk.length
    }
    return { buffer: Buffer.concat(chunks), truncated }
  }
  let response = await send(), got = await read(response)
  // The token is invalid when the server says 401, or 200 with result.statusCode 210 (JPO): fetch a new one and repeat the request once; the second answer is returned as it is.
  if (oauth && (response.status === 401 || (response.status === 200 && !got.truncated && /json/iu.test(response.headers.get('content-type') ?? '') && invalidTokenBody(got.buffer)))) {
    oauth.drop(); oauth = await bearerFor(fields, fetchImpl, true); headers.authorization = 'Bearer ' + oauth.token; secrets = oauth.secrets
    response = await send(); got = await read(response)
  }
  const shown = Object.fromEntries([...response.headers].filter(([name]) => SHOWN_RESPONSE_HEADERS.includes(name) || SHOWN_RATE_HEADER.test(name)).map(([name, value]) => [name, scrubAll(value, secrets)]))
  return { status: response.status, headers: shown, body: scrub(got.buffer, secrets).toString('base64'), truncated: got.truncated }
}

const invalidTokenBody = buffer => { try { return JSON.parse(buffer.toString('utf8'))?.result?.statusCode === 210 } catch { return false } }
