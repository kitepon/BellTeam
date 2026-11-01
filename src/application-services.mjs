import { join } from 'node:path'
import { CharacterSheets } from './character-sheets.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { BotGoals } from './bot-goals.mjs'
import { AitermClient } from './aiterm-client.mjs'
import { createManagedTransport } from './aiterm-transport.mjs'
import { runWaitProcess } from './aiterm-wait-process.mjs'
import { completedThroughlineTurns, latestThroughlineHandoffContext } from './throughline-context.mjs'
import { AiControl, stopRegisteredWork } from './ai-control.mjs'
import { ConversationStore } from './conversation-store.mjs'
import { Diagnostics } from './diagnostics.mjs'
import { BellTeamMessenger } from './messenger.mjs'
import { BellTeamMemory } from './memory-service.mjs'
import { MessageAssets } from './message-assets.mjs'
import { BotScheduler, runShellCommand } from './scheduler.mjs'
import { RoomMessenger } from './room-messenger.mjs'
import { SecretRequests, secretCompletionMessage } from './secret-requests.mjs'
import { OwnerQuestions, ownerAnswerMessage } from './owner-questions.mjs'
import { RoomRegistry } from './room-registry.mjs'
import { TurnReports, judgeOwnerReport } from './turn-reports.mjs'
import { SeatTurns } from './seat-turns.mjs'
import { SelfTurns, readObserverTurns } from './self-turns.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { PushNotifications } from './push-notifications.mjs'
import { Subscriptions } from './subscriptions.mjs'
import { Onboarding } from './onboarding.mjs'
import { HarnessAuth } from './harness-auth.mjs'
import { chooseRoomResponder } from './room-routing.mjs'

// Construct the application graph without starting HTTP listeners or background loops.
export async function createApplicationServices({ root, aiterm, bots, ownerProfile, refreshGlobalInstructions, settings, userRules, environment = process.env, client, seatRuntime = null }) {
  const subscriptions = new Subscriptions({
    path: join(root, seatRuntime ? 'state/subscription.json' : 'shared/subscription.json'),
    environment: environment.BELLTEAM_SUBSCRIPTION_ENVIRONMENT ?? 'Production',
    accessMode: environment.BELLTEAM_SUBSCRIPTION_ACCESS_MODE ?? 'subscription',
  })
  await subscriptions.initialize()
  const diagnostics = new Diagnostics(join(root, 'logs/diagnostics.json'), {
    investigationsFile: environment.BELLTEAM_DIAGNOSTIC_INVESTIGATIONS ?? null,
  })
  await diagnostics.initialize()
  const notifications = new PushNotifications({ root, bots, diagnostics })
  await notifications.initialize()
  const memory = seatRuntime ? seatRuntime.memory(bots) : new BellTeamMemory({ registry: bots, root })
  await memory.initialize()
  const aiControl = new AiControl({
    path: join(root, seatRuntime ? 'state/ai-control.json' : 'shared/ai-control.json'),
    stopAll: () => stopRegisteredWork({ bots, transport, scheduler }),
    beforeResume: at => scheduler.prepareResume(new Date(at)),
  })
  await aiControl.initialize()
  const transport = createManagedTransport({
    client: client ?? new AitermClient({ ...aiterm, ...(seatRuntime ? { seatProject: root } : {}) }),
    ...(seatRuntime ? {
      handoffContext: project => latestThroughlineHandoffContext(project, { seatCommands: true }),
      waitProcess: (process, signal) => runWaitProcess(process, signal, { seatProject: root }),
    } : {}),
    assertWorkAllowed: () => aiControl.assertEnabled(),
    prepareStartup: async (bot, shortTermMemory) => {
      await bots.prepareStartupContext(bot.id, shortTermMemory)
      await onboarding.prepareStartup(bot)
    },
    updateSession: (botId, session) => bots.updateSession(botId, session),
    updateFastMode: (botId, fastMode) => bots.update(botId, { fastMode }),
  })
  const idleSessions = new IdleSessions({ bots, transport })
  const goals = new BotGoals({ transport, admitWork: () => aiControl.admit(), reportError: async error => {
    const frames = String(error.stack ?? '').split('\n').slice(1).filter(line => /^\s*at\s/u.test(line)).slice(0, 12)
    await diagnostics.record({ code: 'GOAL_OPERATION_UNCONFIRMED', module: 'goals', diagnostic_log: `${error.constructor.name}\n${frames.join('\n')}` })
  } })
  const logPath = join(root, 'logs/direct-messages.jsonl')
  const store = new ConversationStore({ logPath })
  const assets = new MessageAssets({ root, ...(seatRuntime ? {
    botsAssetsRoot: join(root, 'state/bots'),
    readImage: (image, maxBytes) => seatRuntime.readImage(image, maxBytes),
  } : {}) })
  const messenger = new BellTeamMessenger({
    bots, transport, logPath, store, assets,
    admitWork: () => aiControl.admit(),
    requireAccess: () => aiControl.assertEnabled(),
    onMessage: record => notifications.direct(record),
    onTurnEnd: turn => turnReports.afterTurn(turn),
  })
  const onboarding = new Onboarding({
    root, bots, client: transport.client, subscriptions,
    ...(seatRuntime ? { path: join(root, 'state/onboarding.json'), projectFiles: seatRuntime.projectFiles } : {}),
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
    ...(seatRuntime ? { read: request => readObserverTurns(request, { seatCommands: true }),
      changed: seatRuntime.throughlineChanged() } : {}),
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
    ...(seatRuntime ? { completedTurns: project => completedThroughlineTurns(project, { seatCommands: true }),
      runCommand: request => runShellCommand(request, { seatProject: request.cwd }) } : {}),
    paused: () => aiControl.paused,
    assertWorkAllowed: () => aiControl.assertEnabled(),
  })
  const characterSheets = seatRuntime ? seatRuntime.characterSheets(id => bots.projectPath(id))
    : new CharacterSheets({ projectPath: id => bots.projectPath(id) })
  // Bot設定変更・停止・削除の業務判断。公開APIと席MCPが同じ判断を使う。
  const administration = new BotAdministration({ bots, rooms, transport })
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
  return {
    aiControl, subscriptions, settings, onboarding, harnessAuth,
    notifications, secretRequests, ownerQuestions, bots, rooms,
    roomMessenger, messenger, store, transport, memory,
    ownerProfile, userRules, characterSheets, refreshGlobalInstructions, assets,
    scheduler, diagnostics, idleSessions, selfTurns, seatTurns, administration, goals,
  }
}
