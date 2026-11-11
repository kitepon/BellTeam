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
// Claudeのslotごとの段階（Appleの認証の状態機械の撮影用）。null は従来の status に従う。
let claude = {}
const binding = { session_id: 'ui-session', launch_id: null, metadata_identity: 'metadata', native_id: 'native', pane_id: 'pane',
  server_pid: 101, server_started: '2026-11-11T11:00:00Z', pane_pid: 102, pane_started: '2026-11-11T11:00:01Z' }
const ui = (stage, extra = {}) => ({ schema: 'aiterm.auth-ui.v1', stage, binding: null, url: null, user_code: null, input: null,
  prompt_digest: null, choices: [], ...extra })
const claudeAuth = state => ({
  paste: { status: 'waiting', url: 'https://claude.ai/oauth/authorize', user_code: null, input_required: true, message: null, session_id: 'ui-session',
    auth_ui: ui('paste_code', { title: '認証コードを貼り付けてください', message: '公式サイトで承認すると表示されるコードを貼り付けます。', binding,
      url: 'https://claude.ai/oauth/authorize', input: 'authorization_code', prompt_digest: 'a'.repeat(64) }) },
  checking: { status: 'waiting', url: null, user_code: null, input_required: false, message: null, session_id: 'ui-session',
    auth_ui: ui('waiting', { title: '確認しています', message: '公式の応答を待っています。', binding }) },
  done: { status: 'authenticated', url: null, user_code: null, input_required: false, message: null, session_id: null,
    auth_ui: ui('complete', { title: 'ログイン状態を確認しました', message: '' }) },
  failed: { status: 'failed', url: null, user_code: null, input_required: false, session_id: null,
    message: '認証の状態を確かめられませんでした（通信できないか、認証の期限が切れています）。「認証し直す」で入り直せます。',
    auth_ui: ui('unavailable', { title: 'ログインの案内を取得できません', message: '認証の手順を確認できませんでした。' }) },
  blocked: { status: 'blocked', url: null, user_code: null, input_required: false, session_id: null,
    message: 'このAIは認証されていないか、認証の期限が切れています。「認証する」から公式サイトで認証してください。',
    auth_ui: ui('unavailable', { title: 'ログインの案内を取得できません', message: '認証の手順を確認できませんでした。' }) },
})[state]
let inputDelay = 0
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
    status = 'authenticated'; failStatus = null; requests = []; claude = {}; inputDelay = 0
    blocked = url.searchParams.get('blocked'); unreadable = url.searchParams.get('unreadable'); accounts = url.searchParams.get('accounts')
    return json({ ok: true })
  }
  // 一覧が全AIを読むので、失敗は対象のAIだけに当てる。
  if (path === '/test/fail-status') { failStatus = url.searchParams.get('harness') ?? 'codex'; return json({ ok: true }) }
  if (path === '/test/claude') {
    claude[url.searchParams.get('slot') ?? '1st'] = url.searchParams.get('state')
    inputDelay = Number(url.searchParams.get('delay') ?? inputDelay)
    return json({ ok: true })
  }
  if (path === '/test/proof') return json({ requests })
  if (path === '/api/harness-auth') return json({ harnesses })
  if (path === '/api/accounts') {
    if (!accounts) { response.statusCode = 404; return json({ error: 'NOT_FOUND' }) }
    const at = hours => new Date(Date.now() + hours * 3600_000).toISOString()
    const fable = hours => [{ scope: 'fable', since: at(-1), resetAt: at(hours), resetSource: 'message' }]
    return json({ rules: [], harnesses: [{ harness: 'claude', slots: [
      { slot: '1st', loggedIn: true, label: 'owner@example.com', history: 'shared', limits: fable(2), seats: ['bot-one'] },
      { slot: '2nd', loggedIn: accounts !== 'signedout', signedOutAt: accounts === 'signedout' ? at(-1) : null, label: 'second@example.com', history: 'shared', limits: accounts === 'both' ? fable(30) : [], seats: accounts === 'both' ? [] : ['bot-three'] },
    ], allLimited: accounts === 'both' ? [{ scope: 'fable', earliestResetAt: at(2) }] : [] }] })
  }
  if (path.startsWith('/api/harness-auth/')) {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = text ? JSON.parse(text) : null
    requests.push({ path, method: request.method, body })
    const harness = path.split('/')[3]
    const slot = url.searchParams.get('slot') ?? '1st'
    if (harness === 'claude' && claude[slot]) {
      if (path.endsWith('/start')) claude[slot] = 'paste'
      if (path.endsWith('/cancel')) { claude[slot] = 'blocked'; return json({ harness, slot, auth: null }) }
      if (path.endsWith('/input')) {
        await new Promise(resolve => setTimeout(resolve, inputDelay))
        claude[slot] = 'checking'
      }
      return json({ harness, slot, auth: claudeAuth(claude[slot]) })
    }
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
