// Apple初期設定のAntigravity認証画面試験用。公式CLIと資格情報には接続しない。
import { createServer } from 'node:http'
import { isDeepStrictEqual } from 'node:util'

const binding = {
  session_id: 'synthetic-antigravity', launch_id: null, metadata_identity: 'synthetic-metadata',
  native_id: 'synthetic-native', pane_id: 'synthetic-pane', server_pid: 101,
  server_started: '2026-10-30T00:00:00Z', pane_pid: 102, pane_started: '2026-10-30T00:00:01Z',
}
const digest = 'a'.repeat(64)
const harnesses = [{ id: 'antigravity', name: 'Antigravity' }]
let selected = false
let stage = 'device_code'
let inputs = []

const auth = () => {
  if (!selected) return null
  const complete = stage === 'complete'
  return {
    status: complete ? 'authenticated' : 'waiting', url: null, user_code: null,
    input_required: stage === 'paste_code', message: null,
    auth_ui: {
      schema: 'aiterm.auth-ui.v1', stage,
      title: complete ? '認証が完了しました' : stage === 'device_code' ? 'Antigravityの公式サイトを開く' : 'Antigravityの認証コード',
      message: complete ? '確認済みです。' : '公式サイトに表示された手順を進めてください。',
      binding: complete ? null : binding,
      url: complete ? null : 'https://example.test/antigravity',
      user_code: stage === 'device_code' ? 'AG-TEST-42' : null,
      input: stage === 'paste_code' ? 'authorization_code' : null,
      prompt_digest: complete ? null : digest,
      choices: [],
    },
  }
}
const setup = () => ({
  phase: selected ? 'authenticate' : 'select_harness', harness: selected ? 'antigravity' : null,
  harnesses, guideBotId: null, complete: false, auth: auth(),
})
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  const json = (value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  if (path === '/test/reset') { selected = false; stage = 'device_code'; inputs = []; return json({ ok: true }) }
  if (path === '/test/paste-code') { stage = 'paste_code'; return json({ ok: true }) }
  if (path === '/test/proof') return json({ inputs })
  if (path === '/api/session') return json({ authenticated: true, authMode: 'local' })
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/setup' && request.method === 'GET') return json(setup())
  if (path === '/api/setup/harness' && request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk
    if (JSON.parse(raw).harness !== 'antigravity') return json({ error: 'INVALID_HARNESS' }, 400)
    selected = true
    return json(setup())
  }
  if (path === '/api/setup/auth/input' && request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    inputs.push(body)
    if (stage !== 'paste_code' || body.prompt_digest !== digest
      || !isDeepStrictEqual(body.binding, binding)
      || body.response?.kind !== 'authorization_code' || body.response.value !== 'SYNTHETIC-CODE')
      return json({ error: 'INVALID_RESPONSE' }, 409)
    stage = 'complete'
    return json(setup())
  }
  return json({ error: 'NOT_FOUND' }, 404)
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
