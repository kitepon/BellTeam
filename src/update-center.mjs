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

const runningText = { queued: '更新の順番を待っています', downloading: '新しい版を取り込んでいます', verifying: '新しい版を確かめています', swapping: '新しい版に切り替えています' }
const failureCause = { UPDATE_PARENT_INTERRUPTED: '本体が止まったため、途中で終わりました', EXECUTION_BUSY: '使用中だったため、見送りました',
  MODULE_EXCHANGE_BUSY: '使用中だったため、見送りました', BOT_UPDATE_HOLD: '使用中だったため、見送りました' }
const updateText = { update_available: '新しい版があります。', up_to_date: '最新です。', incompatible: '新しい版はありますが、今の本体では使えません。' }
// Owner reads JST (owner rule voice.time); `at` stays ISO for clients that reformat.
const jst = at => new Date(at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
// One line per part: installed version, update availability, and only the latest job for that part.
export function componentStatus(component, jobs = []) {
  const job = jobs.filter(item => item.target.moduleId === component.id)
    .reduce((latest, item) => !latest || BigInt(item.updatedAtNs) > BigInt(latest.updatedAtNs) ? item : latest, null)
  const outcome = !job ? null : job.state === 'ready' ? 'succeeded' : job.state === 'failed' ? 'failed' : 'running'
  const at = job && new Date(Number(BigInt(job.updatedAtNs) / 1000000n)).toISOString()
  const installed = !component.current ? '使っている版を確認できません。'
    : component.current.origin === 'release' ? '更新で入れた版を使っています。' : '最初から入っている版を使っています。'
  // The body answering this request proves the container is serving.
  const running = component.id === 'container' || component.availability.available === true
  const stopped = component.id !== 'container' && component.availability.available === false
  let jobText = '', tone = 'ok', action = null
  if (outcome === 'running') { jobText = `${jst(at)} から更新中です（${runningText[job.state]}）。`; tone = 'updating' }
  if (outcome === 'succeeded') jobText = `${jst(at)} の更新は完了しました。`
  if (outcome === 'failed') {
    jobText = `${jst(at)} の更新は${failureCause[job.reason.code] ?? 'できませんでした'}。`
      + (stopped ? 'この機能は今使えません。' : running ? '元の版のまま動いています。対応は不要です。' : '')
      + (!stopped && component.comparison.state === 'update_available' ? 'もう一度更新できます。' : '')
    if (stopped) { tone = 'attention'; action = 'この機能が使えません。「詳細」の内容を担当に伝えてください。' }
  }
  return { line: installed + (updateText[component.comparison.state] ?? '新しい版があるかは確認できません。') + jobText,
    tone, actionRequired: action !== null, action,
    latestJob: job && { jobId: job.jobId, kind: job.kind, state: job.state, outcome, at, reason: job.reason } }
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
    // Module rows and the container row read separate Host catalog stores; one Owner check refreshes both
    // (2026-11-08: the container row otherwise waited for its 30 min timer). The first store's result is returned.
    checkCatalog() {
      const checks = [moduleCatalog?.checkCatalog(), host?.checkCatalog?.()].filter(Boolean)
      if (!checks.length) throw unavailable()
      return Promise.allSettled(checks).then(([first]) => { if (first.status === 'rejected') throw first.reason; return first.value })
    },
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
      const withStatus = value => ({ ...value, components: value.components.map(component => ({ ...component, status: componentStatus(component, value.jobs) })) })
      const project = value => {
        const result = { ...value, notificationCandidates: updateNotificationCandidates(value) }
        return jobReader || problemReader ? Promise.all([jobReader?.jobs(), problemReader?.()])
          .then(([jobs, problems]) => withStatus({ ...result, ...(jobs && visibleJobs(jobs, runtime)), ...(problems ? { problems } : {}) })) : withStatus(result)
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
