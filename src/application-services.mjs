import { join } from 'node:path'
import { createConversationServices } from './conversation-services.mjs'
import { CharacterSheets } from './character-sheets.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { BotGoals } from './bot-goals.mjs'
import { AitermClient } from './aiterm-client.mjs'
import { createManagedTransport } from './aiterm-transport.mjs'
import { runWaitProcess } from './aiterm-wait-process.mjs'
import { completedThroughlineTurns, latestThroughlineHandoffContext } from './throughline-context.mjs'
import { AiControl, stopRegisteredWork } from './ai-control.mjs'
import { Diagnostics } from './diagnostics.mjs'
import { BellTeamMemory } from './memory-service.mjs'
import { BotScheduler, runShellCommand } from './scheduler.mjs'
import { SecretRequests, secretCompletionMessage } from './secret-requests.mjs'
import { OwnerQuestions, ownerAnswerMessage } from './owner-questions.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { PushNotifications } from './push-notifications.mjs'
import { Subscriptions } from './subscriptions.mjs'
import { Onboarding } from './onboarding.mjs'
import { HarnessAuth } from './harness-auth.mjs'

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
    reportError: report => diagnostics.record(report),
    client: client ?? new AitermClient({ ...aiterm, ...(seatRuntime ? { seatProject: root } : {}) }),
    ...(seatRuntime ? {
      writeTemporaryImage: (path, bytes) => seatRuntime.writeTemporaryImage(path, bytes),
      removeTemporaryImage: path => seatRuntime.removeTemporaryImage(path),
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
  const conversation = createConversationServices({ root, bots, transport, notifications, aiControl, settings, seatRuntime })
  const { store, assets, messenger } = conversation
  const onboarding = new Onboarding({
    root, bots, client: transport.client, subscriptions,
    ...(seatRuntime ? { path: join(root, 'state/onboarding.json'), projectFiles: seatRuntime.projectFiles } : {}),
    startConversation: (bot, message) => messenger.enqueueUserTurn({ target: bot.id, message, recordUser: false }),
  })
  await onboarding.initialize()
  const harnessAuth = new HarnessAuth({ bots, client: transport.client })
  const { selfTurns, seatTurns, rooms, roomMessenger } = await conversation.initialize()
  const scheduler = new BotScheduler({ registry: bots, messenger, transport, rooms, roomMessenger,
    ...(seatRuntime ? { completedTurns: project => completedThroughlineTurns(project, { seatCommands: true }),
      runCommand: request => runShellCommand(request, { seatProject: request.cwd }) } : {}),
    paused: () => aiControl.paused,
    assertWorkAllowed: () => aiControl.assertEnabled(),
  })
  const characterSheets = seatRuntime ? seatRuntime.characterSheets(id => bots.projectPath(id))
    : new CharacterSheets({ projectPath: id => bots.projectPath(id) })
  // Bot設定変更・停止・削除の業務判断。公開APIと席MCPが同じ判断を使う。
  const administration = new BotAdministration({ bots, rooms, transport,
    reportError: report => diagnostics.record(report) })
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
