import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { developerAccessAllowed } from './distribution-profile.mjs'
import { MembersAdmission } from './members-admission.mjs'
import { createUsageProcess } from './usage-process.mjs'
import { createUsageAuthority } from './usage/authority.mjs'
import { createUsageFacade } from './usage/facade.mjs'
import { createUsageProjection } from './usage/projection.mjs'
import { NativeSecretCredentials } from './usage/native-secret-credentials.mjs'
import { normalizeCredentialScope } from './usage/secret-credentials.mjs'

// Bootstrap owns this one controller before constructing the remaining service graph.
export function createUsageAssembly({ root, exchangeMutex, environment = {}, seatRuntime = false, getServices,
  onEffect, onState, onModuleChildExit, onModuleRestartLimit, createProcess = createUsageProcess, prepareRelease, spawnProcess }) {
  const accessMode = environment.BELLTEAM_SUBSCRIPTION_ACCESS_MODE ?? 'subscription'
  if (accessMode === 'developer' && !developerAccessAllowed) throw new Error('SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE')
  const admission = new MembersAdmission('usage-parent'), authority = createUsageAuthority()
  const capturedContexts = new WeakMap(), parents = new WeakMap()
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
      if (lease && capturedContexts.has(token)) parents.set(lease, capturedContexts.get(token))
      result = callback ? controller.callback(method, params, options) : controller.request(method, params, options)
      // A caller timeout does not revoke authority while the real request still runs.
      const completion = result.completion ?? result
      if (lease) admission.trackCompletion(lease, completion)
      const release = () => { authority.release(token); capturedContexts.delete(token); if (lease) parents.delete(lease) }
      completion.then(release, release)
      return result
    } catch (error) {
      authority.release(token)
      throw error
    } finally { if (lease) admission.finish(lease) }
  }
  const facade = createUsageFacade({ request, projection, toolsDirectory: join(root, 'state/secret-values') })
  const nativeCredentials = new NativeSecretCredentials({ root })
  const systemContext = (method, parentContext) => {
    const capturedAuthorization = authority.capture(method, { kind: 'system', botId: null })
    if (parentContext) capturedContexts.set(capturedAuthorization, parentContext)
    const context = scope.getStore()
    return context?.usageEffect ? { usageLease: context.usageLease, usageEffect: context.usageEffect, capturedAuthorization } : capturedAuthorization
  }
  const credentials = {
    requestTerminalKey: input => facade.secretRequests.requestTerminalKey(input, systemContext('secrets.requestTerminalKey')),
    bind: (id, target) => facade.secretRequests.bindCredential(id, target, systemContext('secrets.bind')),
    async current(target) {
      target = normalizeCredentialScope(target)
      let selection = await nativeCredentials.selection(target)
      if (!selection.present) {
        const retained = await facade.secretRequests.currentCredential(target, systemContext('secrets.current'))
        if (!retained) return null
        await nativeCredentials.selectCredential({ ...target, ...retained, reason: 'bound' })
        selection = { present: true, credential: retained }
      }
      if (!selection.credential) return null
      const selected = selection.credential
      try {
        const current = await credentials.credential(selected.handle, { ...target, memberId: null })
        return { ...current, requestId: selected.requestId }
      } catch (error) {
        if (error.code === 'SECRET_SOURCE_UNAVAILABLE') return { ...selected, available: false }
        if (error.code !== 'SECRET_CREDENTIAL_REVOKED') throw error
        await nativeCredentials.selectCredential({ ...target, ...selected, available: false, reason: 'unbound' })
        return null
      }
    },
    async unbind(handle, target) {
      target = normalizeCredentialScope({ terminalId: target?.terminalId, purpose: target?.purpose })
      await nativeCredentials.ready()
      if (handle === null) {
        await facade.secretRequests.revokeTerminalRequests(target, systemContext('secrets.revokeTerminalRequests'))
        const selection = await nativeCredentials.selection(target)
        if (selection.credential && nativeCredentials.owns(selection.credential.handle)) await nativeCredentials.unbind(selection.credential.handle, target)
        await nativeCredentials.clearSelection(target)
        return null
      }
      if (!nativeCredentials.owns(handle)) return facade.secretRequests.unbindCredential(handle, target, systemContext('secrets.unbind'))
      const result = await nativeCredentials.unbind(handle, target)
      await facade.secretRequests.revokeTerminalRequests(target, systemContext('secrets.revokeTerminalRequests'))
      return result
    },
    async credential(handle, target) {
      await nativeCredentials.ready()
      return nativeCredentials.owns(handle) ? nativeCredentials.credential(handle, target)
        : facade.secretRequests.credential(handle, target, systemContext('secrets.credential'))
    },
    async withResolved(handle, target, consume) {
      await nativeCredentials.ready()
      await nativeCredentials.assertSelected(handle, { terminalId: target?.terminalId, purpose: target?.purpose })
      return nativeCredentials.owns(handle) ? nativeCredentials.withResolved(handle, target, consume)
        : facade.secretRequests.withResolved(handle, target, consume, systemContext('secrets.resolve'))
    },
    async replace(handle, source, target) {
      await nativeCredentials.ready()
      return nativeCredentials.owns(handle) ? nativeCredentials.replace(handle, source, target)
        : facade.secretRequests.replaceCredential(handle, source, target, systemContext('secrets.replace'))
    },
    async refresh() {
      const results = await Promise.allSettled([nativeCredentials.refresh(), facade.secretRequests.refreshCredentials(systemContext('secrets.refresh'))])
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      return results[1].value
    },
    watch(listener) {
      const child = facade.secretRequests.watchCredentials(listener), native = nativeCredentials.watch(listener)
      return () => { child(); native() }
    },
    setNativeProvider: provider => nativeCredentials.setProvider(provider),
    registerNative: (binding, target) => nativeCredentials.register(binding, target),
    watchRecovery: listener => facade.secretRequests.watchRecovery(listener),
  }
  credentials.watchCredentials = credentials.watch
  controller = createProcess({ root, admission, exchangeMutex, onModuleChildExit, onModuleRestartLimit, authorizeActor: authority.authorizeActor, onState,
    probeCandidate: channel => {
      const token = authority.capture('onboarding.status', { kind: 'system', botId: null })
      let lease
      try {
        lease = admission.enter()
        const result = channel.request('onboarding.status', {}, { usageLease: lease, capturedAuthorization: token })
        const completion = result.completion ?? result
        admission.trackCompletion(lease, completion)
        completion.then(() => authority.release(token), () => authority.release(token))
        return result
      } catch (error) { authority.release(token); throw error }
      finally { if (lease) admission.finish(lease) }
    },
    ...(prepareRelease ? { prepareRelease } : {}), ...(spawnProcess ? { spawnProcess } : {}),
    bootstrap: {
      environment: Object.fromEntries(['TYPESAFE_API_KEY', 'BELLTEAM_CALL_BRIDGE_MCP_URL', 'BELLTEAM_CF_TEAM_DOMAIN', 'BELLTEAM_CF_AUD', 'BELLTEAM_BUGHUB_KEY']
        .filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]])),
      seatRuntime: Boolean(seatRuntime),
      subscription: { environment: environment.BELLTEAM_SUBSCRIPTION_ENVIRONMENT ?? 'Production', accessMode,
        ...(accessMode === 'developer' ? { developerAccessAllowed } : {}) },
    },
    onEffect: (method, params, context) => {
      const inherited = parents.get(context.usageLease)
      const current = inherited ? Object.freeze({ ...inherited, ...context }) : context
      return scope.run(current, () => onEffect(method, params, current))
    },
    onProjection: async (row, context) => {
      if (row.type === 'credential') await nativeCredentials.selectCredential(row.value)
      return context.phase === 'seed' ? projection.seed(row, context.generation)
        : context.phase === 'snapshot' ? projection.accept(row, context.generation) : facade.accept(row, context.generation)
    },
    onSnapshotStart: context => projection.begin(context.generation),
    onSnapshotEnd: context => projection.commit(context.generation),
    onSnapshotAbort: context => projection.discard(context.generation),
  })
  return {
    controller, facade, credentials,
    capture(method, actor, parentContext) {
      const token = authority.capture(method, actor)
      if (parentContext) capturedContexts.set(token, parentContext)
      return token
    },
    systemContext,
    initializeSettings: () => controller.start(),
    initializeSubscriptions: () => controller.initialize('subscriptions'),
    async initializeServices() { await controller.initialize('services'); await controller.activate() },
    close: () => { nativeCredentials.close(); return controller.close() },
  }
}
