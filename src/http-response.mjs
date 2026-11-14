// 塊ごとに文字へ直すと、塊の境目で割れた日本語が化けるので、全部つないでから読む。
export async function readJson(request, maxBytes = 16 * 1024 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('INVALID_JSON') }
}

// a115 (CSRF): another site's page can make the Owner's browser send a write (its cookies attached). Browsers mark it with
// Sec-Fetch-Site; older ones only with Origin, and only a simple content type skips the CORS preflight. Apps and seats send neither header.
// shortcut: a bodyless cross-site POST from a browser without Sec-Fetch-Site (Safari < 16.4) still passes; add an Origin/host match if such clients matter.
const SIMPLE_TYPES = ['text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded']
export function crossSiteWrite({ method, headers }) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false
  const site = headers['sec-fetch-site'], type = headers['content-type']?.split(';')[0].trim().toLowerCase()
  return site !== undefined && site !== 'same-origin' && site !== 'none' || headers.origin !== undefined && SIMPLE_TYPES.includes(type)
}

export function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}
