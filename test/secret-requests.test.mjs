import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SecretRequests, secretCompletionMessage } from '../src/secret-requests.mjs'
import { Diagnostics } from '../src/diagnostics.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { callBellTeamTool } from '../src/mcp-tools.mjs'

async function fixture(t, notify) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-secrets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'テストBot' }], ['bot-b', { id: 'bot-b' }]])
  bots.refresh = async () => {}
  const rooms = new Map([['room-a', { id: 'room-a', memberIds: ['bot-a'] }]])
  rooms.refresh = async () => {}
  rooms.messages = async () => []
  const delivered = []
  const service = new SecretRequests({ root, bots, rooms, notify: notify ?? (item => { delivered.push(secretCompletionMessage(item)) }) })
  await service.initialize()
  return { root, bots, rooms, service, delivered }
}
const input = { botId: 'bot-a', toolId: 'example', label: '接続トークン', message: '接続のために入力してください。' }

test('秘密の値は保護されたファイルだけに保存され、状態・会話・通知・イベントには含まれない', async t => {
  const { service, root, delivered, bots, rooms } = await fixture(t)
  const events = []
  service.watch((...args) => events.push(args))
  const request = await service.create(input)
  const value = '  dummy-secret-\n日本語のパスワード  '
  const result = await service.submit(request.id, value)
  assert.equal(result.status, 'submitted')
  assert.equal(result.notification, 'sent')
  assert.equal(await readFile(result.path, 'utf8'), value)
  assert.equal((await stat(result.path)).mode & 0o777, 0o600)
  const visible = JSON.stringify([request, result, delivered, events, service.timeline({ botId: 'bot-a' })])
  assert.ok(!visible.includes('dummy-secret'))
  assert.ok(delivered[0].includes(result.path))
  for (const name of await readdir(join(root, 'state/secret-requests'))) {
    assert.ok(!(await readFile(join(root, 'state/secret-requests', name), 'utf8')).includes('dummy-secret'))
  }
  const restored = new SecretRequests({ root, bots, rooms, notify: () => {} })
  await restored.initialize()
  assert.deepEqual(restored.get(request.id), result)
  await assert.rejects(restored.submit(request.id, 'overwrite'), /SECRET_REQUEST_CLOSED/u)
  assert.equal(await readFile(result.path, 'utf8'), value)
})

test('取消・二重送信・ルームの対象・不正な入力を扱う', async t => {
  const { service, delivered } = await fixture(t)
  await assert.rejects(service.create({ ...input, toolId: '../../escape' }), /SECRET_REQUEST_INVALID/u)
  await assert.rejects(service.create({ ...input, roomId: 'room-a', botId: 'bot-b' }), /SECRET_ROOM_INVALID/u)
  const request = await service.create({ ...input, roomId: 'room-a' })
  assert.equal(service.timeline({ botId: 'bot-a' }).length, 0)
  assert.equal(service.timeline({ roomId: 'room-a' }).length, 1)
  const result = await service.cancel(request.id)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.path, undefined)
  assert.match(delivered[0], /room-a/u)
  const second = await service.create(input)
  await assert.rejects(service.submit(second.id, 'a'.repeat(16385)), /SECRET_VALUE_INVALID/u)
  const outcomes = await Promise.allSettled([service.submit(second.id, 'first'), service.submit(second.id, 'second')])
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /SECRET_REQUEST_CLOSED/u)
})

test('通知失敗を登録済みの状態とともに明示する', async t => {
  const { service } = await fixture(t, () => { throw new Error('通知不能') })
  const request = await service.create(input)
  const result = await service.submit(request.id, 'dummy')
  assert.equal(result.status, 'submitted')
  assert.equal(result.notification, 'failed')
})

test('MCPは呼び出しBotの入力依頼と状態取得だけを提供し、値を受け取らない', async t => {
  const { bots, service } = await fixture(t)
  const args = { ...input }; delete args.botId
  const result = await callBellTeamTool({ name: 'request_secret', arguments: args, from: 'bot-a', registry: bots,
    requestSecret: async value => ({ request: await service.create(value) }) })
  assert.equal(result.request.botId, 'bot-a')
  await assert.rejects(callBellTeamTool({ name: 'request_secret', arguments: { ...args, value: 'secret' }, from: 'bot-a', registry: bots }), /ARGUMENT/u)
  await assert.rejects(callBellTeamTool({ name: 'get_secret_request', arguments: { requestId: result.request.id }, from: 'bot-b', registry: bots,
    getSecretRequest: async id => ({ request: service.get(id) }) }), /SECRET_REQUEST_NOT_FOUND/u)
})

test('HTTP認証・HTTPS・専用入力経路・SSE・一覧・診断に秘密が漏れない', async t => {
  const { root, bots, rooms, service, delivered } = await fixture(t)
  const reports = []
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json'))
  await diagnostics.initialize()
  const options = { bots, rooms, secretRequests: service, store: { timeline: async () => [], watch: async () => () => {} }, transport: {},
    diagnostics: { record: async report => { reports.push(report); return diagnostics.record(report) } }, authorize: req => req.headers.authorization === 'Bearer test' }
  const publicServer = createBellTeamServer(options)
  const internalServer = createBellTeamServer({ ...options, internal: true })
  for (const server of [publicServer, internalServer]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(() => { server.closeAllConnections(); server.close() })
  }
  await publicServer.startMessageWatch()
  const base = `http://127.0.0.1:${publicServer.address().port}`
  const internal = `http://127.0.0.1:${internalServer.address().port}`
  const headers = { authorization: 'Bearer test', 'content-type': 'application/json', 'x-forwarded-proto': 'https' }
  const controller = new AbortController()
  t.after(() => controller.abort())
  const stream = await fetch(`${base}/api/events`, { headers, signal: controller.signal })
  const reader = stream.body.getReader()
  const ready = await reader.read()
  assert.match(new TextDecoder().decode(ready.value), /ready/u)
  const created = await fetch(`${internal}/api/secret-requests`, { method: 'POST', headers, body: JSON.stringify(input) })
  assert.equal(created.status, 201)
  const { request } = await created.json()
  const path = `/api/secret-requests/${request.id}/submit`
  const value = 'dummy-HTTP-secret'
  const body = JSON.stringify({ value })
  assert.equal((await fetch(`${base}${path}`, { method: 'POST', body })).status, 401)
  assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'x-forwarded-proto': 'http' }, body })).status, 426)
  assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body })).status, 400)
  assert.equal((await fetch(`${internal}${path}`, { method: 'POST', headers, body })).status, 405)
  const registered = await fetch(`${base}${path}`, { method: 'POST', headers, body })
  assert.equal(registered.status, 200)
  assert.ok(!(await registered.text()).includes(value))
  const timeline = await (await fetch(`${base}/api/bots/bot-a/messages`, { headers })).json()
  assert.equal(timeline.items[0].secret_request.status, 'submitted')
  assert.ok(!JSON.stringify(timeline).includes(value))
  const event = new TextDecoder().decode((await reader.read()).value)
  assert.match(event, /messages/u)
  assert.ok(!event.includes(value))
  controller.abort()
  assert.ok(!JSON.stringify([reports, delivered]).includes(value))
  const pending = await service.create(input)
  const submit = service.submit.bind(service)
  service.submit = async () => { throw new Error(value) }
  const failed = await fetch(`${base}/api/secret-requests/${pending.id}/submit`, { method: 'POST', headers, body })
  assert.equal(failed.status, 500)
  assert.ok(!(await failed.text()).includes(value))
  assert.equal(reports[0].code, 'SERVER_SECRET_FAILED')
  assert.ok(!JSON.stringify(reports).includes(value))
  assert.ok(!(await readFile(join(root, 'diagnostics.json'), 'utf8')).includes(value))
  service.submit = submit
})
