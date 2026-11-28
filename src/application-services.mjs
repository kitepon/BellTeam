import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { goalFailureCause } from './execution-failure-report.mjs'
import { TurnReports, judgeOwnerReport } from './turn-reports.mjs'
import { createDirectReceiptAssembly, directFailureReport } from './direct-receipt-assembly.mjs'
import { createModuleChildExitReporter } from './module-child-exit-reporter.mjs'
import { mkdir } from 'node:fs/promises'
import { createSeatProcessRunner } from './seat-process.mjs'
import { seatCommandSpec } from './seat-command.mjs'
import { createUserToolRelay } from './remote-user-tools.mjs'
import { aitermCallerReplaceSupported } from './aiterm-hooks.mjs'
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
import { basename, dirname, join } from 'node:path'
import { createConversationServices } from './conversation-services.mjs'
import { CharacterSheets } from './character-sheets.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { CapacityContinuation } from './capacity-continuation.mjs'
import { createSecretUse } from './secret-use.mjs'
import { BotGoals } from './bot-goals.mjs'
import { AitermClient } from './aiterm-client.mjs'
import { AitermGenerationClient } from './aiterm-generation-client.mjs'
import { ConfigurationIntents } from './configuration-intents.mjs'
import { acquireConfigurationStateAnchor } from './configuration-state-anchor.mjs'
import { ConfigurationRequests } from './configuration-requests.mjs'
import { createManagedTransport } from './aiterm-transport.mjs'
import { runWaitProcess } from './aiterm-wait-process.mjs'
import { completedThroughlineTurns, latestThroughlineHandoffContext, throughlineActivity } from './throughline-context.mjs'
import { AiControl, stopRegisteredWork } from './ai-control.mjs'
import { prepareModuleRelease } from './module-release.mjs'
import { createDiagnosticsFacade } from './diagnostics-facade.mjs'
import { createWorkGraphFacade, createWorkGraphEffects } from './work-graph-facade.mjs'
import { createLatticeFacade, createLatticeEffects, lateAnswerText } from './lattice-facade.mjs'
import { createLatticeReminders } from './lattice/reminders.mjs'
import { createLatticeDecisions } from './lattice-decisions.mjs'
import { createApprovalBoxClientPort } from './approval-box-client.mjs'
import { createSeatEntryPublisher } from './approval-box-entries.mjs'
import { createSeatApprovals } from './seat-approvals.mjs'
import { createApprovalBoxExtensionEffects } from './approval-box-parent-effects.mjs'
import { createApprovalsFacade } from './approval-box-parent-facade.mjs'
import { createAuthMediationEffects } from './auth-mediation-effects.mjs'
import { createAuthMediationFacade } from './auth-mediation-facade.mjs'
import { createAuthMediationRelay } from './auth-mediation-relay.mjs'
import { createRunningExclusions } from './running-exclusions.mjs'
import { createSeatCredentials } from './seat-credentials.mjs'
import { createTerminalKeyHolder, TERMINAL_KEY_OPERATOR } from './terminal-key-holder.mjs'
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
import { MachineStream } from './machine-stream.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { memoryPressure } from './memory-pressure.mjs'
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
import { createRemoteSeatListener, remoteSeatPort } from './remote-seat-port.mjs'
import { prepareOlrwManagement } from './olrw-management-loader.mjs'
import { roomForwardSource } from './origin-reference.mjs'
import { createHomeFront } from './home-login-front.mjs'
import { readMemberSummary } from './members-facade.mjs'

// Saving a report is observation; a store refusal must not fail the child's call, its quiesce or a module exchange.
export const conversationDiagnosticPort = diagnostics => report => Promise.resolve()
  .then(() => diagnostics.record({ code: report.code, module: 'conversation',
    ...(['MESSAGE_LOG_INVALID', 'CONVERSATION_OBSERVATION_FAILED'].includes(report.code) ? { diagnostic_log: JSON.stringify(report) } : {}) }))
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

const TERMINAL_KEY_LOAD_FAILED = (code = 'TERMINAL_KEY_LOAD_UNAVAILABLE', status = 503) => Object.assign(new Error(code), { code, status })
const uuidText = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)

// RS13: hand a secret-backed SSH key to the terminal's private ssh-agent. Only this parent resolves the value; it crosses
// once, on the bin's stdin (never argv, env, file, PTY or log). Exit 0 = accepted receipt, exit 2 = binding error DTO.
export async function loadTerminalKey({ credentials, terminalId, memberId = null, ref, handle, revision, run, reader = null }) {
  if (typeof terminalId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(terminalId) || !uuidText(ref) || !uuidText(handle)
    || !Number.isSafeInteger(revision) || revision < 1 || (memberId !== null && typeof memberId !== 'string'))
    throw TERMINAL_KEY_LOAD_FAILED('TERMINAL_KEY_LOAD_INVALID', 400)
  // The 認証仲介 module's ssh agent serves the key: nothing is loaded into Aiterm and the parent never holds it. The receipt only says the agent holds this terminal's key.
  if (reader?.owns(terminalId)) {
    if ((await reader.available(terminalId)).available !== true) throw TERMINAL_KEY_LOAD_FAILED('CREDENTIAL_UNAVAILABLE')
    return { schema: 'aiterm.credential-load.v1', accepted: true, ref, handle, revision, source: 'module-agent' }
  }
  if (typeof credentials?.withResolved !== 'function') throw TERMINAL_KEY_LOAD_FAILED('CREDENTIAL_UNAVAILABLE')
  return credentials.withResolved(handle, { terminalId, memberId, purpose: 'terminal.ssh', expectedRevision: revision }, async value => {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 65536) throw TERMINAL_KEY_LOAD_FAILED('TERMINAL_KEY_INVALID', 400)
    let result
    try {
      result = await run('/usr/bin/env', ['aiterm-remote-terminal', 'credential-load', '--ref', ref, '--terminal-id', terminalId,
        '--handle', handle, '--revision', String(revision), '--purpose', 'ssh-key'], { input: Buffer.from(value, 'utf8'), acceptNonzero: true, maxBuffer: 65536 })
    } catch { throw TERMINAL_KEY_LOAD_FAILED() }
    let dto
    try { dto = JSON.parse(result.stdout) } catch { throw TERMINAL_KEY_LOAD_FAILED() }
    if (!result.signal && result.code === 0 && dto?.schema === 'aiterm.credential-load.v1') return dto
    if (!result.signal && result.code === 2 && dto?.schema === 'aiterm.remote-binding-error.v1')
      throw Object.assign(TERMINAL_KEY_LOAD_FAILED(typeof dto.code === 'string' ? dto.code : 'TERMINAL_KEY_LOAD_REFUSED', 409), { binding: dto })
    throw TERMINAL_KEY_LOAD_FAILED()
  })
}

// Protects the wrong target: an engine without remote seats would start a terminal-bound member in the server folder.
// Exit: selecting an engine that declares EXECUTION_REMOTE_SEATS (no wrap), or the member losing its terminalId.
// fork-inquiry.md "Owed notice" trigger: at most one root fork.sweep in flight, released on its root result
// (its completion lasts as long as the relayed delivery). An older child refuses the method (not_accepted): silent.
export function createForkSweepTick(sweep, report = code => process.stderr.write(`${JSON.stringify({ code: 'FORK_SWEEP_FAILED', reason: code })}\n`)) {
  let work = null, last = null
  return Object.assign(() => {
    work ??= new Promise(resolve => resolve(sweep())).then(() => { last = null }, error => {
      if (error?.outcome === 'not_accepted') return
      const code = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error?.code ?? '') ? error.code : 'FORK_SWEEP_FAILED'
      if (code !== last) { last = code; report(code) }
    }).finally(() => { work = null })
    return work
  }, { inFlight: () => work })
}

export function refuseRemoteSeatLaunch({ native, bots, botsRoot, versionId = null, record = () => {} }) {
  const guard = call => (name, args, ...rest) => {
    const cwd = args?.cwd
    const bot = name === 'agent_launch' && typeof cwd === 'string' && dirname(cwd) === botsRoot ? bots.get(basename(cwd)) : null
    if (typeof bot?.terminalId !== 'string' || bot.terminalId === '') return call(name, args, ...rest)
    void Promise.resolve().then(() => record({ code: 'REMOTE_SEAT_ENGINE_UNSUPPORTED', module: 'execution',
      diagnostic_log: `bot ${bot.id} execution ${versionId ?? 'unknown'}` })).catch(() => {})
    return Promise.reject(Object.assign(new Error('AI実行制御が古く、この席を端末で起こせません'),
      { code: 'REMOTE_SEAT_ENGINE_UNSUPPORTED', effect: 'not_started', status: 503 }))
  }
  const wrapped = Object.create(native)
  wrapped.call = guard((...args) => native.call(...args))
  // The old engine's operation lease launches through native.pin() (aiterm-generation-pin.md). The pin is frozen with
  // live getters and its own release; define call over it instead of copying.
  if (typeof native.pin === 'function') wrapped.pin = (...args) => {
    const pinned = native.pin(...args)
    return Object.create(pinned, { call: { value: guard((...callArgs) => pinned.call(...callArgs)) } })
  }
  return wrapped
}

export async function createApplicationServices({ root, moduleChildExitReporter = createModuleChildExitReporter(), exchangeMutex = createModuleExchangeMutex(), aiterm, bots, ownerProfile, settings, userRules, environment = process.env, client, seatRuntime = null, botEnvironments = null, olrwManagement = undefined, createNotificationsProcess: createProcess = createNotificationsProcess, gateway = () => null, models = null, notify = null, createMembersProcess: membersFactory, createDiagnosticsProcess: diagnosticsFactory, createWorkGraphProcess: workGraphFactory, prepareWorkGraphRelease: prepareWorkGraph = (versionId, options) => prepareModuleRelease('work-graph', versionId, options), createLatticeProcess: latticeFactory, createApprovalBoxExtensionProcess: approvalsFactory, createAuthMediationProcess: authMediationFactory, prepareAuthMediationRelease: prepareAuthMediation = (versionId, options) => prepareModuleRelease('auth-mediation', versionId, options), prepareLatticeRelease: prepareLattice = (versionId, options) => prepareModuleRelease('lattice', versionId, options), prepareApprovalBoxExtensionRelease: prepareApprovals = (versionId, options) => prepareModuleRelease('approval-box-extension', versionId, options), hostUpdateClient: hostClient, prepareDiagnosticsRelease: prepareDiagnostics = (versionId, options) => prepareModuleRelease('diagnostics', versionId, options), builtinSourceCommit = null, usageAssembly = null, attachUsageServices = () => {}, prepareUsageRelease: prepareUsage = (versionId, options) => prepareModuleRelease('usage', versionId, options), createConversationAssembly: conversationFactory, createExecutionAssembly: executionFactory, loadExecutionFactory: loadExecution = loadExecutionFactory, createExecutionAdoptionStore: adoptionFactory = createExecutionAdoptionStore, prepareExecutionRelease: prepareExecution = prepareExecutionRelease, createTerminalsCore = null, terminalKeyReader = null }) {
  let terminals = null, credentialRefresh = null, members = null, diagnosticsModule = null, workGraphModule = null, workGraph = null, latticeModule = null, lattice = null, approvalsModule = null, approvals = null, authMediationModule = null, authMediation = null, authMediationRelay = null, terminalKeyLoader = null, conversationAssembly = null, execution = null, executionClient, memory, rooms, assets, updateCenter, backgroundSummary, directMessages = null
  let scheduleTurns = null
  // a164: the members assembly reads the scheduler lazily; it is built after the members child starts.
  let scheduler = null
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
      membersAuthorization, diagnostics, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, dependencies: () => ({ memory, rooms, assets, conversationAssembly, scheduleTurns, terminals, scheduler }), onState: () => updateCenter?.notify(),
      ...(membersFactory ? { createProcess: membersFactory } : {}),
    })
    await members.controller.start()
    bots = members.bots; ownerProfile = members.ownerProfile; userRules = members.userRules
  }
  const notifications = createNotifications({ root, bots, diagnostics, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit,
    configuration: () => ({ apns: settings.configuration('notifications') }), createProcess,
    onState: state => {
      // Usage applies errors through its captured settings.changed epoch, never a later snapshot.
      if (!usageAssembly) for (const [provider, feature] of [['apns', 'notifications']]) {
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
  // a451 (cli-not-installed.md): usage's harnessCli window, read lazily; absent (older usage module) reads every CLI as installed.
  const harnessCli = () => usageAssembly?.harnessCli ?? null
  backgroundSummary = createTeamBackgroundSummary({ project: summaryProject, settings, models, harnessCli,
    conversation: () => conversationAssembly, enabled: () => !aiControl.paused,
    notify: () => notify?.({ type: 'bots' }) })
  // Stable native port: one generation until the updater publishes an activated candidate.
  const initialClient = client ?? new AitermClient({ ...aiterm, ...(seatRuntime ? { seatProject: root } : {}), environmentReady: botEnvironments?.ready })
  executionClient = new AitermGenerationClient({ client: initialClient, runtimeCapture: null })
  const seatPorts = seatRuntime ? {
    writeTemporaryImage: (path, bytes) => seatRuntime.writeTemporaryImage(path, bytes),
    removeTemporaryImage: path => seatRuntime.removeTemporaryImage(path),
    handoffContext: project => latestThroughlineHandoffContext(project, { seatCommands: true }),
    seatActivity: project => throughlineActivity(project, { seatCommands: true }),
    waitProcess: (process, signal) => runWaitProcess(process, signal, { seatProject: root }),
  } : {}
  const requireMember = async (bot, context) => {
    if (typeof bots.readMember === 'function') { await readMemberSummary(bots, bot.id, context); return }
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
    await diagnostics.record({ code: 'GOAL_OPERATION_UNCONFIRMED', module: 'goals', diagnostic_log: `${error.constructor.name}\n${JSON.stringify(goalFailureCause(error))}\n${frames.join('\n')}` })
  }
  // conversation/machine-stream.md: execution hands envelopes to seatStream (ingest/cursor); the Owner's answer goes back through transport.streamSend.
  const machineStream = new MachineStream({
    root, bots, onRequest: item => notifications.question(item),
    showThinking: () => settings.configuration('thinkingDisplay').enabled,
    streamSend: (botId, input) => typeof transport.streamSend === 'function' ? transport.streamSend(bots.get(botId), input)
      : Promise.reject(Object.assign(new Error('EXECUTION_REQUEST_INVALID'), { code: 'EXECUTION_REQUEST_INVALID' })),
  })
  await machineStream.initialize()
  const conversationPorts = { bots, settings, seatRuntime, aiControl, seatStream: machineStream, conversationUsage: createConversationUsage({ settings, notifications }) }
  if (conversationFactory) conversationAssembly = conversationFactory({ root, membersAdmission, exchangeMutex, onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, getServices: () => conversationPorts,
    onDiagnostic: conversationDiagnosticPort(diagnostics), onState: state => { updateCenter?.notify(); if (state.phase === 'running' && state.available) directMessages?.requestDrain() } })
  // Remote seats (remote-seat-ingress.md): terminals core is an in-parent injectable; seat credentials are parent state.
  // authMediation is built later in this function, so the loader reads it lazily.
  // The module's ssh agent holds the three terminal keys (terminal-keys-module-agent): started once, it needs the operator Bot's folder as its caller identity.
  const operatorProject = bots.get(TERMINAL_KEY_OPERATOR)?.project ?? null
  terminalKeyLoader = operatorProject ? createTerminalKeyHolder({ run: createSeatProcessRunner(operatorProject, { environment: 'base' }),
    report: report => void Promise.resolve(diagnostics.record(report)).catch(() => process.stderr.write(`BellTeam terminal key holder: ${report.code}: ${report.reason}\n`)) }) : null
  const seatCredentials = createSeatCredentials({ path: join(root, 'state/seat-credentials.json') })
  // remote-user-tools.md U1: names/kinds of the user-global MCP servers for a Bot's harness, read as the seat user.
  const listUserToolsFor = async botId => {
    const bot = bots.get(botId)
    if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND' })
    const { stdout } = await createSeatProcessRunner(bot.project)(process.execPath, [fileURLToPath(new URL('./user-tools.mjs', import.meta.url)), 'list', bot.harness])
    const value = JSON.parse(stdout)
    if (value?.schema !== 'bellteam.user-tools.v1' || !Array.isArray(value.tools)) throw Object.assign(new Error('USER_TOOL_LIST_FAILED'), { code: 'USER_TOOL_LIST_FAILED' })
    return value.tools.filter(tool => typeof tool?.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(tool.name)).map(tool => ({ name: tool.name, kind: tool.kind }))
  }
  // remote-user-tools.md U3: one host per (terminal seat, user tool), run as the seat user in the Bot's container folder.
  const userToolRelay = createUserToolRelay({ spawnHost: (binding, name) => {
    const bot = bots.get(binding.botId)
    if (!bot) throw Object.assign(new Error('BOT_NOT_FOUND'), { code: 'BOT_NOT_FOUND', status: 404 })
    const spec = seatCommandSpec(process.execPath, [fileURLToPath(new URL('./run-user-tool.mjs', import.meta.url)), bot.harness, name], { project: bot.project })
    return spawn(spec.command, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
  } })
  terminals = createTerminalsCore ? createTerminalsCore({ stateRoot: join(root, 'state'), credentials: usageAssembly?.credentials ?? null,
    keyReader: terminalKeyReader ?? terminalKeyLoader ?? null, report: report => diagnostics.record(report) }) : null
  // RS11: native SSH credential status comes from Elegg's one-shot UID 1000 bin; usage validates the DTO.
  if (terminals && usageAssembly?.credentials?.setNativeProvider) usageAssembly.credentials.setNativeProvider({ status: ref => remoteTerminalStatus(root, ref) })
  // RS12: bind an Aiterm-held key ref to a registered terminal; the target comes from the record, never the caller.
  const terminalKeys = terminals && usageAssembly?.credentials?.registerNative ? createTerminalKeys({ terminals, credentials: usageAssembly.credentials }) : null
  // Usage has no timer of its own; the parent drives refresh while a credential is unavailable (Mika C5).
  credentialRefresh = usageAssembly?.credentials?.refresh && usageAssembly.credentials.watch ? createCredentialRefresh({
    refresh: () => usageAssembly.credentials.refresh(), watch: listener => usageAssembly.credentials.watch(listener),
    ...(usageAssembly.credentials.watchRecovery ? { watchRecovery: listener => usageAssembly.credentials.watchRecovery(listener) } : {}),
    report: error => diagnostics.record({ code: 'SECRET_CREDENTIAL_REFRESH_FAILED', module: 'integration', diagnostic_log: String(error?.code ?? 'UNKNOWN') }) }) : null
  // a485: the login-billing home part's body side. Always built when usage exists (an Enforced marker must outlive any configuration);
  // answers 404 on /api/home until an operator is configured and the owner has bound the server.
  const homeFront = usageAssembly?.home ? createHomeFront({ enabled: Boolean(environment.BELLTEAM_HOME_OPERATOR), markerPath: join(root, 'state/login-enforced'),
    call: (name, params) => usageAssembly.home[name.slice('home.'.length)](params) }) : null
  if (credentialRefresh && terminals) terminals.watch(event => { if (event?.reachable === true) void credentialRefresh.refreshNow() })
  // The runtime owns the listener (it holds seat MCP); it binds its ensure here before any launch can run.
  const remoteSeatListener = createRemoteSeatListener()
  // SM10: the seat MCP is created after the services; the runtime binds its seen read here.
  let seatMcpSeen = () => null
  const bindSeatMcpSeen = read => { seatMcpSeen = read }
  const seatCredential = Object.freeze({
    async issue({ botId, sessionName, terminalId, kind = 'main' }) {
      // SK03: a fork's name is <mainSession>-fork-<12hex>; its main part must speak for botId.
      const named = kind === 'fork' ? /^(.+)-fork-[0-9a-f]{12}$/u.exec(sessionName)?.[1] : sessionName
      if (!seatCandidates(named).includes(botId)) throw Object.assign(new Error('SEAT_CREDENTIAL_INVALID'), { code: 'SEAT_CREDENTIAL_INVALID', status: 400 })
      if (!terminals) throw TERMINALS_UNAVAILABLE()
      const terminal = await terminals.registry.get(terminalId)
      if (!terminal) throw Object.assign(new Error('TERMINAL_NOT_FOUND'), { code: 'TERMINAL_NOT_FOUND', status: 404 })
      // The container target; Aiterm rewrites this origin to the terminal's reverse-forward end (RS05). ingressUrl is not read.
      // RS05: the listener is retried here while it is down, so a seat is never launched toward a dead MCP.
      await remoteSeatListener.ensureFor(terminalId)
      const origin = `http://127.0.0.1:${remoteSeatPort(environment)}`
      // A new launch of this seat replaces the old one; its user-tool hosts end with it.
      userToolRelay.closeSeat(sessionName)
      return { url: `${origin}${REMOTE_SEAT_MCP_PATH}`, credentialRef: await seatCredentials.issue({ botId, sessionName, terminalId, kind }) }
    },
    revoke: ({ sessionName }) => { userToolRelay.closeSeat(sessionName); return seatCredentials.revoke({ sessionName }) },
    // RS03: only execution's seat launch call uses this, to put the value into the launcher's stdin privateEnv.
    reveal: credentialRef => seatCredentials.reveal(credentialRef),
    // RS13: execution calls this before launching on a secret-backed terminal (target.credential {handle, revision}).
    loadTerminalKey: ({ terminalId, memberId = null, ref, handle, revision }) => loadTerminalKey({ credentials: usageAssembly?.credentials ?? null,
      terminalId, memberId, ref, handle, revision, run: createSeatProcessRunner(root), reader: terminalKeyReader ?? terminalKeyLoader ?? null }),
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
        emitQueue: async change => { await Promise.all([...queueListeners].map(listener => listener(change))) },
        // host-factory.md observer port: seat-turn and idle-close reports (closes, EACCES) go to the body log.
        report: message => process.stderr.write(`${message}\n`) },
      continuation: { models, harnessAuth: { status: harness => harnessAuth.status(harness, usageAssembly?.systemContext('auth.status')) },
        // The engine sends as the scheduler; without its own scope a send ran in whatever request triggered the review and was
        // refused (CONVERSATION_SENDER_FORBIDDEN / CONTEXT_REQUIRED, 2026-11-25 every minute for every limit-ended member).
        messenger: { sendmessage: (...args) => conversationAssembly ? conversationAssembly.run({ kind: 'scheduler' }, () => messenger.sendmessage(...args)) : messenger.sendmessage(...args) } },
    }, loadFactory: async (...args) => {
      const factory = await loadExecution(...args)
      const supported = factory.supportsModelHandoff === true
      executionHandoffSupport.set(factory.versionId, supported)
      // Older engines reject unknown port keys; remote-seat ports go only to engines that declare them.
      const cli = usageAssembly?.harnessCli
      const harnessPort = factory.supportsHarnessCli === true && cli && typeof cli.installed === 'function' && typeof cli.watch === 'function'
        ? { harnessCli: { installed: () => cli.installed(), watch: listener => cli.watch(listener), ...(typeof cli.recheck === 'function' ? { recheck: harness => cli.recheck(harness) } : {}) } } : {}
      // machine-stream.md: conversation's seatStream (cursor, ingest) goes only to an engine that declares it (EXECUTION_SEAT_STREAM).
      const streamPort = factory.supportsSeatStream === true
        ? { seatStream: { cursor: botId => machineStream.cursor(botId), ingest: envelope => machineStream.ingest(envelope),
          // a471-chat-from-stream: only this flag makes execution stop relaying words and set stream on user.complete / shown.read; set only for an engine that knows it (an older engine rejects unknown port keys).
          ...(factory.supportsSeatStreamDisplay === true ? { displayFromStream: true } : {}) } } : {}
      const remote = factory.supportsRemoteSeats === true && terminals
        ? { terminals: { connection: terminals.connection, watch: listener => {
          const off = [terminals.watch(listener), remoteSeatListener.watch(listener)]
          return () => { for (const stop of off) stop?.() }
        } }, ingress: { seatCredential,
          ...(factory.supportsSeatMcpSeen === true ? { seatMcp: { seen: name => seatMcpSeen(name) } } : {}),
          ...(factory.supportsRemoteUserTools === true ? { userTools: { list: listUserToolsFor, callerReplace: aitermCallerReplaceSupported() } } : {}) } } : {}
      return Object.freeze({ ...factory, createExecutionDispatcher: input => {
        input = { ...input, ports: { ...input.ports, ...remote, ...harnessPort, ...streamPort } }
        if (factory.supportsRemoteSeats !== true) input.ports.native = refuseRemoteSeatLaunch({ native: input.ports.native, bots,
          botsRoot: join(root, 'bots'), versionId: factory.versionId, record: report => diagnostics.record(report) })
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
  const transport = execution?.transport ?? createManagedTransport({ backgroundSummary, membersAdmission, client: executionClient, harnessCli: usageAssembly?.harnessCli ?? null,
    configurationRequests: new ConfigurationRequests({ client: executionClient, intents: new ConfigurationIntents(join(root, 'state/configuration-intents'),
      { trustedAnchor }) }),
    reportError: report => diagnostics.record(report), ...seatPorts, ...storagePorts,
    assertWorkAllowed: () => aiControl.assertEnabled(), requireMember })
  scheduleTurns = transport
  if (!members) bots.currentTurn = botId => transport.currentTurn(botId)
  const idleSessions = execution ? null : new IdleSessions({ bots, transport, pressure: memoryPressure() })
  const goals = execution?.goals ?? new BotGoals({ transport, admitWork: () => aiControl.admit(), reportError: goalError })
  conversationPorts.transport = transport
  const conversation = conversationAssembly ? { ...conversationAssembly.facade, assets: conversationAssembly.assets }
    : createConversationServices({ root, bots, transport, notifications, aiControl, settings, seatRuntime, seatObservation: !execution,
      onLogCorruption: report => diagnostics.record({ code: report.code, module: 'conversation', diagnostic_log: JSON.stringify(report) }) })
  const { store } = conversation
  let directTurnReports
  directMessages = createDirectReceiptAssembly({ root, bots, assets: conversationAssembly?.directAssets ?? conversation.assets,
    legacy: conversation.messenger, conversation: conversationAssembly, transport, aiControl, exchangeMutex, environmentReady: botEnvironments?.ready,
    // forward.md: a forward's original is read from the direct log or the room's saved messages (rooms is assigned below).
    forwardSource: async ({ kind, id, messageId }) => kind === 'bot' ? directMessages.receipts.store.forwardSource(id, messageId)
      : roomForwardSource((await rooms.messages(id)).find(row => row.id === messageId)),
    executionReady: () => !execution || execution.controller.snapshot().phase === 'running' && execution.controller.snapshot().available && !execution.hold?.held,
    machineRow: async (botId, rowId) => machineStream.rowSource(botId, rowId),
    onMessage: record => notifications.direct(record), onTurnEnd: turn => directTurnReports.afterTurn(turn),
    onError: (error, context) => diagnostics.record(directFailureReport(error, context)),
    onLogCorruption: conversationDiagnosticPort(diagnostics) })
  conversationPorts.directReceipts = directMessages.receipts
  const messenger = directMessages.messenger
  directTurnReports = new TurnReports({ bots, store: directMessages.receipts.store, transport,
    enabled: () => !aiControl.paused && settings.configuration('routing').enabled,
    judge: value => judgeOwnerReport({ ...value, apiKey: settings.configuration('routing').apiKey }),
    streamRows: botId => machineStream.timeline({ botId }),
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
  const sweepForks = conversationAssembly ? createForkSweepTick(() => conversationAssembly.run({ kind: 'observer' }, () => conversationAssembly.facade.sweepForks())) : null
  const tick = () => { void pollConversation().catch(() => {}); void sweepForks() }
  const conversationServices = conversationAssembly ? { rooms: conversation.rooms, roomMessenger: conversation.roomMessenger,
    seatTurns: null, selfTurns: { start() { if (!pollTimer) { tick(); pollTimer = setInterval(tick, 5000) } },
      async stop() { clearInterval(pollTimer); pollTimer = null; await Promise.all([pollWork, sweepForks.inFlight()]) } } } : await conversation.initialize()
  rooms = conversationServices.rooms
  const { selfTurns, seatTurns, roomMessenger } = conversationServices
  scheduler = new BotScheduler({ registry: bots, messenger, transport, rooms, roomMessenger,
    membersAdmission: transport.membersAdmission,
    ...(conversationAssembly ? { moduleOperations: { withContext: (operation, context) => conversationAssembly.run({ kind: 'scheduler' }, () => conversationAssembly.moduleOperations.withContext(operation, context)) } } : {}),
    admitWork: () => aiControl.admit(),
    ...(seatRuntime ? { completedTurns: project => completedThroughlineTurns(project, { seatCommands: true }),
      runCommand: request => runShellCommand(request, { seatProject: request.cwd }) } : {}),
    paused: () => aiControl.paused,
    assertWorkAllowed: () => aiControl.assertEnabled(),
    lattice: () => lattice,
  })
  if (!members) bots.onScheduleRemoved = (botId, schedule) => scheduler.releaseConnection(botId, schedule)
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
  if (seatRuntime) secretRequests.useValue = createSecretUse({ projectPath: id => bots.projectPath(id),
    secretRequests: usage?.secretRequests ?? secretRequests, systemContext: usageAssembly?.systemContext ?? null })
  const ownerQuestions = usage?.ownerQuestions ?? new OwnerQuestions({
    root, bots,
    onRequest: item => notifications.question(item),
    notify: item => messenger.enqueueUserTurn({ target: item.botId, message: ownerAnswerMessage(item) }),
  })
  if (!usageAssembly) await ownerQuestions.initialize()
  if (workGraphFactory) {
    // Optional module: the body never waits for it; the route answers 503 until the child is available.
    const { messagePage } = createMessageViews({ rooms, store, secretRequests, ownerQuestions, machineStream })
    const workGraphEffects = createWorkGraphEffects({ bots, transport, messagePage })
    workGraphModule = workGraphFactory({ root, exchangeMutex, prepareRelease: prepareWorkGraph, onEffect: workGraphEffects,
      onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, onState: () => updateCenter?.notify() })
    workGraph = createWorkGraphFacade({ controller: workGraphModule, bots, rooms, transport, ownWork: workGraphEffects.ownWork })
    void workGraphModule.start().catch(() => {})
  }
  // The seats' Approval Box binary is the seat user's (the body is uid 1001, ~/.approval-box is 0700): run it as the seat user (seat-process.mjs). No seat runtime (dev, tests): no runner.
  const seatRun = seatRuntime ? createSeatProcessRunner(root, { environment: 'base' }) : null
  const approvalBoxPort = createApprovalBoxClientPort({ seatRun })
  // P5 (decision-port.md): the seat entry file Molly's registration reads; started and closed with the body, independent of any connector (the connector's start used to carry it).
  const seatEntries = seatRun ? createSeatEntryPublisher({ file: join(root, 'state', 'approval-box-entries', 'harness-entries.json'), run: seatRun }) : null
  if (latticeFactory) {
    // Optional module like work-graph: the routes and the seat tool answer LATTICE_UNAVAILABLE until the child is available.
    // Each new child generation (start, restart, exchange) re-delivers unacked startable notices; the call waits until the child is ready.
    const latticeEffects = createLatticeEffects({ bots, messenger, transport,
      decisions: createLatticeDecisions({ port: () => approvals?.decisions }),
      runAs: (actor, send) => conversationAssembly ? conversationAssembly.run(actor, send) : send() })
    latticeModule = latticeFactory({ root, exchangeMutex, prepareRelease: prepareLattice, onEffect: latticeEffects,
      onGeneration: () => { void lattice?.deliver() },
      onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, onState: () => updateCenter?.notify() })
    const reminders = createLatticeReminders(join(root, 'state/lattice-reminders.json'))
    // Late answer (lattice-child.md): the real outcome of a write that was answered PENDING goes to its seat, through the notice send path.
    lattice = createLatticeFacade({ controller: latticeModule, reminders,
      onLate: late => latticeEffects('messages.send', { from: 'scheduler', target: late.from, message: lateAnswerText(late) }) })
    void latticeModule.start().catch(() => {})
  }
  // R5: Approval Box extension child (runtime/approval-box-extension-child.md). Optional like lattice; its routes answer APPROVALS_UNAVAILABLE until the child serves.
  if (approvalsFactory && lattice) {
    approvalsModule = approvalsFactory({ root, exchangeMutex, prepareRelease: prepareApprovals,
      onEffect: createApprovalBoxExtensionEffects({ lattice, bots, credentials: usageAssembly?.credentials ?? null, decisions: approvalBoxPort, messenger,
        runAs: (actor, send) => conversationAssembly ? conversationAssembly.run(actor, send) : send() }),
      onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, onState: () => updateCenter?.notify() })
    approvals = createApprovalsFacade({ controller: approvalsModule, decisions: approvalBoxPort })
    void approvalsModule.start().catch(() => {})
    approvals.start()
  }
  // 認証仲介 (runtime/auth-mediation-child.md): optional like work-graph; the sockets, the MCP tool and the admin route answer "not running" until the child serves. Starts without waiting.
  if (authMediationFactory) {
    authMediationModule = authMediationFactory({ root, exchangeMutex, prepareRelease: prepareAuthMediation,
      onEffect: createAuthMediationEffects({ bots, credentials: usageAssembly?.credentials ?? null }),
      onModuleChildExit: moduleChildExitReporter.observe, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit, onState: () => updateCenter?.notify() })
    authMediation = createAuthMediationFacade({ controller: authMediationModule, bots })
    void authMediationModule.start().catch(() => {})
    // The sockets (container.sock, host.sock) are the relay's, run as the seat uid; this is the body's endpoint and its supervision. No seat runtime (dev, tests): no relay.
    if (seatRuntime) {
      authMediationRelay = createAuthMediationRelay({ root, facade: authMediation, onModuleRestartLimit: moduleChildExitReporter.observeRestartLimit })
      void authMediationRelay.start().catch(() => {})
    }
  }
  // Start after authMediationRelay is wired so the first `auth ssh` does not race container.sock creation on boot.
  void terminalKeyLoader?.start()
  // a41 (execution current-work.md "Own work"): the only writer of the running exclusion list, on its own connector (Flora 2026-11-13).
  const runningExclusions = createRunningExclusions({ path: join(root, 'state', 'execution-running-exclusions.json'), decisions: approvalBoxPort })
  // seat-approval-to-abx (execution/seat-approvals.md): a seat stopped on a tool approval reaches the Owner as a card through P1 and as an entry.
  const seatApprovals = createSeatApprovals({ path: join(root, 'state', 'seat-approvals.json'), bots, transport, machineStream,
    // The push is the existing owner_question one (title = the Bot's name); tapping it opens the Bot, where the entry is.
    push: { seatApproval: item => notifications.question({ id: item.id, botId: item.botId }) },
    // Until the Owner has linked the one connection (or after he removes it) P1 answers UNAVAILABLE: nothing is filed and the entry stays in-app only.
    decisions: approvalBoxPort })
  const updateClients = hostClient ? { container: hostClient, module: hostClient } : await createUpdateClients()
  const hostUpdate = createHostUpdateAdapter({ root, client: updateClients.container })
  const moduleCatalog = createModuleUpdateCatalog({ client: updateClients.module })
  const moduleExecutor = await createModuleUpdateExecutor({ root, catalog: moduleCatalog, host: hostUpdate, moduleHost: updateClients.module,
    adapters: createModuleUpdateAdapters({ gateway, builtinSourceCommit, notifications, members, memory: seatRuntime?.memoryModule, diagnostics: diagnosticsModule,
      prepareDiagnostics, workGraph: workGraphModule, prepareWorkGraph, lattice: latticeModule, prepareLattice, approvals: approvalsModule, prepareApprovals, authMediation: authMediationModule, prepareAuthMediation, usage: usageAssembly?.controller, prepareUsage, conversation: conversationAssembly?.controller, prepareConversation: (versionId, options) => prepareModuleRelease('conversation', versionId, options), execution: execution?.controller, prepareExecution }), notify: change => updateCenter?.notify(change) })
  updateCenter = createUpdateCenter({ gateway, builtinSourceCommit, notifications, members, host: hostUpdate, moduleCatalog, moduleExecutor,
    onCatalogCheckError: error => { void Promise.resolve(diagnostics.record({ code: 'UPDATE_CATALOG_CHECK_FAILED', module: 'update', diagnostic_log: /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'UNKNOWN' })).catch(() => {}) }, jobReader: createUpdateJobReader(updateClients), problemReader: async () => moduleRestartLimitProblems(await diagnostics.list('all', 1000)), memory: seatRuntime?.memoryModule, diagnostics: diagnosticsModule, workGraph: workGraphModule, lattice: latticeModule, approvals: approvalsModule, authMediation: authMediationModule, usage: usageAssembly?.controller, conversation: conversationAssembly?.controller, execution: execution?.controller, captureRuntime })
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
    homeFront, aiControl, subscriptions, settings, onboarding, harnessAuth, updateCenter, moduleChildExitReporter, membersAuthorization, members, usageAssembly, conversationAssembly, execution, modelHandoffGeneration, backgroundSummary, directMessages,
    notifications, secretRequests, ownerQuestions, machineStream, bots, rooms,
    roomMessenger, messenger, store, transport, memory,
    ownerProfile, userRules, characterSheets, assets,
    scheduler, diagnostics, diagnosticsModule, workGraph, workGraphModule, lattice, latticeModule, approvals, approvalsModule, authMediation, authMediationModule, authMediationRelay, accounts, terminals, terminalKeys, terminalKeyLoader, runningExclusions, seatApprovals, seatEntries, seatCredentials, userToolRelay, remoteSeatListener, bindSeatMcpSeen, credentialRefresh, idleSessions, selfTurns, seatTurns, administration, goals, olrwAuthCaller,
    // Saved direct input drains after listen (Z-c). Starting before the hold release is safe and needs no bound:
    // executionReady is false while held, and the release's hold.watch → requestDrain drains it.
    lifecycle: { ...execution?.lifecycle,
      afterListenReady: async () => { directMessages.start(); void credentialRefresh?.refreshNow(); void homeFront?.start(environment.BELLTEAM_CONSOLE_SOCKET ?? '/run/bellteam-server/console.sock').catch(() => {}); await execution?.lifecycle?.afterListenReady?.() } },
  }
  } catch (error) {
    const failures = []
    for (const close of [() => terminalKeyLoader?.stop(), () => credentialRefresh?.stop(), () => terminals?.close?.(), () => directMessages?.close(), () => backgroundSummary?.close(), () => moduleChildExitReporter.close(), () => updateCenter?.close(), () => seatRuntime?.memoryModule?.close(),
      () => conversationAssembly?.close(), () => execution?.controller.close(), () => execution && executionClient?.close(),
      () => members?.controller.close(), () => usageAssembly?.close(), () => diagnosticsModule?.close(), () => workGraphModule?.close(), () => approvals?.close(), () => approvalsModule?.close(), () => authMediationRelay?.close(), () => authMediationModule?.close(), () => latticeModule?.close()]) {
      try { await close() } catch (cleanupError) { failures.push(cleanupError) }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'APPLICATION_SERVICES_FAILED')
    throw error
  }
}
