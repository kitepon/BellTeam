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
    idleSessions, selfTurns, seatTurns,
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
    models: new LiveModelCatalog({ cwd: root }),
    scheduler,
    diagnostics,
  }
  const internalPort = Number(environment.BELLTEAM_INTERNAL_PORT ?? 4181)
  const callBridgeHeaders = join(root, 'shared/tools/call-bridge/headers')
  const features = createApplicationFeatures({ services, aiterm, home, callBridgeHeaders, environment, notify: data => server.notify(data) })
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
    await features.initialize()
    await server.startMessageWatch()
    if (aiControl.paused) void aiControl.enforce()
    server.listen(Number(environment.BELLTEAM_WEB_PORT ?? 4180), '0.0.0.0')
    internalServer.listen(internalPort, '127.0.0.1')
    scheduler.start()
    selfTurns.start()
    seatTurns.start()
    idleSessions.start()
  }
  const close = async () => {
    scheduler.stop()
    await idleSessions.stop()
    await selfTurns.stop()
    await seatTurns.stop()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await new Promise((resolve, reject) => internalServer.close(error => error ? reject(error) : resolve()))
    await features.close()
    await transport.close()
    await notifications.close()
  }
  return { services, features, server, internalServer, start, close }
}
