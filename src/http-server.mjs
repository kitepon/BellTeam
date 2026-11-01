import { createControlApi, createApplicationApi } from './http-application-api.mjs'
import { createBotApi } from './http-bot-api.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { createRoomApi } from './http-room-api.mjs'
import { createDeliveryApi } from './http-delivery-api.mjs'
import { createScheduleApi } from './http-schedule-api.mjs'
import { createConversationApi } from './http-conversation-api.mjs'
import { createGoalApi } from './http-goal-api.mjs'
import { createServer } from 'node:http'
import { LiveModelCatalog } from './model-catalog.mjs'
import { json } from './http-response.mjs'
import { logWriteRequest, logReadRequest } from './http-request-log.mjs'
import { staticFile } from './http-assets.mjs'
import { respondHttpError } from './http-errors.mjs'
import { createMessageViews } from './http-messages.mjs'
import { createMessageEvents, EVENT_KEEPALIVE_MS, MESSAGE_EVENT_WINDOW_MS } from './http-events.mjs'

export { avatarVersion } from './http-assets.mjs'
export { pageItems } from './http-messages.mjs'
export { EVENT_KEEPALIVE_MS, MESSAGE_EVENT_WINDOW_MS }

// 待機中の接続を閉じるまでの時間。Nodeの既定5秒は、再利用の瞬間に閉じて通信断（-1005）を起こす。
// 手前の中継（cloudflaredの既定90秒）より長く保つ。
export const KEEP_ALIVE_TIMEOUT_MS = 125000

export function createBellTeamServer({ bots, rooms, roomMessenger, authorize, messenger, store, transport, memory, ownerProfile, refreshGlobalInstructions = async () => {}, assets, staticRoot, assetVersion = Date.now().toString(36), models = new LiveModelCatalog(), scheduler = null, userRules = null, characterSheets = null, diagnostics = null, secretRequests = null, ownerQuestions = null, notifications = null, subscriptions = null, settings = null, onboarding = null, harnessAuth = null, aiControl = null, administration = null, goals = null, authMode = () => 'cloudflare', internal = false, seatMcp = null, eventKeepalive = EVENT_KEEPALIVE_MS, messageEventWindow = MESSAGE_EVENT_WINDOW_MS, writeLog = line => process.stderr.write(line) }) {
  if (typeof authorize !== 'function') throw new Error('BELLTEAM_AUTHORIZER_REQUIRED')
  const events = createMessageEvents({ store, secretRequests, ownerQuestions, rooms, bots, transport, aiControl, eventKeepalive, messageEventWindow })
  const { sources, timeline, messagePage } = createMessageViews({ rooms, store, secretRequests, ownerQuestions })

  const controlApi = createControlApi({ aiControl, onboarding, internal, notify: event => server.notify(event), harnessAuth, settings, secretRequests, subscriptions, bots, transport, notifications, ownerQuestions, authMode, diagnostics, models })
  const featureApis = [
    createApplicationApi({ ownerProfile, refreshGlobalInstructions, userRules, events, assets }),
    createBotApi({ bots, transport, memory, characterSheets, aiControl, notify: event => server.notify(event), sources, store, messagePage, messenger,
      administration: administration ?? new BotAdministration({ bots, rooms, transport, writeLog }) }),
    createRoomApi({ rooms, transport, sources, messagePage, roomMessenger }),
    createDeliveryApi({ messenger, roomMessenger, transport }),
    createScheduleApi({ bots, rooms, scheduler }),
    createGoalApi({ bots, goals, aiControl, ownerActions: !internal, notify: event => server.notify(event) }),
    createConversationApi({ bots, rooms, timeline }),
  ]

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
        if (await controlApi(request, response, url) !== false) return
        await bots.refresh?.()
        for (const handle of featureApis) {
          if (await handle(request, response, url) !== false) return
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
  let messageWatchCloseError = null
  server.on('close', () => {
    // EventEmitter exceptions bypass the close callback and its caller's cleanup.
    // Keep the failure for the HTTP close result instead of throwing here.
    try { events.stopWatching() }
    catch (error) { messageWatchCloseError = error }
  })
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  // 止める時に処理中だった接続は、応答を返し終えたら閉じる。待機時間の満了まで停止を待たせない。
  // 知らせの流れは自分からは終わらないので、ここで終える。アプリは再接続する。
  const closeServer = server.close.bind(server)
  server.close = callback => {
    events.endConnections()
    if (internal) seatMcp?.close()
    const reap = setInterval(() => server.closeIdleConnections(), 50)
    server.once('close', () => clearInterval(reap))
    return closeServer(error => {
      const errors = [error, messageWatchCloseError].filter(Boolean)
      const failure = errors.length > 1 ? new AggregateError(errors, 'HTTP_CLOSE_FAILED') : errors[0]
      if (callback) callback(failure)
      else if (messageWatchCloseError) server.emit('error', failure)
    })
  }
  return server
}
