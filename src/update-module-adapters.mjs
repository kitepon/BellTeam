import { prepareGatewayRelease, prepareNotificationsRelease, prepareMembersRelease } from './web-gateway-release.mjs'
import { prepareMemoryRelease } from './memory-release.mjs'
import { assertNotificationsCatalogRelease } from './notifications-release.mjs'
import { assertMembersCatalogRelease } from './members-release.mjs'

const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }) }
const source = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const version = (id, builtin) => id ? { version: id, digest: `sha256:${id}`, sourceCommit: null, origin: 'release' }
  : source(builtin) ? { version: builtin, digest: null, sourceCommit: builtin, origin: 'builtin' } : null

export function createModuleUpdateAdapters({ gateway, notifications, members, memory = null,
  prepare = { 'web-gateway': prepareGatewayRelease, notifications: prepareNotificationsRelease, members: prepareMembersRelease, memory: prepareMemoryRelease } }) {
  const result = {}
  for (const [id, controller] of [['web-gateway', null], ['notifications', notifications?.controller], ['members', members?.controller], ['memory', memory]]) {
    if (id !== 'web-gateway' && !controller) continue
    const snapshot = () => id === 'web-gateway' ? { currentVersionId: gateway()?.versionId, available: Boolean(gateway()?.pid),
      builtinSourceCommit: notifications?.controller.snapshot().builtinSourceCommit } : controller.snapshot()
    const current = () => { const state = snapshot(); return version(state.currentVersionId, state.builtinSourceCommit) }
    result[id] = {
      current,
      capture: () => ({ generation: snapshot().generation ?? null, pid: id === 'web-gateway' ? gateway()?.pid ?? null : null }),
      available: () => snapshot().available === true,
      canRollback: target => target.origin !== 'builtin' || id !== 'web-gateway',
      async prepare(step) {
        if (step.target.origin === 'builtin') {
          if (id === 'web-gateway' || snapshot().builtinSourceCommit !== step.target.sourceCommit) fail('UPDATE_ROLLBACK_UNAVAILABLE')
          return
        }
        const descriptor = await prepare[id](step.target.version, { expectedRelease: step.release })
        if (descriptor.versionId !== step.target.version || step.target.sourceCommit !== null && descriptor.sourceCommit !== step.target.sourceCommit) fail('UPDATE_TARGET_CHANGED')
        if (step.release) {
          if (id === 'notifications') assertNotificationsCatalogRelease(step.release, descriptor)
          else if (id === 'members') assertMembersCatalogRelease(step.release, descriptor)
          else if (id === 'web-gateway' && (descriptor.protocolVersion !== 1 || descriptor.platform.os !== step.release.platform.os || descriptor.platform.arch !== step.release.platform.arch)) fail('UPDATE_INCOMPATIBLE')
        }
      },
      apply: step => id === 'web-gateway' ? gateway().replace(step.target.version)
        : controller.replace(step.target.origin === 'builtin' ? 'builtin' : step.target.version, { expectedRelease: step.release ?? undefined }),
    }
  }
  return result
}
