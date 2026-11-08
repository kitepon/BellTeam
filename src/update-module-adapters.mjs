import { createWebGatewayUpdateAdapter } from './web-gateway-update-adapter.mjs'
import { prepareGatewayRelease, prepareNotificationsRelease, prepareMembersRelease, prepareExecutionRelease } from './web-gateway-release.mjs'
import { prepareMemoryRelease } from './memory-release.mjs'
import { assertNotificationsCatalogRelease } from './notifications-release.mjs'
import { assertMembersCatalogRelease } from './members-release.mjs'

const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }) }
const source = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const version = (id, builtin) => id ? { version: id, digest: `sha256:${id}`, sourceCommit: null, origin: 'release' }
  : source(builtin) ? { version: builtin, digest: null, sourceCommit: builtin, origin: 'builtin' } : null

export function createModuleUpdateAdapters({ gateway, builtinSourceCommit = null, notifications, members, memory = null, diagnostics = null, prepareDiagnostics = null, workGraph = null, prepareWorkGraph = null, usage = null, prepareUsage = null, execution = null, conversation = null, prepareConversation = null, prepareExecution = prepareExecutionRelease,
  prepare = { 'web-gateway': prepareGatewayRelease, notifications: prepareNotificationsRelease, members: prepareMembersRelease, memory: prepareMemoryRelease, execution: prepareExecution, ...(prepareConversation ? { conversation: prepareConversation } : {}), ...(prepareDiagnostics ? { diagnostics: prepareDiagnostics } : {}), ...(prepareWorkGraph ? { 'work-graph': prepareWorkGraph } : {}), ...(prepareUsage ? { usage: prepareUsage } : {}) } }) {
  const result = { 'web-gateway': createWebGatewayUpdateAdapter({ gateway, builtinSourceCommit, prepare: prepare['web-gateway'] }) }
  for (const [id, controller] of [['notifications', notifications?.controller], ['members', members?.controller], ['memory', memory], ['diagnostics', diagnostics], ['work-graph', workGraph], ['usage', usage], ['execution', execution], ['conversation', conversation]]) {
    if (!controller) continue
    const snapshot = () => controller.snapshot()
    const current = () => {
      const state = snapshot()
      const builtin = state.builtinSourceCommit
        ?? (state.currentTarget === 'builtin' && state.currentVersionId === null ? builtinSourceCommit : null)
      return version(state.currentVersionId, builtin)
    }
    result[id] = {
      current,
      capture: () => ({ generation: snapshot().generation ?? null, pid: null }),
      available: () => snapshot().available === true,
      canRollback: () => true,
      async prepare(step) {
        if (step.target.origin === 'builtin') {
          if (snapshot().builtinSourceCommit !== step.target.sourceCommit) fail('UPDATE_ROLLBACK_UNAVAILABLE')
          return
        }
        if (typeof prepare[id] !== 'function') fail('UPDATE_EXECUTOR_UNAVAILABLE')
        const descriptor = await prepare[id](step.target.version, { expectedRelease: step.release })
        if (descriptor.versionId !== step.target.version || step.target.sourceCommit !== null && descriptor.sourceCommit !== step.target.sourceCommit) fail('UPDATE_TARGET_CHANGED')
        if (step.release) {
          if (id === 'notifications') assertNotificationsCatalogRelease(step.release, descriptor)
          else if (id === 'members') assertMembersCatalogRelease(step.release, descriptor)
          else if (id === 'execution' && (descriptor.protocolVersion !== 1 || descriptor.stateCompatibility !== step.release.compatibility.stateCompatibility || descriptor.platform?.os !== step.release.platform.os || descriptor.platform?.arch !== step.release.platform.arch)) fail('UPDATE_INCOMPATIBLE')
        }
      },
      apply: step => controller.replace(step.target.origin === 'builtin' ? 'builtin' : step.target.version, { expectedRelease: step.release ?? undefined }),
    }
  }
  return result
}
