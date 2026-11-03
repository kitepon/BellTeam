import { EventEmitter } from 'node:events'
import { updateComponents, validateUpdates, validateUpdateRequest } from './update-center-contract.mjs'
const unavailable = () => Object.assign(new Error('UPDATE_EXECUTOR_UNAVAILABLE'), { code: 'UPDATE_EXECUTOR_UNAVAILABLE', status: 503,
  publicMessage: 'この設置では、まだアプリから更新を実行できません。' })
const sourceValid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function createUpdateCenter({ gateway = () => null, notifications = null, members = null, host = null, moduleCatalog = null } = {}) {
  const events = new EventEmitter()
  return {
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
        const current = id === 'members' ? versionValid(roster?.currentVersionId)
          ? { version: roster.currentVersionId, sourceCommit: null, digest: `sha256:${roster.currentVersionId}`, origin: 'release' }
          : sourceValid(roster?.builtinSourceCommit) ? { version: roster.builtinSourceCommit, sourceCommit: roster.builtinSourceCommit, digest: null, origin: 'builtin' } : null
          : active(id, id === 'web-gateway' ? web?.versionId : id === 'notifications' ? push?.currentVersionId : null)
        let available = null, reason = 'AVAILABILITY_UNKNOWN'
        if (id === 'web-gateway') { available = Boolean(web?.pid); reason = available ? null : 'WEB_GATEWAY_UNAVAILABLE' }
        if (id === 'members' && members) { available = Boolean(roster?.available); reason = available ? null : 'MEMBERS_UNAVAILABLE' }
        if (id === 'notifications') {
          available = Boolean(push?.available && push.status?.configured)
          reason = available ? null : push?.applyError ?? (push?.available ? 'PUSH_NOT_CONFIGURED' : 'NOTIFICATIONS_UNAVAILABLE')
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
        return value
      }) : snapshot
    },
    plan(input) { validateUpdateRequest('plan', input); if (host) return host.plan(input); throw unavailable() },
    start(input) { validateUpdateRequest('operation', input); if (host) return host.start(input).finally(() => events.emit('change')); throw unavailable() },
    operation(requestId) { validateUpdateRequest('requestId', requestId); if (host) return host.operation(requestId); throw unavailable() },
  }
}
