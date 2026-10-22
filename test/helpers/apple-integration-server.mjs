// Apple結合試験専用。製品のHTTP/SSEと履歴・カード・roomを人工データへ接続する。
// 実Bot、実認証、実予定実行は使わず、両HTTP入口をloopbackだけへ開く。
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ConversationStore } from '../../src/conversation-store.mjs'
import { RoomRegistry } from '../../src/room-registry.mjs'
import { SecretRequests } from '../../src/secret-requests.mjs'
import { OwnerQuestions } from '../../src/owner-questions.mjs'
import { AitermTransport } from '../../src/aiterm-transport.mjs'
import { normalizeSchedule } from '../../src/bot-registry.mjs'
import { createBellTeamServer } from '../../src/http-server.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const line = value => JSON.stringify(value) + '\n'
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
const listen = async (server, port) => { server.listen(port, '127.0.0.1'); await once(server, 'listening') }
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
const direct = (id, bot, message, extra = {}) => ({
  schema: 'bellteam.direct-message.v1', delivery_id: id, from: bot, target: 'user', message,
  at: new Date().toISOString(), delivery: 'delivered', ...extra,
})

export const integrationScenarios = {
  reset: '全fixtureを初期化し、接続を閉じる。アプリ起動前に使う',
  'clear-proof': 'データと接続を保ち、要求/配信/操作の記録だけ消す',
  bot: '?bot=bot-two : そのBotへ新着（実ファイル監視、timeline）',
  peer: '?from=bot-one&to=bot-two : 両Botの会話へ追加（実ファイル監視）',
  status: '?id=baseline-bot-one-1&delivery=failed : 過去行の状態変更',
  room: '?room=planning : roomへ新着（実room監視、timeline）',
  queue: '?bot=bot-one&room=planning&active=1 : 人工jobを追加、active=0で除去（実emitQueue）',
  request: '?bot=bot-one[&room=planning] : 実SecretRequestsのカード作成（requests）',
  'request-cancel': '?id=省略時は最後の依頼 : カード取消',
  question: '?bot=bot-three : 実OwnerQuestionsの選択肢カード作成（questions）',
  answer: '?id=省略時は最後の質問 : 「はい」で回答',
  'bot-schedule': '?bot=bot-one : 実行器を持たない人工registryの未来予定（schedules）',
  'room-schedule': '?room=planning : 実行器を持たないroomの未来予定保存（schedules）',
  owner: '人工ownerを変更し、人工registryからowner通知',
  'bot-profile': '?bot=bot-two : 人工Bot名変更＋bots通知',
  unknown: '未知delivery_idのstatusを実履歴へ追加（all:true）',
  legacy: '試験中継から旧messages {at}だけを注入',
  invalid: '試験中継から不正JSONを注入',
  'invalid-scope': '有効JSONのall:false/timelineからbotIdsとroomIdsを省略して注入',
  'unknown-topic': '試験中継から未知topic/all:falseを注入',
  reconnect: '現在のSSE接続を終了。再接続のreadyは実サーバーが送る',
  proof: 'sourceRevision、要求/応答、配信frame、操作、接続数、人工CLI記録',
  scenarios: 'この場面表',
}

export async function startAppleIntegrationServer({ port = 0 } = {}) {
  const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
  const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repo })
  const sourceRevision = stdout.trim()
  let state, sequence = 0, connectionSequence = 0, actions = Promise.resolve()
  let requests = [], events = [], changes = [], controls = [], cli = [], diagnostics = []
  const streams = new Set()
  const nextId = prefix => `${prefix}-${++sequence}`
  const closeStreams = () => { for (const stream of streams) { stream.upstream.destroy(); stream.response.end() } }
  const notifyBots = change => { for (const listener of state.listeners) listener(change) }
  const scoped = (topic, botIds = [], roomIds = []) => ({ all: false, topics: [topic], botIds, roomIds })
  function capture(stream, chunk, origin) {
    stream.buffer += stream.decoder.write(chunk)
    let end
    while ((end = stream.buffer.indexOf('\n\n')) >= 0) {
      const raw = stream.buffer.slice(0, end)
      stream.buffer = stream.buffer.slice(end + 2)
      if (!raw.startsWith('event:')) continue
      const event = raw.match(/^event: (.+)/mu)?.[1]
      const data = raw.match(/^data: (.*)/mu)?.[1]
      let parsed = null
      try { parsed = JSON.parse(data) } catch {}
      events.push({ connection: stream.id, at: Date.now(), origin, event, raw, data: parsed })
    }
  }
  const inject = data => {
    const raw = `event: messages\ndata: ${data}\n\n`
    for (const stream of streams) { capture(stream, Buffer.from(raw), 'test-injection'); stream.response.write(raw) }
  }
  async function reset() {
    closeStreams()
    if (state) { await stop(state.server); await rm(state.root, { recursive: true, force: true }) }
    requests = []; events = []; changes = []; controls = []; cli = []; diagnostics = []; sequence = 0
    const root = await mkdtemp(join(tmpdir(), 'bell-apple-integration-'))
    const bots = new Map(fixture.bots.map(bot => [bot.id, { ...bot, session: bot.id }]))
    const listeners = new Set(), schedules = new Map()
    bots.refresh = async () => {}
    bots.watch = listener => { listeners.add(listener); return () => listeners.delete(listener) }
    bots.listSchedules = async id => schedules.get(id) ?? []
    const roomIDs = fixture.rooms.map(room => room.id)
    const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots, roomId: () => roomIDs.shift() })
    await rooms.initialize()
    for (const room of fixture.rooms) {
      const { id, recent, ...definition } = room
      await rooms.create(definition)
      await rooms.appendMessage(id, { schema: 'bellteam.room-message.v1', kind: 'message', id: `baseline-${id}-1`, at: '2026-01-01T00:00:00Z', message: `${room.name}の初期行`, sender: { id: room.representativeId, name: bots.get(room.representativeId).name } })
      await rooms.messageView(id)
    }
    const logPath = join(root, 'direct.jsonl')
    await writeFile(logPath, fixture.bots.flatMap(bot => [1, 2].map(n => direct(`baseline-${bot.id}-${n}`, bot.id, `${bot.name}の初期行${n}`, { at: `2026-01-01T00:00:0${n}Z` }))).map(line).join(''))
    const store = new ConversationStore({ logPath })
    await store.timelineViews([...bots.keys()])
    const secretRequests = new SecretRequests({ root, bots, rooms, notify: async () => {} })
    const ownerQuestions = new OwnerQuestions({ root, bots, notify: async () => {} })
    await secretRequests.initialize(); await ownerQuestions.initialize()
    const transport = new AitermTransport({ client: { async call(name) {
      cli.push({ name, at: Date.now() })
      if (name === 'pty_list') return { content: [{ type: 'text', text: [...bots.keys()].map(id => `${id}\tfixture`).join('\n') }] }
      if (name === 'pty_read') return { content: [{ type: 'text', text: '結合試験の人工画面' }] }
      throw new Error(`FIXTURE_CLI_UNEXPECTED: ${name}`)
    } } })
    // 製品へ渡す通知をそのまま記録し、合流後のSSEと発生源を照合する。
    for (const [source, target, method] of [
      ['conversation-store', store, 'watch'], ['room-registry', rooms, 'watch'],
      ['secret-requests', secretRequests, 'watch'], ['owner-questions', ownerQuestions, 'watch'],
      ['fixture-bots', bots, 'watch'], ['transport-queue', transport, 'watchQueue'],
    ]) {
      const watch = target[method].bind(target)
      target[method] = listener => watch(change => {
        changes.push({ source, at: Date.now(), change: structuredClone(change) })
        listener(change)
      })
    }
    const owner = structuredClone(fixture.owner)
    // 予定の実行器は構築しない。未来予定は表示用で、時刻実行も手動runの接続先も持たない。
    const server = createBellTeamServer({
      bots, rooms, store, transport, secretRequests, ownerQuestions,
      authorize: () => true, authMode: () => 'local', writeLog() {},
      ownerProfile: { get: async () => ({ ...owner }) },
      harnessAuth: { list: () => ({ harnesses: [] }) },
      subscriptions: { current: async () => ({ productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer', setupComplete: true, entitled: false, state: 'none', autoRenewing: false }) },
      aiControl: { snapshot: () => ({ paused: false, state: 'enabled', unconfirmedBotIds: [] }), watch: () => () => {} },
      diagnostics: { record: async value => { diagnostics.push(value) } },
      models: { list: async () => ({}) },
    })
    state = { root, bots, rooms, store, logPath, server, transport, secretRequests, ownerQuestions, owner, listeners, schedules }
    await server.startMessageWatch()
    await listen(server, 0)
    return { ok: true, sourceRevision, botIds: [...bots.keys()], roomIds: [...rooms.keys()] }
  }
  async function control(url) {
    const scene = url.pathname.slice('/test/'.length), q = url.searchParams
    const bot = q.get('bot') ?? 'bot-one', room = q.get('room') ?? 'planning'
    const requireBot = id => { if (!state.bots.has(id)) throw new Error(`UNKNOWN_FIXTURE_BOT: ${id}`); return id }
    if (scene === 'reset') return reset()
    if (scene === 'clear-proof') { requests = []; events = []; changes = []; controls = []; cli = []; diagnostics = []; return { ok: true } }
    if (scene === 'scenarios') return integrationScenarios
    if (scene === 'proof') return { sourceRevision, requests, events, changes, controls, cli, diagnostics, subscribers: streams.size, connections: connectionSequence, botIds: [...state.bots.keys()], roomIds: [...state.rooms.keys()] }
    if (!Object.hasOwn(integrationScenarios, scene)) throw new Error('UNKNOWN_SCENE')
    controls.push({ scene, query: url.search, at: Date.now() })
    const id = nextId(scene), text = q.get('text') ?? `${id} 新着です。`
    if (scene === 'bot' || scene === 'peer') {
      const from = scene === 'bot' ? requireBot(bot) : requireBot(q.get('from') ?? 'bot-one')
      const target = scene === 'bot' ? 'user' : requireBot(q.get('to') ?? 'bot-two')
      await appendFile(state.logPath, line(direct(id, from, text, { target })))
    } else if (scene === 'status' || scene === 'unknown') {
      await appendFile(state.logPath, line({ schema: 'bellteam.delivery-status.v1', delivery_id: scene === 'unknown' ? 'missing-fixture-id' : q.get('id') ?? 'baseline-bot-one-1', delivery: q.get('delivery') ?? 'failed' }))
    } else if (scene === 'room') {
      const definition = state.rooms.require(room), from = definition.representativeId
      await state.rooms.appendMessage(room, { schema: 'bellteam.room-message.v1', kind: 'message', id, at: new Date().toISOString(), message: text, sender: { id: from, name: state.bots.get(from).name } })
    } else if (scene === 'queue') {
      requireBot(bot)
      const roomId = q.get('room')
      if (roomId) state.rooms.require(roomId)
      const jobId = `queue-${bot}-${roomId ?? 'direct'}`
      const job = { id: jobId, bot: state.bots.get(bot), startedAt: new Date().toISOString(), info: { context: roomId ? 'room' : 'direct', contextId: roomId ?? bot, target: bot } }
      if (q.get('active') === '0') state.transport.active.delete(jobId)
      else state.transport.active.set(jobId, job)
      state.transport.emitQueue(job)
    } else if (scene === 'request') {
      const item = await state.secretRequests.create({ botId: requireBot(bot), roomId: q.get('room'), toolId: 'integration-fixture', label: '結合試験', message: text })
      state.lastRequest = item.id
      return item
    } else if (scene === 'request-cancel') return state.secretRequests.cancel(q.get('id') ?? state.lastRequest)
    else if (scene === 'question') {
      const item = await state.ownerQuestions.create({ botId: requireBot(q.get('bot') ?? 'bot-three'), question: text, options: ['はい', 'いいえ'] })
      state.lastQuestion = item.id
      return item
    } else if (scene === 'answer') return state.ownerQuestions.answer(q.get('id') ?? state.lastQuestion, { choice: 'はい' })
    else if (scene === 'bot-schedule' || scene === 'room-schedule') {
      const name = q.get('title') ?? `結合試験予定 ${scene === 'bot-schedule' ? bot : room}`
      const input = { kind: 'once', at: '2099-01-01T00:00:00Z', enabled: true, prompt: text, name }
      if (scene === 'room-schedule') return state.rooms.setSchedule(room, input)
      requireBot(bot)
      const item = normalizeSchedule({ ...input, id, lastRunAt: null }, new Date())
      state.schedules.set(bot, [...(state.schedules.get(bot) ?? []), item])
      notifyBots(scoped('schedules', [bot])); return item
    } else if (scene === 'owner') { state.owner.name = text; notifyBots(scoped('owner')) }
    else if (scene === 'bot-profile') { requireBot(bot); state.bots.set(bot, { ...state.bots.get(bot), name: text, displayName: text }); notifyBots(scoped('bots', [bot])) }
    else if (scene === 'unknown-topic') inject(JSON.stringify({ at: new Date().toISOString(), all: false, topics: ['future-topic'], botIds: [bot], roomIds: [] }))
    else if (scene === 'legacy') inject(JSON.stringify({ at: new Date().toISOString() }))
    else if (scene === 'invalid-scope') inject(JSON.stringify({ at: new Date().toISOString(), all: false, topics: ['timeline'] }))
    else if (scene === 'invalid') inject('{broken')
    else if (scene === 'reconnect') closeStreams()
    return { ok: true, id, text }
  }
  await reset()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local')
    if (url.pathname.startsWith('/test/')) {
      const run = actions.then(() => control(url))
      actions = run.catch(() => {})
      try { return json(response, await run) } catch (error) { return json(response, { error: error.message }, 400) }
    }
    const record = { method: request.method, path: url.pathname, query: url.search, at: Date.now(), status: null }
    requests.push(record)
    // 製品の送信操作は試験シーンからだけ発生させる。端末が誤って送れば証拠へ残す。
    if (!['GET', 'HEAD'].includes(request.method) && url.pathname !== '/api/diagnostics') {
      record.status = 405
      return json(response, { error: 'FIXTURE_READ_ONLY_API' }, 405)
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: state.server.address().port, path: request.url, method: request.method, headers: request.headers }, incoming => {
      record.status = incoming.statusCode
      response.writeHead(incoming.statusCode, incoming.headers)
      if (url.pathname === '/api/events' && incoming.statusCode === 200) {
        const stream = { id: ++connectionSequence, upstream, response, buffer: '', decoder: new StringDecoder('utf8') }
        streams.add(stream)
        incoming.on('data', chunk => capture(stream, chunk, 'product-server'))
        response.on('close', () => { streams.delete(stream); upstream.destroy() })
      }
      incoming.pipe(response)
    })
    upstream.on('error', error => {
      if (!response.headersSent) { record.status = 502; json(response, { error: error.code ?? error.message }, 502) }
      else response.end()
    })
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  try { await listen(server, port) }
  catch (error) { await stop(state.server); await rm(state.root, { recursive: true, force: true }); throw error }
  return {
    url: `http://127.0.0.1:${server.address().port}`, sourceRevision,
    async close() { await actions; closeStreams(); await stop(server); await stop(state.server); await rm(state.root, { recursive: true, force: true }) },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startAppleIntegrationServer({ port: Number(process.env.BELLTEAM_INTEGRATION_PORT ?? 0) })
  console.log(JSON.stringify({ url: fixture.url, sourceRevision: fixture.sourceRevision, scenarios: '/test/scenarios' }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0) })
}
