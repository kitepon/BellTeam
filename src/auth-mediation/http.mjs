// The credentialed request (README F14): the module makes the request and adds the credential; only the response leaves. The origin and path prefix come from the item
// (written by Sakura in 1Password), never from the caller. Item fields are lower-case on purpose: the exec transports only return upper-case labels, so none of them ever leaves.
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const SAFE_REQUEST_HEADER = /^(?:accept|accept-language|content-type|idempotency-key|if-match|if-none-match|if-modified-since|user-agent|stripe-version|x-[a-z0-9-]+)$/u
const SHOWN_RESPONSE_HEADERS = ['content-type', 'content-length', 'etag', 'location', 'retry-after', 'last-modified', 'cache-control', 'x-request-id', 'request-id']
export const REQUEST_BODY_MAX = 32768, RESPONSE_BODY_MAX = 262144
const refuse = message => Object.assign(new Error(message), { code: 'HTTP_REFUSED' })

function target(fields, request) {
  let base
  try { base = new URL(fields.http_base) } catch { throw refuse('The key item has no usable base URL.') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw refuse('The key item has no usable base URL.')
  const methods = (fields.http_methods ?? 'GET').toUpperCase().split(/[\s,]+/u).filter(Boolean)
  if (!METHODS.includes(request.method) || !methods.includes(request.method)) throw refuse('This method is not allowed for this key.')
  if (!/^\/[^\s#\\]*$/u.test(request.path)) throw refuse('The path is not usable.')
  const url = new URL(request.path, base)
  const prefix = base.pathname.replace(/\/$/u, '')
  if (url.origin !== base.origin || (url.pathname + '/').slice(0, prefix.length + 1) !== prefix + '/') throw refuse('The path leaves the key\'s API.')
  return url
}

// credential: how the item says it is added. Returns the header (or none) and may set a query parameter on url.
function addCredential(fields, url, headers) {
  const secret = fields.http_secret, how = fields.http_auth ?? ''
  if (!secret) throw refuse('The key item has no credential.')
  if (how === 'bearer') headers.authorization = `Bearer ${secret}`
  else if (how === 'basic') headers.authorization = `Basic ${Buffer.from(secret).toString('base64')}`
  else if (/^header:[A-Za-z0-9-]{1,64}$/u.test(how)) headers[how.slice(7).toLowerCase()] = secret
  else if (/^query:[A-Za-z0-9_.-]{1,64}$/u.test(how)) url.searchParams.set(how.slice(6), secret)
  else throw refuse('The key item names no way to add the credential.')
  return secret
}

const scrub = (buffer, secret) => secret.length < 6 ? buffer : Buffer.from(buffer.toString('latin1').split(secret).join('[redacted]'), 'latin1')

export async function callHttp(fields, request, fetchImpl = fetch) {
  const url = target(fields, request)
  const headers = {}
  for (const [name, value] of Object.entries(request.headers ?? {})) if (SAFE_REQUEST_HEADER.test(name.toLowerCase()) && typeof value === 'string') headers[name.toLowerCase()] = value
  if (/^query:/u.test(fields.http_auth ?? '')) url.searchParams.delete(fields.http_auth.slice(6))
  const secret = addCredential(fields, url, headers) // after the caller's headers, so it always wins
  const body = request.body === undefined ? undefined : Buffer.from(request.body, 'base64')
  if (body && (body.length > REQUEST_BODY_MAX || ['GET', 'HEAD'].includes(request.method))) throw refuse('The body is not allowed.')
  let response
  try { response = await fetchImpl(url, { method: request.method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout((request.timeoutSec ?? 30) * 1000) }) }
  catch (error) { throw Object.assign(new Error(error?.name === 'TimeoutError' ? 'The request timed out.' : 'The request failed.'), { code: 'HTTP_FAILED' }) }
  const chunks = []; let size = 0, truncated = false
  if (response.body) for await (const chunk of response.body) {
    if (size + chunk.length > RESPONSE_BODY_MAX) { chunks.push(chunk.subarray(0, RESPONSE_BODY_MAX - size)); truncated = true; break }
    chunks.push(chunk); size += chunk.length
  }
  const shown = Object.fromEntries(SHOWN_RESPONSE_HEADERS.map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null))
  return { status: response.status, headers: shown, body: scrub(Buffer.concat(chunks), secret).toString('base64'), truncated }
}
