import assert from 'node:assert/strict'
import test from 'node:test'
import { authUi, authResponse } from '../src/auth-ui.mjs'
import { renderAuthFlow } from '../web/auth-flow.js'
import { HarnessAuth } from '../src/harness-auth.mjs'

const binding = { session_id: 'auth-owned', launch_id: null, metadata_identity: 'dev:ino:birth:mtime', native_id: 'tmux-session', pane_id: '%1', server_pid: 100, server_started: '100-start', pane_pid: 101, pane_started: '101-start' }
const ui = (stage, extra = {}) => ({ schema: 'aiterm.auth-ui.v1', binding, url: 'https://claude.com/cai/oauth/authorize?code=true', user_code: null, input: null, prompt_digest: 'a'.repeat(64), choices: [], stage, title: '公式ログイン', message: '表示された手順で認証してください。', ...extra })
const receipt = value => ({ schema: 'aiterm.agent-auth-result.v1', status: 'blocked', session_id: binding.session_id,
  input_required: true, ...value })

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.events = {}; this.value = '' }
  append(...children) { this.children.push(...children) }
  setAttribute(key, value) { this[key] = value }
  addEventListener(key, fn) { this.events[key] = fn }
  all() { return [this, ...this.children.flatMap(child => child.all())] }
}

test('missing native UI and bare input_required cannot become a code field or terminal buttons', () => {
  const value = authUi(receipt(), binding.session_id)
  assert.equal(value.stage, 'unavailable'); assert.equal(value.binding, null)
  assert.throws(() => authResponse({ text: 'not-a-verified-code' }, binding.session_id, value), /AUTH_RESPONSE_INVALID/)
  const document = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) }
  try {
    const flow = renderAuthFlow({ status: 'blocked', input_required: true }, { name: 'Claude', respond() {} })
    const elements = flow.elements.flatMap(node => node.all())
    assert.equal(flow.password, undefined); assert.ok(elements.some(node => node.textContent.includes('案内を取得できません')))
    assert.equal(elements.some(node => ['Enter', 'Up', 'Down', 'Tab'].includes(node.textContent)), false)
  } finally { globalThis.document = document }
})

test('native URL/code/choice stages require their own binding and actionable fields', () => {
  for (const value of [ui('open_url', { url: null }), ui('device_code', { url: 'https://auth.example.invalid/device' }),
    ui('paste_code'), ui('paste_code', { input: 'authorization_code', url: null }), ui('select', { choices: [] }), ui('open_url', { url: 'javascript:alert(1)' }),
    ui('waiting', { binding: { ...binding, session_id: 'other' } })]) {
    assert.equal(authUi(receipt({ auth_ui: value }), binding.session_id).stage, 'unavailable')
  }
  const good = ui('paste_code', { input: 'authorization_code' })
  assert.deepEqual(authUi(receipt({ auth_ui: good }), binding.session_id), good)
})

test('four harness presentations expose meaningful official actions and only the required input', () => {
  const document = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) }
  try {
    for (const [name, value] of [
      ['Claude', ui('paste_code', { url: 'https://claude.com/cai/oauth/authorize?code=true', input: 'authorization_code' })],
      ['Codex', ui('device_code', { url: 'https://auth.openai.com/codex/device', user_code: 'TEST-CODE' })],
      ['Grok', ui('device_code', { url: 'https://auth.example.invalid/grok/device', user_code: 'TEST-GROK' })],
      ['Cursor', ui('open_url', { url: 'https://cursor.com/login' })],
    ]) {
      const replies = [], flow = renderAuthFlow({ auth_ui: value }, { name, respond: async input => replies.push(input) })
      const nodes = flow.elements.flatMap(node => node.all())
      assert.equal(nodes.find(node => node.tag === 'a').textContent, `${name}のログイン画面を開く`)
      assert.equal(nodes.some(node => ['Enter', 'Up', 'Down', 'Tab'].includes(node.textContent)), false)
      assert.equal(!!flow.password, name === 'Claude')
      if (flow.password) {
        flow.password.value = 'synthetic-one-use-code'; flow.password.events.input()
        nodes.find(node => node.tag === 'button').events.click()
        assert.equal(flow.password.value, '')
        assert.deepEqual(replies, [{ binding, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-one-use-code' } }])
      }
    }
    const replies = [], flow = renderAuthFlow({ auth_ui: ui('select', { title: 'ログイン方法を選んでください', choices: [{ id: 'option-1', label: 'ブラウザでログイン' }] }) },
      { name: 'Claude', respond: input => replies.push(input) })
    const button = flow.elements.flatMap(node => node.all()).find(node => node.tag === 'button')
    assert.equal(button.textContent, 'ブラウザでログイン'); button.events.click()
    assert.deepEqual(replies, [{ binding, prompt_digest: 'a'.repeat(64), response: { kind: 'choice', id: 'option-1' } }])
  } finally { globalThis.document = document }
})

test('code/choice responses reject stale generation, wrong phase and arbitrary key input', () => {
  const code = ui('paste_code', { input: 'authorization_code' })
  for (const input of [{ key: 'Enter' }, { binding: { ...binding, launch_id: 'b'.repeat(32) }, response: { kind: 'authorization_code', value: 'synthetic' } },
    { binding, prompt_digest: 'a'.repeat(64), response: { kind: 'choice', id: 'option-1' } }]) {
    assert.throws(() => authResponse(input, binding.session_id, code), /AUTH_RESPONSE_INVALID/)
  }
})

test('relogin uses native respond once, with no generic pty send/key or input value in public errors', async () => {
  const calls = [], code = ui('paste_code', { input: 'authorization_code' })
  let fail = false
  const client = { async call(name, args) {
    calls.push({ name, args })
    if (args.action === 'respond' && fail) throw new Error('synthetic-one-use-code')
    return { structuredContent: receipt({ auth_ui: code }) }
  } }
  const auth = new HarnessAuth({ bots: new Map([['a', { harness: 'claude', project: '/synthetic' }]]), client })
  await auth.start('claude')
  await auth.input('claude', { binding, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-one-use-code' } })
  assert.equal(calls.filter(call => call.args.action === 'respond').length, 1)
  assert.ok(calls.every(call => call.name === 'agent_auth'))
  assert.deepEqual(calls.at(-1).args.expected_binding, binding)
  assert.equal(calls.at(-1).args.expected_prompt_digest, 'a'.repeat(64))
  fail = true
  await assert.rejects(auth.input('claude', { binding, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-one-use-code' } }), error => {
    assert.equal(error.code, 'HARNESS_AUTH_RESPONSE_UNCONFIRMED')
    assert.equal(error.message.includes('synthetic-one-use-code'), false)
    return true
  })
  assert.equal(calls.filter(call => call.args.action === 'respond').length, 2)
})

test('typed MCP refusal and unknown survive HTTP without exposing input or returning success', async t => {
  const { AitermClient } = await import('../src/aiterm-client.mjs')
  const { createBellTeamServer } = await import('../src/http-server.mjs')
  const { once } = await import('node:events')
  for (const effect of ['not_issued', 'unknown']) {
    const bridge = new AitermClient(), calls = []
    bridge.client = { async callTool({ name, arguments: args }) {
      calls.push({ name, action: args.action })
      if (args.action === 'respond') return { isError: true, content: [], structuredContent: {
        schema: 'aiterm.auth-response-error.v1', harness: 'claude-code', session_id: binding.session_id,
        code: 'AUTH_STAGE_CHANGED', effect, message: 'native synthetic-one-use-code',
      } }
      return { structuredContent: receipt({ auth_ui: ui('paste_code', { input: 'authorization_code' }) }) }
    } }
    const client = { call: (name, args) => bridge.call(name, args) }
    const bots = new Map([['test', { harness: 'claude', project: '/synthetic' }]])
    const log = [], diagnostics = []
    const server = createBellTeamServer({ bots, harnessAuth: new HarnessAuth({ bots, client }), authorize: () => true,
      diagnostics: { record: value => diagnostics.push(value) }, writeLog: line => log.push(line) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/harness-auth/claude`
      assert.equal((await fetch(base + '/start', { method: 'POST' })).status, 200)
      const response = await fetch(base + '/input', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ binding, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-one-use-code' } }) })
      assert.equal(response.status, effect === 'not_issued' ? 409 : 502)
      const result = await response.json(); assert.equal(result.effect, effect)
      assert.equal(JSON.stringify(result).includes('synthetic-one-use-code'), false)
      assert.equal(log.join('').includes('synthetic-one-use-code'), false)
      assert.deepEqual(diagnostics, []); assert.equal(calls.filter(call => call.action === 'respond').length, 1)
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
})
