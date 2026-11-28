// The credentialed request (README F14): the module makes the request and adds the credential; only the response leaves. The origin and path prefix come from the item
// (written by Sakura in 1Password), never from the caller. Item fields are lower-case on purpose: the exec transports only return upper-case labels, so none of them ever leaves.
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const SAFE_REQUEST_HEADER = /^(?:accept|accept-language|content-type|idempotency-key|if-match|if-none-match|if-modified-since|user-agent|stripe-version|x-request-id|x-correlation-id)$/u
const SHOWN_RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'location', 'retry-after', 'last-modified', 'cache-control', 'x-request-id', 'request-id']
export const REQUEST_BODY_MAX = 32768, RESPONSE_BODY_MAX = 262144
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
  if (!/^\/[^\s#\\]*$/u.test(request.path)) throw refuse('The path is not usable.')
  const url = new URL(request.path, base)
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

// Replaces the credential and its base64 form (basic auth) wherever the response shows it.
const scrubText = (text, secret) => secret.length < 6 ? text : [secret, Buffer.from(secret).toString('base64')].reduce((out, s) => out.split(s).join('[redacted]'), text)
const scrubAll = (text, secrets) => secrets.reduce((out, s) => scrubText(out, s), text)
const scrub = (buffer, secrets) => Buffer.from(scrubAll(buffer.toString('latin1'), secrets), 'latin1')

export async function callHttp(fields, request, fetchImpl = fetch) {
  const url = target(fields, request)
  const headers = {}
  for (const [name, value] of Object.entries(request.headers ?? {})) if (SAFE_REQUEST_HEADER.test(name.toLowerCase()) && typeof value === 'string') headers[name.toLowerCase()] = value
  let body = request.body === undefined ? undefined : Buffer.from(request.body, 'base64')
  let secrets = []
  if (passthrough(fields, url)) {
    // the caller's own short-lived token, only on the listed paths; the module adds nothing
    const own = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
    if (typeof own !== 'string' || !/^[\x21-\x7e ]{1,2048}$/u.test(own)) throw refuse('This path needs your own Authorization header.')
    headers.authorization = own; secrets = [own.replace(/^\S+ /u, '')]
  } else {
    if (/^query:/u.test(fields.http_auth ?? '')) url.searchParams.delete(fields.http_auth.slice(6))
    const added = addCredential(fields, url, headers, request) // after the caller's headers, so it always wins
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
  }
  if (body && (body.length > REQUEST_BODY_MAX || ['GET', 'HEAD'].includes(request.method))) throw refuse('The body is not allowed.')
  let response
  try { response = await fetchImpl(url, { method: request.method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout((request.timeoutSec ?? 30) * 1000) }) }
  catch (error) { throw Object.assign(new Error(error?.name === 'TimeoutError' ? 'The request timed out.' : 'The request failed.'), { code: 'HTTP_FAILED' }) }
  const chunks = []; let size = 0, truncated = false
  if (response.body) for await (const chunk of response.body) {
    if (size + chunk.length > RESPONSE_BODY_MAX) { chunks.push(chunk.subarray(0, RESPONSE_BODY_MAX - size)); truncated = true; break }
    chunks.push(chunk); size += chunk.length
  }
  const shown = Object.fromEntries(SHOWN_RESPONSE_HEADERS.map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null).map(([name, value]) => [name, scrubAll(value, secrets)]))
  return { status: response.status, headers: shown, body: scrub(Buffer.concat(chunks), secrets).toString('base64'), truncated }
}
