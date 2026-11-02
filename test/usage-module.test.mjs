import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerQuestions } from '../src/owner-questions.mjs'
import { SecretRequests } from '../src/secret-requests.mjs'
import { respondHttpError } from '../src/http-errors.mjs'
import { createUsageApi } from '../src/usage/http-api.mjs'
import { createApplicationFeatures } from '../src/usage/application-features.mjs'
import { usageToolHandlers, usageTools } from '../src/usage/mcp-tools.mjs'

async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-module-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a' }]])
  const rejected = Object.assign(new Error('synthetic delivery failure'), {
    code: 'BOT_SESSION_UNCONFIRMED', status: 503, publicMessage: '会話の受付は未確認です。',
  })
  const notify = async () => { throw rejected }
  const secretRequests = new SecretRequests({ root, bots, rooms: new Map(), notify })
  const ownerQuestions = new OwnerQuestions({ root, bots, notify })
  const settings = new FeatureSettings({ root, environment: {} })
  for (const service of [secretRequests, ownerQuestions, settings]) await service.initialize()
  const api = createUsageApi({ secretRequests, ownerQuestions, settings, bots, authMode: () => 'local', ...options })
  const server = createServer(async (request, response) => {
    try {
      if (await api(request, response, new URL(request.url, 'http://localhost')) === false) {
        response.writeHead(404); response.end('unmatched')
      }
    } catch (error) { await respondHttpError(request, response, error) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, body, method = 'POST') => fetch(base + path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { root, bots, secretRequests, ownerQuestions, settings, base, call }
}

test('独立したusageの公開HTTPは秘密の保存成功と通知失敗、質問の回答保存と公開例外を保つ', async t => {
  const { root, secretRequests, ownerQuestions, base, call } = await fixture(t)
  const pending = await secretRequests.create({ botId: 'bot-a', toolId: 'synthetic', label: '鍵', message: '入力してください' })
  const submitted = await call(`/api/secret-requests/${pending.id}/submit`, { value: 'synthetic-only-secret' })
  assert.equal(submitted.status, 200)
  const { request } = await submitted.json()
  assert.equal(request.status, 'submitted')
  assert.equal(request.notification, 'failed')
  assert.equal(await readFile(request.path, 'utf8'), 'synthetic-only-secret')
  assert.doesNotMatch(JSON.stringify(request), /synthetic-only-secret/u)
  assert.equal(JSON.parse(await readFile(join(root, 'state/secret-requests', `${pending.id}.json`))).notification, 'failed')

  const question = await ownerQuestions.create({ botId: 'bot-a', question: 'どうしますか？', options: ['進める', '待つ'] })
  const answered = await call(`/api/owner-questions/${question.id}/answer`, { choice: '進める' })
  assert.equal(answered.status, 503)
  assert.deepEqual(await answered.json(), { error: 'BOT_SESSION_UNCONFIRMED', message: '会話の受付は未確認です。' })
  const saved = await (await fetch(`${base}/api/owner-questions/${question.id}`)).json()
  assert.equal(saved.question.status, 'answered')
  assert.equal(saved.question.answer, '進める')
  assert.equal(JSON.parse(await readFile(join(root, 'state/owner-questions', `${question.id}.json`))).status, 'answered')
  const repeated = await call(`/api/owner-questions/${question.id}/answer`, { choice: '進める' })
  assert.equal(repeated.status, 409)
  assert.deepEqual(await repeated.json(), { error: 'OWNER_QUESTION_CLOSED' })
  assert.equal((await fetch(base + '/api/unknown')).status, 404)
})

test('独立したusageの設定適用失敗は保存値と公開エラー・変更通知を保持する', async t => {
  const { root, bots, settings, base, call } = await fixture(t)
  let rejectConfiguration = false
  const changes = []
  const features = createApplicationFeatures({ services: { bots, settings, messenger: {}, transport: {},
    diagnostics: { async record() {} }, notifications: { async configure() {
      if (rejectConfiguration) throw new Error('synthetic provider failure')
    } } }, home: join(root, 'home'), callBridgeHeaders: join(root, 'headers'),
    environment: {}, configureHarnessConfig: async () => {}, notify: event => changes.push(event),
  })
  t.after(() => features.close())
  await features.initialize()
  rejectConfiguration = true
  const failed = await call('/api/settings/notifications', { enabled: false, values: { relayUrl: 'https://example.com' } }, 'PATCH')
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).error, 'FEATURE_APPLY_FAILED')
  assert.equal(settings.configuration('notifications').relayUrl, 'https://example.com')
  const restored = new FeatureSettings({ root, environment: {} })
  await restored.initialize()
  assert.equal(restored.configuration('notifications').relayUrl, 'https://example.com')
  const current = (await (await fetch(base + '/api/settings')).json()).settings.find(item => item.id === 'notifications')
  assert.equal(current.error.code, 'FEATURE_APPLY_FAILED')
  assert.deepEqual(changes, [{ type: 'settings', featureId: 'notifications' }])
})

test('usageのMCP公開登録は説明/schemaと全7handlerを持ち、Bot本人の入力と結果を保持する', async () => {
  const tools = usageTools((properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false }))
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(usageToolHandlers).sort())
  const calls = []
  const context = {
    from: 'bot-a', args: {},
    getSettings: () => ({ settings: [] }),
    updateSettings: (id, input) => { calls.push([id, input]) },
    completeSetup: input => { calls.push(['complete', input]) },
    requestSecret: input => { calls.push(['secret', input]) },
    askOwner: input => { calls.push(['question', input]) },
    getSecretRequest: async id => ({ request: { id, botId: 'bot-a', status: 'pending' } }),
    cancelSecretRequest: (id, from) => { calls.push(['cancel', id, from]) },
  }
  assert.deepEqual(usageToolHandlers.get_settings(context), { settings: [] })
  usageToolHandlers.update_settings({ ...context, args: { featureId: 'routing', enabled: false } })
  usageToolHandlers.complete_setup(context)
  usageToolHandlers.request_secret({ ...context, args: { toolId: 'synthetic', botId: 'forged' } })
  usageToolHandlers.ask_owner({ ...context, args: { question: 'q', botId: 'forged' } })
  usageToolHandlers.cancel_secret_request({ ...context, args: { requestId: 'r' } })
  assert.deepEqual(calls, [
    ['routing', { enabled: false, botId: 'bot-a' }], ['complete', { botId: 'bot-a' }],
    ['secret', { toolId: 'synthetic', botId: 'bot-a' }], ['question', { question: 'q', botId: 'bot-a' }],
    ['cancel', 'r', 'bot-a'],
  ])
  const own = await usageToolHandlers.get_secret_request({ ...context, args: { requestId: 'r' } })
  assert.equal(own.request.id, 'r')
  await assert.rejects(usageToolHandlers.get_secret_request({ ...context, from: 'bot-b', args: { requestId: 'r' } }), /SECRET_REQUEST_NOT_FOUND/u)
})
