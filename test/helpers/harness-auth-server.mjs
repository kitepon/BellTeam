// Appleアプリの認証画面試験用。公式CLIと資格情報には接続しない。
import { createServer } from 'node:http'

const harnesses = [
  { id: 'claude', name: 'Claude', members: 10, startWarning: null },
  { id: 'codex', name: 'Codex', members: 19, startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。途中でやめても元に戻りません。認証が済むまで、Codexを使うメンバーは起動できません。' },
  { id: 'grok', name: 'Grok', members: 3, startWarning: 'Grokは、認証し直しを途中でやめた時に今の認証が残るかを確かめられていません。' },
  { id: 'cursor', name: 'Cursor', members: 1, startWarning: null },
  { id: 'antigravity', name: 'Antigravity', members: 1, startWarning: null, reloginSupported: false },
]
let status = 'authenticated'
let failStatus = null
let blocked = null
let unreadable = null
let accounts = null // null: older body (404). 'fable': 1st limited for Fable. 'both': both slots limited for Fable.
let requests = []
const auth = harness => {
  const current = harness === blocked ? 'blocked' : status
  return { status: current, url: current === 'waiting' ? 'https://example.com/auth' : null,
    user_code: current === 'waiting' ? 'UI-TEST-CODE' : null, input_required: current === 'waiting',
    message: current === 'blocked' ? '認証し直すで入り直せます。' : null }
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') {
    status = 'authenticated'; failStatus = null; requests = []
    blocked = url.searchParams.get('blocked'); unreadable = url.searchParams.get('unreadable'); accounts = url.searchParams.get('accounts')
    return json({ ok: true })
  }
  // 一覧が全AIを読むので、失敗は対象のAIだけに当てる。
  if (path === '/test/fail-status') { failStatus = url.searchParams.get('harness') ?? 'codex'; return json({ ok: true }) }
  if (path === '/test/proof') return json({ requests })
  if (path === '/api/harness-auth') return json({ harnesses })
  if (path === '/api/accounts') {
    if (!accounts) { response.statusCode = 404; return json({ error: 'NOT_FOUND' }) }
    const at = hours => new Date(Date.now() + hours * 3600_000).toISOString()
    const fable = hours => [{ scope: 'fable', since: at(-1), resetAt: at(hours), resetSource: 'message' }]
    return json({ rules: [], harnesses: [{ harness: 'claude', slots: [
      { slot: '1st', loggedIn: true, label: 'owner@example.com', history: 'shared', limits: fable(2), seats: ['bot-one'] },
      { slot: '2nd', loggedIn: true, label: 'second@example.com', history: 'shared', limits: accounts === 'both' ? fable(30) : [], seats: accounts === 'both' ? [] : ['bot-three'] },
    ], allLimited: accounts === 'both' ? [{ scope: 'fable', earliestResetAt: at(2) }] : [] }] })
  }
  if (path.startsWith('/api/harness-auth/')) {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = text ? JSON.parse(text) : null
    requests.push({ path, method: request.method, body })
    const harness = path.split('/')[3]
    if (request.method === 'GET' && (harness === failStatus || harness === unreadable)) {
      if (harness === failStatus) failStatus = null
      response.statusCode = 500
      return json({ error: 'AUTH_STATUS_FAILED', message: '試験の通信エラーです。状態を更新してください。' })
    }
    // Antigravityは認証済みなら何も変えず、未認証なら公式の認証を始める。
    if (path.endsWith('/start') && path.includes('/antigravity/') && harness !== blocked) return json({ harness, auth: auth(harness) })
    if (path.endsWith('/start')) { status = 'waiting'; blocked = null }
    if (path.endsWith('/input') && body?.text) status = 'authenticated'
    if (path.endsWith('/cancel')) { status = 'blocked'; return json({ harness: 'codex', auth: null }) }
    return json({ harness, auth: auth(harness) })
  }
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/subscription') return json({ subscription: { accessMode: 'developer', entitled: false, canUseAI: true } })
  response.statusCode = 404
  json({ error: 'NOT_FOUND' })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
