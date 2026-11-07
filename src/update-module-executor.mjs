import { createModuleExchangeMutex } from './module-exchange-mutex.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runtimeComponentIds, validateUpdateRequest, validateUpdateResponse } from './update-center-contract.mjs'
import { moduleReleaseCompatible } from './update-module-catalog.mjs'
import { validateModuleExchangeDiagnostic } from './module-exchange-diagnostic.mjs'
import { createInstallInspection, validateSavedInstallInspection, installReconciliationClosed } from './update-install-inspection.mjs'

const failure = (code, status = 503) => Object.assign(new Error(code), { code, status })
const requireValue = (ok, code, status) => { if (!ok) throw failure(code, status) }
const safeCode = error => /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'UPDATE_MODULE_FAILED'
const installReason = capability => /^[A-Z][A-Z0-9_]{0,99}$/.test(capability?.reason ?? '') ? capability.reason : 'HOST_MODULE_INSTALL_UNAVAILABLE'
const copy = value => structuredClone(value)
const terminal = value => ['completed', 'failed', 'unknown'].includes(value.phase)
const publicOperation = entry => copy(entry.operation)
const published = release => ({ version: release.versionId, sourceCommit: release.sourceCommit, digest: `sha256:${release.versionId}`, origin: 'published' })
const jobKind = id => id === 'container' ? 'container' : runtimeComponentIds.includes(id) ? 'runtime' : 'module'
// The updater worker owns an accepted runtime job; only one it never accepted can still be queued for the parent to close.
const runtimeUnissued = step => !step.installIssued || step.installPhase === 'failed'
const matches = (current, target) => current !== null && (target.origin === 'builtin'
  ? current.origin === 'builtin' && current.sourceCommit === target.sourceCommit : current.digest === target.digest)

// The server state lock owns this ledger. Controllers retain their own writer/drain locks.
export async function createModuleUpdateExecutor({ root, catalog, adapters, host = null, moduleHost = null, notify = () => {}, now = Date.now }) {
  const directory = join(root, 'state/update-ledger'), path = join(directory, 'ledger.json')
  let state = { schema: 'bellteam.module-update.ledger.v1', plans: [], operations: [] }
  const jobClient = binding => binding.kind === 'container' ? host : moduleHost
  const hasCloseIntent = entry => entry.steps.some(step => step.installReconciliation?.close)
  const publicJobs = async entry => {
    // Active work owns its writes; a retained close intent can only converge its fence.
    if (!active && !closed && !fault && !hasCloseIntent(entry)) {
      if (entry.jobBindings) await flushJobReports(entry)
      if (entry.interrupted) {
        for (const binding of entry.jobBindings.filter((binding, index) => binding.admitted && (binding.kind === 'module'
          || (binding.kind === 'runtime' ? runtimeUnissued(entry.steps[index]) : !entry.hostIssued)))) {
          const job = await jobClient(binding).job(binding.jobId)
          if (!['ready', 'failed'].includes(job.state)) await jobClient(binding).updateJob({ jobId: binding.jobId,
            state: 'failed', reason: { code: 'UPDATE_PARENT_INTERRUPTED', message: '親が停止し、機能の切替を完了できませんでした。' } })
        }
        entry.interrupted = false; await save()
      }
    }
    const value = publicOperation(entry)
    if (entry.jobBindings) value.jobs = await Promise.all(entry.jobBindings.filter(binding => binding.admitted)
      .map(async binding => {
        const job = await jobClient(binding).job(binding.jobId)
        validateUpdateResponse('job', { job })
        requireValue(job.jobId === binding.jobId && job.kind === binding.kind
          && job.idempotencyKey === binding.idempotencyKey, 'UPDATE_JOB_BINDING_INVALID')
        return job
      }))
    validateUpdateResponse('operation', { operation: value })
    return value
  }
  const exchangeMutex = createModuleExchangeMutex()
  let busy = false, closed = false, active = null, fault = null
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const info = await dir.stat()
    requireValue(info.uid === process.getuid() && (info.mode & 0o7777) === 0o700, 'UPDATE_LEDGER_INVALID')
  } finally { await dir.close() }
  const save = async () => {
    const bytes = JSON.stringify(state) + '\n'
    // shortcut: retain 4096 plans/operations in 16 MiB; add archival before raising these bounds.
    requireValue(state.plans.length <= 4096 && state.operations.length <= 4096 && Buffer.byteLength(bytes) <= 16 * 1024 ** 2, 'UPDATE_LEDGER_CAPACITY')
    const temporary = join(directory, randomUUID() + '.tmp')
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes); await file.sync(); await file.close()
      await rename(temporary, path)
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
    } catch (error) { fault = 'UPDATE_LEDGER_WRITE_FAILED'; await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw failure('UPDATE_LEDGER_WRITE_FAILED') }
    try { notify() } catch {}
  }
  const flushJobReports = async entry => {
    let changed = false
    for (const [index, binding] of (entry.jobBindings ?? []).entries()) {
      const progress = entry.steps[index], report = progress.jobReport
      if (!report) continue
      const stored = await jobClient(binding).job(binding.jobId)
      const job = ['ready', 'failed'].includes(stored.state) ? stored
        : await jobClient(binding).updateJob({ jobId: binding.jobId, ...report })
      if (report.state === 'ready' && job.state === 'ready') progress.phase = 'succeeded'
      delete progress.jobReport; changed = true
    }
    if (changed) {
      if (entry.steps.every(step => step.phase === 'succeeded')) Object.assign(entry.operation,
        { phase: 'completed', execution: 'succeeded', verification: 'succeeded', error: null })
      await save()
    }
  }
  const reportJob = async (entry, index, state, reason) => {
    entry.steps[index].jobReport = { state, reason }; await save()
    await flushJobReports(entry)
  }
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      requireValue(info.isFile() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o7777) === 0o600 && info.size <= 16 * 1024 ** 2, 'UPDATE_LEDGER_INVALID')
      state = JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
    requireValue(state?.schema === 'bellteam.module-update.ledger.v1' && Array.isArray(state.plans) && state.plans.length <= 4096
      && Array.isArray(state.operations) && state.operations.length <= 4096, 'UPDATE_LEDGER_INVALID')
    const planIds = new Set(), operationIds = new Set()
    for (const entry of state.plans) {
      validateUpdateResponse('plan', { plan: entry.plan })
      requireValue(!planIds.has(entry.plan.planId) && Array.isArray(entry.steps) && entry.steps.length === entry.plan.targets.length
        && entry.steps.every((step, index) => step.componentId === entry.plan.targets[index].componentId
          && (step.componentId === 'container' ? entry.hostPlan?.planId : jobKind(step.componentId) === 'runtime' ? step.installPlan : adapters[step.componentId])
          && isDeepStrictEqual(step.target, entry.plan.targets[index].published)), 'UPDATE_LEDGER_INVALID')
      planIds.add(entry.plan.planId)
      for (const step of entry.steps) if (step.installPlan) {
        validateUpdateRequest('requestId', step.installPlan.planId)
        requireValue(step.release && step.componentId !== 'container' && entry.plan.action !== 'rollback'
          && Number.isFinite(Date.parse(step.installPlan.expiresAt)), 'UPDATE_LEDGER_INVALID')
      }
    }
    const installIds = new Set()
    for (const entry of state.operations) {
      validateUpdateResponse('operation', { operation: entry.operation })
      const plan = state.plans.find(value => value.plan.planId === entry.operation.plan.planId)
      requireValue(plan && isDeepStrictEqual(plan.plan, entry.operation.plan) && !operationIds.has(entry.operation.requestId)
        && Array.isArray(entry.steps) && entry.steps.length === plan.steps.length
        && entry.steps.every(step => ['pending', 'applying', 'verifying', 'succeeded', 'failed', 'unknown'].includes(step.phase)), 'UPDATE_LEDGER_INVALID')
      operationIds.add(entry.operation.requestId)
      if (entry.jobBindings) {
        validateUpdateRequest('operation', { planId: entry.operation.plan.planId, requestId: entry.operation.requestId,
          confirmContainerRestart: false, idempotencyKey: entry.idempotencyKey })
        requireValue(Array.isArray(entry.jobBindings) && entry.jobBindings.length === entry.steps.length
          && typeof entry.admissionComplete === 'boolean', 'UPDATE_LEDGER_INVALID')
        for (const [index, binding] of entry.jobBindings.entries()) {
          validateUpdateRequest('requestId', binding.jobId)
          requireValue(binding.kind === jobKind(plan.steps[index].componentId)
            && /^[a-f0-9]{64}$/.test(binding.idempotencyKey) && typeof binding.admitted === 'boolean', 'UPDATE_LEDGER_INVALID')
        }
      }
      for (const [index, step] of entry.steps.entries()) if (Object.hasOwn(step, 'runtimeDiagnostic'))
        requireValue(validateModuleExchangeDiagnostic(step.runtimeDiagnostic)
          && step.runtimeDiagnostic.component === plan.steps[index].componentId, 'UPDATE_LEDGER_INVALID')
      for (const step of entry.steps) if (Object.hasOwn(step, 'applyIssued'))
        requireValue(typeof step.applyIssued === 'boolean', 'UPDATE_LEDGER_INVALID')
      for (const [index, step] of entry.steps.entries()) if (step.installRequestId !== undefined) {
        validateUpdateRequest('requestId', step.installRequestId)
        requireValue(plan.steps[index].installPlan && !installIds.has(step.installRequestId)
          && step.installRequestId !== entry.operation.requestId && typeof step.installIssued === 'boolean'
          && ['pending', 'completed', 'failed', 'unknown'].includes(step.installPhase), 'UPDATE_LEDGER_INVALID')
        installIds.add(step.installRequestId)
      }
      for (const [index, step] of entry.steps.entries()) if (Object.hasOwn(step, 'installReconciliation'))
        requireValue(step.installRequestId && validateSavedInstallInspection(step.installReconciliation,
          plan.steps[index], step, entry.operation), 'UPDATE_LEDGER_INVALID')
    }
    let changed = false
    for (const entry of state.operations.filter(entry => !terminal(entry.operation) && entry.admissionComplete !== false)) {
      if (entry.jobBindings) entry.interrupted = true
      for (const step of entry.steps) if (step.phase !== 'succeeded') step.phase = 'unknown'
      Object.assign(entry.operation, { phase: 'unknown', execution: 'unknown', verification: 'unknown',
        error: { code: 'UPDATE_PARENT_INTERRUPTED', message: '処理が中断されました。同じ要求の結果を確認してください。' } })
      changed = true
    }
    if (changed) await save()
  } catch (error) { if (error.code !== 'ENOENT') throw failure('UPDATE_LEDGER_INVALID') }

  const exclusive = async (operation, allowStopped = false) => {
    if (!allowStopped) requireValue(!closed && !fault, fault ?? 'UPDATE_EXECUTOR_CLOSED')
    requireValue(!busy, 'MODULE_EXCHANGE_BUSY', 409)
    busy = true
    // save() が状態の変化を知らせる。読取りだけの排他（snapshotのhost/install再読）は知らせない。
    // 知らせると端末が /api/updates を読み直し、その読取りがまた鳴らして洪水になる（2026-11-07）。
    try { return await operation() } finally { busy = false }
  }
  const findPlan = id => state.plans.find(entry => entry.plan.planId === id)
  const findOperation = id => state.operations.find(entry => entry.operation.requestId === id)
  const inspection = createInstallInspection({ findOperation, findPlan, moduleHost, adapters, catalog, save, now })
  const installPending = step => step.installIssued && !['completed', 'failed'].includes(step.installPhase) && !installReconciliationClosed(step)
  const hostPending = entry => (entry.hostIssued || entry.jobBindings?.some((binding, index) => binding.kind === 'runtime' && entry.steps[index].installIssued))
    && !['completed', 'failed'].includes(entry.operation.phase) || entry.steps.some(installPending)
  const planInstall = async step => {
    const capability = await moduleHost.moduleInstallCapabilities()
    requireValue(capability?.supported === true, installReason(capability))
    const planId = randomUUID()
    const value = await moduleHost.planModuleInstall({ planId, catalogSha256: step.catalogSha256,
      componentId: step.componentId, versionId: step.release.versionId })
    requireValue(value?.schema === 'bellteam.host-update.plan.v1' && value.planId === planId
      && value.catalogSha256 === step.catalogSha256 && isDeepStrictEqual(value.target, step.release)
      && value.impact?.containerRestart === false && Date.parse(value.expiresAt) > now(), 'UPDATE_HOST_RESPONSE_INVALID')
    step.installPlan = { planId, expiresAt: value.expiresAt }
  }
  const prepareStep = async (step, planning = false) => {
    try { await adapters[step.componentId].prepare(step); return true }
    catch (error) {
      if (error.code !== 'ENOENT' || !moduleHost || !step.release || step.target.origin === 'builtin') throw error
      if (planning) await planInstall(step)
      requireValue(step.installPlan && Date.parse(step.installPlan.expiresAt) > now(), 'UPDATE_INSTALL_PLAN_EXPIRED', 409)
      return false
    }
  }
  const installResult = (step, progress, value) => {
    requireValue(value?.requestId === progress.installRequestId && value.planId === step.installPlan.planId
      && isDeepStrictEqual(value.target, step.release) && ['accepted', 'rejected', 'unknown'].includes(value.admission)
      && ['preparing', 'admitted', 'applying', 'verifying', 'completed', 'failed', 'unknown'].includes(value.phase)
      && ['pending', 'succeeded', 'failed', 'unknown'].includes(value.execution)
      && ['pending', 'succeeded', 'failed', 'unknown'].includes(value.verification), 'UPDATE_HOST_RESPONSE_INVALID')
    if (value.phase === 'completed') requireValue(value.admission === 'accepted' && value.execution === 'succeeded'
      && value.verification === 'succeeded', 'UPDATE_HOST_RESPONSE_INVALID')
    return value
  }
  const refreshInstalls = async entry => {
    if (!moduleHost) return
    const planned = findPlan(entry.operation.plan.planId)
    for (const [index, progress] of entry.steps.entries()) if (installPending(progress) && !progress.installReconciliation) {
      const value = installResult(planned.steps[index], progress, await moduleHost.operation(progress.installRequestId))
      if (['completed', 'failed'].includes(value.phase)) { progress.installPhase = value.phase; await save() }
    }
  }
  const install = async (step, progress, binding) => {
    progress.installIssued = true; await save()
    // Persist the separate step UUID before the only issuing call; all recovery is read-only.
    let accepted
    try {
      accepted = installResult(step, progress, await moduleHost.startModuleInstall({
        requestId: progress.installRequestId, planId: step.installPlan.planId, ...(binding ? { idempotencyKey: binding.idempotencyKey } : {}) }))
    } catch (error) {
      if (error.outcome === 'not_accepted') { progress.installPhase = 'failed'; await save() }
      throw error
    }
    if (accepted.admission === 'rejected') { progress.installPhase = 'failed'; await save() }
    requireValue(accepted.admission === 'accepted', 'UPDATE_ADMISSION_UNCONFIRMED')
    while (true) {
      requireValue(!closed, 'UPDATE_EXECUTOR_CLOSED')
      const value = installResult(step, progress, await moduleHost.operation(progress.installRequestId))
      try { notify() } catch {}
      if (['completed', 'failed', 'unknown'].includes(value.phase)) {
        progress.installPhase = value.phase; await save()
        requireValue(value.phase === 'completed', value.phase === 'failed' ? 'UPDATE_INSTALL_FAILED' : 'UPDATE_INSTALL_UNKNOWN')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const checkCurrent = entry => {
    for (const step of entry.steps.filter(step => jobKind(step.componentId) === 'module')) {
      requireValue(isDeepStrictEqual(adapters[step.componentId].current(), step.from) && adapters[step.componentId].available()
        && isDeepStrictEqual(adapters[step.componentId].capture?.() ?? null, step.guard), 'UPDATE_CURRENT_CHANGED', 409)
    }
  }
  const checkPublication = async entry => {
    if (entry.plan.action === 'rollback') return
    for (const step of entry.steps.filter(step => step.componentId !== 'container')) {
      const value = await catalog.select(step.componentId)
      requireValue(value.catalogSha256 === step.catalogSha256 && Date.parse(value.expiresAt) > now()
        && isDeepStrictEqual(value.release, step.release) && moduleReleaseCompatible(step.componentId, value.release), 'UPDATE_PLAN_STALE', 409)
    }
  }
  const finish = async entry => {
    Object.assign(entry.operation, { phase: 'completed', execution: 'succeeded', verification: 'succeeded', error: null })
    await save()
  }
  const refreshHost = async entry => {
    const planned = findPlan(entry.operation.plan.planId), index = planned.steps.findIndex(step => step.componentId === 'container')
    if (index < 0 || !entry.hostIssued || entry.steps[index].phase === 'succeeded') return
    const result = await host.operation(entry.operation.requestId)
    requireValue(result.plan.planId === planned.hostPlan.planId, 'UPDATE_HOST_RESPONSE_INVALID')
    if (result.phase === 'completed') {
      entry.steps[index].phase = 'succeeded'; await finish(entry)
    } else {
      Object.assign(entry.operation, { phase: result.phase, execution: result.execution, verification: result.verification, error: result.error })
      entry.steps[index].phase = result.phase === 'failed' ? 'failed' : 'unknown'
      await save()
    }
  }
  // Like a Host-completed container step: the worker drives the runtime job; the parent only projects its terminal record.
  const refreshRuntime = async entry => {
    const index = entry.jobBindings?.findIndex(binding => binding.kind === 'runtime') ?? -1, progress = entry.steps[index]
    if (index < 0 || !progress.installIssued || ['completed', 'failed'].includes(entry.operation.phase)) return
    const job = await moduleHost.job(entry.jobBindings[index].jobId)
    if (!['ready', 'failed'].includes(job.state)) return
    Object.assign(progress, job.state === 'ready' ? { phase: 'succeeded', installPhase: 'completed' } : { phase: 'failed', installPhase: 'failed' })
    if (job.state === 'ready') return finish(entry)
    Object.assign(entry.operation, { phase: 'failed', execution: 'failed', verification: 'failed',
      error: { code: safeCode(job.reason), message: '実行部品の更新を完了できませんでした。' } })
    await save()
  }
  const work = async entry => {
    const planned = findPlan(entry.operation.plan.planId)
    try {
      requireValue(!closed, 'UPDATE_EXECUTOR_CLOSED')
      for (let index = 0; index < planned.steps.length; index++) {
        const step = planned.steps[index], progress = entry.steps[index], binding = entry.jobBindings?.[index]
        progress.phase = 'applying'; entry.operation.phase = 'applying'; await save()
        if (step.componentId === 'container') {
          // Persist issuance intent before Host admission; recovery only queries this UUID.
          entry.hostIssued = true; await save()
          const result = await host.start({ planId: planned.hostPlan.planId, requestId: entry.operation.requestId, confirmContainerRestart: true, ...(binding ? { idempotencyKey: binding.idempotencyKey } : {}) })
          requireValue(result.admission === 'accepted', 'UPDATE_ADMISSION_UNCONFIRMED')
          await refreshHost(entry); return
        }
        if (binding?.kind === 'runtime') {
          try { await install(step, progress, binding) } catch (error) { if (!progress.installIssued || error.outcome === 'not_accepted') throw error }
          await refreshRuntime(entry); return
        }
        const adapter = adapters[step.componentId]
        requireValue(isDeepStrictEqual(adapter.current(), step.from) && isDeepStrictEqual(adapter.capture?.() ?? null, step.guard), 'UPDATE_CURRENT_CHANGED', 409)
        const needsInstall = !await prepareStep(step)
        if (binding && !needsInstall) {
          await moduleHost.updateJob({ jobId: binding.jobId, state: 'downloading', reason: null })
          await moduleHost.updateJob({ jobId: binding.jobId, state: 'verifying', reason: null })
        }
        if (needsInstall) await install(step, progress, binding)
        await adapter.prepare(step)
        requireValue(adapter.available() && isDeepStrictEqual(adapter.current(), step.from) && isDeepStrictEqual(adapter.capture?.() ?? null, step.guard), 'UPDATE_CURRENT_CHANGED', 409)
        progress.applyIssued = true; await save()
        if (binding) await moduleHost.updateJob({ jobId: binding.jobId, state: 'swapping', reason: null })
        await adapter.apply(step)
        progress.phase = 'verifying'; entry.operation.phase = 'verifying'; entry.operation.execution = 'succeeded'; await save()
        requireValue(adapter.available() && matches(adapter.current(), step.target), 'UPDATE_VERIFICATION_FAILED')
        if (binding) await reportJob(entry, index, 'ready', null)
        progress.phase = 'succeeded'; entry.operation.execution = 'pending'; await save()
      }
      await finish(entry)
    } catch (error) {
      if (entry.jobBindings) {
        for (const [index, binding] of entry.jobBindings.entries()) {
          if (binding.kind === 'container' && entry.hostIssued || binding.kind === 'runtime' && !runtimeUnissued(entry.steps[index]) || !binding.admitted || entry.steps[index].phase === 'succeeded'
            || entry.steps[index].jobReport?.state === 'ready') continue
          entry.steps[index].jobReport = { state: 'failed', reason: {
            code: error.code === 'UNREADABLE' ? 'UPDATE_MODULE_ABORTED' : safeCode(error), message: '機能の更新を中断しました。' } }
        }
        try {
          await save(); await flushJobReports(entry)
          if (entry.steps.every(step => step.phase === 'succeeded')) return
        } catch {} // Saved reports retry without replaying controller work.
      }
      const current = entry.steps.find(step => step.phase !== 'succeeded')
      if (current) {
        current.phase = 'failed'
        try {
          const diagnostic = copy(error?.moduleDiagnostic)
          if (validateModuleExchangeDiagnostic(diagnostic)
            && diagnostic.component === planned.steps[entry.steps.indexOf(current)].componentId) current.runtimeDiagnostic = diagnostic
        } catch {} // Diagnostic extraction must not replace the original failure.
      }
      Object.assign(entry.operation, { phase: 'failed', execution: 'failed', verification: 'unknown',
        error: { code: safeCode(error), message: '更新を完了できませんでした。保存された結果を確認してください。' } })
      if (entry.hostIssued || entry.steps.some(installPending) || !error?.code) Object.assign(entry.operation, { phase: 'unknown', execution: 'unknown' })
      try { await save() } catch { fault = 'UPDATE_LEDGER_WRITE_FAILED'; entry.operation.phase = 'unknown'; entry.operation.execution = 'unknown' }
    }
  }
  const admit = async entry => {
    const planned = findPlan(entry.operation.plan.planId)
    for (const [index, binding] of entry.jobBindings.entries()) {
      if (binding.admitted) continue
      const step = planned.steps[index]
      const job = binding.kind === 'container' ? await host.admitJob({ planId: planned.hostPlan.planId, ...binding })
        : await moduleHost.admitJob({ jobId: binding.jobId, idempotencyKey: binding.idempotencyKey,
          kind: binding.kind, target: { catalogSha256: step.catalogSha256 ?? null, moduleId: step.componentId,
            versionId: step.target.origin === 'builtin' ? 'builtin' : step.target.version } })
      validateUpdateResponse('job', { job })
      requireValue(job.jobId === binding.jobId && job.idempotencyKey === binding.idempotencyKey && job.kind === binding.kind
        && job.target.moduleId === step.componentId && job.target.versionId === (step.target.origin === 'builtin' ? 'builtin' : step.target.version), 'UPDATE_JOB_BINDING_INVALID')
      binding.admitted = true; await save()
    }
    entry.admissionComplete = true; entry.operation.admission = 'accepted'; await save()
  }
  return {
    reserveExchange() {
      requireValue(!closed && !fault, fault ?? 'UPDATE_EXECUTOR_CLOSED')
      requireValue(!busy && !state.operations.some(hostPending), 'MODULE_EXCHANGE_BUSY', 409)
      return exchangeMutex.reserve()
    },
    hasPlan: id => Boolean(findPlan(id)),
    hasOperation: id => Boolean(findOperation(id)),
    installReconciliation(requestId, installRequestId) {
      requireValue(!busy, 'MODULE_EXCHANGE_BUSY', 409)
      return inspection.read(requestId, installRequestId)
    },
    inspectModuleInstall(requestId, installRequestId, input, grant) {
      return exclusive(() => exchangeMutex.runExclusive(async () => {
        requireValue(!active, 'MODULE_EXCHANGE_BUSY', 409)
        let owned = true
        try {
          return await inspection.inspect(requestId, installRequestId, input, grant, () => {
            requireValue(owned && busy && !active && !closed && !fault, 'UPDATE_RECONCILIATION_PROOF_CHANGED', 409)
            return true
          })
        } finally { owned = false }
      }))
    },
    async plan(input, inventory = null) {
      validateUpdateRequest('plan', input)
      return exclusive(async () => {
        requireValue(!active && !state.operations.some(hostPending), 'MODULE_EXCHANGE_BUSY', 409)
        const action = input.action ?? 'update'
        requireValue(action !== 'rollback' || input.scope === 'component' && jobKind(input.componentId) === 'module', 'UPDATE_ROLLBACK_UNSUPPORTED', 409)
        if (input.componentId === 'container') {
          requireValue(host, 'UPDATE_EXECUTOR_UNAVAILABLE')
          const plan = await host.plan(input)
          state.plans.push({ plan, hostPlan: plan, steps: plan.targets.map(target => ({ componentId: 'container', target: target.published })) })
          await save(); return copy(plan)
        }
        if (jobKind(input.componentId) === 'runtime') {
          // Never part of an 'all' plan: one runtime target per plan, installed and selected by the updater worker.
          requireValue(moduleHost?.admitJob, 'UPDATE_EXECUTOR_UNAVAILABLE')
          const from = inventory?.components.find(component => component.id === input.componentId)?.current
          requireValue(from, 'RUNTIME_BINDING_UNAVAILABLE')
          const value = await catalog.select(input.componentId)
          requireValue(value.release && Date.parse(value.expiresAt) > now(), 'PUBLISHED_RELEASE_UNAVAILABLE')
          requireValue(moduleReleaseCompatible(input.componentId, value.release), 'UPDATE_INCOMPATIBLE', 409)
          requireValue(!matches(from, published(value.release)), 'UPDATE_ALREADY_CURRENT', 409)
          const step = { componentId: input.componentId, from, target: published(value.release), release: value.release, catalogSha256: value.catalogSha256 }
          await planInstall(step)
          const plan = { planId: randomUUID(), scope: 'component', componentId: input.componentId, action,
            expiresAt: new Date(Math.min(now() + 10 * 60 * 1000, Date.parse(value.expiresAt), Date.parse(step.installPlan.expiresAt))).toISOString(),
            targets: [{ componentId: input.componentId, current: from, published: step.target }], compatibility: { compatible: true, reason: null },
            impact: { containerRestart: false, description: '次回起動から適用します。実行中の席は現在の版を継続し、本体は再起動しません。' }, capability: { supported: true, reason: null } }
          validateUpdateResponse('plan', { plan })
          requireValue(!closed && Date.parse(plan.expiresAt) > now(), 'UPDATE_PLAN_EXPIRED', 409)
          state.plans.push({ plan, steps: [step], hostPlan: null }); await save(); return copy(plan)
        }
        const ids = input.scope === 'all' ? Object.keys(adapters) : [input.componentId]
        requireValue(ids.every(id => adapters[id]), 'UPDATE_EXECUTOR_UNAVAILABLE')
        const steps = [], selections = []
        let expires = now() + 10 * 60 * 1000
        for (const id of ids) {
          const adapter = adapters[id], from = adapter.current()
          requireValue(adapter.available() && (from || adapter.capture?.()?.generation), 'UPDATE_CURRENT_UNAVAILABLE')
          if (action === 'rollback') {
            const previous = [...state.operations].reverse().filter(entry => entry.operation.phase === 'completed' && entry.operation.plan.scope === 'component')
              .flatMap(entry => findPlan(entry.operation.plan.planId).steps).find(step => step.componentId === id)
            requireValue(previous?.from && matches(from, previous.target) && adapter.canRollback(previous.from), 'UPDATE_ROLLBACK_UNAVAILABLE', 409)
            const release = previous.fromRelease ?? null
            steps.push({ componentId: id, from, guard: adapter.capture?.() ?? null, target: previous.from, release, catalogSha256: null, fromRelease: previous.release })
          } else {
            const value = await catalog.select(id)
            requireValue(value.release && Date.parse(value.expiresAt) > now(), 'PUBLISHED_RELEASE_UNAVAILABLE')
            requireValue(moduleReleaseCompatible(id, value.release), 'UPDATE_INCOMPATIBLE', 409)
            selections.push(value.catalogSha256); expires = Math.min(expires, Date.parse(value.expiresAt))
            if (matches(from, published(value.release)) || from?.origin === 'builtin' && from.sourceCommit === value.release.sourceCommit) continue
            const old = [...state.plans].reverse().flatMap(entry => entry.steps).find(step => step.componentId === id && matches(from, step.target))
            steps.push({ componentId: id, from, guard: adapter.capture?.() ?? null, target: published(value.release), release: value.release, catalogSha256: value.catalogSha256, fromRelease: old?.release ?? null })
          }
        }
        requireValue(new Set(selections).size <= 1, 'UPDATE_CATALOG_CHANGED', 409)
        let hostPlan = null
        if (input.scope === 'all' && host) {
          const container = inventory?.components.find(component => component.id === 'container')
          requireValue(container?.publication && container.comparison.state !== 'incompatible', 'UPDATE_CONTAINER_PLAN_UNAVAILABLE')
          requireValue(!selections.length || container.publication.catalog.sha256 === selections[0], 'UPDATE_CATALOG_CHANGED', 409)
          if (container.comparison.state === 'update_available') {
            requireValue(container.capability.supported, container.capability.reason)
            hostPlan = await host.plan({ scope: 'component', componentId: 'container' })
            expires = Math.min(expires, Date.parse(hostPlan.expiresAt))
            steps.push({ componentId: 'container', target: hostPlan.targets[0].published })
          }
        }
        requireValue(steps.length, 'UPDATE_ALREADY_CURRENT', 409)
        for (const step of steps.filter(step => step.componentId !== 'container')) {
          await prepareStep(step, action !== 'rollback')
          if (step.installPlan) expires = Math.min(expires, Date.parse(step.installPlan.expiresAt))
        }
        const plan = { planId: randomUUID(), scope: input.scope, componentId: input.scope === 'all' ? null : input.componentId, action,
          expiresAt: new Date(expires).toISOString(), targets: steps.map(step => ({ componentId: step.componentId, current: step.componentId === 'container' ? hostPlan.targets[0].current : step.from, published: step.target })),
          compatibility: { compatible: true, reason: null }, impact: { containerRestart: Boolean(hostPlan), description: hostPlan ? '機能の切替後、本体を再起動します。会話と処理が一時中断します。' : '対象の機能を順に切り替えます。本体は再起動しません。' }, capability: { supported: true, reason: null } }
        validateUpdateResponse('plan', { plan })
        const entry = { plan, steps, hostPlan }; checkCurrent(entry)
        requireValue(!closed && expires > now(), 'UPDATE_PLAN_EXPIRED', 409)
        state.plans.push(entry); await save(); return copy(plan)
      })
    },
    async start(input) {
      validateUpdateRequest('operation', input)
      return exclusive(async () => {
        const key = input.idempotencyKey ?? input.requestId
        const sameId = findOperation(input.requestId)
        const existing = sameId ?? state.operations.find(entry => entry.idempotencyKey === key)
        if (existing) {
          requireValue(existing.operation.plan.planId === input.planId
            && (existing.idempotencyKey ?? existing.operation.requestId) === key, 'UPDATE_REQUEST_CONFLICT', 409)
          if (existing.admissionComplete !== false || hasCloseIntent(existing)) return publicJobs(existing)
        }
        requireValue(!active && !state.operations.some(hostPending), 'MODULE_EXCHANGE_BUSY', 409)
        const planned = findPlan(input.planId)
        requireValue(planned, 'UPDATE_PLAN_NOT_FOUND', 404)
        requireValue(Date.parse(planned.plan.expiresAt) > now(), 'UPDATE_PLAN_EXPIRED', 409)
        requireValue(!planned.plan.impact.containerRestart || input.confirmContainerRestart, 'UPDATE_RESTART_CONFIRMATION_REQUIRED', 409)
        requireValue(moduleHost?.admitJob || planned.steps.every(step => step.componentId === 'container'), 'UPDATE_JOB_READER_UNAVAILABLE')
        const release = exchangeMutex.reserve()
        try {
          checkCurrent(planned); await checkPublication(planned)
          for (const step of planned.steps.filter(step => jobKind(step.componentId) === 'module')) await prepareStep(step)
          checkCurrent(planned)
          requireValue(!closed && Date.parse(planned.plan.expiresAt) > now(), 'UPDATE_PLAN_EXPIRED', 409)
          let entry = existing
          if (!entry) {
            const bindings = planned.steps.map(step => ({ jobId: step.componentId === 'container' ? input.requestId : randomUUID(),
              kind: jobKind(step.componentId), admitted: false,
              idempotencyKey: createHash('sha256').update(JSON.stringify([key, step.componentId])).digest('hex') }))
            entry = { idempotencyKey: key, admissionComplete: false, jobBindings: bindings,
              operation: { requestId: input.requestId, plan: copy(planned.plan), admission: 'pending', phase: 'preparing', execution: 'pending', verification: 'pending', error: null, reference: input.requestId },
              steps: planned.steps.map((step, index) => ({ phase: 'pending', applyIssued: false, ...(step.installPlan ? {
                installRequestId: bindings[index].jobId, installIssued: false, installPhase: 'pending',
              } : {}) })), hostIssued: false }
            state.operations.push(entry); await save()
          }
          await admit(entry)
          const accepted = await publicJobs(entry)
          active = work(entry).finally(() => { active = null; release(); try { notify({ operationCompleted: true }) } catch {} })
          return accepted
        } catch (error) { release(); throw error }
      })
    },
    async operation(id) {
      validateUpdateRequest('requestId', id)
      return exclusive(async () => {
        const entry = findOperation(id); requireValue(entry, 'UPDATE_OPERATION_NOT_FOUND', 404)
        if (entry.hostIssued && !['completed', 'failed'].includes(entry.operation.phase) && !active && !closed && !fault) await refreshHost(entry)
        if (!active && !closed && !fault) { try { await refreshRuntime(entry) } catch {} }
        if (entry.steps.some(installPending) && !active && !closed && !fault) {
          // A failed readback must not hide the already durable unknown result.
          try { await refreshInstalls(entry) } catch {}
        }
        return publicJobs(entry)
      }, true)
    },
    async snapshot(inventory) {
      return exclusive(async () => {
        const pendingHost = state.operations.find(hostPending)
        if (pendingHost && !active && !closed && !fault) { try { await refreshHost(pendingHost); await refreshRuntime(pendingHost); await refreshInstalls(pendingHost) } catch {} }
        // Runtime rows are present only for a runtime=1 reader; released readers never see a runtime plan or operation.
        const runtimeShown = inventory.components.some(component => jobKind(component.id) === 'runtime')
        const visible = plan => runtimeShown || plan.targets.every(target => jobKind(target.componentId) !== 'runtime')
        const recent = state.operations.filter(entry => visible(entry.operation.plan)).slice(-2).reverse()
        const blockedHost = Boolean(pendingHost)
        if (recent[0]) inventory.operation = await publicJobs(recent[0])
        if (recent[1]) inventory.previousOperation = await publicJobs(recent[1])
        inventory.plans = state.plans.filter(entry => visible(entry.plan) && Date.parse(entry.plan.expiresAt) > now()).slice(-16).map(entry => copy(entry.plan))
        for (const component of inventory.components) {
          const current = component.comparison.state === 'up_to_date' && component.publication?.check.status === 'verified'
          const runtime = jobKind(component.id) === 'runtime' && component.availability.available === true && moduleHost?.admitJob
          if ((adapters[component.id] || runtime) && component.published && (current || component.comparison.state === 'update_available' || component.comparison.state === 'unknown' && adapters[component.id]?.capture?.()?.generation))
            component.capability = { supported: !current && !closed && !fault && !active && !blockedHost,
              reason: closed ? 'UPDATE_EXECUTOR_CLOSED' : fault ?? (active || blockedHost ? 'MODULE_EXCHANGE_BUSY' : current ? 'UPDATE_ALREADY_CURRENT' : null) }
        }
        // Inventory advertises what plan will accept: an unplaced archive needs the Host module installer, so its refusal reason is projected here.
        // shortcut: an archive already placed by an earlier install would still plan without the Host; plan stays the final arbiter.
        const offered = inventory.components.filter(component => (adapters[component.id] || jobKind(component.id) === 'runtime') && component.capability.supported)
        if (offered.length && typeof moduleHost?.moduleInstallCapabilities === 'function') {
          const capability = await moduleHost.moduleInstallCapabilities()
          if (capability?.supported !== true) for (const component of offered) component.capability = { supported: false, reason: installReason(capability) }
        }
        if (fault || recent[0] && ['unknown', 'failed'].includes(recent[0].operation.phase)) inventory.notice = { state: 'attention', code: fault ?? recent[0].operation.error?.code ?? 'UPDATE_RESULT_UNKNOWN', message: '保存された更新結果を確認してください。同じ要求を自動で再実行しません。' }
        else if (recent[0] && !terminal(recent[0].operation)) inventory.notice = { state: 'updating', code: null, message: '更新処理の結果を保存しています。' }
        else if (inventory.components.some(component => component.capability.supported)) inventory.notice = { state: 'ready', code: null, message: '固定計画を作成して更新対象を確認できます。' }
        else if (!closed && !fault && !active && !blockedHost && inventory.notice.code === 'UPDATE_PROVIDERS_UNAVAILABLE'
          && inventory.components.some(component => adapters[component.id] && component.capability.reason === 'UPDATE_ALREADY_CURRENT'))
          inventory.notice = { state: 'ready', code: null, message: '確認できた機能の稼働版は、正式公開版と一致しています。' }
        return inventory
      }, true)
    },
    async close() { closed = true; await active; await exchangeMutex.waitForIdle() },
  }
}
