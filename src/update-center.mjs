import { EventEmitter } from 'node:events'
import { updateComponents, validateUpdates, validateUpdateRequest } from './update-center-contract.mjs'
const unavailable = () => Object.assign(new Error('UPDATE_EXECUTOR_UNAVAILABLE'), { code: 'UPDATE_EXECUTOR_UNAVAILABLE', status: 503,
  publicMessage: 'この設置では、まだアプリから更新を実行できません。' })
const sourceValid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function createUpdateCenter({ gateway = () => null, notifications = null, members = null, host = null, moduleCatalog = null, moduleExecutor = null, memory = null, diagnostics = null } = {}) {
  const events = new EventEmitter()
  return {
    close: () => moduleExecutor?.close(),
    reserveExchange: moduleExecutor?.reserveExchange,
    notify: () => events.emit('change'),
    watch(listener) { events.on('change', listener); return () => events.off('change', listener) },
    snapshot() {
      const web = gateway(), push = notifications?.controller?.snapshot(), roster = members?.controller?.snapshot()
      const source = sourceValid(push?.builtinSourceCommit) ? push.builtinSourceCommit : null
      const builtin = source ? { version: source, sourceCommit: source, digest: null, origin: 'builtin' } : null
      const active = (id, versionId) => versionValid(versionId)
        ? { version: versionId, sourceCommit: null, digest: `sha256:${versionId}`, origin: 'release' }
        : id === 'container' && builtin ? { ...builtin, origin: 'container' } : builtin
      const components = updateComponents.map(([id, name, description]) => {
        const memoryState = id === 'memory' ? memory?.snapshot() : id === 'diagnostics' ? diagnostics?.snapshot() : null
        const current = ['memory', 'diagnostics'].includes(id) ? memoryState?.currentVersionId ? active(id, memoryState.currentVersionId) : sourceValid(memoryState?.builtinSourceCommit) ? { version: memoryState.builtinSourceCommit, sourceCommit: memoryState.builtinSourceCommit, digest: null, origin: 'builtin' } : null : id === 'members' ? versionValid(roster?.currentVersionId)
          ? { version: roster.currentVersionId, sourceCommit: null, digest: `sha256:${roster.currentVersionId}`, origin: 'release' }
          : sourceValid(roster?.builtinSourceCommit) ? { version: roster.builtinSourceCommit, sourceCommit: roster.builtinSourceCommit, digest: null, origin: 'builtin' } : null
          : active(id, id === 'web-gateway' ? web?.versionId : id === 'notifications' ? push?.currentVersionId : null)
        let available = null, reason = 'AVAILABILITY_UNKNOWN'
        if (id === 'memory' && memory || id === 'diagnostics' && diagnostics) { available = Boolean(memoryState?.available); reason = available ? null : id === 'memory' ? 'MEMORY_UNAVAILABLE' : 'DIAGNOSTICS_UNAVAILABLE' }
        if (id === 'web-gateway') { available = Boolean(web?.pid); reason = available ? null : 'WEB_GATEWAY_UNAVAILABLE' }
        if (id === 'members' && members) { available = Boolean(roster?.available); reason = available ? null : 'MEMBERS_UNAVAILABLE' }
        if (id === 'notifications') {
          available = Boolean(push?.available && (push.status?.apns?.configured || push.status?.webPush?.configured || push.status?.configured))
          const applyError = typeof push?.applyError === 'string' ? push.applyError : push?.applyError?.apns ?? push?.applyError?.webPush
          reason = available ? null : applyError ?? (push?.available ? 'PUSH_NOT_CONFIGURED' : 'NOTIFICATIONS_UNAVAILABLE')
        }
        return { id, name, description, current, published: null, publication: null, changes: [],
          comparison: { state: 'unavailable', reason: 'PUBLISHED_RELEASE_UNAVAILABLE' },
          capability: { supported: false, reason: (['container', 'web-gateway', 'notifications'].includes(id) || id === 'members' && members)
            ? 'UPDATE_EXECUTOR_UNAVAILABLE' : 'MODULE_NOT_INDEPENDENT' }, availability: { available, reason } }
      })
      const value = { schema: 'bellteam.updates.v1', server: { id: null }, observedAt: new Date().toISOString(),
        notice: { state: 'unavailable', code: 'UPDATE_PROVIDERS_UNAVAILABLE', message: '更新情報を取得できないため、確認できた現在版を表示しています。' },
        components, plans: [], operation: null, previousOperation: null }
      if (!validateUpdates(value).valid) throw new Error('UPDATE_SNAPSHOT_INVALID')
      const snapshot = host ? host.snapshot(value) : value
      return moduleCatalog ? Promise.resolve(snapshot).then(value => moduleCatalog.snapshot(value)).then(value => {
        if (!validateUpdates(value).valid) throw new Error('UPDATE_SNAPSHOT_INVALID')
        return moduleExecutor ? moduleExecutor.snapshot(value) : value
      }) : moduleExecutor ? Promise.resolve(snapshot).then(value => moduleExecutor.snapshot(value)) : snapshot
    },
    plan(input) { validateUpdateRequest('plan', input); if (moduleExecutor) return Promise.resolve(this.snapshot()).then(value => moduleExecutor.plan(input, value)); if (host && (!input.action || input.action === 'update')) return host.plan(input); throw unavailable() },
    start(input) { validateUpdateRequest('operation', input); if ((moduleExecutor?.hasPlan(input.planId) || moduleExecutor?.hasOperation(input.requestId))) return moduleExecutor.start(input); if (host) return host.start(input).finally(() => events.emit('change')); throw unavailable() },
    operation(requestId) { validateUpdateRequest('requestId', requestId); if (moduleExecutor?.hasOperation(requestId)) return moduleExecutor.operation(requestId); if (host) return host.operation(requestId); throw unavailable() },
  }
}
