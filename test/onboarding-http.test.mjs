import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBellTeamServer } from '../src/http-server.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { bellTeamTools, callBellTeamTool } from '../src/mcp-tools.mjs'
import { isSupportedServerURL } from '../src/server-address.mjs'

async function listen(t, options) {
  const server = createBellTeamServer({ bots: new Map(), ...options })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

test('接続確認は未認証でも認証方式を返し、他のAPIは拒否する', async t => {
  const { base } = await listen(t, { authorize: () => false, authMode: () => 'cloudflare' })
  const response = await fetch(`${base}/api/session`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { authenticated: false, authMode: 'cloudflare' })
  assert.equal((await fetch(`${base}/api/settings`)).status, 401)
})

test('初期設定中は旧接続テストで案内会話を終えず、案内役を購入前に再起動できる', async t => {
  let restarted = null
  const guide = { id: 'bot-guide' }
  const bots = new Map([[guide.id, guide]])
  const { base } = await listen(t, { bots, authorize: () => true,
    subscriptions: {},
    onboarding: { snapshot: () => ({ complete: false }) },
    transport: { async restart(bot) { restarted = bot.id } },
  })
  assert.equal((await fetch(`${base}/api/subscription/setup-test`, { method: 'POST', body: '{}' })).status, 409)
  assert.equal((await fetch(`${base}/api/bots/${guide.id}/restart`, { method: 'POST' })).status, 202)
  assert.equal(restarted, guide.id)
})

test('初期設定のAPIは公式認証の進行を渡し、開始・完了で設定イベントを出す', async t => {
  const calls = [], events = []
  const onboarding = {
    async status() { return { phase: 'authenticate' } },
    async select(harness) { calls.push(['select', harness]); return { phase: 'authenticate' } },
    async input(input) { calls.push(['input', input]); return { phase: 'authenticate' } },
    async start() { calls.push(['start']); return { phase: 'ready' } },
    async complete(botId) { calls.push(['complete', botId]); return { phase: 'ready', complete: true } },
  }
  const { base, server } = await listen(t, { authorize: () => true, onboarding, internal: true })
  server.notify = event => events.push(event)
  for (const [path, body] of [['harness', { harness: 'codex' }], ['auth/input', { text: '利用者の入力' }], ['start', {}], ['complete', { botId: 'bot-guide' }]]) {
    const response = await fetch(`${base}/api/setup/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
  }
  assert.deepEqual(calls, [['select', 'codex'], ['input', { text: '利用者の入力' }], ['start'], ['complete', 'bot-guide']])
  assert.equal(events.length, 4)
  assert.ok(events.every(event => event.type === 'setup'))
})

test('MCPの設定APIは自分の秘密入力依頼だけを受け取り、生値を返さない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-settings-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'submitted-secret')
  await writeFile(path, 'test-secret')
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const secretRequests = { get() { return { botId: 'bot-guide', toolId: 'bellteam-settings', status: 'submitted', path } } }
  const { base } = await listen(t, { authorize: () => true, settings, secretRequests, internal: true })
  const patch = body => fetch(`${base}/api/settings/routing`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await patch({ botId: 'bot-guide', enabled: true, values: { apiKey: '入力禁止' } })).status, 400)
  assert.equal((await patch({ botId: 'bot-other', enabled: true, secretRequestId: 'request' })).status, 400)
  const response = await patch({ botId: 'bot-guide', enabled: true, secretRequestId: 'request' })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.doesNotMatch(text, /test-secret/u)
  assert.equal(JSON.parse(text).setting.fields[0].configured, true)
  assert.equal(settings.configuration('routing').apiKey, 'test-secret')
})

test('設定MCPは呼出し元を維持し、秘密の生値をschemaへ出さない', async () => {
  const calls = []
  const registry = new Map([['bot-guide', { id: 'bot-guide' }]])
  registry.refresh = async () => {}
  await callBellTeamTool({ name: 'update_settings', arguments: { featureId: 'routing', enabled: true, secretRequestId: 'r' }, from: 'bot-guide', registry,
    updateSettings: (id, input) => calls.push([id, input]) })
  await callBellTeamTool({ name: 'complete_setup', from: 'bot-guide', registry, completeSetup: input => calls.push(input) })
  assert.deepEqual(calls, [['routing', { enabled: true, secretRequestId: 'r', botId: 'bot-guide' }], { botId: 'bot-guide' }])
  const values = bellTeamTools.find(tool => tool.name === 'update_settings').inputSchema.properties.values.properties
  assert.equal('apiKey' in values, false)
  assert.equal('token' in values, false)
})

test('直接接続のHTTPはLANとloopbackを使い、外部URLはHTTPSにする', () => {
  for (const url of ['http://localhost:18891', 'http://127.0.0.1:18891', 'http://192.168.1.2:18891', 'http://172.16.0.2:18891', 'http://server.local:18891', 'http://server:18891', 'http://[::1]:18891', 'https://example.com'])
    assert.equal(isSupportedServerURL(url), true, url)
  for (const url of ['http://example.com', 'http://172.32.0.2', 'http://user:pass@192.168.1.2', 'https://example.com/path', 'ftp://192.168.1.2', 'invalid'])
    assert.equal(isSupportedServerURL(url), false, url)
})
