// Apple 決裁箱 screens (docs/architecture/modules/approval-box-extension/screen-spec.md) against the app contract
// (contract/approvals-contract.md), answering with the contract fixtures in test/fixtures/approvals.
// Prints {"url"} on start. /test/reset; /test/grant (the Owner allowed BellTeam on the consent page); /test/mode?state=ready|not_entitled|expired|not_connected|old|unavailable|empty
//   &delivery=delivered|waiting|unknown (what an answer reports) &stream=ok|drop &connected=1 (the module's /connection after consent).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/approvals')
const load = name => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))
const iso = minutes => new Date(Date.now() - minutes * 60000).toISOString()

let state, subscribers = new Set()
function reset() {
  const [d1, d2, d3] = load('list.pending').items
  state = {
    mode: { state: 'ready', delivery: 'delivered', stream: 'ok' },
    connection: 'not_connected',
    decisions: new Map([
      [d1.id, { ...d1, createdAt: iso(40) }],
      [d2.id, { ...d2, createdAt: iso(20) }],
      [d3.id, { ...d3, status: 'held', createdAt: iso(300) }],
      ['K-DEMO9', { ...load('view-decision.answered-delivery-unknown') }],
    ]),
  }
}
reset()

const summary = () => {
  const all = [...state.decisions.values()]
  const open = all.filter(d => d.status === 'pending')
  return { schema: 'bellteam.approvals-summary.v1', pending: open.length, urgent: open.filter(d => d.urgency === 'high').length,
    held: all.filter(d => d.status === 'held').length, answeredToday: all.filter(d => d.status === 'answered').length, filedToday: all.length,
    byOrigin: { bellteam: open.filter(d => d.origin.kind === 'bellteam').length, external: open.filter(d => d.origin.kind !== 'bellteam').length } }
}
const error = (code, message, extra = {}) => ({ error: { code, message, ...extra } })
const gate = () => {
  const s = state.mode.state
  if (s === 'old') return [404, { error: 'not found' }]
  if (s === 'not_entitled') return [403, error('not_entitled', '決裁箱の拡張は、まだ使えません。', { state: 'none' })]
  if (s === 'expired') return [403, error('not_entitled', '決裁箱の契約が切れています。', { state: 'expired', validUntil: '2026-10-31T00:00:00Z' })]
  if (s === 'unavailable') return [503, error('unavailable', 'いまは決裁箱を読めません。')]
  if (s === 'not_connected' && state.connection !== 'connected') return [409, error('not_connected', '決裁箱につながっていません。')]
  return null
}

function push(event, data) { for (const response of subscribers) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x')
  const path = url.pathname
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    if (path === '/test/reset') { reset(); return send(200, { ok: true }) }
    if (path === '/test/mode') { for (const key of ['state', 'delivery', 'stream']) if (url.searchParams.has(key)) state.mode[key] = url.searchParams.get(key); return send(200, state.mode) }
    if (path === '/test/grant') { state.connection = 'connected'; state.mode.state = 'ready'; return send(200, { ok: true }) }
    if (path === '/consent') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return response.end('<meta charset=utf-8><p>許可しました。BellTeamに戻ってください。') }
    if (!path.startsWith('/api/approvals')) return send(404, { error: 'not found' })
    const sub = path.slice('/api/approvals'.length)
    if (sub === '/connection' && request.method === 'GET') return send(200, { state: state.connection, connectedAt: iso(5) })
    if (sub === '/connect' && request.method === 'POST') { state.connection = 'waiting'; return send(200, { authorizationUrl: `http://${request.headers.host}/consent`, expiresAt: iso(-10) }) }
    if (sub === '/connect' && request.method === 'DELETE') { state.connection = 'not_connected'; return send(200, { state: 'not_connected' }) }
    if (sub === '/connection' && request.method === 'DELETE') { state.connection = 'not_connected'; state.mode.state = 'not_connected'; return send(200, { state: 'not_connected' }) }
    const blocked = gate()
    if (blocked) return send(...blocked)
    if (sub === '/events') {
      if (state.mode.stream === 'drop') return send(503, error('unavailable', 'x'))
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`event: summary\ndata: ${JSON.stringify(summary())}\n\n`)
      subscribers.add(response)
      const beat = setInterval(() => response.write(': hb\n\n'), 15000)
      request.on('close', () => { subscribers.delete(response); clearInterval(beat) })
      return
    }
    if (sub === '/summary') return send(200, summary())
    if (sub === '') {
      const statuses = (url.searchParams.get('status') || '').split(',')
      const items = state.mode.state === 'empty' ? [] : [...state.decisions.values()].filter(d => statuses.includes(d.status))
      return send(200, { items })
    }
    const [, id, action] = sub.split('/')
    const decision = state.decisions.get(id)
    if (!decision) return send(404, error('not_found', '見つかりません。'))
    if (!action) return send(200, decision)
    if (action === 'hold' || action === 'unhold') { decision.status = action === 'hold' ? 'held' : 'pending'; decision.version += 1; push('summary', summary()); return send(200, decision) }
    if (action === 'answer') {
      const body = JSON.parse(raw || '{}')
      if (body.version !== decision.version) return send(409, error('conflict', '答える前に、内容が直されました。', { decision }))
      Object.assign(decision, { status: 'answered', version: decision.version + 1, delivery: state.mode.delivery, answer: { optionId: body.optionId ?? null, text: body.text ?? null, attachments: [], answeredAt: new Date().toISOString() } })
      push('summary', summary())
      return send(200, decision)
    }
    send(404, error('not_found', '見つかりません。'))
  })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
