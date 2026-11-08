import { resolveSeatBotId, seatExecutionSource } from './seat-mcp.mjs'
import { createControlApi, createApplicationApi } from './http-application-api.mjs'
import { createBotApi } from './http-bot-api.mjs'
import { createScreenInputApi } from './http-screen-input-api.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { createMemberDeletionApi } from './members/deletion.mjs'
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
import { createWebPushOrigin } from './web-push-origin.mjs'
import { validateConversationAdmissionDiagnostic } from './conversation-lifetimes.mjs'
import { captureInstallInspectionOwner } from './update-install-inspection.mjs'

export { avatarVersion } from './http-assets.mjs'
export { pageItems } from './http-messages.mjs'
export { EVENT_KEEPALIVE_MS, MESSAGE_EVENT_WINDOW_MS }

// 待機中の接続を閉じるまでの時間。Nodeの既定5秒は、再利用の瞬間に閉じて通信断（-1005）を起こす。
// 手前の中継（cloudflaredの既定90秒）より長く保つ。
export const KEEP_ALIVE_TIMEOUT_MS = 125000

export function createBellTeamServer({ bots, rooms, roomMessenger, authorize, messenger, store, transport, memory, ownerProfile, refreshGlobalInstructions = async () => {}, assets, staticRoot, assetVersion = Date.now().toString(36), models = new LiveModelCatalog(), scheduler = null, userRules = null, characterSheets = null, diagnostics = null, secretRequests = null, ownerQuestions = null, ownerSecretGuide = null, submittedSecretConsumer = null, captureSubmittedSecretContext = null, notifications = null, subscriptions = null, settings = null, onboarding = null, harnessAuth = null, aiControl = null, administration = null, goals = null, webGatewayControl = null, notificationsReleaseControl = null, updateCenter = null, membersAuthorization = null, usageAssembly = null, conversationAssembly = null, authMode = () => 'cloudflare', internal = false, seatMcp = null, eventKeepalive = EVENT_KEEPALIVE_MS, messageEventWindow = MESSAGE_EVENT_WINDOW_MS, writeLog = line => process.stderr.write(line) }) {

  if (typeof authorize !== 'function') throw new Error('BELLTEAM_AUTHORIZER_REQUIRED')
  const events = createMessageEvents({ store, secretRequests, ownerQuestions, rooms, bots, transport, aiControl, updateCenter: internal ? null : updateCenter, eventKeepalive, messageEventWindow })
  const { sources, timeline, messagePage } = createMessageViews({ rooms, store, secretRequests, ownerQuestions,
    ownerSecretGuide: internal ? null : ownerSecretGuide })

  const assertWebPushOrigin = createWebPushOrigin({ settings })
  const captureUsageContext = usageAssembly ? async (request, method) => {
    const botId = internal ? await resolveSeatBotId(request, bots) : null
    if (internal && !botId) throw Object.assign(new Error('BELLTEAM_SEAT_UNRESOLVED'), { code: 'BELLTEAM_SEAT_UNRESOLVED', status: 403 })
    return usageAssembly.capture(method, { kind: internal ? 'bot' : 'owner', botId })
  } : undefined
  const controlApi = createControlApi({ captureUsageContext, submittedSecretConsumer, captureSubmittedSecretContext, aiControl, onboarding, internal, notify: event => server.notify(event), harnessAuth, settings, secretRequests, subscriptions, bots, transport, notifications, ownerQuestions, authMode, diagnostics, models, webGatewayControl, notificationsReleaseControl, updateCenter, assertWebPushOrigin,
    captureInstallInspectionOwner: request => captureInstallInspectionOwner(async () => !internal && await authorize(request) === true) })
  administration ??= new BotAdministration({ bots, rooms, transport, writeLog,
    reportError: report => diagnostics?.record(report) })
  const featureApis = [
    createApplicationApi({ ownerProfile, refreshGlobalInstructions, userRules, events, assets }),
    createMemberDeletionApi({ administration }),
    createBotApi({ bots, transport, memory, characterSheets, aiControl, notify: event => server.notify(event), sources, store, messagePage, messenger,
      administration }),
    createRoomApi({ bots, rooms, transport, sources, messagePage, roomMessenger }),
    createDeliveryApi({ messenger, roomMessenger, transport }),
    createScheduleApi({ bots, rooms, scheduler }),
    createGoalApi({ bots, goals, aiControl, ownerActions: !internal, notify: event => server.notify(event) }),
    createConversationApi({ bots, rooms, timeline }),
    createScreenInputApi({ bots, transport, internal }),
  ]

  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    let stage = 'url'
    logWriteRequest(request, response, writeLog)
    logReadRequest(request, response, writeLog)
    let membersContext
    try {
      const url = new URL(request.url, 'http://bellteam.local')
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' })
      stage = 'authorize'
      const authenticated = await authorize(request)
      if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, { authenticated, authMode: authMode(request) })
      if (!authenticated) return json(response, url.pathname === '/api/updates' || url.pathname.startsWith('/api/updates/') ? 403 : 401, { error: 'UNAUTHORIZED' })
      if (url.pathname === '/api/diagnostics/conversation-admission') {
        if (internal) return json(response, 403, { error: 'DIAGNOSTIC_OWNER_REQUIRED' })
        if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        if (url.search || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0)
          return json(response, 400, { error: 'DIAGNOSTIC_INPUT_INVALID' })
        let admission
        try { admission = validateConversationAdmissionDiagnostic(conversationAssembly?.admission?.inspectAdmission?.()) }
        catch { return json(response, 503, { error: 'CONVERSATION_ADMISSION_DIAGNOSTIC_UNAVAILABLE' }) }
        return json(response, 200, { admission })
      }
      if (url.pathname === '/internal/members-owner') {
        // No approved dedicated registrations have been supplied for initial migration.
        return json(response, 403, { error: 'MEMBERS_OWNER_GRANT_UNKNOWN' })
      }
      stage = 'members_authorization'
      if (!internal) membersContext = membersAuthorization?.captureHttp(request, url.pathname)
      // 席のCLIがつなぐMCP。内部入口（loopback）だけで開く。
      if (internal && seatMcp && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) {
        stage = 'seat_mcp'
        return await seatMcp(request, response, url)
      }

      const dispatchApi = async () => {
      if (url.pathname.startsWith('/api/')) {
        stage = 'control'
        if (await controlApi(request, response, url) !== false) return
        stage = 'members_refresh'
        const botRead = /^\/api\/bots\/[a-z0-9-]+(?:\/(.*))?$/u.exec(url.pathname)
        const directRead = request.method === 'GET' && (
          !internal && url.pathname === '/api/queue'
          || url.pathname === '/api/bots' && typeof bots.listForClient === 'function'
          || ['/api/owner', '/api/owner/avatar', '/api/user-rules'].includes(url.pathname)
          || botRead && typeof bots.readMember === 'function' && (['', 'messages', 'queue', 'avatar', 'avatar-large', 'avatar-source', 'avatar-large-source'].includes(botRead[1] ?? '')
            || /^character-sheet(?:\/[^/]+)?$/u.test(botRead[1] ?? '') || /^configuration-operations\/[^/]+$/u.test(botRead[1] ?? '')))
        if (!directRead) await bots.refresh?.()
        stage = 'feature'
        for (const handle of featureApis) {
          if (await handle(request, response, url, membersContext) !== false) return
        }
        return json(response, 404, { error: 'NOT_FOUND' })
      }

      }
      if (conversationAssembly && url.pathname.startsWith('/api/')) {
        const botId = internal ? await resolveSeatBotId(request, bots) : null
        const actor = internal ? (botId ? { kind: 'bot', botId } : null) : { kind: 'owner' }
        return await conversationAssembly.run(actor, dispatchApi, internal && botId ? { executionSource: seatExecutionSource(request, bots) } : undefined)
      }
      if (url.pathname.startsWith('/api/')) return await dispatchApi()

      if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      stage = 'static'
      return staticFile(response, staticRoot, url.pathname, assetVersion)
    } catch (error) {
      return respondHttpError(request, response, error, diagnostics, { stage, startedAt })
    } finally {
      membersAuthorization?.releaseHttp(request)
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
