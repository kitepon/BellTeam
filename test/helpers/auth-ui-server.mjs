// Apple画面の型付き認証案内を確認する人工API。公式CLIと資格情報は使わない。
import { createServer } from 'node:http'
import { isDeepStrictEqual } from 'node:util'

const harnesses = ['claude', 'codex', 'grok', 'cursor'].map(id => ({ id, name: id, members: 1, startWarning: null }))
const binding = id => ({ session_id: `test-${id}`, launch_id: null, metadata_identity: `test-meta-${id}`,
  native_id: `test-native-${id}`, pane_id: `test-pane-${id}`, server_pid: 101, server_started: '2026-10-25T00:00:00Z',
  pane_pid: 102, pane_started: '2026-10-25T00:00:01Z' })
const digest = id => String(Object.keys(stages).indexOf(id) + 1).repeat(64)
const stages = {
  claude: { stage: 'open_url', title: 'Claudeの公式サイトを開く', message: 'ブラウザーで認証を完了してください。',
    url: 'https://example.test/claude', user_code: null, input: null, choices: [] },
  codex: { stage: 'device_code', title: 'Codexの公式サイトを開く', message: '表示された利用者コードを公式サイトへ入力してください。',
    url: 'https://example.test/codex', user_code: 'TEST-CODE', input: null, choices: [] },
  grok: { stage: 'select', title: 'Grokの認証方法', message: '表示された方法を選んでください。',
    url: null, user_code: null, input: 'choice', choices: [
      { id: 'option-1', label: 'ブラウザーで続ける' }, { id: 'option-2', label: 'コードで続ける' },
    ] },
  cursor: { stage: 'paste_code', title: 'Cursorの認証コード', message: '公式サイトで表示されたコードを貼り付けてください。',
    url: 'https://example.test/cursor', user_code: null, input: 'authorization_code', choices: [] },
}
const state = new Map()
let writes = []
let setupStatus = 'waiting', setupWrites = [], setupReads = 0, holdNextSetup = false, heldSetup = [], setupUnknown = false
let holdNextHarness = null, heldHarness = [], harnessReads = 0
const initial = () => {
  state.clear(); for (const id of Object.keys(stages)) state.set(id, { status: 'blocked', ui: stages[id] })
  writes = []; setupStatus = 'waiting'; setupWrites = []; setupReads = 0
  holdNextSetup = false; heldSetup = []; setupUnknown = false
  holdNextHarness = null; heldHarness = []; harnessReads = 0
}
initial()
const auth = id => {
  const current = state.get(id)
  return { status: current.status, url: null, user_code: null, input_required: true,
    message: '従来の入力フラグだけで入力欄を出さない。', auth_ui: {
      schema: 'aiterm.auth-ui.v1', ...current.ui, binding: current.status === 'authenticated' ? null : binding(id),
      prompt_digest: current.status === 'authenticated' ? null : digest(id),
    } }
}
const setup = () => {
  const current = auth('cursor')
  current.status = setupStatus
  if (setupStatus === 'authenticated') current.auth_ui = { schema: 'aiterm.auth-ui.v1', stage: 'complete',
    title: '認証が完了しました', message: '確認済みです。', binding: null, url: null, user_code: null,
    input: null, choices: [], prompt_digest: null }
  return { phase: 'authenticate', harness: 'cursor', harnesses: [{ id: 'cursor', name: 'Cursor' }],
    guideBotId: null, complete: false, auth: current }
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  const json = (value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  if (path === '/test/reset') {
    for (const held of heldSetup) {
      held.response.writeHead(503, { 'content-type': 'application/json' })
      held.response.end(JSON.stringify({ error: 'FIXTURE_RESET' }))
    }
    for (const held of heldHarness) {
      held.response.writeHead(503, { 'content-type': 'application/json' })
      held.response.end(JSON.stringify({ error: 'FIXTURE_RESET' }))
    }
    initial(); return json({ ok: true })
  }
  if (path === '/test/proof') return json({ writes, setupWrites, setupReads, heldSetupReads: heldSetup.length,
    harnessReads, heldHarnessReads: heldHarness.length })
  if (path === '/test/setup/hold') { holdNextSetup = true; return json({ ok: true }) }
  if (path === '/test/setup/set-complete') { setupStatus = 'authenticated'; return json({ ok: true }) }
  if (path === '/test/setup/release' || path === '/test/setup/release-error') {
    const failed = path.endsWith('release-error')
    for (const held of heldSetup) {
      held.response.writeHead(failed ? 503 : 200, { 'content-type': 'application/json' })
      held.response.end(JSON.stringify(failed ? { error: 'OLD_READ' } : held.snapshot))
    }
    const count = heldSetup.length; heldSetup = []
    return json({ count })
  }
  if (path === '/test/setup/next-unknown') { setupUnknown = true; return json({ ok: true }) }
  const harnessControl = path.match(/^\/test\/harness\/(hold|set-complete|release|release-error)\/(claude|codex|grok|cursor)$/u)
  if (harnessControl) {
    const [, action, id] = harnessControl
    if (action === 'hold') { holdNextHarness = id; return json({ ok: true }) }
    if (action === 'set-complete') {
      state.set(id, { status: 'authenticated', ui: { stage: 'complete', title: '認証が完了しました',
        message: '確認済みです。', url: null, user_code: null, input: null, choices: [] } })
      return json({ ok: true })
    }
    const failed = action === 'release-error'
    const released = heldHarness.filter(held => held.id === id)
    heldHarness = heldHarness.filter(held => held.id !== id)
    for (const held of released) {
      held.response.writeHead(failed ? 503 : 200, { 'content-type': 'application/json' })
      held.response.end(JSON.stringify(failed ? { error: 'OLD_READ' } : held.snapshot))
    }
    return json({ count: released.length })
  }
  if (path === '/api/setup' && request.method === 'GET') {
    setupReads += 1
    if (holdNextSetup) { holdNextSetup = false; heldSetup.push({ response, snapshot: setup() }); return }
    return json(setup())
  }
  if (path === '/api/setup/auth/input' && request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    setupWrites.push(body)
    if (!isDeepStrictEqual(body.binding, binding('cursor')) || body.prompt_digest !== digest('cursor')
      || body.response?.kind !== 'authorization_code') return json({ error: 'INVALID_RESPONSE' }, 409)
    setupStatus = 'authenticated'
    if (setupUnknown) { setupUnknown = false; return json({ error: 'AUTH_RESPONSE_UNCONFIRMED', message: '認証結果を確認できませんでした。状態を更新してください。' }, 502) }
    return json(setup())
  }
  if (path === '/api/harness-auth') return json({ harnesses })
  const match = path.match(/^\/api\/harness-auth\/(claude|codex|grok|cursor)(?:\/(input))?$/u)
  if (!match) return json({ error: 'NOT_FOUND' }, 404)
  const [, id, action] = match
  if (request.method === 'GET' && !action) {
    harnessReads += 1
    if (holdNextHarness === id) {
      holdNextHarness = null
      heldHarness.push({ id, response, snapshot: { harness: id, auth: auth(id) } })
      return
    }
    return json({ harness: id, auth: auth(id) })
  }
  if (request.method !== 'POST' || action !== 'input') return json({ error: 'NOT_FOUND' }, 404)
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  writes.push({ id, body })
  if (!isDeepStrictEqual(body.binding, binding(id)) || body.prompt_digest !== digest(id)) {
    return json({ error: 'STALE_PROMPT' }, 409)
  }
  if (id === 'grok' && body.response?.kind === 'choice' && body.response.id === 'option-2') {
    state.set(id, { status: 'blocked', ui: { ...stages.cursor, title: 'Grokの認証コード' } })
  } else if (id === 'cursor' && body.response?.kind === 'authorization_code' && body.response.value === 'TEST-RESPONSE') {
    state.set(id, { status: 'authenticated', ui: { stage: 'complete', title: '認証が完了しました', message: '確認済みです。',
      url: null, user_code: null, input: null, choices: [] } })
  } else return json({ error: 'INVALID_RESPONSE' }, 400)
  return json({ harness: id, auth: auth(id) })
})
// 実機から届くよう、AUTH_UI_FIXTURE_HOSTにMacのLANアドレスを渡せる。既定はこのMacの中だけ。
const host = process.env.AUTH_UI_FIXTURE_HOST ?? '127.0.0.1'
server.listen(0, host, () => console.log(JSON.stringify({ url: `http://${host}:${server.address().port}` })))
