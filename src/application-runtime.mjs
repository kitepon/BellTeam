import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHttpGatewayProcess } from './http-gateway-process.mjs'
import { prepareGatewayRelease } from './web-gateway-release.mjs'
import { createWebGatewayControl } from './web-gateway-control.mjs'
import { createApplicationServices } from './application-services.mjs'
import { createApplicationFeatures } from './application-features.mjs'
import { createBellTeamServer } from './http-server.mjs'
import { createRemoteSeatIngress, createRemoteSeatServer, createSeatMcp, internalApi } from './seat-mcp.mjs'
import { createBugHubSecurity } from './bughub-security.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { runtimeHome } from './runtime-home.mjs'
import { readServerSourceCommit } from './server-source.mjs'
import { remoteSeatPort } from './remote-seat-port.mjs'
import { listenBodyQuiesce } from './body-quiesce.mjs'

// Fixed bounds for the optional lifecycle contacts (Z-c slice 2); the shutdown one leaves most of the 30 s stop grace to close().
const AFTER_LISTEN_READY_MS = 60_000, SHUTDOWN_SIGNAL_MS = 10_000

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
    workGraph: services.workGraph,
    lattice: services.lattice,
    accounts: services.accounts,
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
    terminals: () => services.terminals,
    runningExclusions: () => services.runningExclusions,
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
  // Remote seats reach this only through Aiterm's SSH reverse forward (remote-seat-ingress.md RS05); never via 4180/18891.
  const remoteSeatServer = createRemoteSeatServer(createRemoteSeatIngress({ credentials: services.seatCredentials, bots, seatMcp: () => seatMcp }))
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
    // SK01: engines without the registry have no fork seats.
    forkSeat: name => typeof transport.forkSeat === 'function' ? transport.forkSeat(name) : null,
    assertWorkAllowed: () => aiControl.assertEnabled(),
    tools: { registry: bots, botView: bot => administration.view(bot), messenger, store, rooms, roomMessenger, memory, ownerProfile, userRules, bugHubSecurity: createBugHubSecurity({ root }), terminals: () => services.terminals, terminalKeys: () => services.terminalKeys, runningExclusions: () => services.runningExclusions, internalUrl: `http://127.0.0.1:${internalPort}`, lattice: services.lattice, ...internalApi(internalPort) },
    callBridge: () => {
      const config = settings.configuration('callBridge')
      return config.enabled ? { url: config.url, headersFile: callBridgeHeaders } : null
    },
  })
  services.bindSeatMcpSeen?.(seatMcp.seen)
  const internalServer = createBellTeamServer({ ...serverOptions, internal: true, seatMcp, authorize: async () => true })
  const listen = (server, ...args) => new Promise((resolve, reject) => {
    const failed = error => reject(error)
    server.once('error', failed)
    server.listen(...args, () => { server.removeListener('error', failed); resolve() })
  })
  let stopRequested = false, started = false, starting = null, interrupt
  // RS05: one bind at a time; a failure is recorded and leaves it unbound, so the next issue (or start) binds again.
  let remoteSeatBinding = null, remoteSeatBound = false
  const ensureRemoteSeatListener = () => remoteSeatBound ? Promise.resolve() : remoteSeatBinding ??= (stopRequested
    ? Promise.reject(Object.assign(new Error('STARTUP_INTERRUPTED'), { code: 'STARTUP_INTERRUPTED' }))
    : listen(remoteSeatServer, remoteSeatPort(environment), '127.0.0.1')).then(async () => {
      // A bind that lands after close() began is undone, never left serving a disposed body.
      if (stopRequested) { await closeServer(remoteSeatServer).catch(() => {}); throw Object.assign(new Error('STARTUP_INTERRUPTED'), { code: 'STARTUP_INTERRUPTED' }) }
      remoteSeatBound = true
    }, error => {
      process.stderr.write(`REMOTE_SEAT_LISTEN_FAILED ${error.code ?? ''}\n`)
      try { diagnostics?.record({ code: 'REMOTE_SEAT_LISTEN_FAILED', module: 'integration', diagnostic_log: String(error?.code ?? 'UNKNOWN') }) } catch {}
      throw Object.assign(new Error('REMOTE_SEAT_INGRESS_UNAVAILABLE'), { code: 'REMOTE_SEAT_INGRESS_UNAVAILABLE', status: 503, cause: error })
    }).finally(() => { remoteSeatBinding = null })
  services.remoteSeatListener?.bind(ensureRemoteSeatListener)
  const interrupted = new Promise(resolve => { interrupt = resolve })
  const proceed = () => {
    if (stopRequested) throw Object.assign(new Error('STARTUP_INTERRUPTED'), { code: 'STARTUP_INTERRUPTED' })
  }
  // An optional contact supplied by the execution assembly; its failure or timeout is logged and never stops the body.
  const contact = async (name, bound, input) => {
    const handler = services.lifecycle?.[name]
    if (!handler) return
    let timer
    try {
      const outcome = await Promise.race([Promise.resolve().then(() => handler(input)).then(() => 'done'),
        new Promise(resolve => { timer = setTimeout(resolve, bound, 'timeout') }),
        ...(name === 'afterListenReady' ? [interrupted.then(() => 'interrupted')] : [])])
      if (outcome !== 'done') process.stderr.write(`LIFECYCLE_CONTACT_${outcome.toUpperCase()} ${name}\n`)
    } catch (error) {
      process.stderr.write(`LIFECYCLE_CONTACT_FAILED ${name} ${error?.code ?? ''}\n`)
    } finally { clearTimeout(timer) }
  }
  const run = async () => {
    try {
      await features.initialize(); proceed()
      await server.startMessageWatch(); proceed()
      if (aiControl.paused) void aiControl.enforce()
      socketDirectory = await mkdtemp(join(tmpdir(), 'bellteam-http-')); proceed()
      const socketPath = join(socketDirectory, 'public.sock')
      await listen(server, socketPath); proceed()
      await listen(internalServer, internalPort, '127.0.0.1'); proceed()
      // A failed remote-seat listener does not stop the body; each remote launch retries it and fails visibly while it is down.
      await ensureRemoteSeatListener().catch(() => {}); proceed()
      // Without this endpoint the installer records quiesce=unconfirmed and still stops; serving matters more.
      if (quiesceSocket) quiesceEndpoint = await listenBodyQuiesce({ path: quiesceSocket, ...(services.lifecycle?.quiesce ? { quiesce: services.lifecycle.quiesce } : {}) }).catch(error => {
        process.stderr.write(`BODY_QUIESCE_UNAVAILABLE ${error.code ?? ''}\n`)
        return null
      })
      proceed()
      gateway = createHttpGatewayProcess({ onModuleChildExit: services.moduleChildExitReporter.observe, onModuleRestartLimit: services.moduleChildExitReporter.observeRestartLimit, socketPath, port: Number(environment.BELLTEAM_WEB_PORT ?? 4180), appRoot,
        prepareRelease: bootstrap.prepareGatewayRelease ?? prepareGatewayRelease,
        adoptionPath: join(root, 'state/web-gateway-release.json') })
      await gateway.start(); proceed()
      // Recovery is admitted before ordinary dispatch; one slow seat must not keep dispatch or the listeners down.
      await contact('afterListenReady', AFTER_LISTEN_READY_MS); proceed()
      services.updateCenter.startNotifications()
      scheduler.start()
      selfTurns.start()
      seatTurns?.start()
      idleSessions?.start()
      services.runningExclusions?.start()
      started = true
    } catch (error) {
      if (error?.code === 'STARTUP_INTERRUPTED') throw error // stop() closes after its shutdown contact
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
      // Both close paths: no further startup step or remote seat bind/retry once disposal begins.
      stopRequested = true; services.remoteSeatListener?.close()
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
        () => scheduler.stop(), () => services.runningExclusions?.stop(), () => idleSessions?.stop(), () => selfTurns.stop(), () => seatTurns?.stop(),
        () => closeServer(server), () => closeServer(internalServer), () => closeServer(remoteSeatServer), () => features.close(),
        // Before the providers they call (usage, diagnostics, native client) close.
        () => services.credentialRefresh?.stop(), () => services.terminals?.close?.(),
        () => bootstrap.seatRuntime?.memoryModule?.close(),
        () => services.conversationAssembly?.close(), () => transport.close(), () => services.execution && transport.client.close(), () => services.members?.controller.close(), () => notifications.close(), () => services.usageAssembly?.close(), () => services.diagnosticsModule?.close(), () => services.workGraphModule?.close(), () => services.latticeModule?.close(),
        () => socketDirectory && rm(socketDirectory, { recursive: true, force: true }),
      ]) {
        try { await stop() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'APPLICATION_CLOSE_FAILED')
    })()
    return closing
  }
  const start = () => (starting = run())
  // Signal path: no further startup step or dispatch, the execution contact persists its markers, then the same close.
  let stopping = null
  const stop = () => {
    stopping ??= (async () => {
      stopRequested = true; services.remoteSeatListener?.close()
      interrupt()
      await contact('onShutdownSignal', SHUTDOWN_SIGNAL_MS, { phase: started ? 'running' : 'starting' })
      await starting?.catch(() => {})
      await close()
    })()
    return stopping
  }
  return { services, features, server, internalServer, remoteSeatServer, get gateway() { return gateway }, start, stop, close }
}
