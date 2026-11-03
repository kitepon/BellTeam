import { createMembersAssembly } from './members-assembly.mjs'
import { MembersAdmission } from './members-admission.mjs'
import { createMembersOwnerAuthorization } from './members-owner-authorization.mjs'
import { join } from 'node:path'
import { createConversationServices } from './conversation-services.mjs'
import { CharacterSheets } from './character-sheets.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { BotGoals } from './bot-goals.mjs'
import { AitermClient } from './aiterm-client.mjs'
import { ConfigurationIntents } from './configuration-intents.mjs'
import { ConfigurationRequests } from './configuration-requests.mjs'
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
import { createNotifications } from './usage/notifications.mjs'
import { createNotificationsProcess } from './notifications-process.mjs'
import { createContainerUpdateClient } from './container-update-client.mjs'
import { createHostUpdateAdapter } from './update-host-adapter.mjs'
import { createModuleUpdateCatalog } from './update-module-catalog.mjs'
import { createUpdateCenter } from './update-center.mjs'
import { Subscriptions } from './subscriptions.mjs'
import { Onboarding } from './onboarding.mjs'
import { HarnessAuth } from './harness-auth.mjs'
import { attachOlrwOwnerQuestion } from './olrw-management-caller.mjs'
import { prepareOlrwManagement } from './olrw-management-loader.mjs'

// Construct the application graph without starting HTTP listeners or background loops.
export async function createApplicationServices({ root, aiterm, bots, ownerProfile, refreshGlobalInstructions, settings, userRules, environment = process.env, client, seatRuntime = null, olrwManagement = undefined, createNotificationsProcess: createProcess = createNotificationsProcess, gateway = () => null, models = null, createMembersProcess: membersFactory }) {
  let members = null, memory, rooms, assets, updateCenter
  const membersAdmission = new MembersAdmission()
  try {
  const membersAuthorization = createMembersOwnerAuthorization()
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
  if (seatRuntime || membersFactory) {
    members = createMembersAssembly({ root, seatRuntime, aiterm, settings, models, membersAdmission,
      membersAuthorization, diagnostics, dependencies: () => ({ memory, rooms, assets }), onState: () => updateCenter?.notify(),
      ...(membersFactory ? { createProcess: membersFactory } : {}),
    })
    await members.controller.start()
    bots = members.bots; ownerProfile = members.ownerProfile; userRules = members.userRules
    // The members writer already regenerates global instructions after its saves.
    refreshGlobalInstructions = async () => {}
  }
  const notifications = createNotifications({ root, bots, diagnostics,
    configuration: () => ({ apns: settings.configuration('notifications'), webPush: settings.configuration('webPush') }), createProcess,
    onState: state => {
      for (const [provider, feature] of [['apns', 'notifications'], ['webPush', 'webPush']]) {
        if (state.applyError?.[provider]) settings.setError(feature, { code: state.applyError[provider] })
      }
      updateCenter?.notify()
    },
  })
  const hostUpdateClient = createContainerUpdateClient()
  updateCenter = createUpdateCenter({ gateway, notifications, members, host: createHostUpdateAdapter({ root, client: hostUpdateClient }), moduleCatalog: createModuleUpdateCatalog({ client: hostUpdateClient }) })
  await notifications.initialize()
  memory = seatRuntime ? seatRuntime.memory(bots) : new BellTeamMemory({ registry: bots, root })
  await memory.initialize()
  const aiControl = new AiControl({
    path: join(root, seatRuntime ? 'state/ai-control.json' : 'shared/ai-control.json'),
    stopAll: () => stopRegisteredWork({ bots, transport, scheduler }),
    beforeResume: at => scheduler.prepareResume(new Date(at)),
  })
  await aiControl.initialize()
  const executionClient = client ?? new AitermClient({ ...aiterm, ...(seatRuntime ? { seatProject: root } : {}) })
  const configurationRequests = new ConfigurationRequests({ client: executionClient, intents: new ConfigurationIntents(join(root, 'state/configuration-intents')) })
  const transport = createManagedTransport({
    membersAdmission,
    configurationRequests,
    reportError: report => diagnostics.record(report),
    client: executionClient,
    ...(seatRuntime ? {
      writeTemporaryImage: (path, bytes) => seatRuntime.writeTemporaryImage(path, bytes),
      removeTemporaryImage: path => seatRuntime.removeTemporaryImage(path),
      handoffContext: project => latestThroughlineHandoffContext(project, { seatCommands: true }),
      waitProcess: (process, signal) => runWaitProcess(process, signal, { seatProject: root }),
    } : {}),
    assertWorkAllowed: () => aiControl.assertEnabled(),
    requireMember: async (bot, context) => {
      if (typeof bots.readMember === 'function') { await bots.readMember(bot.id, context); return }
      await bots.refresh(context)
      if (!bots.get(bot.id)) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404, effect: 'not_started' })
    },
    prepareStartup: async (bot, shortTermMemory, context) => {
      await bots.prepareStartupContext(bot.id, shortTermMemory, context)
      await onboarding.prepareStartup(bot, context)
    },
    updateSession: (botId, session, context) => bots.updateSession(botId, session, context),
    updateFastMode: (botId, fastMode, context) => members ? bots.updateFastMode(botId, fastMode, context) : bots.update(botId, { fastMode }, context),
  })
  await transport.restoreConfigurationRequests()
  const idleSessions = new IdleSessions({ bots, transport })
  const goals = new BotGoals({ transport, admitWork: () => aiControl.admit(), reportError: async error => {
    const frames = String(error.stack ?? '').split('\n').slice(1).filter(line => /^\s*at\s/u.test(line)).slice(0, 12)
    await diagnostics.record({ code: 'GOAL_OPERATION_UNCONFIRMED', module: 'goals', diagnostic_log: `${error.constructor.name}\n${frames.join('\n')}` })
  } })
  const conversation = createConversationServices({ root, bots, transport, notifications, aiControl, settings, seatRuntime })
  const { store, messenger } = conversation
  assets = conversation.assets
  const onboarding = new Onboarding({
    root, bots, client: transport.client, subscriptions,
    ...(seatRuntime ? { path: join(root, 'state/onboarding.json'), projectFiles: members ? {
      appendInstructions: (bot, text) => seatRuntime.membersProject('project.appendInstructions', { botId: bot.id, text }),
    } : seatRuntime.projectFiles } : {}),
    startConversation: (bot, message) => messenger.enqueueUserTurn({ target: bot.id, message, recordUser: false }),
  })
  await assets.initialize()
  await onboarding.initialize()
  const harnessAuth = new HarnessAuth({ bots, client: transport.client })
  const conversationServices = await conversation.initialize()
  rooms = conversationServices.rooms
  const { selfTurns, seatTurns, roomMessenger } = conversationServices
  const scheduler = new BotScheduler({ registry: bots, messenger, transport, rooms, roomMessenger,
    membersAdmission: transport.membersAdmission,
    admitWork: () => aiControl.admit(),
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
  let olrwAuthCaller = null
  try {
    if (olrwManagement === undefined) olrwManagement = await prepareOlrwManagement({ root, ownerQuestions, aiControl })
    if (olrwManagement) {
      olrwAuthCaller = attachOlrwOwnerQuestion({
        plan: olrwManagement.plan, ownerQuestions, aiControl, assertAuthorized: olrwManagement.assertAuthorized,
        createConsumer: ({ assertAuthorized }) => {
          const consumer = olrwManagement.createConsumer({ secretRequests, runDirectory: join(root, 'state/olrw-auth'),
            context: olrwManagement.context, assertAuthorized, auth: olrwManagement.auth })
          return { ownerSecretGuide: input => consumer.ownerSecretGuide(input),
            execute: async options => { try { return await consumer.execute(options) } finally { await olrwManagement.auth?.close?.() } },
            close: async () => { await consumer.close(); await olrwManagement.auth?.close?.() } }
        },
        reportFailure: code => diagnostics.record({ code, module: 'integration' }),
      })
      if (olrwAuthCaller.status === 'already_answered') await olrwManagement.auth?.close?.()
    }
  } catch {
    try { await olrwManagement?.auth?.close?.() } catch {}
    olrwAuthCaller = { status: 'unavailable', ownerSecretGuide: async () => null, async close() {} }
    try { await diagnostics.record({ code: 'OLRW_MANAGEMENT_UNAVAILABLE', module: 'integration' }) } catch {}
  }
  return {
    aiControl, subscriptions, settings, onboarding, harnessAuth, updateCenter, membersAuthorization, members,
    notifications, secretRequests, ownerQuestions, bots, rooms,
    roomMessenger, messenger, store, transport, memory,
    ownerProfile, userRules, characterSheets, refreshGlobalInstructions, assets,
    scheduler, diagnostics, idleSessions, selfTurns, seatTurns, administration, goals, olrwAuthCaller,
  }
  } catch (error) {
    try { await members?.controller.close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'MEMBERS_ASSEMBLY_FAILED') }
    throw error
  }
}
