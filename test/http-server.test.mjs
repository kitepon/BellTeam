import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { avatarVersion, createBellTeamServer, pageItems } from '../src/http-server.mjs'

const mockAuthorize = request => request.headers['cf-access-jwt-assertion'] === 'test-assertion'

test('Botが提示した画像を認証付き会話APIから配信する', async (t) => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const bot = { id: 'bot-a' }
  const server = createBellTeamServer({
    bots: new Map([[bot.id, bot]]), authorize: mockAuthorize, messenger: {}, transport: {},
    store: { async timeline() { return [{
      id: 'delivery-1', kind: 'message', direction: 'incoming', message: '画像です', image: true,
      imageAsset: { owner: 'bot-a', file: 'delivery-1.png', mime: 'image/png' },
    }] } },
    assets: {
      async open(owner, file) {
        assert.equal(owner, 'bot-a')
        assert.equal(file, 'delivery-1.png')
        return { mime: 'image/png', size: image.length, stream: Readable.from(image) }
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }

  const item = (await (await fetch(`${base}/api/bots/bot-a/messages`, { headers })).json()).items[0]
  assert.equal(item.image_url, '/api/message-images/bot-a/delivery-1.png')
  assert.equal(item.imageAsset, undefined)
  assert.equal((await fetch(`${base}${item.image_url}`)).status, 401)
  const response = await fetch(`${base}${item.image_url}`, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
})

test('Web APIから同じオーナープロフィール正本を取得・更新する', async (t) => {
  const updates = []
  const ownerProfile = {
    async get() { return { schema: 'bellteam.owner-profile.v1', name: '利用者', profile: '', avatar: '', xUrl: '', githubUrl: '', links: [] } },
    async update(value) { updates.push(value); return { ...await this.get(), ...value } },
  }
  const server = createBellTeamServer({
    bots: new Map(), authorize: mockAuthorize, ownerProfile,
    messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' }

  assert.equal((await fetch(`${base}/api/owner`)).status, 401)
  assert.equal((await (await fetch(`${base}/api/owner`, { headers })).json()).owner.name, '利用者')
  const response = await fetch(`${base}/api/owner`, {
    method: 'PATCH', headers, body: JSON.stringify({ name: '利用者', githubUrl: 'https://github.com/example-user' }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).owner.name, '利用者')
  assert.deepEqual(updates, [{ name: '利用者', githubUrl: 'https://github.com/example-user' }])
})

test('Web APIはCloudflare Access認証を必須にし、一覧・会話取得・Bot送信を提供する', async (t) => {
  const bot = {
    id: 'bell-grok-a', name: 'あかり', position: '調査担当', displayName: 'あかり 調査担当', harness: 'grok',
    session: 'bell-grok-a', project: '/bots/bell-grok-a', color: 'rose',
  }
  const sent = []
  const restarted = []
  const server = createBellTeamServer({
    bots: new Map([[bot.id, bot]]),
    authorize: mockAuthorize,
    messenger: { async enqueueUserTurn(message) { sent.push(message); return { delivery: 'queued', delivery_id: 'delivery-1', queue_id: 'queue-1' } } },
    store: { async timeline() { return [{ id: '1', kind: 'message', direction: 'incoming', message: 'こんにちは', at: '2026-09-02T01:02:03.000Z' }] } },
    transport: { async runningBots(list) { return new Set(list.map(value => value.id)) }, async restart(value) { restarted.push(value.id) } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  assert.equal((await fetch(`${base}/api/bots`)).status, 401)

  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }
  const botsResponse = await fetch(`${base}/api/bots`, { headers })
  assert.equal(botsResponse.status, 200)
  assert.deepEqual(await botsResponse.json(), { bots: [{
    id: bot.id, displayName: bot.displayName, harness: 'grok', color: 'rose', online: true,
    name: bot.name, model: '', reasoningEffort: '', profileText: '', personality: '', speechStyle: '', position: bot.position, role: '', avatar: '', avatarVersion: '',
    recent: { id: '1', kind: 'message', direction: 'incoming', message: 'こんにちは', at: '2026-09-02T01:02:03.000Z' },
  }] })

  const messagesResponse = await fetch(`${base}/api/bots/${bot.id}/messages`, { headers })
  assert.equal(messagesResponse.status, 200)
  assert.equal((await messagesResponse.json()).items[0].message, 'こんにちは')

  const sendResponse = await fetch(`${base}/api/bots/${bot.id}/messages`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '状況を教えて' }),
  })
  assert.equal(sendResponse.status, 200)
  assert.deepEqual(sent, [{ target: bot.id, message: '状況を教えて', images: [] }])

  const restartResponse = await fetch(`${base}/api/bots/${bot.id}/restart`, { method: 'POST', headers })
  assert.equal(restartResponse.status, 202)
  assert.deepEqual(await restartResponse.json(), { restarting: bot.id })
  assert.deepEqual(restarted, [bot.id])

  const image = { mime: 'image/png', data: 'iVBORw0KGgo=' }
  const imageResponse = await fetch(`${base}/api/bots/${bot.id}/messages`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '', image }),
  })
  assert.equal(imageResponse.status, 200)
  assert.deepEqual(sent.at(-1), { target: bot.id, message: '', images: [image] })

  const images = [image, { mime: 'image/jpeg', data: '/9j/4A==' }]
  const imagesResponse = await fetch(`${base}/api/bots/${bot.id}/messages`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '2枚見て', images }),
  })
  assert.equal(imagesResponse.status, 200)
  assert.deepEqual(sent.at(-1), { target: bot.id, message: '2枚見て', images })

  const invalidImages = await fetch(`${base}/api/bots/${bot.id}/messages`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '', images: ['not-an-image'] }),
  })
  assert.equal(invalidImages.status, 400)
  assert.deepEqual(await invalidImages.json(), { error: 'IMAGE_INVALID' })

  const missing = await fetch(`${base}/api/bots/missing/messages`, { headers })
  assert.equal(missing.status, 404)
})

test('本文の塊の境目で日本語が割れても、文字化けせずに受け取る', async (t) => {
  const bot = { id: 'bot-a', name: 'あかり', displayName: 'あかり', harness: 'grok', session: 'bot-a', project: '/bots/bot-a' }
  const sent = []
  const server = createBellTeamServer({
    bots: new Map([[bot.id, bot]]),
    authorize: mockAuthorize,
    messenger: { async enqueueUserTurn(message) { sent.push(message); return { delivery: 'queued', delivery_id: 'delivery-1' } } },
    store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const body = Buffer.from(JSON.stringify({ message: '表示をした上で' }))
  const cut = body.indexOf(Buffer.from('し')) + 1
  const request = httpRequest({
    host: '127.0.0.1', port: server.address().port, method: 'POST', path: `/api/bots/${bot.id}/messages`,
    headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json', 'content-length': body.length },
  })
  request.write(body.subarray(0, cut))
  await new Promise(resolve => setTimeout(resolve, 50))
  request.end(body.subarray(cut))
  const [response] = await once(request, 'response')
  response.resume()
  assert.equal(response.statusCode, 200)
  assert.equal(sent[0].message, '表示をした上で')
})

test('healthzは認証なしで応答し、空本文は400にする', async (t) => {
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a', harness: 'grok', session: 'bot-a', project: '/bot-a' }]]),
    authorize: mockAuthorize,
    messenger: { async sendmessage() { throw new Error('呼ばれない') } },
    store: { async timeline() { return [] } },
    transport: { async isRunning() { return false } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  const response = await fetch(`${base}/api/bots/bot-a/messages`, {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  })
  assert.equal(response.status, 400)
})

test('会話の知らせは知らせが無い間も間隔ごとに流れる', async (t) => {
  const server = createBellTeamServer({
    bots: new Map(),
    authorize: mockAuthorize,
    store: { async timeline() { return [] } },
    eventKeepalive: 20,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, {
    headers: { 'cf-access-jwt-assertion': 'test-assertion' }, signal: controller.signal,
  })
  const reader = response.body.getReader()
  let text = ''
  while ((text.match(/: keepalive\n\n/gu) ?? []).length < 2) text += new TextDecoder().decode((await reader.read()).value)
  assert.match(text, /^event: ready\ndata: \{\}\n\n/u)
  controller.abort()
})

test('Web APIの記憶とRAGはMCPと同じ共通サービスを呼ぶ', async (t) => {
  const calls = []
  const memory = {
    async remember(value) { calls.push(['remember', value]); return { id: 'memory-1' } },
    async recallMemory(value) { calls.push(['recall', value]); return { items: [] } },
    async listMemoryCandidates(value) { calls.push(['candidates', value]); return { items: [] } },
    async organizeMemoryCandidate(value) { calls.push(['organize', value]); return { status: 'organized' } },
    async dismissMemoryCandidate(value) { calls.push(['dismiss', value]); return { status: 'dismissed' } },
    async reviseMemory(value) { calls.push(['revise', value]); return { id: 'memory-2' } },
    async pinMemory(value) { calls.push(['pin', value]); return { id: value.id } },
    async consolidateGrowth(value) { calls.push(['consolidate', value]); return { id: 'memory-3' } },
    async recordKnowledge(value) { calls.push(['record', value]); return { id: 'knowledge-1' } },
    async searchKnowledge(value) { calls.push(['search', value]); return { items: [] } },
  }
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: mockAuthorize, memory,
    messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' }

  await fetch(`${base}/api/bots/bot-a/memory`, { method: 'POST', headers, body: JSON.stringify({ content: '思い出', kind: 'episode' }) })
  await fetch(`${base}/api/bots/bot-a/memory?query=${encodeURIComponent('思い出')}`, { headers })
  await fetch(`${base}/api/bots/bot-a/memory/candidates?limit=5`, { headers })
  await fetch(`${base}/api/bots/bot-a/memory/candidates/turn-1/organize`, {
    method: 'POST', headers, body: JSON.stringify({ memories: [{ content: '会話の記憶' }] }),
  })
  await fetch(`${base}/api/bots/bot-a/memory/candidates/turn-2/dismiss`, { method: 'POST', headers, body: '{}' })
  await fetch(`${base}/api/bots/bot-a/memory/memory-1`, {
    method: 'PATCH', headers, body: JSON.stringify({ content: '更新後' }),
  })
  await fetch(`${base}/api/bots/bot-a/memory/memory-2/pin`, { method: 'POST', headers, body: JSON.stringify({ pinned: true }) })
  await fetch(`${base}/api/bots/bot-a/memory/consolidate-growth`, {
    method: 'POST', headers, body: JSON.stringify({ memoryIds: ['memory-1'], content: '成長した' }),
  })
  await fetch(`${base}/api/bots/bot-a/knowledge`, { method: 'POST', headers, body: JSON.stringify({ title: '設計', content: '本文' }) })
  await fetch(`${base}/api/bots/bot-a/knowledge?query=${encodeURIComponent('設計')}&scope=shared`, { headers })

  assert.deepEqual(calls, [
    ['remember', { botId: 'bot-a', content: '思い出', kind: 'episode', sourceRef: 'ui' }],
    ['recall', { botId: 'bot-a', query: '思い出', scope: 'personal' }],
    ['candidates', { botId: 'bot-a', limit: '5' }],
    ['organize', { botId: 'bot-a', candidateId: 'turn-1', memories: [{ content: '会話の記憶' }] }],
    ['dismiss', { botId: 'bot-a', candidateId: 'turn-2' }],
    ['revise', { botId: 'bot-a', id: 'memory-1', content: '更新後' }],
    ['pin', { botId: 'bot-a', id: 'memory-2', pinned: true }],
    ['consolidate', { botId: 'bot-a', memoryIds: ['memory-1'], content: '成長した' }],
    ['record', { botId: 'bot-a', title: '設計', content: '本文' }],
    ['search', { botId: 'bot-a', query: '設計', scope: 'shared' }],
  ])
})

test('Bot内MCPの直接・ルーム配送をメインサーバーの共通待ち行列へ渡す', async (t) => {
  const calls = []
  const server = createBellTeamServer({
    bots: new Map(), authorize: async () => true, store: {}, transport: {},
    messenger: { async sendmessage(value) { calls.push(['direct', value]); return { delivery: 'queued' } } },
    roomMessenger: { async sendroommessage(value) { calls.push(['room', value]); return { delivery: 'queued' } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json' }

  const direct = await fetch(`${base}/api/deliveries/direct`, {
    method: 'POST', headers, body: JSON.stringify({ from: 'bot-a', target: 'bot-b', message: '確認して' }),
  })
  const room = await fetch(`${base}/api/deliveries/room`, {
    method: 'POST', headers, body: JSON.stringify({ from: 'bot-a', room: 'room-a', message: '共有' }),
  })

  assert.deepEqual(await direct.json(), { delivery: 'queued' })
  assert.deepEqual(await room.json(), { delivery: 'queued' })
  assert.deepEqual(calls, [
    ['direct', { from: 'bot-a', target: 'bot-b', message: '確認して' }],
    ['room', { from: 'bot-a', room: 'room-a', message: '共有' }],
  ])
})

test('待機中メッセージを取得し、手動割り込みAPIは公開しない', async (t) => {
  const calls = []
  const item = { id: 'queue-1', botId: 'bot-a', status: 'queued', message: '追加指示' }
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: mockAuthorize, messenger: {}, store: {},
    transport: {
      queueItems(filter = {}) { calls.push(['list', filter]); return [item] },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }

  const queue = await (await fetch(`${base}/api/bots/bot-a/queue`, { headers })).json()
  assert.deepEqual(queue.items, [item])
  const steer = await fetch(`${base}/api/queue/queue-1/steer`, { method: 'POST', headers })
  assert.equal(steer.status, 404)
  assert.deepEqual(calls, [['list', { botId: 'bot-a' }]])
})

test('Web APIはBotセッション・ルーム参照・プロジェクトを順に削除する', async (t) => {
  const bot = { id: 'bot-a', harness: 'grok', session: 'bot-a', project: '/bot-a' }
  const bots = new Map([[bot.id, bot]])
  const calls = []
  bots.remove = async id => { calls.push(['bot', id]); bots.delete(id) }
  const server = createBellTeamServer({
    bots, rooms: { async removeBot(id) { calls.push(['rooms', id]) } }, authorize: mockAuthorize,
    messenger: {}, store: {}, transport: { async stop(value) { calls.push(['session', value.id]) } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a`, {
    method: 'DELETE', headers: { 'cf-access-jwt-assertion': 'test-assertion' },
  })
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { deleting: 'bot-a' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['session', 'bot-a'], ['rooms', 'bot-a'], ['bot', 'bot-a']])
})

test('Web APIはルームの保存領域を削除する', async (t) => {
  const rooms = new Map([['room-a', { id: 'room-a', name: '開発室', memberIds: [] }]])
  const removed = []
  rooms.refresh = async () => rooms
  rooms.remove = async id => { removed.push(id); rooms.delete(id) }
  const server = createBellTeamServer({
    bots: new Map(), rooms, authorize: mockAuthorize, messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }

  assert.equal((await fetch(`${base}/api/rooms/room-a`, { method: 'DELETE', headers })).status, 204)
  assert.deepEqual(removed, ['room-a'])
  assert.equal((await fetch(`${base}/api/rooms/room-a`, { method: 'DELETE', headers })).status, 404)
})

test('Web APIからBot追加・プロフィール編集・予定管理ができる', async (t) => {
  const bot = { id: 'bot-a', displayName: 'Bot A', harness: 'grok', session: 'bot-a', project: '/bot-a' }
  const bots = new Map([[bot.id, bot]])
  bots.refresh = async () => bots
  bots.create = async profile => {
    const created = { ...profile, id: 'bot-b', session: 'bot-b', project: '/bots/bot-b' }
    bots.set(created.id, created)
    return created
  }
  bots.update = async (id, changes) => {
    const updated = { ...bots.get(id), ...changes }
    bots.set(id, updated)
    return updated
  }
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.listSchedules = async () => [{ id: 's-1', kind: 'cron', expression: '0 * * * *', prompt: '確認' }]
  bots.setSchedule = async (_id, schedule) => ({ id: 's-2', ...schedule })
  bots.removeSchedule = async () => true
  const server = createBellTeamServer({
    bots, authorize: mockAuthorize,
    messenger: { async sendmessage() { return {} } },
    store: { async timeline() { return [] } },
    transport: { async isRunning() { return false } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' }

  const createResponse = await fetch(`${base}/api/bots`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Bot B', harness: 'grok', profileText: '調査チームの一員', personality: '穏やか', speechStyle: '一人称は私', position: '設計者', role: '開発' }),
  })
  assert.equal(createResponse.status, 201)
  assert.equal((await createResponse.json()).bot.position, '設計者')

  const updateResponse = await fetch(`${base}/api/bots/bot-b`, {
    method: 'PATCH', headers, body: JSON.stringify({ position: 'リード', role: '設計', speechStyle: '一人称は僕' }),
  })
  assert.equal(updateResponse.status, 200)
  const updated = (await updateResponse.json()).bot
  assert.equal(updated.position, 'リード')
  assert.equal(updated.role, '設計')
  assert.equal(updated.profileText, '調査チームの一員')
  assert.equal(updated.personality, '穏やか')
  assert.equal(updated.speechStyle, '一人称は僕')

  assert.equal((await fetch(`${base}/api/bots/bot-b/schedules`, { headers })).status, 200)
  assert.equal((await fetch(`${base}/api/bots/bot-b/schedules`, {
    method: 'POST', headers, body: JSON.stringify({ kind: 'once', at: '2026-09-01T00:00:00Z', prompt: '実行' }),
  })).status, 201)
  assert.equal((await fetch(`${base}/api/bots/bot-b/schedules/s-2`, { method: 'DELETE', headers })).status, 204)
})

test('稼働中BotのCLI・モデル・エフォート変更を配送後に適用してから保存する', async (t) => {
  const bot = { id: 'bot-a', name: 'ベル', displayName: 'ベル', harness: 'grok', session: 'bot-a', project: '/bots/bot-a', model: '', reasoningEffort: '' }
  const bots = new Map([[bot.id, bot]])
  bots.refresh = async () => bots
  bots.update = async (id, changes) => {
    const updated = { ...bots.get(id), ...changes }
    bots.set(id, updated)
    return updated
  }
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  const applied = []
  const runningChecks = []
  const server = createBellTeamServer({
    bots, authorize: mockAuthorize, messenger: {}, store: {},
    transport: {
      async isRunning(value) { runningChecks.push(value.harness); return true },
      async reconfigure(current, next) {
        applied.push({ current: current.harness, next: next.harness, model: next.model, effort: next.reasoningEffort })
        return { mode: current.harness === next.harness ? 'configure' : 'restart' }
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a`, {
    method: 'PATCH',
    headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' }),
  })

  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.bot.harness, 'codex')
  assert.equal(result.bot.model, 'gpt-5.6-sol')
  assert.equal(result.bot.reasoningEffort, 'high')
  assert.equal(result.harnessChanged, true)
  assert.equal(result.configurationChanged, true)
  assert.equal(result.applying, true)
  assert.deepEqual(applied, [{ current: 'grok', next: 'codex', model: 'gpt-5.6-sol', effort: 'high' }])

  const modelResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a`, {
    method: 'PATCH',
    headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
  })
  const modelResult = await modelResponse.json()
  assert.equal(modelResult.applying, true)
  assert.deepEqual(applied.at(-1), { current: 'codex', next: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' })
  assert.deepEqual(runningChecks, ['grok', 'codex'])
})

test('Bot作成APIは偽の初回会話を作らず、作成結果を一度だけ返す', async (t) => {
  const bots = new Map()
  let created = 0
  bots.refresh = async () => bots
  bots.create = async profile => {
    created += 1
    const bot = { ...profile, id: 'bot-b', session: 'bot-b', project: '/bots/bot-b' }
    bots.set(bot.id, bot)
    return bot
  }
  const server = createBellTeamServer({
    bots, authorize: mockAuthorize,
    messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const response = await Promise.race([
    fetch(`${base}/api/bots`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ベル', harness: 'grok' }),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('作成応答が初回挨拶を待っている')), 100)),
  ])
  assert.equal(response.status, 201)
  assert.equal((await response.json()).bot.id, 'bot-b')
  assert.equal(created, 1)
})

test('HTMLへ起動単位のasset versionを埋め込み、古いJavaScriptとの混在を防ぐ', async (t) => {
  const staticRoot = await mkdtemp(join(tmpdir(), 'bellteam-static-'))
  await writeFile(join(staticRoot, 'index.html'), '<link href="/styles.css?v=__ASSET_VERSION__"><script src="/app.js?v=__ASSET_VERSION__"></script>')
  await writeFile(join(staticRoot, 'app.js'), 'import "./chat-input.js?v=__ASSET_VERSION__"; import "./activity-order.js?v=__ASSET_VERSION__"')
  await writeFile(join(staticRoot, 'chat-input.js'), 'export const ok = true')
  await writeFile(join(staticRoot, 'activity-order.js'), 'export const ok = true')
  await writeFile(join(staticRoot, 'styles.css'), 'body{}')
  const server = createBellTeamServer({
    bots: new Map(), authorize: mockAuthorize, staticRoot, assetVersion: 'release-123',
    messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }
  assert.equal((await fetch(`${base}/`)).status, 401)
  const response = await fetch(`${base}/`, { headers })
  const html = await response.text()
  assert.match(html, /app\.js\?v=release-123/u)
  assert.match(html, /styles\.css\?v=release-123/u)
  assert.doesNotMatch(html, /__ASSET_VERSION__/u)
  assert.equal(response.headers.get('cache-control'), 'no-cache')
  const app = await (await fetch(`${base}/app.js?v=release-123`, { headers })).text()
  assert.match(app, /chat-input\.js\?v=release-123/u)
  assert.match(app, /activity-order\.js\?v=release-123/u)
  assert.doesNotMatch(app, /__ASSET_VERSION__/u)
  assert.equal((await fetch(`${base}/chat-input.js`, { headers })).status, 200)
  assert.equal((await fetch(`${base}/activity-order.js`, { headers })).status, 200)
})

test('Webアプリがimportする実ファイルを同じ版で最後まで配信する', async t => {
  const server = createBellTeamServer({
    bots: new Map(), authorize: mockAuthorize,
    staticRoot: fileURLToPath(new URL('../web/', import.meta.url)), assetVersion: 'import-graph-test',
    messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const pending = [new URL('/app.js?v=import-graph-test', base)]
  const visited = new Set()
  while (pending.length) {
    const url = pending.pop()
    if (visited.has(url.pathname)) continue
    visited.add(url.pathname)
    const response = await fetch(url, { headers: { 'cf-access-jwt-assertion': 'test-assertion' } })
    assert.equal(response.status, 200, `${url.pathname}を配信できない`)
    assert.match(response.headers.get('content-type'), /javascript/u)
    const module = await response.text()
    assert.doesNotMatch(module, /__ASSET_VERSION__/u, `${url.pathname}の版が未置換`)
    for (const match of module.matchAll(/(?:from\s*|^\s*import\s*)['"](\.[^'"]+)['"]/gmu)) {
      const dependency = new URL(match[1], url)
      assert.equal(dependency.searchParams.get('v'), 'import-graph-test')
      pending.push(dependency)
    }
  }
  assert.ok(visited.has('/onboarding.js'))
  assert.ok(visited.has('/server-origin.js'))
})

test('Web APIからルーム作成・設定・会話・予定を操作できる', async (t) => {
  const room = { id: 'room-dev', name: '開発室', purpose: '連携', representativeId: 'bot-a', memberIds: ['bot-a', 'bot-b'] }
  const rooms = new Map()
  rooms.refresh = async () => rooms
  rooms.create = async input => { const value = { ...room, ...input, id: room.id }; rooms.set(value.id, value); return value }
  rooms.update = async (id, changes) => { const value = { ...rooms.get(id), ...changes }; rooms.set(id, value); return value }
  rooms.messages = async () => [{ id: 'm-1', at: '2026-08-31T00:00:00Z', sender: { id: 'bot-a', name: 'あかり', role: '調査' }, room: { members: [] }, targets: [], message: '共有', image: false }]
  rooms.listSchedules = async () => [{ id: 's-1', prompt: '朝会' }]
  rooms.setSchedule = async (_id, value) => ({ id: 's-2', ...value })
  rooms.removeSchedule = async () => true
  const sent = []
  const server = createBellTeamServer({
    bots: new Map(), rooms, roomMessenger: { async sendroommessage(value) { sent.push(value); return { id: 'm-2' } } },
    authorize: mockAuthorize, messenger: {}, store: {}, transport: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' }

  assert.equal((await fetch(`${base}/api/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: room.name, purpose: room.purpose, representativeId: room.representativeId, memberIds: room.memberIds }) })).status, 201)
  assert.equal((await fetch(`${base}/api/rooms`, { headers })).status, 200)
  assert.equal((await fetch(`${base}/api/rooms/room-dev`, { method: 'PATCH', headers, body: JSON.stringify({ purpose: '共同開発' }) })).status, 200)
  assert.equal((await fetch(`${base}/api/rooms/room-dev/messages`, { method: 'POST', headers, body: JSON.stringify({ message: '始めよう' }) })).status, 200)
  assert.deepEqual(sent[0], { from: 'user', room: 'room-dev', message: '始めよう', images: [], targets: null })
  assert.equal((await fetch(`${base}/api/rooms/room-dev/schedules`, { method: 'POST', headers, body: JSON.stringify({ kind: 'cron', expression: '0 9 * * *', prompt: '朝会' }) })).status, 201)
  assert.equal((await fetch(`${base}/api/rooms/room-dev/schedules/s-2`, { method: 'DELETE', headers })).status, 204)
})

test('モデル候補APIはCLIごとの一覧を返す', async (t) => {
  let calls = 0
  const server = createBellTeamServer({
    bots: new Map(), authorize: mockAuthorize, messenger: {}, transport: {},
    models: { list: async harness => { calls++; return { [harness ?? 'grok']: [`model-${calls}`] } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${base}/api/models`, { headers: { 'cf-access-jwt-assertion': 'test-assertion' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { models: { grok: ['model-1'] } })
  const next = await fetch(`${base}/api/models?harness=codex`, { headers: { 'cf-access-jwt-assertion': 'test-assertion' } })
  assert.deepEqual(await next.json(), { models: { codex: ['model-2'] } })
})

test('既存の予定はPUTで同じIDのまま更新する', async (t) => {
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const received = []
  bots.listSchedules = async () => []
  bots.setSchedule = async (_id, schedule) => { received.push(schedule); return schedule }
  const server = createBellTeamServer({ bots, authorize: mockAuthorize, messenger: {}, store: {}, transport: {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/schedules/s-1`, {
    method: 'PUT', headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'cron', expression: '0 6 * * *', prompt: '巡回', name: '朝' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(received, [{ kind: 'cron', expression: '0 6 * * *', prompt: '巡回', name: '朝', id: 's-1' }])
  assert.equal((await response.json()).schedule.id, 's-1')
})

test('予定の今すぐ実行はschedulerへ渡して202を返す', async (t) => {
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const runs = []
  const server = createBellTeamServer({
    bots, authorize: mockAuthorize, messenger: {}, store: {}, transport: {},
    scheduler: { async runBotSchedule(botId, scheduleId) { runs.push([botId, scheduleId]); return { id: scheduleId } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/schedules/s-1/run`, {
    method: 'POST', headers: { 'cf-access-jwt-assertion': 'test-assertion' },
  })
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { ran: 's-1' })
  assert.deepEqual(runs, [['bot-a', 's-1']])
})

test('Botの画面APIは稼働状態とCLI画面の末尾を返す', async (t) => {
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const server = createBellTeamServer({
    bots, authorize: mockAuthorize, messenger: {}, store: {},
    transport: { async screen(bot) { return { online: true, screen: `${bot.id}\n❯ 作業中` } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/screen`, { headers: { 'cf-access-jwt-assertion': 'test-assertion' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { online: true, screen: 'bot-a\n❯ 作業中' })
})

test('ユーザー規範はAPIで読み書きし、更新後に共通指示を作り直す', async (t) => {
  let stored = '- 初期。\n'
  let refreshed = 0
  const server = createBellTeamServer({
    bots: new Map(), authorize: mockAuthorize, messenger: {}, store: {}, transport: {},
    userRules: { async get() { return stored }, async update(text) { stored = `${text.trim()}\n`; return stored } },
    refreshGlobalInstructions: async () => { refreshed++ },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' }
  assert.deepEqual(await (await fetch(`${base}/api/user-rules`, { headers })).json(), { text: '- 初期。\n' })
  const put = await fetch(`${base}/api/user-rules`, { method: 'PUT', headers, body: JSON.stringify({ text: '- 新しい規範。' }) })
  assert.deepEqual(await put.json(), { text: '- 新しい規範。\n' })
  assert.equal(refreshed, 1)
})

test('会話は最新から件数指定で読み、beforeで遡り、afterで差分を取る', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ id: `m${index + 1}` }))
  const page = query => pageItems(items, new URL(`http://x/?${query}`))
  assert.deepEqual(page('limit=10').items.map(item => item.id), ['m16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25'])
  assert.equal(page('limit=10').has_more, true)
  assert.deepEqual(page('limit=20&before=m16').items.map(item => item.id), items.slice(0, 15).map(item => item.id))
  assert.equal(page('limit=20&before=m16').has_more, false)
  assert.deepEqual(page('after=m23').items.map(item => item.id), ['m24', 'm25'])
  assert.equal(page('').items.length, 10)
})

test('Botのキャラクターシートを一覧し、画像を認証付きで配信する', async (t) => {
  const image = Buffer.from('jpeg-bytes')
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: mockAuthorize, messenger: {}, store: {}, transport: {},
    characterSheets: {
      async list(botId) {
        assert.equal(botId, 'bot-a')
        return [{ file: 'bell sheet.jpg', size: image.length, updatedAt: '2026-09-03T11:00:00.000Z' }]
      },
      async open(botId, file) {
        assert.equal(botId, 'bot-a')
        if (file !== 'bell sheet.jpg') throw new Error('CHARACTER_SHEET_NOT_FOUND')
        return { mime: 'image/jpeg', size: image.length, stream: Readable.from(image) }
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }

  const { sheets } = await (await fetch(`${base}/api/bots/bot-a/character-sheet`, { headers })).json()
  assert.deepEqual(sheets, [{ file: 'bell sheet.jpg', size: image.length, updatedAt: '2026-09-03T11:00:00.000Z', url: '/api/bots/bot-a/character-sheet/bell%20sheet.jpg' }])
  assert.equal((await fetch(`${base}${sheets[0].url}`)).status, 401)
  const response = await fetch(`${base}${sheets[0].url}`, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/jpeg')
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'jpeg-bytes')
  assert.equal((await fetch(`${base}/api/bots/bot-a/character-sheet/none.jpg`, { headers })).status, 404)
  assert.equal((await fetch(`${base}/api/bots/bot-x/character-sheet`, { headers })).status, 404)
})

test('画像を何枚も持つ発言は、全部のURLと1枚目のURLを渡す', async (t) => {
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: mockAuthorize, messenger: {}, transport: {},
    store: { async timeline() { return [{
      id: 'delivery-2', kind: 'message', direction: 'outgoing', message: '2枚', image: true, image_count: 2, imageAsset: null,
      imageAssets: [{ owner: 'user', file: 'delivery-2-1.png', mime: 'image/png' }, { owner: 'user', file: 'delivery-2-2.jpg', mime: 'image/jpeg' }],
    }] } },
    assets: {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const item = (await (await fetch(`${base}/api/bots/bot-a/messages`, { headers: { 'cf-access-jwt-assertion': 'test-assertion' } })).json()).items[0]
  assert.deepEqual(item.image_urls, ['/api/message-images/user/delivery-2-1.png', '/api/message-images/user/delivery-2-2.jpg'])
  assert.equal(item.image_url, '/api/message-images/user/delivery-2-1.png')
  assert.equal(item.imageAssets, undefined)
})

test('一覧はアバターの版を返し、avatar=omitで画像本体を外して別URLで配る', async (t) => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
  const avatar = `data:image/jpeg;base64,${image.toString('base64')}`
  const version = avatarVersion(avatar)
  const roomList = new Map([
    ['room-a', { id: 'room-a', name: '部屋', avatar }],
    ['room-b', { id: 'room-b', name: '画像なし', avatar: '' }],
  ])
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a', avatar }], ['bot-b', { id: 'bot-b' }]]),
    rooms: { async refresh() {}, has: id => roomList.has(id), get: id => roomList.get(id), values: () => roomList.values(), async messages() { return [] } },
    ownerProfile: { async get() { return { name: '利用者', avatar } } },
    authorize: mockAuthorize, messenger: {}, transport: { async runningBots() { return new Set() } },
    store: { async timeline() { return [] } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'cf-access-jwt-assertion': 'test-assertion' }
  const get = async path => (await fetch(`${base}${path}`, { headers })).json()

  assert.match(version, /^[a-f0-9]{16}$/u)
  // 指定の無い古いアプリには今までどおり画像本体を返す。
  const full = await get('/api/bots')
  assert.deepEqual(full.bots.map(bot => [bot.avatar, bot.avatarVersion]), [[avatar, version], ['', '']])
  assert.equal((await get('/api/rooms')).rooms[0].avatar, avatar)
  assert.equal((await get('/api/owner')).owner.avatar, avatar)

  const light = await get('/api/bots?avatar=omit')
  assert.deepEqual(light.bots.map(bot => [bot.avatar, bot.avatarVersion]), [['', version], ['', '']])
  assert.deepEqual((await get('/api/rooms?avatar=omit')).rooms.map(room => [room.avatar, room.avatarVersion]), [['', version], ['', '']])
  const owner = (await get('/api/owner?avatar=omit')).owner
  assert.deepEqual([owner.name, owner.avatar, owner.avatarVersion], ['利用者', '', version])

  for (const path of ['/api/bots/bot-a/avatar', '/api/rooms/room-a/avatar', '/api/owner/avatar']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401)
    const versioned = await fetch(`${base}${path}?v=${version}`, { headers })
    assert.equal(versioned.status, 200)
    assert.equal(versioned.headers.get('content-type'), 'image/jpeg')
    assert.equal(versioned.headers.get('etag'), `"${version}"`)
    assert.equal(versioned.headers.get('cache-control'), 'private, max-age=31536000, immutable')
    assert.deepEqual(Buffer.from(await versioned.arrayBuffer()), image)
    // 版が合わない取得は長く保存させない。
    const stale = await fetch(`${base}${path}?v=0000000000000000`, { headers })
    assert.equal(stale.headers.get('cache-control'), 'private, no-cache')
    await stale.arrayBuffer()
    const unchanged = await fetch(`${base}${path}`, { headers: { ...headers, 'if-none-match': `"${version}"` } })
    assert.equal(unchanged.status, 304)
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0)
  }
  for (const path of ['/api/bots/bot-b/avatar', '/api/rooms/room-b/avatar']) {
    const missing = await fetch(`${base}${path}`, { headers })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error, 'AVATAR_NOT_FOUND')
  }
  assert.equal((await fetch(`${base}/api/bots/bot-none/avatar`, { headers })).status, 404)
})

test('同じ変更で続けて鳴った知らせは1件にまとめ、次の変更は別に流す', async (t) => {
  const watchers = []
  const server = createBellTeamServer({
    bots: new Map(), authorize: mockAuthorize,
    store: { async timeline() { return [] }, async watch(notify) { watchers.push(notify); return () => {} } },
    transport: { watchQueue(notify) { watchers.push(notify); return () => {} } },
    messageEventWindow: 20,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  await server.startMessageWatch()
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, {
    headers: { 'cf-access-jwt-assertion': 'test-assertion' }, signal: controller.signal,
  })
  const reader = response.body.getReader()
  let text = ''
  const count = () => (text.match(/event: messages\n/gu) ?? []).length
  const readUntil = async wanted => { while (count() < wanted) text += new TextDecoder().decode((await reader.read()).value) }
  while (!text.includes('event: ready')) text += new TextDecoder().decode((await reader.read()).value)

  for (let index = 0; index < 6; index += 1) watchers[index % watchers.length]()
  await readUntil(1)
  await new Promise(resolve => setTimeout(resolve, 80))
  // 待っている間に追加の知らせが届いていれば、次の読み取りに混ざる。
  watchers[0]()
  await readUntil(2)
  assert.equal(count(), 2)
  controller.abort()
})

test('待機中の接続は手前の中継より長く保つ', async (t) => {
  const server = createBellTeamServer({ bots: new Map(), authorize: mockAuthorize, messenger: {}, store: {}, transport: {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const response = await new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/healthz', headers: { connection: 'keep-alive' } }, resolve)
      .on('error', reject).end()
  })
  response.resume()
  assert.equal(server.keepAliveTimeout, 125000)
  assert.equal(response.headers['keep-alive'], 'timeout=125')
})

test('止める時に開いている知らせの流れを終えて、停止を待たせない', async () => {
  const server = createBellTeamServer({ bots: new Map(), authorize: mockAuthorize, store: {}, transport: {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, {
    headers: { 'cf-access-jwt-assertion': 'test-assertion' },
  })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await reader.read()
  const closed = once(server, 'close')
  server.close()
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('接続が閉じない')), 3000).unref())
  await Promise.race([closed, timeout])
  let done = false
  while (!done) ({ done } = await reader.read())
})

test('止める時に処理中だった接続は、応答を返し終えたら閉じる', async () => {
  let release
  const server = createBellTeamServer({
    bots: new Map([['bot-a', { id: 'bot-a' }]]), authorize: mockAuthorize, store: {}, transport: {},
    messenger: { async enqueueUserTurn() { await new Promise(resolve => { release = resolve }); return { delivery: 'queued', delivery_id: 'delivery-1' } } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/messages`, {
    method: 'POST', headers: { 'cf-access-jwt-assertion': 'test-assertion', 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'こんにちは' }),
  })
  while (!release) await new Promise(resolve => setTimeout(resolve, 5))
  const closed = once(server, 'close')
  server.close()
  release()
  assert.equal((await pending).status, 200)
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('接続が閉じない')), 3000).unref())
  await Promise.race([closed, timeout])
})
