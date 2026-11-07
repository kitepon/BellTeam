import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHttpGatewayProcess } from './http-gateway-process.mjs'
import { prepareGatewayRelease } from './web-gateway-release.mjs'
import { createWebGatewayControl } from './web-gateway-control.mjs'
import { createApplicationServices } from './application-services.mjs'
import { createApplicationFeatures } from './application-features.mjs'
import { createBellTeamServer } from './http-server.mjs'
import { createSeatMcp, internalApi } from './seat-mcp.mjs'
import { createBugHubSecurity } from './bughub-security.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { runtimeHome } from './runtime-home.mjs'
import { readServerSourceCommit } from './server-source.mjs'
import { listenBodyQuiesce } from './body-quiesce.mjs'

// Importing this factory does not bootstrap the installation or bind any ports.
export async function createApplicationRuntime({ root, appRoot, bootstrap, environment = process.env, home = runtimeHome(), client, quiesceSocket = null }) {
  let socketDirectory = null, gateway = null, quiesceEndpoint = null, server
  const builtinSourceCommit = await readServerSourceCommit()
  const models = bootstrap.models ?? new LiveModelCatalog({ cwd: root })
  const services = await createApplicationServices({ root, ...bootstrap, models, environment, client, gateway: () => gateway, builtinSourceCommit, notify: change => server?.notify(change) })
  const {
    aiControl, subscriptions, settings, onboarding, harnessAuth, notifications,
    secretRequests, ownerQuestions, bots, rooms, roomMessenger, messenger,
    store, transport, memory, ownerProfile, userRules, characterSheets,
    refreshGlobalInstructions, assets, scheduler, diagnostics,
    idleSessions, selfTurns, seatTurns, administration, goals, olrwAuthCaller,
  } = services
  const { aiterm } = bootstrap
  const webGatewayControl = createWebGatewayControl({ gateway: () => gateway, notify: () => services.updateCenter.notify() })
  const serverOptions = {
    webGatewayControl,
    notificationsReleaseControl: notifications.controller,
    updateCenter: services.updateCenter,
    membersAuthorization: services.membersAuthorization,
    usageAssembly: services.usageAssembly,
    conversationAssembly: services.conversationAssembly,
    ownerSecretGuide: input => olrwAuthCaller?.ownerSecretGuide(input) ?? null,
    aiControl,
    subscriptions,
    settings,
    onboarding,
    harnessAuth,
    notifications,
    secretRequests,
    submittedSecretConsumer: services.submittedSecretCaller?.consumer,
    captureSubmittedSecretContext: services.submittedSecretCaller ? (request, id) => services.submittedSecretCaller.capture(request, id) : undefined,
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
    models,
    scheduler,
    diagnostics,
    administration,
    goals,
  }
  const internalPort = Number(environment.BELLTEAM_INTERNAL_PORT ?? 4181)
  const callBridgeHeaders = bootstrap.callBridgeHeaders ?? join(root, 'shared/tools/call-bridge/headers')
  const features = createApplicationFeatures({ services: services.conversationAssembly ? { ...services, messenger: { ...messenger, receiveCallBridge: (...args) => services.conversationAssembly.run({ kind: 'bridge' }, () => messenger.receiveCallBridge(...args)) } } : services, aiterm, home, callBridgeHeaders, environment, notify: data => server.notify(data),
    ...(services.usageAssembly ? { usageContext: method => services.usageAssembly.systemContext(method) } : {}),
    ...(bootstrap.seatRuntime ? { configureHarnessConfig: (bots, _home, { callBridge }) =>
      services.members ? transport.membersAdmission.withLease(membersLease =>
        bootstrap.seatRuntime.configureMembersHarnesses(() => services.members.readCurrentBotIds({ membersLease }), aiterm,
          () => settings.configuration('callBridge'))) : bootstrap.seatRuntime.writeHarnessConfig(bots, aiterm, callBridge) } : {}) })
  server = createBellTeamServer({ ...serverOptions, authMode: features.authMode, authorize: features.authorize })
  const seatMcp = createSeatMcp({
    bots,
    runTool: (from, operation) => services.conversationAssembly ? services.conversationAssembly.run({ kind: 'bot', botId: from }, operation) : operation(),
    toolsForSource: executionSource => {
      const generation = services.modelHandoffGeneration()
      return { ...internalApi(internalPort, fetch, { executionSource }),
        ...(generation ? { configureFromMcp: (botId, changes, context) => {
          if (services.modelHandoffGeneration() !== generation)
            throw Object.assign(new Error('EXECUTION_NOT_ACCEPTING'), { code: 'EXECUTION_NOT_ACCEPTING', status: 503, effect: 'not_started' })
          return administration.configureFromMcp(botId, changes, context)
        } } : {}),
        currentWork: bot => transport.currentWork(bot),
        currentWorkBinding: bot => transport.currentWorkBinding(bot, executionSource),
        updateWorkSummary: (bot, input) => transport.updateWorkSummary(bot, input, executionSource),
      }
    },
    admitWork: () => aiControl.admit(),
    assertWorkAllowed: () => aiControl.assertEnabled(),
    tools: { registry: bots, botView: bot => administration.view(bot), messenger, store, rooms, roomMessenger, memory, ownerProfile, userRules, bugHubSecurity: createBugHubSecurity({ root }), internalUrl: `http://127.0.0.1:${internalPort}`, ...internalApi(internalPort) },
    callBridge: () => {
      const config = settings.configuration('callBridge')
      return config.enabled ? { url: config.url, headersFile: callBridgeHeaders } : null
    },
  })
  const internalServer = createBellTeamServer({ ...serverOptions, internal: true, seatMcp, authorize: async () => true })
  const listen = (server, ...args) => new Promise((resolve, reject) => {
    const failed = error => reject(error)
    server.once('error', failed)
    server.listen(...args, () => { server.removeListener('error', failed); resolve() })
  })
  const start = async () => {
    try {
      await features.initialize()
      await server.startMessageWatch()
      if (aiControl.paused) void aiControl.enforce()
      socketDirectory = await mkdtemp(join(tmpdir(), 'bellteam-http-'))
      const socketPath = join(socketDirectory, 'public.sock')
      await listen(server, socketPath)
      await listen(internalServer, internalPort, '127.0.0.1')
      // Without this endpoint the installer records quiesce=unconfirmed and still stops; serving matters more.
      if (quiesceSocket) quiesceEndpoint = await listenBodyQuiesce({ path: quiesceSocket }).catch(error => {
        process.stderr.write(`BODY_QUIESCE_UNAVAILABLE ${error.code ?? ''}\n`)
        return null
      })
      gateway = createHttpGatewayProcess({ onModuleChildExit: services.moduleChildExitReporter.observe, onModuleRestartLimit: services.moduleChildExitReporter.observeRestartLimit, socketPath, port: Number(environment.BELLTEAM_WEB_PORT ?? 4180), appRoot,
        prepareRelease: bootstrap.prepareGatewayRelease ?? prepareGatewayRelease,
        adoptionPath: join(root, 'state/web-gateway-release.json') })
      await gateway.start()
      services.updateCenter.startNotifications()
      scheduler.start()
      selfTurns.start()
      seatTurns?.start()
      idleSessions?.start()
    } catch (error) {
      try { await close() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'APPLICATION_START_FAILED') }
      throw error
    }
  }
  const closeServer = server => new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
    else resolve()
  }))
  let closing = null
  const close = () => {
    closing ??= (async () => {
      const errors = []
      for (const stop of [
        () => quiesceEndpoint?.close(),
        () => services.directMessages?.close(),
        () => services.backgroundSummary?.close(),
        () => services.moduleChildExitReporter.close(),
        () => olrwAuthCaller?.close(),
        () => services.submittedSecretCaller?.close(),
        () => services.updateCenter.close(),
        () => webGatewayControl.close(),
        () => gateway?.close(),
        () => scheduler.stop(), () => idleSessions?.stop(), () => selfTurns.stop(), () => seatTurns?.stop(),
        () => closeServer(server), () => closeServer(internalServer), () => features.close(),
        () => bootstrap.seatRuntime?.memoryModule?.close(),
        () => services.conversationAssembly?.close(), () => transport.close(), () => services.execution && transport.client.close(), () => services.members?.controller.close(), () => notifications.close(), () => services.usageAssembly?.close(), () => services.diagnosticsModule?.close(),
        () => socketDirectory && rm(socketDirectory, { recursive: true, force: true }),
      ]) {
        try { await stop() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'APPLICATION_CLOSE_FAILED')
    })()
    return closing
  }
  return { services, features, server, internalServer, get gateway() { return gateway }, start, close }
}
