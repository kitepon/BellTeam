import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { SubscriptionAccessError } from './subscriptions.mjs'
import { LiveModelCatalog, ModelCatalogError } from './model-catalog.mjs'

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
])

// 会話の知らせ（SSE）を黙らせない間隔。
export const EVENT_KEEPALIVE_MS = 25000
// 一つの変更で複数の監視が続けて鳴る。この間の知らせは1件にまとめる。
export const MESSAGE_EVENT_WINDOW_MS = 50
// 待機中の接続を閉じるまでの時間。Nodeの既定5秒は、再利用の瞬間に閉じて通信断（-1005）を起こす。
// 手前の中継（cloudflaredの既定90秒）より長く保つ。
export const KEEP_ALIVE_TIMEOUT_MS = 125000

const avatarVersions = new Map()

// アバターはdata URLで保存している。版は中身から決め、アプリは版が変わった時だけ画像を取り直す。
export function avatarVersion(avatar) {
  if (typeof avatar !== 'string' || !avatar) return ''
  let version = avatarVersions.get(avatar)
  if (!version) {
    if (avatarVersions.size >= 256) avatarVersions.clear()
    version = createHash('sha256').update(avatar).digest('hex').slice(0, 16)
    avatarVersions.set(avatar, version)
  }
  return version
}

// 一覧の `?avatar=omit` は画像本体を外す。指定の無い古いアプリには今までどおり本体を返す。
function listAvatar(avatar, url) {
  const value = typeof avatar === 'string' ? avatar : ''
  return { avatar: url.searchParams.get('avatar') === 'omit' ? '' : value, avatarVersion: avatarVersion(value) }
}

function sendAvatar(request, response, avatar, url) {
  const match = typeof avatar === 'string' ? avatar.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u) : null
  if (!match) return json(response, 404, { error: 'AVATAR_NOT_FOUND' })
  const version = avatarVersion(avatar)
  const headers = {
    etag: `"${version}"`,
    // 版つきURLの中身は変わらない。版の無い取得は毎回確かめさせる。
    'cache-control': url.searchParams.get('v') === version ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  }
  if (request.headers['if-none-match'] === headers.etag) {
    response.writeHead(304, headers)
    return response.end()
  }
  const body = Buffer.from(match[2], 'base64')
  response.writeHead(200, { ...headers, 'content-type': match[1], 'content-length': body.length })
  response.end(body)
}

// 書き込み系の要求は、受付の時刻と結果を1行残す。
// 保存が届いたか・応答を返し終えたかを、端末側の時刻と後から照合するため（本文と問い合わせ文字列は残さない）。
// 応答を返し終える前に接続が切れた時は、状態コードの代わりに aborted と書く。
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
function logWriteRequest(request, response, write) {
  const path = String(request.url).split('?')[0]
  if (!WRITE_METHODS.has(request.method) || !path.startsWith('/api/')) return
  const started = Date.now()
  let finished = false
  response.once('finish', () => { finished = true })
  response.once('close', () => {
    write(`BellTeam write: ${new Date(started).toISOString()} ${request.method} ${path} ${finished ? response.statusCode : 'aborted'} ${Date.now() - started}ms\n`)
  })
}

export function createBellTeamServer({ bots, rooms, roomMessenger, authorize, messenger, store, transport, memory, ownerProfile, refreshGlobalInstructions = async () => {}, assets, staticRoot, assetVersion = Date.now().toString(36), models = new LiveModelCatalog(), scheduler = null, userRules = null, characterSheets = null, diagnostics = null, secretRequests = null, ownerQuestions = null, notifications = null, subscriptions = null, settings = null, onboarding = null, authMode = () => 'cloudflare', internal = false, seatMcp = null, eventKeepalive = EVENT_KEEPALIVE_MS, messageEventWindow = MESSAGE_EVENT_WINDOW_MS, writeLog = line => process.stderr.write(line) }) {
  if (typeof authorize !== 'function') throw new Error('BELLTEAM_AUTHORIZER_REQUIRED')
  const subscribers = new Set()
  let closeWatch = null
  let pendingNotify = null
  const timeline = async (kind, id) => [
    ...await (kind === 'rooms' ? rooms.messages(id) : store.timeline(id)),
    ...secretRequests?.timeline(kind === 'rooms' ? { roomId: id } : { botId: id }) ?? [],
    ...(kind === 'bots' ? ownerQuestions?.timeline({ botId: id }) ?? [] : []),
  ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))

  const server = createServer(async (request, response) => {
    logWriteRequest(request, response, writeLog)
    try {
      const url = new URL(request.url, 'http://bellteam.local')
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' })
      const authenticated = await authorize(request)
      if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, { authenticated, authMode: authMode(request) })
      if (!authenticated) return json(response, 401, { error: 'UNAUTHORIZED' })
      // 席のCLIがつなぐMCP。内部入口（loopback）だけで開く。
      if (internal && seatMcp && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) return await seatMcp(request, response, url)

      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/setup' && request.method === 'GET') return json(response, 200, onboarding ? await onboarding.status() : { phase: 'ready', harness: null, harnesses: [], guideBotId: null, complete: true, auth: null })
        if (url.pathname.startsWith('/api/setup/') && request.method === 'POST') {
          if (!onboarding) return json(response, 404, { error: 'NOT_FOUND' })
          const body = await readJson(request, 8192)
          const actions = {
            '/api/setup/harness': () => onboarding.select(body.harness),
            '/api/setup/auth/input': () => onboarding.input(body),
            '/api/setup/start': () => onboarding.start(),
            '/api/setup/complete': () => onboarding.complete(internal ? body.botId : undefined),
          }
          if (!actions[url.pathname]) return json(response, 404, { error: 'NOT_FOUND' })
          const setup = await actions[url.pathname]()
          server.notify({ type: 'setup' })
          return json(response, 200, setup)
        }
        if (url.pathname === '/api/settings' && request.method === 'GET') return json(response, 200, { settings: settings?.list() ?? [] })
        const settingsMatch = url.pathname.match(/^\/api\/settings\/([A-Za-z]+)$/u)
        if (settingsMatch && request.method === 'PATCH') {
          if (!settings) return json(response, 404, { error: 'NOT_FOUND' })
          const body = await readJson(request, 32768)
          const botId = internal ? body.botId : undefined
          if (internal) delete body.botId
          const setting = await settings.update(settingsMatch[1], body, { secretRequests, botId, allowSecretValues: !internal })
          return json(response, 200, { setting })
        }
        if (url.pathname.startsWith('/api/subscription')) {
          if (!subscriptions) return json(response, 503, { error: 'SUBSCRIPTION_NOT_CONFIGURED' })
          if (request.method === 'GET' && url.pathname === '/api/subscription') return json(response, 200, { subscription: await subscriptions.current() })
          if (request.method === 'POST' && url.pathname === '/api/subscription/verify')
            return json(response, 200, { subscription: await subscriptions.install((await readJson(request, 32768)).signedTransaction) })
          if (request.method === 'POST' && url.pathname === '/api/subscription/refresh')
            return json(response, 200, { subscription: await subscriptions.refresh({ force: true }) })
          if (request.method === 'POST' && url.pathname === '/api/subscription/setup-test') {
            if (onboarding && !onboarding.snapshot().complete) return json(response, 409, { error: 'SETUP_GUIDE_REQUIRED', message: '案内役との会話で初期設定を進めてください。' })
            const { botId } = await readJson(request, 4096)
            await bots.refresh?.()
            const bot = bots.get(botId)
            if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
            if (!transport.isIdle(bot.id)) throw new SubscriptionAccessError('SETUP_BOT_BUSY', 409, 'メンバーが作業中です。完了してから動作確認してください。')
            return json(response, 200, await subscriptions.runSetupTest(bot.id, () => transport.setupTest(bot)))
          }
          return json(response, 404, { error: 'NOT_FOUND' })
        }
        if (url.pathname.startsWith('/api/notifications')) {
          if (!notifications) return json(response, 404, { error: 'NOT_FOUND' })
          if (request.method === 'GET' && url.pathname === '/api/notifications') return json(response, 200, notifications.status())
          if (request.method === 'POST' && url.pathname === '/api/notifications/devices')
            return json(response, 200, await notifications.register(await readJson(request, 32768)))
          if (request.method === 'POST' && url.pathname === '/api/notifications/unregister')
            return json(response, 200, await notifications.unregister(await readJson(request, 4096)))
          return json(response, 404, { error: 'NOT_FOUND' })
        }
        if (url.pathname.startsWith('/api/secret-requests')) {
          if (!secretRequests) return json(response, 404, { error: 'NOT_FOUND' })
          if (request.method === 'POST' && url.pathname === '/api/secret-requests' && internal) {
            return json(response, 201, { request: await secretRequests.create(await readJson(request, 8192)) })
          }
          const match = url.pathname.match(/^\/api\/secret-requests\/([a-f0-9-]+)(?:\/(submit|cancel))?$/u)
          if (!match) return json(response, 404, { error: 'NOT_FOUND' })
          const [, id, action] = match
          if (request.method === 'GET' && !action) return json(response, 200, { request: secretRequests.get(id) })
          if (request.method !== 'POST' || !action || internal) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
          if (authMode(request) !== 'local' && !request.socket.encrypted && request.headers['x-forwarded-proto'] !== 'https') {
            return json(response, 426, { error: 'SECRET_HTTPS_REQUIRED' })
          }
          if (!request.headers['content-type']?.startsWith('application/json')
            || request.headers['sec-fetch-site'] === 'cross-site') {
            return json(response, 400, { error: 'SECRET_REQUEST_INVALID' })
          }
          const body = await readJson(request, 131072)
          const result = action === 'submit'
            ? await secretRequests.submit(id, body?.value)
            : await secretRequests.cancel(id)
          return json(response, 200, { request: result })
        }
        if (url.pathname.startsWith('/api/owner-questions')) {
          if (!ownerQuestions) return json(response, 404, { error: 'NOT_FOUND' })
          if (request.method === 'POST' && url.pathname === '/api/owner-questions' && internal) {
            return json(response, 201, { question: await ownerQuestions.create(await readJson(request, 65536)) })
          }
          const match = url.pathname.match(/^\/api\/owner-questions\/([a-f0-9-]+)(?:\/(answer))?$/u)
          if (!match) return json(response, 404, { error: 'NOT_FOUND' })
          const [, id, action] = match
          if (request.method === 'GET' && !action) return json(response, 200, { question: ownerQuestions.get(id) })
          if (request.method !== 'POST' || !action || internal) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
          return json(response, 200, { question: await ownerQuestions.answer(id, await readJson(request, 65536)) })
        }
        if (request.method === 'POST' && url.pathname === '/api/diagnostics') {
          if (!diagnostics) return json(response, 404, { error: 'NOT_FOUND' })
          const report = await readJson(request, 65536)
          if (typeof report?.code !== 'string' || !report.code.startsWith('IOS_')) return json(response, 400, { error: 'DIAGNOSTIC_INVALID' })
          await diagnostics.record(report)
          return json(response, 202, { accepted: true })
        }
        if (request.method === 'GET' && url.pathname === '/api/models')
          return json(response, 200, { models: await models.list(url.searchParams.get('harness') || undefined) })
        await bots.refresh?.()
        if (request.method === 'GET' && url.pathname === '/api/owner') {
          const owner = await ownerProfile.get()
          return json(response, 200, { owner: { ...owner, ...listAvatar(owner.avatar, url) } })
        }
        if (request.method === 'GET' && url.pathname === '/api/owner/avatar') return sendAvatar(request, response, (await ownerProfile.get()).avatar, url)
        if (request.method === 'PATCH' && url.pathname === '/api/owner') {
          const owner = await ownerProfile.update(await readJson(request))
          await refreshGlobalInstructions()
          return json(response, 200, { owner })
        }
        if (request.method === 'GET' && url.pathname === '/api/user-rules') return json(response, 200, { text: await userRules.get() })
        if (request.method === 'PUT' && url.pathname === '/api/user-rules') {
          const text = await userRules.update((await readJson(request)).text)
          await refreshGlobalInstructions()
          return json(response, 200, { text })
        }
        if (request.method === 'GET' && url.pathname === '/api/events') {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          })
          response.write('event: ready\ndata: {}\n\n')
          subscribers.add(response)
          // 知らせの無い間も流れを止めない。アプリ（URLSessionの既定60秒）や途中の中継が、黙った接続を時間切れにするため。
          const keepalive = setInterval(() => response.write(': keepalive\n\n'), eventKeepalive)
          request.on('close', () => {
            clearInterval(keepalive)
            subscribers.delete(response)
          })
          return
        }
        const imageAssetMatch = url.pathname.match(/^\/api\/message-images\/([a-z0-9-]+)\/([a-z0-9-]+\.(?:png|jpg|webp|gif))$/u)
        if (request.method === 'GET' && imageAssetMatch) {
          if (!assets) return json(response, 404, { error: 'IMAGE_ASSET_NOT_FOUND' })
          const asset = await assets.open(imageAssetMatch[1], imageAssetMatch[2])
          response.writeHead(200, {
            'content-type': asset.mime,
            'content-length': asset.size,
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          })
          return asset.stream.pipe(response)
        }
        if (request.method === 'GET' && url.pathname === '/api/bots') {
          const all = [...bots.values()]
          const running = await transport.runningBots(all)
          const list = await Promise.all(all.map(async bot => {
            const items = await timeline('bots', bot.id)
            const last = items.at(-1) ?? null
            return {
              id: bot.id,
              name: bot.name ?? bot.displayName ?? bot.id,
              displayName: bot.displayName ?? bot.id,
              harness: bot.harness,
              model: bot.model ?? '',
              reasoningEffort: bot.reasoningEffort ?? '',
              color: bot.color ?? 'violet',
              profileText: bot.profileText ?? '',
              personality: bot.personality ?? '',
              speechStyle: bot.speechStyle ?? '',
              position: bot.position ?? '',
              role: bot.role ?? '',
              ...listAvatar(bot.avatar, url),
              online: running.has(bot.id),
              recent: last && { id: last.id, kind: last.kind, direction: last.direction, message: last.message, image: last.image, at: last.at },
            }
          }))
          return json(response, 200, { bots: list })
        }
        if (request.method === 'GET' && url.pathname === '/api/rooms') {
          await rooms.refresh()
          const list = await Promise.all([...rooms.values()].map(async room => ({
            ...room, ...listAvatar(room.avatar, url), recent: (await timeline('rooms', room.id)).at(-1) ?? null,
          })))
          return json(response, 200, { rooms: list })
        }
        if (request.method === 'POST' && url.pathname === '/api/rooms') {
          return json(response, 201, { room: await rooms.create(await readJson(request)) })
        }
        if (request.method === 'POST' && url.pathname === '/api/bots') {
          const bot = await bots.create(await readJson(request))
          await memory?.ensureScope(bot.id, 'personal')
          return json(response, 201, { bot })
        }
        if (request.method === 'POST' && url.pathname === '/api/deliveries/direct') {
          return json(response, 200, await messenger.sendmessage(await readJson(request)))
        }
        if (request.method === 'POST' && url.pathname === '/api/deliveries/room') {
          return json(response, 200, await roomMessenger.sendroommessage(await readJson(request)))
        }
        if (request.method === 'GET' && url.pathname === '/api/queue') {
          return json(response, 200, { items: transport.queueItems() })
        }

        const sheetListMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/character-sheet$/u)
        if (request.method === 'GET' && sheetListMatch) {
          const botId = sheetListMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          const sheets = await characterSheets.list(botId)
          return json(response, 200, { sheets: sheets.map(sheet => ({ ...sheet, url: `/api/bots/${botId}/character-sheet/${encodeURIComponent(sheet.file)}` })) })
        }
        const sheetFileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/character-sheet\/([^/]+)$/u)
        if (request.method === 'GET' && sheetFileMatch) {
          const botId = sheetFileMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          const sheet = await characterSheets.open(botId, decodeURIComponent(sheetFileMatch[2]))
          response.writeHead(200, {
            'content-type': sheet.mime,
            'content-length': sheet.size,
            'cache-control': 'private, no-cache',
            'x-content-type-options': 'nosniff',
          })
          return sheet.stream.pipe(response)
        }

        const restartMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/restart$/u)
        if (request.method === 'POST' && restartMatch) {
          const botId = restartMatch[1]
          const bot = bots.get(botId)
          if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          transport.restart(bot).catch(error => process.stderr.write(`BellTeam restart error: ${error.stack ?? error.message}\n`))
          return json(response, 202, { restarting: botId })
        }

        const screenMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/screen$/u)
        if (request.method === 'GET' && screenMatch) {
          const bot = bots.get(screenMatch[1])
          if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return json(response, 200, await transport.screen(bot))
        }

        const botAvatarMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/avatar$/u)
        if (request.method === 'GET' && botAvatarMatch) {
          if (!bots.has(botAvatarMatch[1])) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return sendAvatar(request, response, bots.get(botAvatarMatch[1]).avatar, url)
        }
        const profileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/u)
        if (profileMatch) {
          const botId = profileMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, { bot: bots.get(botId) })
          if (request.method === 'PATCH') {
            const current = bots.get(botId)
            const changes = await readJson(request)
            const candidate = await bots.previewUpdate(botId, changes)
            const harnessChanged = candidate.harness !== current.harness
            const configurationChanged = harnessChanged || candidate.model !== current.model
              || candidate.reasoningEffort !== current.reasoningEffort
            const wasRunning = configurationChanged ? await transport.isRunning(current) : false
            // 稼働中Botへの適用は現在の作業の後に並ぶ。保存の応答はそれを待たずに返す。
            if (wasRunning) {
              transport.reconfigure(current, candidate)
                .catch(error => process.stderr.write(`BellTeam reconfigure error: ${error.stack ?? error.message}\n`))
            }
            const bot = await bots.update(botId, changes)
            return json(response, 200, { bot, harnessChanged, configurationChanged, applying: wasRunning })
          }
          if (request.method === 'DELETE') {
            const bot = bots.get(botId)
            void (async () => {
              await transport.stop(bot)
              await rooms.removeBot(botId)
              await bots.remove(botId)
            })().catch(error => process.stderr.write(`BellTeam delete error: ${error.stack ?? error.message}\n`))
            return json(response, 202, { deleting: botId })
          }
        }

        const candidateActionMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/candidates\/([^/]+)\/(organize|dismiss)$/u)
        if (request.method === 'POST' && candidateActionMatch) {
          const [, botId, candidateId, action] = candidateActionMatch
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          if (action === 'organize') return json(response, 200, await memory.organizeMemoryCandidate({
            botId, candidateId, ...await readJson(request),
          }))
          return json(response, 200, await memory.dismissMemoryCandidate({ botId, candidateId }))
        }

        const candidatesMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/candidates$/u)
        if (request.method === 'GET' && candidatesMatch) {
          const botId = candidatesMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return json(response, 200, await memory.listMemoryCandidates({
            botId, limit: url.searchParams.get('limit') ?? undefined,
          }))
        }

        const memoryPinMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/([^/]+)\/pin$/u)
        if (request.method === 'POST' && memoryPinMatch) {
          const [, botId, id] = memoryPinMatch
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return json(response, 200, await memory.pinMemory({ botId, id, ...await readJson(request) }))
        }

        const memoryItemMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/([^/]+)$/u)
        if (request.method === 'PATCH' && memoryItemMatch) {
          const [, botId, id] = memoryItemMatch
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return json(response, 200, await memory.reviseMemory({ botId, id, ...await readJson(request) }))
        }

        const memoryConsolidateMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/consolidate-growth$/u)
        if (request.method === 'POST' && memoryConsolidateMatch) {
          const botId = memoryConsolidateMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return json(response, 200, await memory.consolidateGrowth({ botId, ...await readJson(request) }))
        }

        const memoryMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory$/u)
        if (memoryMatch) {
          const botId = memoryMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, await memory.recallMemory({
            botId, query: url.searchParams.get('query') ?? '', scope: url.searchParams.get('scope') ?? 'personal',
          }))
          if (request.method === 'POST') return json(response, 201, await memory.remember({
            botId, ...await readJson(request), sourceRef: 'ui',
          }))
        }

        const knowledgeMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/knowledge$/u)
        if (knowledgeMatch) {
          const botId = knowledgeMatch[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, await memory.searchKnowledge({
            botId, query: url.searchParams.get('query') ?? '', scope: url.searchParams.get('scope') ?? 'personal',
          }))
          if (request.method === 'POST') return json(response, 201, await memory.recordKnowledge({
            botId, ...await readJson(request),
          }))
        }

        const botQueueMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/queue$/u)
        if (request.method === 'GET' && botQueueMatch) {
          if (!bots.has(botQueueMatch[1])) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          return json(response, 200, { items: transport.queueItems({ botId: botQueueMatch[1] }) })
        }

        const scheduleRunMatch = url.pathname.match(/^\/api\/(bots|rooms)\/([a-z0-9-]+)\/schedules\/([^/]+)\/run$/u)
        if (request.method === 'POST' && scheduleRunMatch) {
          if (!scheduler) return json(response, 503, { error: 'SCHEDULER_UNAVAILABLE' })
          const [, kind, ownerId, scheduleId] = scheduleRunMatch
          const ran = kind === 'rooms'
            ? await scheduler.runRoomSchedule(ownerId, decodeURIComponent(scheduleId))
            : await scheduler.runBotSchedule(ownerId, decodeURIComponent(scheduleId))
          return json(response, 202, { ran: ran.id })
        }

        const scheduleMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/schedules(?:\/([^/]+))?$/u)
        if (scheduleMatch) {
          const botId = scheduleMatch[1]
          const scheduleId = scheduleMatch[2]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          if (request.method === 'GET' && !scheduleId)
            return json(response, 200, { schedules: await bots.listSchedules(botId) })
          if (request.method === 'POST' && !scheduleId) {
            const schedule = await bots.setSchedule(botId, await readJson(request))
            return json(response, 201, { schedule })
          }
          if (request.method === 'PUT' && scheduleId) {
            const schedule = await bots.setSchedule(botId, { ...await readJson(request), id: decodeURIComponent(scheduleId) })
            return json(response, 200, { schedule })
          }
          if (request.method === 'DELETE' && scheduleId) {
            await bots.removeSchedule(botId, decodeURIComponent(scheduleId))
            response.writeHead(204)
            return response.end()
          }
        }

        const roomAvatarMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/avatar$/u)
        if (request.method === 'GET' && roomAvatarMatch) {
          await rooms.refresh()
          if (!rooms.has(roomAvatarMatch[1])) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
          return sendAvatar(request, response, rooms.get(roomAvatarMatch[1]).avatar, url)
        }
        const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)$/u)
        if (roomMatch) {
          await rooms.refresh()
          const roomId = roomMatch[1]
          if (!rooms.has(roomId)) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, { room: rooms.get(roomId) })
          if (request.method === 'PATCH') return json(response, 200, { room: await rooms.update(roomId, await readJson(request)) })
          if (request.method === 'DELETE') {
            await rooms.remove(roomId)
            response.writeHead(204)
            return response.end()
          }
        }

        const roomScheduleMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/schedules(?:\/([^/]+))?$/u)
        if (roomScheduleMatch) {
          await rooms.refresh()
          const roomId = roomScheduleMatch[1]
          const scheduleId = roomScheduleMatch[2]
          if (!rooms.has(roomId)) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
          if (request.method === 'GET' && !scheduleId) return json(response, 200, { schedules: await rooms.listSchedules(roomId) })
          if (request.method === 'POST' && !scheduleId)
            return json(response, 201, { schedule: await rooms.setSchedule(roomId, await readJson(request)) })
          if (request.method === 'PUT' && scheduleId)
            return json(response, 200, { schedule: await rooms.setSchedule(roomId, { ...await readJson(request), id: decodeURIComponent(scheduleId) }) })
          if (request.method === 'DELETE' && scheduleId) {
            await rooms.removeSchedule(roomId, decodeURIComponent(scheduleId))
            response.writeHead(204)
            return response.end()
          }
        }

        const exportMatch = url.pathname.match(/^\/api\/(bots|rooms)\/([a-z0-9-]+)\/export$/u)
        if (request.method === 'GET' && exportMatch) {
          const [, kind, id] = exportMatch
          if (kind === 'rooms') await rooms.refresh()
          const target = (kind === 'rooms' ? rooms : bots).get(id)
          if (!target) return json(response, 404, { error: kind === 'rooms' ? 'ROOM_NOT_FOUND' : 'BOT_NOT_FOUND' })
          return json(response, 200, {
            format: 'bellteam.conversation.v1',
            exportedAt: new Date().toISOString(),
            target: { kind, id, name: target.displayName ?? target.name ?? id },
            messages: (await timeline(kind, id)).map(webMessage),
          })
        }

        const roomMessagesMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/messages$/u)
        if (roomMessagesMatch) {
          await rooms.refresh()
          const roomId = roomMessagesMatch[1]
          if (!rooms.has(roomId)) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, pageItems((await timeline('rooms', roomId)).map(webMessage), url))
          if (request.method === 'POST') {
            const body = await readJson(request, MESSAGE_MAX_BYTES)
            const message = typeof body.message === 'string' ? body.message.trim() : ''
            const images = messageImages(body)
            if (!message && !images.length) return json(response, 400, { error: 'MESSAGE_REQUIRED' })
            return json(response, 200, await roomMessenger.sendroommessage({
              from: 'user', room: roomId, message, images, targets: body.targets ?? null,
            }))
          }
        }

        const roomQueueMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/queue$/u)
        if (request.method === 'GET' && roomQueueMatch) {
          await rooms.refresh()
          if (!rooms.has(roomQueueMatch[1])) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
          return json(response, 200, { items: transport.queueItems({ roomId: roomQueueMatch[1] }) })
        }

        const match = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/messages$/u)
        if (match) {
          const botId = match[1]
          if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, pageItems((await timeline('bots', botId)).map(webMessage), url))
          if (request.method === 'POST') {
            const body = await readJson(request, MESSAGE_MAX_BYTES)
            const message = typeof body.message === 'string' ? body.message.trim() : ''
            const images = messageImages(body)
            if (!message && !images.length)
              return json(response, 400, { error: 'MESSAGE_REQUIRED' })
            const result = await messenger.enqueueUserTurn({ target: botId, message, images })
            return json(response, 200, result)
          }
        }
        return json(response, 404, { error: 'NOT_FOUND' })
      }

      if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      return staticFile(response, staticRoot, url.pathname, assetVersion)
    } catch (error) {
      if (typeof error.code === 'string' && Number.isInteger(error.status)) return json(response, error.status, { error: error.code, message: error.publicMessage ?? error.message })
      if (error instanceof SubscriptionAccessError) return json(response, error.status, { error: error.code, message: error.message })
      if (request.url?.startsWith('/api/subscription') && ['INVALID_JSON', 'REQUEST_TOO_LARGE'].includes(error.message))
        return json(response, 400, { error: error.message, message: '購入情報または動作確認のリクエスト形式を確認してください。' })
      if (error.message === 'PUSH_DEVICE_INVALID') return json(response, 400, { error: error.message })
      if (['PUSH_NOT_CONFIGURED', 'PUSH_ENVIRONMENT_UNAVAILABLE'].includes(error.message))
        return json(response, 503, { error: error.message })
      if (request.url?.startsWith('/api/secret-requests')) {
        const statuses = {
          SECRET_REQUEST_NOT_FOUND: 404, SECRET_REQUEST_CLOSED: 409,
          SECRET_REQUEST_INVALID: 400, SECRET_VALUE_INVALID: 400, SECRET_ROOM_INVALID: 400,
          BOT_NOT_FOUND: 404, INVALID_JSON: 400, REQUEST_TOO_LARGE: 400,
        }
        if (Object.hasOwn(statuses, error.message)) return json(response, statuses[error.message], { error: error.message })
        // この入口のエラーは、入力値を含み得る例外本文・スタックを記録しない。
        process.stderr.write('BellTeam: 秘密情報の登録処理に失敗しました\n')
        try {
          await diagnostics?.record({ code: 'SERVER_SECRET_FAILED', module: 'secrets', diagnostic_log: '秘密情報の登録処理に失敗。入力値・例外本文は記録しません。' })
        } catch {
          process.stderr.write('BellTeam: 秘密情報処理の診断を保存できませんでした\n')
        }
        return json(response, 500, { error: 'SECRET_OPERATION_FAILED' })
      }
      if (error instanceof ModelCatalogError) return json(response, error.code === 'MODEL_HARNESS_INVALID' ? 400 : 503, { error: error.code, message: error.message })
      if (error.message === 'INVALID_JSON') return json(response, 400, { error: 'INVALID_JSON' })
      if (error.message === 'DIAGNOSTIC_INVALID' || error.message === 'REQUEST_TOO_LARGE') return json(response, 400, { error: error.message })
      if (error.message === 'IMAGE_ASSET_NOT_FOUND') return json(response, 404, { error: error.message })
      if (error.message === 'CHARACTER_SHEET_NOT_FOUND') return json(response, 404, { error: error.message })
      if (error.message === 'CHARACTER_SHEET_INVALID') return json(response, 400, { error: error.message })
      if (/^IMAGE_/u.test(error.message)) return json(response, 400, { error: error.message })
      if (/^(?:BOT|ROOM|SCHEDULE|QUEUE|OWNER_QUESTION)_(?:NOT_FOUND)/u.test(error.message)) return json(response, 404, { error: error.message })
      if (error.message === 'OWNER_QUESTION_CLOSED') return json(response, 409, { error: error.message })
      if (/^OWNER_QUESTION_/u.test(error.message)) return json(response, 400, { error: error.message })
      if (/^BOT_DUPLICATE/u.test(error.message)) return json(response, 409, { error: error.message })
      if (/^(?:BOT|ROOM|SCHEDULE|MEMORY|KNOWLEDGE|SEARCH|OWNER)_/u.test(error.message)) return json(response, 400, { error: error.message })
      // fetchの失敗はスタックを持たない。どの要求が何で失敗したかを後から引けるよう、要求と原因の符号も残す（問い合わせ文字列は残さない）。
      const cause = error.cause?.code ?? error.cause?.message
      process.stderr.write(`BellTeam HTTP error: ${request.method} ${String(request.url).split('?')[0]}${cause ? ` cause=${cause}` : ''}: ${error.stack ?? error.message}\n`)
      if (diagnostics && request.url !== '/api/diagnostics') {
        try {
          const frames = String(error.stack ?? '').split('\n').slice(1)
            .filter(line => /^\s*at\s/u.test(line)).slice(0, 20)
            .map(line => line.replaceAll(process.cwd(), '<app>'))
          await diagnostics.record({
            code: 'SERVER_HTTP_500', module: 'server',
            diagnostic_log: `${error.constructor.name}\n${frames.join('\n')}`,
          })
        }
        catch (reportError) { process.stderr.write(`BellTeam diagnostics error: ${reportError.stack ?? reportError.message}\n`) }
      }
      return json(response, 500, { error: 'INTERNAL_ERROR' })
    }
  })

  server.notify = data => {
    for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(data)}\n\n`)
  }
  server.startMessageWatch = async () => {
    if (closeWatch) return
    const notify = () => {
      // アプリは知らせ1件ごとに一覧を読み直す。同じ変更の知らせを重ねて流さない。
      if (pendingNotify) return
      pendingNotify = setTimeout(() => {
        pendingNotify = null
        for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: {"at":${JSON.stringify(new Date().toISOString())}}\n\n`)
      }, messageEventWindow)
    }
    const stops = [await store.watch(notify)]
    if (secretRequests) stops.push(secretRequests.watch(notify))
    if (ownerQuestions) stops.push(ownerQuestions.watch(notify))
    if (rooms?.watch) stops.push(await rooms.watch(notify))
    if (transport?.watchQueue) stops.push(transport.watchQueue(notify))
    closeWatch = () => stops.forEach(stop => stop())
  }
  server.on('close', () => {
    closeWatch?.()
    closeWatch = null
    clearTimeout(pendingNotify)
    pendingNotify = null
  })
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  // 止める時に処理中だった接続は、応答を返し終えたら閉じる。待機時間の満了まで停止を待たせない。
  // 知らせの流れは自分からは終わらないので、ここで終える。アプリは再接続する。
  const closeServer = server.close.bind(server)
  server.close = callback => {
    for (const subscriber of subscribers) subscriber.end()
    if (internal) seatMcp?.close()
    const reap = setInterval(() => server.closeIdleConnections(), 50)
    server.once('close', () => clearInterval(reap))
    return closeServer(callback)
  }
  return server
}

// 会話は最新から読む。limit=最新からの件数、before=そのIDより前、after=そのIDより後（差分）。
export function pageItems(items, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 10))
  const before = url.searchParams.get('before')
  const after = url.searchParams.get('after')
  if (after) {
    const index = items.findIndex(item => item.id === after)
    return { items: index < 0 ? items.slice(-limit) : items.slice(index + 1), has_more: false }
  }
  let end = items.length
  if (before) {
    const index = items.findIndex(item => item.id === before)
    if (index >= 0) end = index
  }
  const start = Math.max(0, end - limit)
  return { items: items.slice(start, end), has_more: start > 0 }
}

// 画像の保存先は記録に残し、画面へは取得用のURLだけを渡す。`image_url` は1枚しか読まない古いアプリ向けに1枚目を入れる。
function webMessage(item) {
  const imageAsset = item.imageAsset ?? item.image_asset ?? null
  const { imageAsset: _camelAsset, image_asset: _snakeAsset, imageAssets: camelAssets, image_assets: snakeAssets, ...visible } = item
  const imageAssets = camelAssets ?? snakeAssets ?? []
  const assets = imageAssets.length ? imageAssets : imageAsset ? [imageAsset] : []
  if (!assets.length) return visible
  const urls = assets.map(asset => `/api/message-images/${encodeURIComponent(asset.owner)}/${encodeURIComponent(asset.file)}`)
  return { ...visible, image: true, image_url: urls[0], image_urls: urls }
}

// 画像を何枚も付けた送信を受ける。Cloudflareの無料プランが受ける本文の上限（100MB）に収める。
const MESSAGE_MAX_BYTES = 96 * 1024 * 1024

// 送信の画像は `images`（複数）で受ける。1枚の `image` しか送らない古いアプリの送信も受ける。
function messageImages(body) {
  if (Array.isArray(body.images)) {
    if (body.images.some(image => !image || typeof image !== 'object')) throw new Error('IMAGE_INVALID')
    return body.images
  }
  if (body.images !== undefined) throw new Error('IMAGE_INVALID')
  return body.image ? [body.image] : []
}

// 塊ごとに文字へ直すと、塊の境目で割れた日本語が化けるので、全部つないでから読む。
async function readJson(request, maxBytes = 16 * 1024 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('INVALID_JSON') }
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function staticFile(response, root, pathname, assetVersion) {
  if (!root) return json(response, 404, { error: 'NOT_FOUND' })
  const files = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/styles.css', 'styles.css'],
    ['/app.js', 'app.js'],
    ['/onboarding.js', 'onboarding.js'],
    ['/server-origin.js', 'server-origin.js'],
    ['/chat-input.js', 'chat-input.js'],
    ['/rich-text.js', 'rich-text.js'],
    ['/secret-input.js', 'secret-input.js'],
    ['/owner-question.js', 'owner-question.js'],
    ['/activity-order.js', 'activity-order.js'],
    ['/image-gallery.js', 'image-gallery.js'],
    ['/manifest.webmanifest', 'manifest.webmanifest'],
    ['/icons/apple-touch-icon.png', 'icons/apple-touch-icon.png'],
    ['/apple-touch-icon.png', 'icons/apple-touch-icon.png'],
    ['/icons/icon-192.png', 'icons/icon-192.png'],
    ['/icons/icon-512.png', 'icons/icon-512.png'],
  ])
  const name = files.get(pathname)
  if (!name) return json(response, 404, { error: 'NOT_FOUND' })
  const file = join(root, name)
  const info = await stat(file)
  if (['index.html', 'app.js', 'rich-text.js', 'secret-input.js'].includes(name)) {
    const body = (await readFile(file, 'utf8')).replaceAll('__ASSET_VERSION__', assetVersion)
    response.writeHead(200, {
      'content-type': contentTypes.get(extname(file)),
      'content-length': Buffer.byteLength(body),
      'cache-control': name === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    return response.end(body)
  }
  response.writeHead(200, {
    'content-type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'public, max-age=31536000, immutable',
  })
  createReadStream(file).pipe(response)
}
