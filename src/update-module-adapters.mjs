import { createWebGatewayUpdateAdapter } from './web-gateway-update-adapter.mjs'
import { prepareGatewayRelease, prepareNotificationsRelease, prepareMembersRelease } from './web-gateway-release.mjs'
import { prepareMemoryRelease } from './memory-release.mjs'
import { assertNotificationsCatalogRelease } from './notifications-release.mjs'
import { assertMembersCatalogRelease } from './members-release.mjs'

const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }) }
const source = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const version = (id, builtin) => id ? { version: id, digest: `sha256:${id}`, sourceCommit: null, origin: 'release' }
  : source(builtin) ? { version: builtin, digest: null, sourceCommit: builtin, origin: 'builtin' } : null

export function createModuleUpdateAdapters({ gateway, builtinSourceCommit = null, notifications, members, memory = null, diagnostics = null, prepareDiagnostics = null, usage = null, prepareUsage = null,
  prepare = { 'web-gateway': prepareGatewayRelease, notifications: prepareNotificationsRelease, members: prepareMembersRelease, memory: prepareMemoryRelease, ...(prepareDiagnostics ? { diagnostics: prepareDiagnostics } : {}), ...(prepareUsage ? { usage: prepareUsage } : {}) } }) {
  const result = { 'web-gateway': createWebGatewayUpdateAdapter({ gateway, builtinSourceCommit, prepare: prepare['web-gateway'] }) }
  for (const [id, controller] of [['notifications', notifications?.controller], ['members', members?.controller], ['memory', memory], ['diagnostics', diagnostics], ['usage', usage]]) {
    if (!controller) continue
    const snapshot = () => controller.snapshot()
    const current = () => { const state = snapshot(); return version(state.currentVersionId, state.builtinSourceCommit) }
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
        }
      },
      apply: step => controller.replace(step.target.origin === 'builtin' ? 'builtin' : step.target.version, { expectedRelease: step.release ?? undefined }),
    }
  }
  return result
}
