import { TurnReports, judgeOwnerReport } from './turn-reports.mjs'
import { createDirectReceiptAssembly, directFailureReport } from './direct-receipt-assembly.mjs'
import { createSubmittedSecretApprovalBridge } from './submitted-secret-approval-bridge.mjs'
import { createSubmittedSecretConsumer } from './usage/submitted-secret-consumer.mjs'
import { createSubmittedSecretRabbitClient } from './usage/submitted-secret-rabbit-client.mjs'
import { createSubmittedSecretCaller } from './submitted-secret-caller.mjs'
import { createModuleChildExitReporter } from './module-child-exit-reporter.mjs'
import { mkdir } from 'node:fs/promises'
import { createSeatProcessRunner } from './seat-process.mjs'
import { createTeamBackgroundSummary } from './background-summary-assembly.mjs'
import { createModuleExchangeMutex } from './module-exchange-mutex.mjs'
import { createConversationUsage } from './usage/conversation-effects.mjs'
import { loadExecutionFactory } from './execution-loader.mjs'
import { createExecutionAdoptionStore } from './execution-adoption.mjs'
import { prepareExecutionRelease } from './web-gateway-release.mjs'
import { sendSessionStop } from './session-interruption.mjs'
import { createMembersAssembly } from './members-assembly.mjs'
import { MembersAdmission } from './members-admission.mjs'
import { createMembersOwnerAuthorization } from './members-owner-authorization.mjs'
import { join } from 'node:path'
import { createConversationServices } from './conversation-services.mjs'
import { CharacterSheets } from './character-sheets.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { CapacityContinuation } from './capacity-continuation.mjs'
import { BotGoals } from './bot-goals.mjs'
import { AitermClient } from './aiterm-client.mjs'
import { AitermGenerationClient } from './aiterm-generation-client.mjs'
import { ConfigurationIntents } from './configuration-intents.mjs'
import { acquireConfigurationStateAnchor } from './configuration-state-anchor.mjs'
import { ConfigurationRequests } from './configuration-requests.mjs'
import { createManagedTransport } from './aiterm-transport.mjs'
import { runWaitProcess } from './aiterm-wait-process.mjs'
import { completedThroughlineTurns, latestThroughlineHandoffContext } from './throughline-context.mjs'
import { AiControl, stopRegisteredWork } from './ai-control.mjs'
import { prepareModuleRelease } from './module-release.mjs'
import { createDiagnosticsFacade } from './diagnostics-facade.mjs'
import { createWorkGraphFacade, createWorkGraphEffects } from './work-graph-facade.mjs'
import { createSeatCredentials } from './seat-credentials.mjs'
import { createCredentialRefresh } from './secret-credential-refresh.mjs'
import { REMOTE_SEAT_MCP_PATH, seatCandidates } from './seat-mcp.mjs'
import { TERMINALS_UNAVAILABLE } from './http-terminals-api.mjs'
import { createTerminalKeys } from './terminals-mcp.mjs'
import { createMessageViews } from './http-messages.mjs'
import { Diagnostics, moduleRestartLimitProblems } from './diagnostics.mjs'
import { BellTeamMemory } from './memory-service.mjs'
import { BotScheduler, runShellCommand } from './scheduler.mjs'
import { SecretRequests, secretCompletionMessage } from './secret-requests.mjs'
import { OwnerQuestions, ownerAnswerMessage } from './owner-questions.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { createNotifications } from './usage/notifications.mjs'
import { createNotificationsProcess } from './notifications-process.mjs'
import { createUpdateClients } from './container-update-client.mjs'
import { createHostUpdateAdapter } from './update-host-adapter.mjs'
import { createModuleUpdateCatalog } from './update-module-catalog.mjs'
import { createModuleUpdateExecutor } from './update-module-executor.mjs'
import { createModuleUpdateAdapters } from './update-module-adapters.mjs'
import { createUpdateCenter } from './update-center.mjs'
import { createUpdateJobReader } from './update-job-reader.mjs'
import { captureRuntime } from './runtime-selection.mjs'
import { Subscriptions } from './subscriptions.mjs'
import { Onboarding } from './onboarding.mjs'
import { HarnessAuth } from './harness-auth.mjs'
import { attachOlrwOwnerQuestion } from './olrw-management-caller.mjs'
import { prepareOlrwManagement } from './olrw-management-loader.mjs'

// Saving a report is observation; a store refusal must not fail the child's call, its quiesce or a module exchange.
export const conversationDiagnosticPort = diagnostics => report => Promise.resolve()
  .then(() => diagnostics.record({ code: report.code, module: 'conversation',
    ...(report.code === 'MESSAGE_LOG_INVALID' ? { diagnostic_log: JSON.stringify(report) } : {}) }))
  .catch(error => {
    const candidate = error?.code ?? error?.message
    const reason = /^[A-Z][A-Z0-9_]{0,99}$/u.test(candidate ?? '') ? candidate : 'DIAGNOSTICS_OPERATION_FAILED'
    process.stderr.write(`${JSON.stringify({ code: 'CONVERSATION_DIAGNOSTIC_UNRECORDED', reportCode: report.code, reason })}\n`)
  })

// Construct the application graph without starting HTTP listeners or background loops.
const REMOTE_TERMINAL_STATUS_UNAVAILABLE = () => Object.assign(new Error('Remote terminal status unavailable'), { code: 'REMOTE_TERMINAL_STATUS_UNAVAILABLE' })

// Exit 0 = aiterm.remote-binding-status.v1, exit 2 = aiterm.remote-binding-error.v1; both are returned as-is.
export async function remoteTerminalStatus(project, ref, run = createSeatProcessRunner(project)) {
  let result
  try { result = await run('/usr/bin/env', ['aiterm-remote-terminal', 'status', '--ref', ref], { acceptNonzero: true, maxBuffer: 65536 }) } catch { throw REMOTE_TERMINAL_STATUS_UNAVAILABLE() }
  if (result.signal || (result.code !== 0 && result.code !== 2)) throw REMOTE_TERMINAL_STATUS_UNAVAILABLE()
  let value
  try { value = JSON.parse(result.stdout) } catch { throw REMOTE_TERMINAL_STATUS_UNAVAILABLE() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw REMOTE_TERMINAL_STATUS_UNAVAILABLE()
  return value
}

export async function createApplicationServices({ root, moduleChildExitReporter = createModuleChildExitReporter(), exchangeMutex = createModuleExchangeMutex(), aiterm, bots, ownerProfile, refreshGlobalInstructions, settings, userRules, environment = process.env, client, seatRuntime = null, botEnvironments = null, olrwManagement = undefined, submittedSecretManagement = undefined, createNotificationsProcess: createProcess = createNotificationsProcess, gateway = () => null, models = null, notify = null, createMembersProcess: membersFactory, createDiagnosticsProcess: diagnosticsFactory, createWorkGraphProcess: workGraphFactory, prepareWorkGraphRelease: prepareWorkGraph = (versionId, options) => prepareModuleRelease('work-graph', versionId, options), hostUpdateClient: hostClient, prepareDiagnosticsRelease: prepareDiagnostics = (versionId, options) => prepareModuleRelease('diagnostics', versionId, options), builtinSourceCommit = null, usageAssembly = null, attachUsageServices = () => {}, prepareUsageRelease: prepareUsage = (versionId, options) => prepareModuleRelease('usage', versionId, options), createConversationAssembly: conversationFactory, createExecutionAssembly: executionFactory, loadExecutionFactory: loadExecution = loadExecutionFactory, createExecutionAdoptionStore: adoptionFactory = createExecutionAdoptionStore, prepareExecutionRelease: prepareExecution = prepareExecutionRelease, createTerminalsCore = null }) {
  let terminals = null, credentialRefresh = null, members = null, diagnosticsModule = null, workGraphModule = null, workGraph = null, conversationAssembly = null, execution = null, executionClient, memory, rooms, assets, updateCenter, backgroundSummary, submittedSecretCaller = null, directMessages = null
  let scheduleTurns = null
  const membersAdmission = new MembersAdmission()
  const executionHandoffSupport = new Map()
  const modelHandoffGeneration = () => {
    const current = execution?.controller.snapshot()
    return current?.available && executionHandoffSupport.get(current.currentVersionId) === true ? current.generation : null
  }
  try {
  const trustedAnchor = acquireConfigurationStateAnchor(root)
  const membersAuthorization = createMembersOwnerAuthorization()
  const usage = usageAssembly?.facade
  const usageServices = { bots, settings, models, notify }
  attachUsageServices(usageServices)
  const subscriptions = usage?.subscriptions ?? new Subscriptions({
    path: join(root, seatRuntime ? 'state/subscription.json' : 'shared/subscription.json'),
    environment: environment.BELLTEAM_SUBSCRIPTION_ENVIRONMENT ?? 'Production',
    accessMode: environment.BELLTEAM_SUBSCRIPTION_ACCESS_MODE ?? 'subscription',
  })
  if (usageAssembly) await usageAssembly.initializeSubscriptions()
  else await subscriptions.initialize()
  const investigationsFile = environment.BELLTEAM_DIAGNOSTIC_INVESTIGATIONS ?? null
  if (diagnosticsFactory) diagnosticsModule = diagnosticsFactory({ root, investigationsFile, prepareRelease: prepareDiagnostics, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, onState: state => { moduleChildExitReporter.ready(Boolean(state.available)); updateCenter?.notify() } })
  const diagnostics = diagnosticsModule ? createDiagnosticsFacade(diagnosticsModule)
    : new Diagnostics(join(root, 'logs/diagnostics.json'), { investigationsFile })
  await diagnostics.initialize()
  moduleChildExitReporter.attach({ record: report => diagnostics.record(report), recordModuleRestartLimit: async dto => {
    const row = await diagnostics.recordModuleRestartLimit(dto)
    updateCenter?.notify()
    return row
  } }, !diagnosticsModule || Boolean(diagnosticsModule.snapshot().available))
  if (seatRuntime || membersFactory) {
    members = createMembersAssembly({ root, seatRuntime, aiterm, settings, models, membersAdmission, exchangeMutex,
      membersAuthorization, diagnostics, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, dependencies: () => ({ memory, rooms, assets, conversationAssembly, scheduleTurns }), onState: () => updateCenter?.notify(),
      ...(membersFactory ? { createProcess: membersFactory } : {}),
    })
    await members.controller.start()
    bots = members.bots; ownerProfile = members.ownerProfile; userRules = members.userRules
    // The members writer already regenerates global instructions after its saves.
    refreshGlobalInstructions = async () => {}
  }
  const notifications = createNotifications({ root, bots, diagnostics, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit,
    configuration: () => ({ apns: settings.configuration('notifications'), webPush: settings.configuration('webPush') }), createProcess,
    onState: state => {
      // Usage applies errors through its captured settings.changed epoch, never a later snapshot.
      if (!usageAssembly) for (const [provider, feature] of [['apns', 'notifications'], ['webPush', 'webPush']]) {
        if (state.applyError?.[provider]) settings.setError(feature, { code: state.applyError[provider] })
      }
      updateCenter?.notify()
    },
  })
  await notifications.initialize()
  memory = seatRuntime ? seatRuntime.memory(bots) : new BellTeamMemory({ registry: bots, root })
  await memory.initialize()
  const aiControl = new AiControl({
    path: join(root, seatRuntime ? 'state/ai-control.json' : 'shared/ai-control.json'),
    stopAll: () => stopRegisteredWork({ bots, transport, scheduler }),
    beforeResume: at => scheduler.prepareResume(new Date(at)),
  })
  await aiControl.initialize()
  const summaryProject = join(root, 'shared/tools/bellteam-background-agent')
  if (seatRuntime) await createSeatProcessRunner(root, { environment: 'base' })('/usr/bin/mkdir', ['-p', '-m', '700', '--', summaryProject])
  else await mkdir(summaryProject, { recursive: true, mode: 0o700 })
  backgroundSummary = createTeamBackgroundSummary({ project: summaryProject, settings, models,
    conversation: () => conversationAssembly, enabled: () => !aiControl.paused,
    notify: () => notify?.({ type: 'bots' }) })
  // Stable native port: one generation until the updater publishes an activated candidate.
  const initialClient = client ?? new AitermClient({ ...aiterm, ...(seatRuntime ? { seatProject: root } : {}), environmentReady: botEnvironments?.ready })
  executionClient = new AitermGenerationClient({ client: initialClient, runtimeCapture: null })
  const seatPorts = seatRuntime ? {
    writeTemporaryImage: (path, bytes) => seatRuntime.writeTemporaryImage(path, bytes),
    removeTemporaryImage: path => seatRuntime.removeTemporaryImage(path),
    handoffContext: project => latestThroughlineHandoffContext(project, { seatCommands: true }),
    waitProcess: (process, signal) => runWaitProcess(process, signal, { seatProject: root }),
  } : {}
  const requireMember = async (bot, context) => {
    if (typeof bots.readMember === 'function') { await bots.readMember(bot.id, context); return }
    await bots.refresh(context)
    if (!bots.get(bot.id)) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404, effect: 'not_started' })
  }
  const storagePorts = {
    deliveryAnchor: (input, options) => conversationAssembly.run(options.actor,
      () => conversationAssembly.facade.store.deliveryAnchor(input, options)),
    prepareStartup: async (bot, shortTermMemory, context) => {
      await bots.prepareStartupContext(bot.id, shortTermMemory, context)
      await onboarding.prepareStartup(bot, usageAssembly ? usageAssembly.systemContext('onboarding.prepareStartup', context) : context)
    },
    updateSession: (botId, session, context) => bots.updateSession(botId, session, context),
    updateFastMode: (botId, fastMode, context) => members ? bots.updateFastMode(botId, fastMode, context) : bots.update(botId, { fastMode }, context),
  }
  const goalError = async error => {
    const frames = String(error.stack ?? '').split('\n').slice(1).filter(line => /^\s*at\s/u.test(line)).slice(0, 12)
    await diagnostics.record({ code: 'GOAL_OPERATION_UNCONFIRMED', module: 'goals', diagnostic_log: `${error.constructor.name}\n${frames.join('\n')}` })
  }
  const conversationPorts = { bots, settings, seatRuntime, aiControl, conversationUsage: createConversationUsage({ settings, notifications }) }
  if (conversationFactory) conversationAssembly = conversationFactory({ root, membersAdmission, exchangeMutex, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, getServices: () => conversationPorts,
    onDiagnostic: conversationDiagnosticPort(diagnostics), onState: state => { updateCenter?.notify(); if (state.phase === 'running' && state.available) directMessages?.requestDrain() } })
  // Remote seats (remote-seat-ingress.md): terminals core is an in-parent injectable; seat credentials are parent state.
  const seatCredentials = createSeatCredentials({ path: join(root, 'state/seat-credentials.json') })
  terminals = createTerminalsCore ? createTerminalsCore({ stateRoot: join(root, 'state'), credentials: usageAssembly?.credentials ?? null,
    report: report => diagnostics.record(report) }) : null
  // RS11: native SSH credential status comes from Elegg's one-shot UID 1000 bin; usage validates the DTO.
  if (terminals && usageAssembly?.credentials?.setNativeProvider) usageAssembly.credentials.setNativeProvider({ status: ref => remoteTerminalStatus(root, ref) })
  // RS12: bind an Aiterm-held key ref to a registered terminal; the target comes from the record, never the caller.
  const terminalKeys = terminals && usageAssembly?.credentials?.registerNative ? createTerminalKeys({ terminals, credentials: usageAssembly.credentials }) : null
  // Usage has no timer of its own; the parent drives refresh while a credential is unavailable (Mika C5).
  credentialRefresh = usageAssembly?.credentials?.refresh && usageAssembly.credentials.watch ? createCredentialRefresh({
    refresh: () => usageAssembly.credentials.refresh(), watch: listener => usageAssembly.credentials.watch(listener),
    ...(usageAssembly.credentials.watchRecovery ? { watchRecovery: listener => usageAssembly.credentials.watchRecovery(listener) } : {}),
    report: error => diagnostics.record({ code: 'SECRET_CREDENTIAL_REFRESH_FAILED', module: 'integration', diagnostic_log: String(error?.code ?? 'UNKNOWN') }) }) : null
  if (credentialRefresh && terminals) terminals.watch(event => { if (event?.reachable === true) void credentialRefresh.refreshNow() })
  const seatCredential = Object.freeze({
    async issue({ botId, sessionName, terminalId }) {
      if (!seatCandidates(sessionName).includes(botId)) throw Object.assign(new Error('SEAT_CREDENTIAL_INVALID'), { code: 'SEAT_CREDENTIAL_INVALID', status: 400 })
      if (!terminals) throw TERMINALS_UNAVAILABLE()
      const terminal = await terminals.registry.get(terminalId)
      if (!terminal) throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { code: 'TERMINAL_NOT_FOUND', status: 404 })
      // The container target; Aiterm rewrites this origin to the terminal's reverse-forward end (RS05). ingressUrl is not read.
      const origin = `http://127.0.0.1:${Number(environment.BELLTEAM_REMOTE_SEAT_PORT ?? 4182)}`
      return { url: `${origin}${REMOTE_SEAT_MCP_PATH}`, credentialRef: await seatCredentials.issue({ botId, sessionName, terminalId }) }
    },
    revoke: ({ sessionName }) => seatCredentials.revoke({ sessionName }),
    // RS03: only execution's seat launch call uses this, to put the value into the launcher's stdin privateEnv.
    reveal: credentialRef => seatCredentials.reveal(credentialRef),
  })
  if (executionFactory) {
    const selection = adoptionFactory({ root }), selected = await selection.read()
    const queueListeners = new Set()
    execution = executionFactory({ onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, backgroundSummary, requestRestartSummary: ({ botId, from, to, resumed = true }) => {
      if (![from, to].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) || Date.parse(from) >= Date.parse(to))
        throw new Error('RESTART_SUMMARY_INTERVAL_INVALID')
      const [start, end] = [from, to].map(value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' '))
      // resumed:false = the previous conversation could not be resumed; this delivery wakes the seat fresh (restart-resume.md).
      const send = () => messenger.sendmessage({ from: 'scheduler', target: botId, message: resumed === false
        ? `BellTeam was updated while you were working (last seen working ${start} JST, restarted ${end} JST), and your previous conversation could not be resumed. You have been started fresh. Continue the interrupted work from your docs/ and memory. Do not redo external actions that already completed.`
        : `BellTeam reconnected after an interruption. Please summarize any output I missed between ${start} and ${end} JST. Do not repeat the previous task or external actions.` })
      return conversationAssembly ? conversationAssembly.run({ kind: 'scheduler' }, send) : send()
    }, ports: {
      native: executionClient, membersAdmission, bots,
      ...(conversationAssembly ? { conversationAdmission: conversationAssembly.admission, moduleOperations: conversationAssembly.moduleOperations } : {}), rooms: { removeBot: (...args) => rooms.removeBot(...args) },
      configurationStorage: { root: join(root, 'state/configuration-intents'), trustedAnchor },
      access: { assertWorkAllowed: () => aiControl.assertEnabled(), admitWork: () => aiControl.admit(), requireMember },
      storage: storagePorts, seat: seatPorts,
      diagnostics: { record: report => diagnostics.record(report), goalError },
      observer: { appendInterimWords: (...args) => conversationAssembly ? conversationAssembly.run({ kind: 'observer' }, () => messenger.appendInterimWords(...args)) : messenger.appendInterimWords(...args),
        emitQueue: async change => { await Promise.all([...queueListeners].map(listener => listener(change))) } },
      continuation: { models, harnessAuth: { status: harness => harnessAuth.status(harness, usageAssembly?.systemContext('auth.status')) },
        messenger: { sendmessage: (...args) => messenger.sendmessage(...args) } },
    }, loadFactory: async (...args) => {
      const factory = await loadExecution(...args)
      const supported = factory.supportsModelHandoff === true
      executionHandoffSupport.set(factory.versionId, supported)
      // Older engines reject unknown port keys; remote-seat ports go only to engines that declare them.
      const remote = factory.supportsRemoteSeats === true && terminals
        ? { terminals: { connection: terminals.connection, watch: listener => terminals.watch(listener) }, ingress: { seatCredential } } : {}
      return Object.freeze({ ...factory, createExecutionDispatcher: input => {
        input = { ...input, ports: { ...input.ports, ...remote } }
        if (supported) return factory.createExecutionDispatcher(input)
        const { deliveryAnchor, ...storage } = input.ports.storage
        return factory.createExecutionDispatcher({ ...input, ports: { ...input.ports, storage } })
      } })
    }, onAdopt: selection.save,
      currentVersionId: selected?.currentVersionId ?? null, previousVersionId: selected?.previousVersionId ?? null,
      requestStop: (sessions, options) => sendSessionStop(executionClient, sessions, options),
      watchQueue: listener => { queueListeners.add(listener); return () => queueListeners.delete(listener) },
      onState: state => { updateCenter?.notify(); if (state.phase === 'running' && state.available) directMessages?.requestDrain() } })
  }
  const transport = execution?.transport ?? createManagedTransport({ backgroundSummary, membersAdmission, client: executionClient,
    configurationRequests: new ConfigurationRequests({ client: executionClient, intents: new ConfigurationIntents(join(root, 'state/configuration-intents'),
      { trustedAnchor, runtimeCapture: () => executionClient.runtime() }) }),
    reportError: report => diagnostics.record(report), ...seatPorts, ...storagePorts,
    assertWorkAllowed: () => aiControl.assertEnabled(), requireMember })
  scheduleTurns = transport
  if (!members) bots.currentTurn = botId => transport.currentTurn(botId)
  const idleSessions = execution ? null : new IdleSessions({ bots, transport })
  const goals = execution?.goals ?? new BotGoals({ transport, admitWork: () => aiControl.admit(), reportError: goalError })
  conversationPorts.transport = transport
  const conversation = conversationAssembly ? { ...conversationAssembly.facade, assets: conversationAssembly.assets }
    : createConversationServices({ root, bots, transport, notifications, aiControl, settings, seatRuntime, seatObservation: !execution,
      onLogCorruption: report => diagnostics.record({ code: report.code, module: 'conversation', diagnostic_log: JSON.stringify(report) }) })
  const { store } = conversation
  let directTurnReports
  directMessages = createDirectReceiptAssembly({ root, bots, assets: conversationAssembly?.directAssets ?? conversation.assets,
    legacy: conversation.messenger, conversation: conversationAssembly, transport, aiControl, exchangeMutex,
    executionReady: () => !execution || execution.controller.snapshot().phase === 'running' && execution.controller.snapshot().available && !execution.hold?.held,
    onMessage: record => notifications.direct(record), onTurnEnd: turn => directTurnReports.afterTurn(turn),
    onError: (error, context) => diagnostics.record(directFailureReport(error, context)) })
  conversationPorts.directReceipts = directMessages.receipts
  const messenger = directMessages.messenger
  directTurnReports = new TurnReports({ bots, store: directMessages.receipts.store, transport,
    enabled: () => !aiControl.paused && settings.configuration('routing').enabled,
    judge: value => judgeOwnerReport({ ...value, apiKey: settings.configuration('routing').apiKey }),
    appendInterimWords: (...args) => directMessages.receipts.appendInterimWords(...args) })
  if (conversationAssembly) await conversationAssembly.initialize()
  if (conversationAssembly) {
    const reader = directMessages.receipts.store
    store.timeline = id => reader.timeline(id)
    store.timelineView = id => reader.timelineView(id)
    store.timelineViews = ids => reader.timelineViews(ids)
    store.recentViews = ids => reader.timelineViews(ids)
    store.watch = listener => reader.watch(listener)
    conversation.rooms.watch = listener => conversationAssembly.watch(listener)
  }
  assets = conversation.assets
  const onboarding = usage?.onboarding ?? new Onboarding({
    root, bots, client: transport.client, subscriptions,
    ...(seatRuntime ? { path: join(root, 'state/onboarding.json'), projectFiles: members ? {
      appendInstructions: (bot, text) => seatRuntime.membersProject('project.appendInstructions', { botId: bot.id, text }),
    } : seatRuntime.projectFiles } : {}),
    startConversation: (bot, message) => conversationAssembly ? conversationAssembly.run({ kind: 'onboarding', botId: bot.id }, () => messenger.enqueueUserTurn({ target: bot.id, message, recordUser: false })) : messenger.enqueueUserTurn({ target: bot.id, message, recordUser: false }),
  })
  await assets.initialize()
  if (!usageAssembly) await onboarding.initialize()
  // Claude 1st/2nd accounts (harness-accounts.md); an engine without them leaves this null.
  const accounts = execution?.accounts ?? null
  const harnessAuth = usage?.harnessAuth ?? new HarnessAuth({ bots, client: transport.client, accounts })
  let pollTimer = null, pollWork = null
  const pollConversation = () => {
    if (!pollWork) {
      const result = conversationAssembly.run({ kind: 'observer' }, () => conversationAssembly.facade.selfTurns.poll())
      pollWork = result.completion ?? result
      void pollWork.finally(() => { pollWork = null }).catch(() => {})
    }
    return pollWork
  }
  const conversationServices = conversationAssembly ? { rooms: conversation.rooms, roomMessenger: conversation.roomMessenger,
    seatTurns: null, selfTurns: { start() { if (!pollTimer) { void pollConversation().catch(() => {}); pollTimer = setInterval(() => { void pollConversation().catch(() => {}) }, 5000) } },
      async stop() { clearInterval(pollTimer); pollTimer = null; await pollWork } } } : await conversation.initialize()
  rooms = conversationServices.rooms
  const { selfTurns, seatTurns, roomMessenger } = conversationServices
  const scheduler = new BotScheduler({ registry: bots, messenger, transport, rooms, roomMessenger,
    membersAdmission: transport.membersAdmission,
    ...(conversationAssembly ? { moduleOperations: { withContext: (operation, context) => conversationAssembly.run({ kind: 'scheduler' }, () => conversationAssembly.moduleOperations.withContext(operation, context)) } } : {}),
    admitWork: () => aiControl.admit(),
    ...(seatRuntime ? { completedTurns: project => completedThroughlineTurns(project, { seatCommands: true }),
      runCommand: request => runShellCommand(request, { seatProject: request.cwd }) } : {}),
    paused: () => aiControl.paused,
    assertWorkAllowed: () => aiControl.assertEnabled(),
  })
  aiControl.watch(control => { if (!control.paused && transport.currentTurn) scheduler.requestAfterTurn() })
  const characterSheets = seatRuntime ? seatRuntime.characterSheets(id => bots.projectPath(id))
    : new CharacterSheets({ projectPath: id => bots.projectPath(id) })
  // Bot設定変更・停止・削除の業務判断。公開APIと席MCPが同じ判断を使う。
  const administration = execution?.administration ?? new BotAdministration({ bots, rooms, transport, ...(conversationAssembly ? { moduleOperations: conversationAssembly.moduleOperations } : {}),
    reportError: report => diagnostics.record(report) })
  if (!execution) transport.continuation = new CapacityContinuation({ bots, administration, messenger, models, harnessAuth,
    assertEnabled: () => aiControl.assertEnabled() })
  const secretRequests = usage ? { ...usage.secretRequests,
    notifyOwnerGuide: id => usage.secretRequests.notifyOwnerGuide(id, usageAssembly.systemContext('secrets.notifyOwnerGuide')),
    resolveValue: id => usage.secretRequests.resolveValue(id, usageAssembly.systemContext('secrets.resolveRequest')),
  } : new SecretRequests({
    root, bots, rooms,
    onRequest: item => notifications.secret(item),
    notify: item => messenger.enqueueUserTurn({ target: item.botId, message: secretCompletionMessage(item) }),
  })
  if (!usageAssembly) await secretRequests.initialize()
  if (submittedSecretManagement === undefined && seatRuntime) submittedSecretManagement = {
    assertOwnerAuthorized: createSubmittedSecretApprovalBridge({ project: root }),
    createConsumer: createSubmittedSecretConsumer, consume: createSubmittedSecretRabbitClient({ project: root }),
  }
  submittedSecretCaller = submittedSecretManagement ? createSubmittedSecretCaller({
    root, secretRequests, usageAssembly, aiControl, bots, ...submittedSecretManagement,
  }) : null
  const ownerQuestions = usage?.ownerQuestions ?? new OwnerQuestions({
    root, bots,
    onRequest: item => notifications.question(item),
    notify: item => messenger.enqueueUserTurn({ target: item.botId, message: ownerAnswerMessage(item) }),
  })
  if (!usageAssembly) await ownerQuestions.initialize()
  if (workGraphFactory) {
    // Optional module: the body never waits for it; the route answers 503 until the child is available.
    const { messagePage } = createMessageViews({ rooms, store, secretRequests, ownerQuestions })
    workGraphModule = workGraphFactory({ root, exchangeMutex, prepareRelease: prepareWorkGraph, onEffect: createWorkGraphEffects({ bots, transport, messagePage }),
      onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, onState: () => updateCenter?.notify() })
    workGraph = createWorkGraphFacade({ controller: workGraphModule, bots, rooms, transport })
    void workGraphModule.start().catch(() => {})
  }
  const updateClients = hostClient ? { container: hostClient, module: hostClient } : await createUpdateClients()
  const hostUpdate = createHostUpdateAdapter({ root, client: updateClients.container })
  const moduleCatalog = createModuleUpdateCatalog({ client: updateClients.module })
  const moduleExecutor = await createModuleUpdateExecutor({ root, catalog: moduleCatalog, host: hostUpdate, moduleHost: updateClients.module,
    adapters: createModuleUpdateAdapters({ gateway, builtinSourceCommit, notifications, members, memory: seatRuntime?.memoryModule, diagnostics: diagnosticsModule,
      prepareDiagnostics, workGraph: workGraphModule, prepareWorkGraph, usage: usageAssembly?.controller, prepareUsage, conversation: conversationAssembly?.controller, prepareConversation: (versionId, options) => prepareModuleRelease('conversation', versionId, options), execution: execution?.controller, prepareExecution }), notify: change => updateCenter?.notify(change) })
  updateCenter = createUpdateCenter({ gateway, builtinSourceCommit, notifications, members, host: hostUpdate, moduleCatalog, moduleExecutor,
    onCatalogCheckError: error => { void Promise.resolve(diagnostics.record({ code: 'UPDATE_CATALOG_CHECK_FAILED', module: 'update', diagnostic_log: /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'UNKNOWN' })).catch(() => {}) }, jobReader: createUpdateJobReader(updateClients), problemReader: async () => moduleRestartLimitProblems(await diagnostics.list('all', 1000)), memory: seatRuntime?.memoryModule, diagnostics: diagnosticsModule, workGraph: workGraphModule, usage: usageAssembly?.controller, conversation: conversationAssembly?.controller, execution: execution?.controller, captureRuntime })
  Object.assign(usageServices, { bots, rooms, transport, messenger, notifications, settings, updateCenter, conversationAssembly, backgroundSummary, accounts })
  if (usageAssembly) await usageAssembly.initializeServices()
  // Missing or corrupt summary settings must not prevent the main application from starting.
  try { backgroundSummary.configure(await settings.backgroundAgentConfiguration()) } catch {}
  // Z-c: a hold saved by the replaced box is restored before the engine starts; release redrains saved input.
  if (execution?.hold) { await execution.hold.initialize(); execution.hold.watch(() => directMessages?.requestDrain()) }
  if (execution) await execution.controller.start()
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
    aiControl, subscriptions, settings, onboarding, harnessAuth, updateCenter, moduleChildExitReporter, membersAuthorization, members, usageAssembly, conversationAssembly, execution, modelHandoffGeneration, backgroundSummary, directMessages,
    notifications, secretRequests, ownerQuestions, bots, rooms,
    roomMessenger, messenger, store, transport, memory,
    ownerProfile, userRules, characterSheets, refreshGlobalInstructions, assets,
    scheduler, diagnostics, diagnosticsModule, workGraph, workGraphModule, accounts, terminals, terminalKeys, seatCredentials, credentialRefresh, idleSessions, selfTurns, seatTurns, administration, goals, olrwAuthCaller, submittedSecretCaller,
    // Saved direct input drains after listen (Z-c). Starting before the hold release is safe and needs no bound:
    // executionReady is false while held, and the release's hold.watch → requestDrain drains it.
    lifecycle: { ...execution?.lifecycle,
      afterListenReady: async () => { directMessages.start(); void credentialRefresh?.refreshNow(); await execution?.lifecycle?.afterListenReady?.() } },
  }
  } catch (error) {
    const failures = []
    for (const close of [() => credentialRefresh?.stop(), () => terminals?.close?.(), () => directMessages?.close(), () => submittedSecretCaller?.close(), () => backgroundSummary?.close(), () => moduleChildExitReporter.close(), () => updateCenter?.close(), () => seatRuntime?.memoryModule?.close(),
      () => conversationAssembly?.close(), () => execution?.controller.close(), () => execution && executionClient?.close(),
      () => members?.controller.close(), () => usageAssembly?.close(), () => diagnosticsModule?.close(), () => workGraphModule?.close()]) {
      try { await close() } catch (cleanupError) { failures.push(cleanupError) }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'APPLICATION_SERVICES_FAILED')
    throw error
  }
}
