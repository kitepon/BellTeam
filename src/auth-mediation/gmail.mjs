// Gmail inside the module (README F21): the module holds the OAuth client and refresh token, exchanges them for a short-lived access token (kept in memory only)
// and makes a few fixed calls for the user "me". The caller gets Google's status and body unchanged, never the token.
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/threads', TOKEN_URL = 'https://oauth2.googleapis.com/token'
const BODY_MAX = 1048576
export const GMAIL_REJECTED = 'GMAIL_REJECTED', GMAIL_FAILED = 'GMAIL_FAILED', GMAIL_AUTH = 'GMAIL_AUTH'
const fail = (code, why) => Object.assign(new Error(code), { code, why })
const list = value => (value ?? '').split(',').map(v => v.trim()).filter(Boolean)
const LABEL = /^[A-Za-z0-9_-]{1,64}$/u

// tokens: Map shared by the core; an entry {value, until} per refresh token owner (item name).
export async function callGmail(fields, request, { tokens, name, fetchImpl = fetch, now = Date.now }) {
  const { gmail_client_id: id, gmail_client_secret: secret, gmail_refresh_token: refresh } = fields ?? {}
  if (!id || !secret || !refresh) throw fail(GMAIL_REJECTED, 'item')
  const url = new URL(API); let init = { method: 'GET' }
  if (request.action === 'list') {
    if (request.q !== undefined && !(typeof request.q === 'string' && request.q.length <= 200 && /^[\x20-\x7e]*$/u.test(request.q))) throw fail(GMAIL_REJECTED, 'q')
    if (request.max_results !== undefined && !(Number.isInteger(request.max_results) && request.max_results >= 1 && request.max_results <= 50)) throw fail(GMAIL_REJECTED, 'max_results')
    if (request.page_token !== undefined && !(typeof request.page_token === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(request.page_token))) throw fail(GMAIL_REJECTED, 'page_token')
    if (request.q) url.searchParams.set('q', request.q)
    if (request.max_results) url.searchParams.set('maxResults', String(request.max_results))
    if (request.page_token) url.searchParams.set('pageToken', request.page_token)
  } else if (request.action === 'get' || request.action === 'modify') {
    if (!/^[A-Za-z0-9]{1,40}$/u.test(request.id ?? '')) throw fail(GMAIL_REJECTED, 'id')
    url.pathname += '/' + request.id
    if (request.action === 'get') {
      const format = request.format ?? 'full'
      if (!['full', 'metadata', 'minimal'].includes(format)) throw fail(GMAIL_REJECTED, 'format')
      url.searchParams.set('format', format)
    } else {
      const add = request.add_labels ?? [], remove = request.remove_labels ?? [], canAdd = list(fields.gmail_add_labels), canRemove = list(fields.gmail_remove_labels ?? 'INBOX')
      if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length < 1 || add.length > 8 || remove.length > 8
        || !add.every(l => LABEL.test(l) && canAdd.includes(l)) || !remove.every(l => LABEL.test(l) && canRemove.includes(l))) throw fail(GMAIL_REJECTED, 'labels')
      url.pathname += '/modify'
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(add.length ? { addLabelIds: add } : {}), ...(remove.length ? { removeLabelIds: remove } : {}) }) }
    }
  } else throw fail(GMAIL_REJECTED, 'action')
  let token = tokens.get(name)
  if (!token || token.until <= now()) {
    let answer
    try { answer = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: id, client_secret: secret, refresh_token: refresh }), redirect: 'manual', signal: AbortSignal.timeout(20000) }) }
    catch { throw fail(GMAIL_FAILED, 'token request') }
    const parsed = await answer.json().catch(() => ({}))
    if (!answer.ok || typeof parsed.access_token !== 'string') throw fail(GMAIL_AUTH, 'token ' + answer.status)
    token = { value: parsed.access_token, until: now() + Math.max(60, Math.min(Number(parsed.expires_in) || 3600, 3600) - 60) * 1000 }
    tokens.set(name, token)
  }
  let response
  try { response = await fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), authorization: 'Bearer ' + token.value }, redirect: 'manual', signal: AbortSignal.timeout(30000) }) }
  catch { throw fail(GMAIL_FAILED, 'request') }
  if (response.status === 401) tokens.delete(name) // the next call gets a fresh token
  const text = Buffer.from(await response.arrayBuffer()), cut = text.length > BODY_MAX
  const body = text.subarray(0, BODY_MAX).toString('utf8').split(token.value).join('[redacted]')
  return { status: response.status, body, ...(cut ? { truncated: true } : {}) }
}
