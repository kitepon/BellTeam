import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { MembersAdmission } from './members-admission.mjs'
import { createUsageProcess } from './usage-process.mjs'
import { createUsageAuthority } from './usage/authority.mjs'
import { createUsageFacade } from './usage/facade.mjs'
import { createUsageProjection } from './usage/projection.mjs'

// Bootstrap owns this one controller before constructing the remaining service graph.
export function createUsageAssembly({ root, environment = {}, seatRuntime = false, getServices,
  onEffect, onState, createProcess = createUsageProcess, prepareRelease, spawnProcess }) {
  const admission = new MembersAdmission('usage-parent'), authority = createUsageAuthority()
  const scope = new AsyncLocalStorage()
  const projection = createUsageProjection({ bots: { get: id => getServices().bots?.get(id) } })
  let controller
  const request = (method, params, context) => {
    const callback = Boolean(context?.usageEffect)
    const token = callback ? context.capturedAuthorization : context
    let lease, result
    try {
      authority.authorizeActor(method, token)
      const options = callback ? context : { usageLease: lease = admission.enter(), capturedAuthorization: token }
      result = callback ? controller.callback(method, params, options) : controller.request(method, params, options)
      // A caller timeout does not revoke authority while the real request still runs.
      const completion = result.completion ?? result
      if (lease) admission.trackCompletion(lease, completion)
      completion.then(() => authority.release(token), () => authority.release(token))
      return result
    } catch (error) {
      authority.release(token)
      throw error
    } finally { if (lease) admission.finish(lease) }
  }
  const facade = createUsageFacade({ request, projection, toolsDirectory: join(root, 'state/secret-values') })
  controller = createProcess({ root, admission, authorizeActor: authority.authorizeActor, onState,
    ...(prepareRelease ? { prepareRelease } : {}), ...(spawnProcess ? { spawnProcess } : {}),
    bootstrap: {
      environment: Object.fromEntries(['TYPESAFE_API_KEY', 'BELLTEAM_CALL_BRIDGE_MCP_URL', 'BELLTEAM_CF_TEAM_DOMAIN', 'BELLTEAM_CF_AUD', 'BELLTEAM_BUGHUB_KEY']
        .filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]])),
      seatRuntime: Boolean(seatRuntime),
      subscription: { environment: environment.BELLTEAM_SUBSCRIPTION_ENVIRONMENT ?? 'Production', accessMode: environment.BELLTEAM_SUBSCRIPTION_ACCESS_MODE ?? 'subscription' },
    },
    onEffect: (method, params, context) => scope.run(context, () => onEffect(method, params, context)),
    onProjection: (row, context) => context.phase === 'seed' ? projection.seed(row, context.generation)
      : context.phase === 'snapshot' ? projection.accept(row, context.generation) : facade.accept(row, context.generation),
    onSnapshotStart: context => projection.begin(context.generation),
    onSnapshotEnd: context => projection.commit(context.generation),
    onSnapshotAbort: context => projection.discard(context.generation),
  })
  return {
    controller, facade,
    capture: (method, actor) => authority.capture(method, actor),
    systemContext(method) {
      const capturedAuthorization = authority.capture(method, { kind: 'system', botId: null })
      const context = scope.getStore()
      return context?.usageEffect ? { usageLease: context.usageLease, usageEffect: context.usageEffect, capturedAuthorization } : capturedAuthorization
    },
    initializeSettings: () => controller.start(),
    initializeSubscriptions: () => controller.initialize('subscriptions'),
    async initializeServices() { await controller.initialize('services'); await controller.activate() },
    close: () => controller.close(),
  }
}
