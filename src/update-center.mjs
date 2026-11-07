import { EventEmitter } from 'node:events'
import { runtimeComponentIds, runtimeUpdateComponents, updateComponents, validateUpdates, validateUpdateRequest } from './update-center-contract.mjs'
const unavailable = () => Object.assign(new Error('UPDATE_EXECUTOR_UNAVAILABLE'), { code: 'UPDATE_EXECUTOR_UNAVAILABLE', status: 503,
  publicMessage: 'この設置では、まだアプリから更新を実行できません。' })
const sourceValid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const versionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function updateNotificationCandidates(inventory, now = Date.now()) {
  return inventory.components.filter(component => !runtimeComponentIds.includes(component.id) && component.current && component.published
    && component.comparison.state === 'update_available' && component.publication?.check.status === 'verified'
    && Date.parse(component.publication.catalog.expiresAt) > now
    && /^[a-f0-9]{64}$/.test(component.published.version))
    .map(component => ({ componentId: component.id, id: component.published.version }))
}

// Released Web/Apple readers accept only module/container jobs; runtime jobs and rows reach only runtime=1 readers.
const visibleJobs = (value, runtime) => runtime ? value : { ...value, jobs: value.jobs.filter(job => job.kind !== 'runtime') }
const runtimeRows = async captureRuntime => {
  let capture = null, reason = 'UPDATE_EXECUTOR_UNAVAILABLE'
  if (captureRuntime) try { capture = await captureRuntime() } catch { reason = 'RUNTIME_BINDING_UNAVAILABLE' }
  return runtimeUpdateComponents.map(([id, name, description]) => {
    const item = capture?.components[id]
    const current = !item ? null : item.origin === 'release'
      ? { version: item.archiveSha256, sourceCommit: null, digest: `sha256:${item.archiveSha256}`, origin: 'release' }
      : { version: 'builtin', sourceCommit: null, digest: null, origin: 'builtin' }
    return { id, name, description, current, published: null, publication: null, changes: [],
      comparison: { state: 'unavailable', reason: 'PUBLISHED_RELEASE_UNAVAILABLE' },
      capability: { supported: false, reason: current ? 'UPDATE_EXECUTOR_UNAVAILABLE' : reason },
      availability: { available: Boolean(current), reason: current ? null : reason },
      runtimeApplication: { generationId: capture?.generation ?? null, policy: 'next_launch' } }
  })
}

export function createUpdateCenter({ gateway = () => null, builtinSourceCommit = null, notifications = null, members = null, host = null, moduleCatalog = null, moduleExecutor = null, jobReader = null, problemReader = null, memory = null, diagnostics = null, usage = null, execution = null, conversation = null, captureRuntime = null } = {}) {
  const events = new EventEmitter(), notified = new Map()
  let notificationTimer = null, notificationRead = null, notificationsClosed = false, lastCandidates = null
  const checkNotifications = () => {
    if (notificationsClosed || notificationRead) return notificationRead
    notificationRead = Promise.resolve().then(() => center.snapshot()).then(value => {
      if (notificationsClosed) return
      const fingerprint = JSON.stringify(value.notificationCandidates)
      if (fingerprint !== lastCandidates) { lastCandidates = fingerprint; events.emit('change') }
      for (const candidate of value.notificationCandidates) {
        if (notified.get(candidate.componentId) === candidate.id) continue
        // Mark before publishing; an unconfirmed notification must never be retried.
        notified.set(candidate.componentId, candidate.id)
        notifications.update({ id: candidate.id })
      }
    }).catch(() => {}).finally(() => { notificationRead = null })
    return notificationRead
  }
  const center = {
    startNotifications() {
      if (notificationsClosed || notificationTimer || typeof notifications?.update !== 'function') return
      notificationTimer = setInterval(checkNotifications, 60000)
      notificationTimer.unref?.()
      void checkNotifications()
    },
    async close() {
      notificationsClosed = true; clearInterval(notificationTimer)
      await notificationRead
      await moduleExecutor?.close()
    },
    reserveExchange: moduleExecutor?.reserveExchange,
    notify: change => events.emit('change', change),
    watch(listener) { events.on('change', listener); return () => events.off('change', listener) },
    checkCatalog() { if (!moduleCatalog) throw unavailable(); return moduleCatalog.checkCatalog() },
    jobs: ({ runtime = false } = {}) => jobReader ? jobReader.jobs().then(value => visibleJobs(value, runtime)) : Promise.resolve({ jobs: [] }),
    job(kind, jobId) { if (!jobReader) throw unavailable(); return jobReader.job(kind, jobId) },
    snapshot({ runtime = false } = {}) {
      const web = gateway(), push = notifications?.controller?.snapshot(), roster = members?.controller?.snapshot()
      const source = sourceValid(push?.builtinSourceCommit) ? push.builtinSourceCommit : null
      const builtin = source ? { version: source, sourceCommit: source, digest: null, origin: 'builtin' } : null
      const active = (id, versionId) => versionValid(versionId)
        ? { version: versionId, sourceCommit: null, digest: `sha256:${versionId}`, origin: 'release' }
        : id === 'container' && builtin ? { ...builtin, origin: 'container' } : builtin
      const components = updateComponents.map(([id, name, description]) => {
        const memoryState = id === 'memory' ? memory?.snapshot() : id === 'diagnostics' ? diagnostics?.snapshot() : id === 'usage' ? usage?.snapshot() : id === 'execution' ? execution?.snapshot() : id === 'conversation' ? conversation?.snapshot() : null
        const moduleBuiltinSource = memoryState?.builtinSourceCommit
          ?? (memoryState?.currentTarget === 'builtin' && memoryState?.currentVersionId === null ? builtinSourceCommit : null)
        const gatewayBuiltin = sourceValid(builtinSourceCommit) ? { version: builtinSourceCommit, sourceCommit: builtinSourceCommit, digest: null, origin: 'builtin' } : null
        const current = id === 'web-gateway' ? versionValid(web?.versionId) ? active(id, web.versionId) : web?.versionId === null ? gatewayBuiltin : null : ['memory', 'diagnostics', 'usage', 'execution', 'conversation'].includes(id) ? memoryState?.currentVersionId ? active(id, memoryState.currentVersionId) : sourceValid(moduleBuiltinSource) ? { version: moduleBuiltinSource, sourceCommit: moduleBuiltinSource, digest: null, origin: 'builtin' } : null : id === 'members' ? versionValid(roster?.currentVersionId)
          ? { version: roster.currentVersionId, sourceCommit: null, digest: `sha256:${roster.currentVersionId}`, origin: 'release' }
          : sourceValid(roster?.builtinSourceCommit) ? { version: roster.builtinSourceCommit, sourceCommit: roster.builtinSourceCommit, digest: null, origin: 'builtin' } : null
          : active(id, id === 'web-gateway' ? web?.versionId : id === 'notifications' ? push?.currentVersionId : null)
        let available = null, reason = 'AVAILABILITY_UNKNOWN'
        if (id === 'memory' && memory || id === 'diagnostics' && diagnostics || id === 'usage' && usage || id === 'execution' && execution || id === 'conversation' && conversation) { available = Boolean(memoryState?.available); reason = available ? null : id === 'memory' ? 'MEMORY_UNAVAILABLE' : id === 'diagnostics' ? 'DIAGNOSTICS_UNAVAILABLE' : id === 'usage' ? 'USAGE_UNAVAILABLE' : id === 'conversation' ? 'CONVERSATION_UNAVAILABLE' : 'EXECUTION_UNAVAILABLE' }
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
      const base = runtime ? runtimeRows(captureRuntime).then(rows => { value.components.push(...rows); return value }) : value
      const snapshot = host ? (base.then ? base.then(value => host.snapshot(value)) : host.snapshot(base)) : base
      const result = moduleCatalog ? Promise.resolve(snapshot).then(value => moduleCatalog.snapshot(value)).then(value => {
        if (!validateUpdates(value).valid) throw new Error('UPDATE_SNAPSHOT_INVALID')
        return moduleExecutor ? moduleExecutor.snapshot(value) : value
      }) : moduleExecutor ? Promise.resolve(snapshot).then(value => moduleExecutor.snapshot(value)) : snapshot
      const project = value => {
        const result = { ...value, notificationCandidates: updateNotificationCandidates(value) }
        return jobReader || problemReader ? Promise.all([jobReader?.jobs(), problemReader?.()])
          .then(([jobs, problems]) => ({ ...result, ...(jobs && visibleJobs(jobs, runtime)), ...(problems ? { problems } : {}) })) : result
      }
      return result?.then ? result.then(project) : project(result)
    },
    plan(input) { validateUpdateRequest('plan', input); if (moduleExecutor) return Promise.resolve(this.snapshot({ runtime: runtimeComponentIds.includes(input.componentId) })).then(value => moduleExecutor.plan(input, value)); if (host && (!input.action || input.action === 'update')) return host.plan(input); throw unavailable() },
    start(input) { validateUpdateRequest('operation', input); if ((moduleExecutor?.hasPlan(input.planId) || moduleExecutor?.hasOperation(input.requestId))) return moduleExecutor.start(input); if (host) return host.start(input).finally(() => events.emit('change')); throw unavailable() },
    operation(requestId) { validateUpdateRequest('requestId', requestId); if (moduleExecutor?.hasOperation(requestId)) return moduleExecutor.operation(requestId); if (host) return host.operation(requestId); throw unavailable() },
    installReconciliation(requestId, installRequestId) {
      if (!moduleExecutor) throw unavailable()
      return moduleExecutor.installReconciliation(requestId, installRequestId)
    },
    inspectModuleInstall(requestId, installRequestId, input, grant) {
      if (!moduleExecutor) throw unavailable()
      return moduleExecutor.inspectModuleInstall(requestId, installRequestId, input, grant)
    },
  }
  return center
}
