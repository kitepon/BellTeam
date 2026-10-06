// Appleアプリの認証画面試験用。公式CLIと資格情報には接続しない。
import { createServer } from 'node:http'

const harnesses = [
  { id: 'claude', name: 'Claude', members: 10, startWarning: null },
  { id: 'codex', name: 'Codex', members: 19, startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。途中でやめても元に戻りません。認証が済むまで、Codexを使うメンバーは起動できません。' },
  { id: 'grok', name: 'Grok', members: 3, startWarning: 'Grokは、認証し直しを途中でやめた時に今の認証が残るかを確かめられていません。' },
  { id: 'cursor', name: 'Cursor', members: 1, startWarning: null },
]
let status = 'authenticated'
let failStatus = false
let requests = []
const auth = () => ({ status, url: status === 'waiting' ? 'https://example.com/auth' : null,
  user_code: status === 'waiting' ? 'UI-TEST-CODE' : null, input_required: status === 'waiting',
  message: status === 'blocked' ? '認証し直すで入り直せます。' : null })
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') { status = 'authenticated'; failStatus = false; requests = []; return json({ ok: true }) }
  if (path === '/test/fail-status') { failStatus = true; return json({ ok: true }) }
  if (path === '/test/proof') return json({ requests })
  if (path === '/api/harness-auth') return json({ harnesses })
  if (path.startsWith('/api/harness-auth/')) {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = text ? JSON.parse(text) : null
    requests.push({ path, method: request.method, body })
    if (request.method === 'GET' && failStatus) {
      failStatus = false
      response.statusCode = 500
      return json({ error: 'AUTH_STATUS_FAILED', message: '試験の通信エラーです。状態を更新してください。' })
    }
    if (path.endsWith('/start')) status = 'waiting'
    if (path.endsWith('/input') && body?.text) status = 'authenticated'
    if (path.endsWith('/cancel')) { status = 'blocked'; return json({ harness: 'codex', auth: null }) }
    return json({ harness: path.split('/')[3], auth: auth() })
  }
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/subscription') return json({ subscription: { accessMode: 'developer', entitled: false, canUseAI: true } })
  response.statusCode = 404
  json({ error: 'NOT_FOUND' })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
