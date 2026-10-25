import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Diagnostics } from '../../src/diagnostics.mjs'
import { createBellTeamServer } from '../../src/http-server.mjs'

// 本番と同じ受け口・表を、試験専用のデータへつなぐ。通信先はloopbackだけ。
const root = resolve(`runtime/network-reporting-46/bughub-three-${process.pid}`)
await mkdir(root, { recursive: true })
let mode = 'normal', sequence = 0, requests = [], diagnostics, intake, settingsReads = 0
let stopScenario = false, stopAccepted = false
let pendingPost = null, sentMessages = []
let subscribers = []
let saved = { name: 'ユキ', profileText: '', personality: '', speechStyle: '', position: '', role: '相談と実務', avatar: '', color: 'indigo', harness: 'claude', model: 'opus', reasoningEffort: 'high' }
async function reset(next) {
  if (pendingPost) {
    if (!pendingPost.response.destroyed) { pendingPost.response.writeHead(503); pendingPost.response.end() }
    pendingPost = null
  }
  mode = next; requests = []; settingsReads = 0; sentMessages = []
  stopScenario = next === 'stop-http-502'; stopAccepted = false
  diagnostics = new Diagnostics(`${root}/scenario-${++sequence}.json`)
  await diagnostics.initialize()
  intake = createBellTeamServer({ authorize: async () => true, bots: { refresh: async () => {} }, diagnostics })
}
await reset('normal')
const bot = () => ({ id: 'bot-one', ...saved, displayName: saved.name, fastMode: false, online: true, recent: null })
const owner = { name: '試験用', profile: '', avatar: '', xUrl: '', githubUrl: '', links: [] }
const subscription = { productId: 'dev.kitepon.bellbot.monthly', environment: 'Sandbox', accessMode: 'developer', setupComplete: true, entitled: false, state: 'none', checkedAt: null, expiresAt: null, validUntil: null, autoRenewing: false, error: null }
const setting = { id: 'routing', title: '試験機能', enabled: true, status: 'enabled', error: null, fields: [{ key: 'label', label: '試験の値', secret: false, value: '保持する値', configured: true }] }
const message = { id: 'probe-message', kind: 'message', direction: 'incoming', at: '2026-10-07T00:00:00Z', message: '試験用の会話', delivery: 'delivered' }
const longMessage = { ...message, at: '2026-10-07T01:00:00Z', message: Array.from({ length: 6 }, (_, index) =>
  `${index + 1}段目。画面の高さを越える直前の返信です。配布候補の確認を続け、処理待ちと次の作業時刻を読み合わせます。`).join('\n\n') }
const priorMessages = Array.from({ length: 35 }, (_, index) => ({
  id: `prior-${index}`, kind: 'message', direction: index % 2 ? 'outgoing' : 'incoming',
  at: new Date(Date.UTC(2026, 9, 7, 0, index)).toISOString(),
  message: `先行する会話 ${index + 1}`, delivery: 'delivered',
}))
const json = (response, value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/test/reset') { await reset(url.searchParams.get('mode') ?? 'normal'); return json(response, { ok: true }) }
  if (url.pathname === '/test/mode') { mode = url.searchParams.get('mode') ?? 'normal'; return json(response, { ok: true }) }
  if (url.pathname === '/test/proof') return json(response, { requests, reports: diagnostics.list(), subscribers: subscribers.length })
  if (url.pathname === '/test/complete-post') {
    if (!pendingPost) { response.writeHead(409); response.end(); return }
    const waiting = pendingPost
    pendingPost = null
    json(waiting.response, { delivery_id: 'accepted-message', delivery: 'running', from: 'user', target: 'bot-one' })
    return json(response, { ok: true })
  }
  if (url.pathname === '/api/diagnostics') { intake.emit('request', request, response); return }
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(': open\n\n')
    subscribers.push(response)
    request.on('close', () => { subscribers = subscribers.filter(item => item !== response) })
    return
  }
  const record = { method: request.method, path: url.pathname, at: Date.now(), closed: false }
  requests.push(record); response.once('close', () => { record.closed = true })
  if (request.method === 'POST' && url.pathname.endsWith('/messages')) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    record.imageCount = body.images?.length ?? 0
    if (mode === 'post-failure') { request.socket.destroy(); return }
    if (mode === 'post-http-503') {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'TEST_HTTP_503' }))
      return
    }
    if (mode === 'post-http-500') {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'TEST_HTTP_500' }))
      return
    }
    if (['post-wait', 'post-wait-long', 'post-wait-history'].includes(mode)) {
      pendingPost = { response }
      sentMessages.push({ id: 'accepted-message', kind: 'message', direction: 'outgoing',
        sender: { id: 'user', name: '試験用' }, at: new Date().toISOString(),
        message: body.message, delivery: 'running' })
      const event = { type: 'messages', at: new Date().toISOString(), all: false,
        topics: ['timeline'], botIds: ['bot-one'], roomIds: [] }
      for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(event)}\n\n`)
      return
    }
    return json(response, { delivery_id: 'accepted-message', delivery: 'running', from: 'user', target: 'bot-one' })
  }
  if (request.method === 'POST' && url.pathname === '/api/bots/bot-one/stop') {
    if (mode === 'stop-http-502') {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'TEST_HTTP_502' }))
      return
    }
    stopAccepted = true
    response.writeHead(202, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ bot_id: 'bot-one', status: 'stop_sent' }))
    return
  }
  if (request.method === 'PATCH' && url.pathname === '/api/bots/bot-one') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    saved = JSON.parse(Buffer.concat(chunks).toString())
    if (mode === 'save-confirmed') { request.socket.destroy(); return }
    return json(response, {})
  }
  if (request.method === 'PATCH' && url.pathname === '/api/settings/routing') {
    for await (const _ of request) { }
    return json(response, { setting })
  }
  if (url.pathname.endsWith('/schedules')) {
    if (mode === 'schedule-pending') return
    if (mode === 'schedule-known' && url.pathname === '/api/bots/bot-one/schedules') {
      return json(response, { schedules: [{ id: 'fixture-one', name: '隔離予定', kind: 'command', command: 'noop', enabled: true, nextRunAt: '2026-10-16T09:00:00Z' }] })
    }
    return json(response, { schedules: [] })
  }
  if (url.pathname.endsWith('/messages')) {
    if (mode === 'conversation-pending') return
    const items = mode === 'post-wait-history' ? [...priorMessages, longMessage] : [mode === 'post-wait-long' ? longMessage : message]
    return json(response, { items: [...items, ...sentMessages], hasMore: false })
  }
  if (url.pathname.endsWith('/queue') || url.pathname === '/api/queue') return json(response, { items: stopScenario && !stopAccepted
    ? [{ id: 'running-one', botId: 'bot-one', botName: 'ユキ', status: 'running', groupId: null, message: null }] : [] })
  if (url.pathname === '/api/bots/bot-one') return json(response, { bot: bot() })
  if (url.pathname === '/api/bots') return json(response, { bots: [bot()] })
  if (url.pathname === '/api/rooms') return json(response, { rooms: [] })
  if (url.pathname === '/api/owner') return json(response, { owner })
  if (url.pathname === '/api/models') return json(response, { models: { claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'] }] } } })
  if (url.pathname === '/api/subscription') return json(response, { subscription })
  if (url.pathname === '/api/settings') {
    settingsReads++
    if ((mode === 'settings-editor-failure' && settingsReads === 2) ||
        (mode === 'settings-known-after-write-failure' && settingsReads === 3)) {
      response.writeHead(503); response.end(); return
    }
    return json(response, { settings: [setting] })
  }
  if (url.pathname === '/api/setup') return json(response, { phase: 'ready', complete: true, harnesses: [], guideBotId: null, auth: null })
  if (url.pathname === '/api/session') return json(response, { authenticated: true, authMode: 'local' })
  response.writeHead(404); response.end()
})
server.listen(18896, '127.0.0.1', () => console.log('報告試験サーバー http://127.0.0.1:18896'))
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
