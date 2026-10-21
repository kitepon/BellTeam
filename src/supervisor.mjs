#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

import { bots, ownerProfile, refreshGlobalInstructions, settings, userRules } from './bootstrap.mjs'
import { CharacterSheets } from './character-sheets.mjs'
import { createBugHubSecurity } from './bughub-security.mjs'
import { createCallBridgeServer, listenCallBridge } from './call-bridge-server.mjs'
import { AitermTransport } from './aiterm-transport.mjs'
import { AiControl, stopRegisteredWork } from './ai-control.mjs'
import { ConversationStore } from './conversation-store.mjs'
import { Diagnostics, createDiagnosticsAdminServer } from './diagnostics.mjs'
import { createBellTeamServer } from './http-server.mjs'
import { createSeatMcp, internalApi } from './seat-mcp.mjs'
import { cloudflareAccessAuthorizer } from './cloudflare-access.mjs'
import { waitForShutdown } from './lifecycle.mjs'
import { BellTeamMessenger } from './messenger.mjs'
import { BellTeamMemory } from './memory-service.mjs'
import { MessageAssets } from './message-assets.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { BotScheduler } from './scheduler.mjs'
import { RoomMessenger } from './room-messenger.mjs'
import { SecretRequests, secretCompletionMessage } from './secret-requests.mjs'
import { OwnerQuestions, ownerAnswerMessage } from './owner-questions.mjs'
import { RoomRegistry } from './room-registry.mjs'
import { TurnReports, judgeOwnerReport } from './turn-reports.mjs'
import { SeatTurns } from './seat-turns.mjs'
import { SelfTurns } from './self-turns.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { PushNotifications } from './push-notifications.mjs'
import { Subscriptions } from './subscriptions.mjs'
import { Onboarding } from './onboarding.mjs'
import { HarnessAuth } from './harness-auth.mjs'
import { chooseRoomResponder } from './room-routing.mjs'
import { writeHarnessConfig } from './harness-config.mjs'
import { runtimeHome } from './runtime-home.mjs'
import { isLocalHostname } from './server-address.mjs'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = process.env.BELLTEAM_ROOT ?? '/srv/bellteam'
const subscriptions = new Subscriptions({
  path: join(root, 'shared/subscription.json'),
  environment: process.env.BELLTEAM_SUBSCRIPTION_ENVIRONMENT ?? 'Production',
  accessMode: process.env.BELLTEAM_SUBSCRIPTION_ACCESS_MODE ?? 'subscription',
})
await subscriptions.initialize()
const diagnostics = new Diagnostics(join(root, 'logs/diagnostics.json'), {
  investigationsFile: process.env.BELLTEAM_DIAGNOSTIC_INVESTIGATIONS ?? null,
})
await diagnostics.initialize()
const notifications = new PushNotifications({ root, bots, diagnostics })
await notifications.initialize()
const memory = new BellTeamMemory({ registry: bots, root })
await memory.initialize()
const aiControl = new AiControl({
  path: join(root, 'shared/ai-control.json'),
  stopAll: () => stopRegisteredWork({ bots, transport, scheduler }),
  beforeResume: at => scheduler.prepareResume(new Date(at)),
})
await aiControl.initialize()
const transport = new AitermTransport({
  assertWorkAllowed: () => aiControl.assertEnabled(),
  prepareStartup: async (bot, shortTermMemory) => {
    await bots.prepareStartupContext(bot.id, shortTermMemory)
    await onboarding.prepareStartup(bot)
  },
  updateSession: (botId, session) => bots.updateSession(botId, session),
  updateFastMode: (botId, fastMode) => bots.update(botId, { fastMode }),
})
const idleSessions = new IdleSessions({ bots, transport })
const logPath = join(root, 'logs/direct-messages.jsonl')
const store = new ConversationStore({ logPath })
const assets = new MessageAssets({ root })
const messenger = new BellTeamMessenger({
  bots, transport, logPath, assets,
  admitWork: () => aiControl.admit(),
  requireAccess: () => aiControl.assertEnabled(),
  onMessage: record => notifications.direct(record),
  onTurnEnd: turn => turnReports.afterTurn(turn),
})
const onboarding = new Onboarding({
  root, bots, client: transport.client, subscriptions,
  startConversation: (bot, message) => messenger.enqueueUserTurn({ target: bot.id, message, recordUser: false }),
})
await onboarding.initialize()
const harnessAuth = new HarnessAuth({ bots, client: transport.client })
const turnReports = new TurnReports({
  bots, store, transport,
  enabled: () => !aiControl.paused && settings.configuration('routing').enabled,
  judge: value => judgeOwnerReport({ ...value, apiKey: settings.configuration('routing').apiKey }),
  appendInterimWords: (botId, groupId, words) => messenger.appendInterimWords(botId, groupId, words),
})
// ハーネスが自分から始めたターンは配送を通らないので、Throughlineの記録から拾って会話画面へ出す。
const selfTurns = new SelfTurns({
  bots, statePath: join(root, 'logs/self-turns.json'),
  appendAnswer: (botId, groupId, text) => messenger.appendInterimWords(botId, groupId, [{ text, kind: 'answer' }]),
  afterTurn: turn => turnReports.afterTurn(turn),
  shown: botId => transport.shownInSelfTurn(botId),
})
await selfTurns.initialize()
// BellTeamが始めていないターンも、Aitermに席の今のターンを聞いて「処理中」と合間の言葉に出す。
const seatTurns = new SeatTurns({
  bots, transport,
  appendInterimWords: (botId, groupId, words) => messenger.appendInterimWords(botId, groupId, words),
})
const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots })
await rooms.initialize()
const roomMessenger = new RoomMessenger({
  rooms, bots, transport, assets,
  admitWork: () => aiControl.admit(),
  requireAccess: () => aiControl.assertEnabled(),
  automaticRouting: () => settings.configuration('routing').enabled,
  chooseResponder: value => chooseRoomResponder({ ...value, apiKey: settings.configuration('routing').apiKey }),
  onMessage: record => notifications.room(record),
  onInterimWords: (botId, groupId, words) => messenger.appendInterimWords(botId, groupId, words),
  onTurnEnd: turn => turnReports.afterTurn(turn),
})
const scheduler = new BotScheduler({ registry: bots, messenger, transport, rooms, roomMessenger,
  paused: () => aiControl.paused,
  assertWorkAllowed: () => aiControl.assertEnabled(),
})
const characterSheets = new CharacterSheets({ projectPath: id => bots.projectPath(id) })
const secretRequests = new SecretRequests({
  root, bots, rooms,
  onRequest: item => notifications.secret(item),
  notify: item => messenger.enqueueUserTurn({ target: item.botId, message: secretCompletionMessage(item) }),
})
await secretRequests.initialize()
const ownerQuestions = new OwnerQuestions({
  root, bots,
  onRequest: item => notifications.question(item),
  notify: item => messenger.enqueueUserTurn({ target: item.botId, message: ownerAnswerMessage(item) }),
})
await ownerQuestions.initialize()
const serverOptions = {
  aiControl,
  subscriptions,
  settings,
  onboarding,
  harnessAuth,
  notifications,
  secretRequests,
  ownerQuestions,
  bots, rooms, roomMessenger,
  messenger,
  store,
  transport,
  memory,
  ownerProfile,
  userRules,
  characterSheets,
  refreshGlobalInstructions,
  assets,
  staticRoot: join(appRoot, 'web'),
  models: new LiveModelCatalog({ cwd: root }),
  scheduler,
  diagnostics,
}
let cloudflareAuthorize = null
const configureCloudflare = config => {
  cloudflareAuthorize = config.enabled ? cloudflareAccessAuthorizer(config) : null
}
configureCloudflare(settings.configuration('cloudflare'))
const authMode = request => {
  if (!cloudflareAuthorize) return 'local'
  const host = new URL(`http://${request.headers.host}`).hostname
  return isLocalHostname(host) ? 'local' : 'cloudflare'
}
const server = createBellTeamServer({ ...serverOptions, authMode,
  authorize: request => authMode(request) === 'local' ? true : cloudflareAuthorize(request),
})
const internalPort = Number(process.env.BELLTEAM_INTERNAL_PORT ?? 4181)
const callBridgeHeaders = join(root, 'shared/tools/call-bridge/headers')
const seatMcp = createSeatMcp({
  bots,
  toolsForSource: executionSource => internalApi(internalPort, fetch, { executionSource }),
  admitWork: () => aiControl.admit(),
  assertWorkAllowed: () => aiControl.assertEnabled(),
  tools: { registry: bots, messenger, store, rooms, roomMessenger, memory, ownerProfile, userRules, bugHubSecurity: createBugHubSecurity({ root }), internalUrl: `http://127.0.0.1:${internalPort}`, ...internalApi(internalPort) },
  callBridge: () => {
    const config = settings.configuration('callBridge')
    return config.enabled ? { url: config.url, headersFile: callBridgeHeaders } : null
  },
})
const internalServer = createBellTeamServer({ ...serverOptions, internal: true, seatMcp, authorize: async () => true })
let adminServer = null
const callBridgeSocket = process.env.BELLTEAM_CALL_BRIDGE_SOCKET
let closeCallBridge = null
const closeServer = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
const configureDiagnostics = async config => {
  if (adminServer) { await closeServer(adminServer); adminServer = null }
  if (!config.enabled) return
  const next = createDiagnosticsAdminServer({ diagnostics, key: config.key })
  await new Promise((resolve, reject) => {
    next.once('error', reject)
    next.listen(Number(process.env.BELLTEAM_ADMIN_PORT ?? 4182), '0.0.0.0', resolve)
  })
  adminServer = next
}
const configureCalls = async config => {
  await closeCallBridge?.()
  closeCallBridge = null
  if (config.enabled) {
    await mkdir(dirname(callBridgeHeaders), { recursive: true })
    await writeFile(callBridgeHeaders, `Authorization: Bearer ${config.token}\n`, { mode: 0o600 })
    if (callBridgeSocket) closeCallBridge = await listenCallBridge(createCallBridgeServer({ bots, messenger }), callBridgeSocket)
  }
  await writeHarnessConfig(bots, runtimeHome(), { callBridge: config })
}
for (const [id, apply] of [['diagnostics', configureDiagnostics], ['callBridge', configureCalls], ['notifications', value => notifications.configure(value)]]) {
  try { await apply(settings.configuration(id)) }
  catch (error) {
    settings.setError(id, error)
    process.stderr.write(`BellTeam: ${id}の設定を反映できませんでした\n`)
    await diagnostics.record({ code: 'SERVER_FEATURE_CONFIGURATION_FAILED', module: 'server', diagnostic_log: id })
  }
}
settings.onChange = async (id, config) => {
  settings.setError(id, null)
  try {
  if (id === 'cloudflare') configureCloudflare(config)
  if (id === 'diagnostics') await configureDiagnostics(config)
  if (id === 'callBridge') {
    await configureCalls(config)
    // CLIは起動時にMCP登録を読む。現在のターンを終えたら閉じ、次の配送で新しい登録を読む。
    for (const bot of bots.values()) {
      if (!await transport.isRunning(bot)) continue
      transport.stopForConfiguration(bot).catch(async error => {
        process.stderr.write(`BellTeam: 通話設定をメンバーへ反映できませんでした (${bot.id})\n`)
        settings.setError(id, error)
        server.notify({ type: 'settings', featureId: id })
        await diagnostics.record({ code: 'SERVER_CALL_CONFIGURATION_FAILED', module: 'server', diagnostic_log: error.code ?? 'CALL_CONFIGURATION_FAILED' })
      })
    }
  }
  if (id === 'notifications') await notifications.configure(config)
  } catch (error) {
    settings.setError(id, error)
    throw error
  } finally {
  server.notify({ type: 'settings', featureId: id })
  }
}

await server.startMessageWatch()
if (aiControl.paused) void aiControl.enforce()
server.listen(Number(process.env.BELLTEAM_WEB_PORT ?? 4180), '0.0.0.0')
internalServer.listen(internalPort, '127.0.0.1')
scheduler.start()
selfTurns.start()
seatTurns.start()
idleSessions.start()

process.stderr.write('BellTeam ready\n')
await waitForShutdown()
scheduler.stop()
await idleSessions.stop()
await selfTurns.stop()
await seatTurns.stop()
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
await new Promise((resolve, reject) => internalServer.close(error => error ? reject(error) : resolve()))
if (adminServer) await closeServer(adminServer)
await closeCallBridge?.()
await transport.close()
await notifications.close()
