import { createServer } from 'node:http'
import { recentTimeline } from './timeline-index.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { stopFailureReport } from './stop-failure-report.mjs'
import { json, readJson } from './http-response.mjs'
import { logWriteRequest, logReadRequest } from './http-request-log.mjs'
import { listAvatar, sendAvatar, staticFile } from './http-assets.mjs'
import { respondHttpError } from './http-errors.mjs'
import { createMessageViews, webMessage, messageImages, MESSAGE_MAX_BYTES } from './http-messages.mjs'
import { createMessageEvents, EVENT_KEEPALIVE_MS, MESSAGE_EVENT_WINDOW_MS } from './http-events.mjs'

export { avatarVersion } from './http-assets.mjs'
export { pageItems } from './http-messages.mjs'
export { EVENT_KEEPALIVE_MS, MESSAGE_EVENT_WINDOW_MS }

// 待機中の接続を閉じるまでの時間。Nodeの既定5秒は、再利用の瞬間に閉じて通信断（-1005）を起こす。
// 手前の中継（cloudflaredの既定90秒）より長く保つ。
export const KEEP_ALIVE_TIMEOUT_MS = 125000

export function createBellTeamServer({ bots, rooms, roomMessenger, authorize, messenger, store, transport, memory, ownerProfile, refreshGlobalInstructions = async () => {}, assets, staticRoot, assetVersion = Date.now().toString(36), models = new LiveModelCatalog(), scheduler = null, userRules = null, characterSheets = null, diagnostics = null, secretRequests = null, ownerQuestions = null, notifications = null, subscriptions = null, settings = null, onboarding = null, harnessAuth = null, aiControl = null, authMode = () => 'cloudflare', internal = false, seatMcp = null, eventKeepalive = EVENT_KEEPALIVE_MS, messageEventWindow = MESSAGE_EVENT_WINDOW_MS, writeLog = line => process.stderr.write(line) }) {
  if (typeof authorize !== 'function') throw new Error('BELLTEAM_AUTHORIZER_REQUIRED')
  const events = createMessageEvents({ store, secretRequests, ownerQuestions, rooms, bots, transport, aiControl, eventKeepalive, messageEventWindow })
  const { sources, timeline, messagePage } = createMessageViews({ rooms, store, secretRequests, ownerQuestions })

  const server = createServer(async (request, response) => {
    logWriteRequest(request, response, writeLog)
    logReadRequest(request, response, writeLog)
    try {
      const url = new URL(request.url, 'http://bellteam.local')
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' })
      const authenticated = await authorize(request)
      if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, { authenticated, authMode: authMode(request) })
      if (!authenticated) return json(response, 401, { error: 'UNAUTHORIZED' })
      // 席のCLIがつなぐMCP。内部入口（loopback）だけで開く。
      if (internal && seatMcp && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) return await seatMcp(request, response, url)

      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/ai-control') {
          if (!aiControl) return json(response, 404, { error: 'NOT_FOUND' })
          if (request.method === 'GET') return json(response, 200, { control: aiControl.snapshot() })
          if (request.method !== 'PATCH') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
          const body = await readJson(request, 8192)
          if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.paused !== 'boolean')
            return json(response, 400, { error: 'AI_CONTROL_INVALID' })
          const result = await aiControl.update(body.paused)
          return json(response, result.status, { control: result.control, ...(result.error ? { error: result.error } : {}) })
        }
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
        // 初期設定の後に、AIの公式認証をやり直す入口。認証が切れて全員が止まった時も、利用者がここから戻せる。
        const harnessAuthMatch = url.pathname.match(/^\/api\/harness-auth(?:\/([a-z]+)(?:\/(start|input|cancel))?)?$/u)
        if (harnessAuthMatch) {
          if (!harnessAuth) return json(response, 404, { error: 'NOT_FOUND' })
          const [, harness, action] = harnessAuthMatch
          if (request.method === 'GET' && !action) return json(response, 200, harness ? await harnessAuth.status(harness) : harnessAuth.list())
          if (request.method === 'POST' && action === 'input') return json(response, 200, await harnessAuth.input(harness, await readJson(request, 8192)))
          if (request.method === 'POST' && action) return json(response, 200, await harnessAuth[action](harness))
          return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
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
          // 席（内側）から出来るのは、依頼したBotが自分の未入力の依頼を取り下げる事だけ。値の登録は、オーナーの画面の専用経路だけが受ける。
          if (internal && request.method === 'POST' && action === 'cancel') {
            const body = await readJson(request, 8192)
            return json(response, 200, { request: await secretRequests.withdraw(id, body?.botId) })
          }
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
          return events.connect(request, response)
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
          const [running, views] = await Promise.all([
            transport.runningBots(all), store.timelineViews?.(all.map(bot => bot.id)),
          ])
          const list = await Promise.all(all.map(async bot => {
            const last = recentTimeline(await sources('bots', bot.id, views?.get(bot.id)))
            return {
              id: bot.id,
              name: bot.name ?? bot.displayName ?? bot.id,
              displayName: bot.displayName ?? bot.id,
              harness: bot.harness,
              model: bot.model ?? '',
              reasoningEffort: bot.reasoningEffort ?? '',
              fastMode: bot.fastMode === true,
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
            ...room, ...listAvatar(room.avatar, url), recent: recentTimeline(await sources('rooms', room.id)),
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
        const resumeDeliveryMatch = url.pathname.match(/^\/api\/deliveries\/direct\/([a-f0-9-]+)\/resume$/u)
        if (request.method === 'POST' && resumeDeliveryMatch) {
          const { target } = await readJson(request)
          return json(response, 200, await messenger.resumeDelivery(resumeDeliveryMatch[1], target))
        }
        const closeLaunchMatch = url.pathname.match(/^\/api\/deliveries\/direct\/([a-f0-9-]+)\/close-launch$/u)
        if (request.method === 'POST' && closeLaunchMatch) {
          const { target } = await readJson(request)
          return json(response, 200, await messenger.closeDeliveryLaunch(closeLaunchMatch[1], target))
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

        const stopMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/stop$/u)
        if (stopMatch) {
          if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
          const bot = bots.get(stopMatch[1])
          if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
          try {
            const result = await transport.interrupt(bot)
            if (result?.botId !== bot.id || !(result.status === 'stop_sent' || result.status === 'interrupted' && result.sessionPreserved === true))
              throw new Error('BOT_STOP_UNCONFIRMED')
            server.notify({ type: 'bots' })
            return json(response, result.status === 'stop_sent' ? 202 : 200, result)
          } catch (error) {
            try { writeLog(`BellTeam stop failure: ${JSON.stringify(stopFailureReport(bot.id, error))}\n`) }
            catch { /* Reporting must not change the stop response or retry it. */ }
            return json(response, 502, { error: 'BOT_STOP_UNCONFIRMED', message: '処理の中断を確認できませんでした。会話を確認してください。' })
          }
        }

        const restartMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/restart$/u)
        if (request.method === 'POST' && restartMatch) {
          aiControl?.assertEnabled()
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
            const fastModeChanged = candidate.fastMode !== current.fastMode
            const configurationChanged = harnessChanged || candidate.model !== current.model
              || candidate.reasoningEffort !== current.reasoningEffort || fastModeChanged
            const wasRunning = configurationChanged ? await transport.isRunning(current) : false
            // 稼働中Botへの適用は現在の作業の後に並ぶ。保存の応答はそれを待たずに返す。
            if (wasRunning) {
              transport.reconfigure(current, candidate)
                .catch(async error => {
                  process.stderr.write(`BellTeam reconfigure error: ${error.stack ?? error.message}\n`)
                  // ファストモードを当てられなかった時は、保存した値を元へ戻す。記録が「有効」のまま、実際は通常の速度、という食い違いを残さない。
                  if (fastModeChanged && bots.get(botId)?.fastMode === candidate.fastMode) await bots.update(botId, { fastMode: current.fastMode })
                })
                .catch(error => process.stderr.write(`BellTeam fast mode restore error: ${error.stack ?? error.message}\n`))
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
          if (request.method === 'GET') return json(response, 200, await messagePage('rooms', roomId, url))
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
          if (request.method === 'GET') return json(response, 200, await messagePage('bots', botId, url))
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
      return respondHttpError(request, response, error, diagnostics)
    }
  })

  server.notify = events.notify
  server.startMessageWatch = events.startMessageWatch
  server.on('close', events.stopWatching)
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  // 止める時に処理中だった接続は、応答を返し終えたら閉じる。待機時間の満了まで停止を待たせない。
  // 知らせの流れは自分からは終わらないので、ここで終える。アプリは再接続する。
  const closeServer = server.close.bind(server)
  server.close = callback => {
    events.endConnections()
    if (internal) seatMcp?.close()
    const reap = setInterval(() => server.closeIdleConnections(), 50)
    server.once('close', () => clearInterval(reap))
    return closeServer(callback)
  }
  return server
}
