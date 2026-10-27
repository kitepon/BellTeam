import { join } from 'node:path'
import { createApplicationServices } from './application-services.mjs'
import { createApplicationFeatures } from './application-features.mjs'
import { createBellTeamServer } from './http-server.mjs'
import { createSeatMcp, internalApi } from './seat-mcp.mjs'
import { createBugHubSecurity } from './bughub-security.mjs'
import { LiveModelCatalog } from './model-catalog.mjs'
import { runtimeHome } from './runtime-home.mjs'

// Importing this factory does not bootstrap the installation or bind any ports.
export async function createApplicationRuntime({ root, appRoot, bootstrap, environment = process.env, home = runtimeHome(), client }) {
  const services = await createApplicationServices({ root, ...bootstrap, environment, client })
  const {
    aiControl, subscriptions, settings, onboarding, harnessAuth, notifications,
    secretRequests, ownerQuestions, bots, rooms, roomMessenger, messenger,
    store, transport, memory, ownerProfile, userRules, characterSheets,
    refreshGlobalInstructions, assets, scheduler, diagnostics,
    idleSessions, selfTurns, seatTurns, administration, goals,
  } = services
  const { aiterm } = bootstrap
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
    models: bootstrap.models ?? new LiveModelCatalog({ cwd: root }),
    scheduler,
    diagnostics,
    administration,
    goals,
  }
  const internalPort = Number(environment.BELLTEAM_INTERNAL_PORT ?? 4181)
  const callBridgeHeaders = bootstrap.callBridgeHeaders ?? join(root, 'shared/tools/call-bridge/headers')
  const features = createApplicationFeatures({ services, aiterm, home, callBridgeHeaders, environment, notify: data => server.notify(data),
    ...(bootstrap.seatRuntime ? { configureHarnessConfig: (bots, _home, { callBridge }) =>
      bootstrap.seatRuntime.writeHarnessConfig(bots, aiterm, callBridge) } : {}) })
  const server = createBellTeamServer({ ...serverOptions, authMode: features.authMode, authorize: features.authorize })
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
  const start = async () => {
    try {
      await features.initialize()
      await server.startMessageWatch()
      if (aiControl.paused) void aiControl.enforce()
      server.listen(Number(environment.BELLTEAM_WEB_PORT ?? 4180), '0.0.0.0')
      internalServer.listen(internalPort, '127.0.0.1')
      scheduler.start()
      selfTurns.start()
      seatTurns.start()
      idleSessions.start()
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
        () => scheduler.stop(), () => idleSessions.stop(), () => selfTurns.stop(), () => seatTurns.stop(),
        () => closeServer(server), () => closeServer(internalServer), () => features.close(),
        () => transport.close(), () => notifications.close(),
      ]) {
        try { await stop() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'APPLICATION_CLOSE_FAILED')
    })()
    return closing
  }
  return { services, features, server, internalServer, start, close }
}
