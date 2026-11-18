import { httpRouteType } from './http-errors.mjs'

// t20 (BugHub 44906d23, 4783ee40, c882af7b): the apps give up after 60 s. A public API request that the client closed before
// the response finished, or that took 60 s or more, is also kept as a diagnostic (route type only), so app timeouts can be
// matched with what the server did. Event streams end by closing and are not recorded.
export const SLOW_REQUEST_MS = 60_000
export function recordSlowOrAborted(request, response, diagnostics, now = Date.now) {
  const path = String(request.url).split('?')[0]
  if (!diagnostics || !path.startsWith('/api/') || path === '/api/events') return
  const started = now()
  let finished = false, eventStream = false
  response.once('finish', () => { finished = true })
  // 8c6f: writeHead(status, {headers}) never reaches getHeader(), so read the type there too (the SSE routes all use it).
  // shortcut: object form of the headers only (every writeHead here passes an object), upgrade if an array form appears.
  const writeHead = response.writeHead
  if (typeof writeHead === 'function') response.writeHead = function (...args) {
    const headers = args.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg))
    const type = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    if (String(type ?? '').startsWith('text/event-stream')) eventStream = true
    return writeHead.apply(this, args)
  }
  response.once('close', () => {
    const duration = now() - started
    if (finished && duration < SLOW_REQUEST_MS) return
    if (eventStream || String(response.getHeader?.('content-type') ?? '').startsWith('text/event-stream')) return
    Promise.resolve().then(() => diagnostics.record({ code: 'SERVER_HTTP_SLOW_OR_ABORTED', module: 'server', diagnostic_log: JSON.stringify({
      schema: 'bellteam.http-slow.v1',
      http_method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? request.method : 'unknown',
      request_route: httpRouteType(request.url), request_started_at_ms: started, duration_ms: duration,
      response_headers_sent: response.headersSent === true, response_finished: finished, http_status: finished ? response.statusCode : null,
      ending: finished ? 'slow' : 'client_closed_first',
    }) })).catch(() => process.stderr.write('BellTeam: 遅い要求の診断を保存できませんでした\n'))
  })
}

// 書き込み系の要求は、受付の時刻と結果を1行残す。
// 保存が届いたか・応答を返し終えたかを、端末側の時刻と後から照合するため（本文と問い合わせ文字列は残さない）。
// 応答を返し終える前に接続が切れた時は、状態コードの代わりに aborted と書く。
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export function logWriteRequest(request, response, write) {
  const path = String(request.url).split('?')[0]
  if (!WRITE_METHODS.has(request.method) || !path.startsWith('/api/')) return
  const started = Date.now()
  let finished = false
  response.once('finish', () => { finished = true })
  response.once('close', () => {
    write(`BellTeam write: ${new Date(started).toISOString()} ${request.method} ${path} ${finished ? response.statusCode : 'aborted'} ${Date.now() - started}ms\n`)
  })
}

// 読み取りは受付時にも残す。応答待ちのGETと、記録されなかったGETを区別するため。
// finishは端末の受領ではなく、Nodeが応答をOSへ渡し終えた事を表す。
export function logReadRequest(request, response, write) {
  const path = String(request.url).split('?')[0]
  if (!['GET', 'HEAD'].includes(request.method) || !path.startsWith('/api/')) return
  const started = Date.now()
  const prefix = `BellTeam read: ${new Date(started).toISOString()} ${request.method} ${path}`
  write(`${prefix} started\n`)
  let finished = false
  response.once('finish', () => { finished = true })
  response.once('close', () => {
    write(`${prefix} ${finished ? response.statusCode : 'aborted'} ${Date.now() - started}ms\n`)
  })
}
