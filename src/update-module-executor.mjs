import { createModuleExchangeMutex } from './module-exchange-mutex.mjs'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { validateUpdateRequest, validateUpdateResponse } from './update-center-contract.mjs'
import { moduleReleaseCompatible } from './update-module-catalog.mjs'

const failure = (code, status = 503) => Object.assign(new Error(code), { code, status })
const requireValue = (ok, code, status) => { if (!ok) throw failure(code, status) }
const safeCode = error => /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'UPDATE_MODULE_FAILED'
const copy = value => structuredClone(value)
const terminal = value => ['completed', 'failed', 'unknown'].includes(value.phase)
const publicOperation = entry => copy(entry.operation)
const published = release => ({ version: release.versionId, sourceCommit: release.sourceCommit, digest: `sha256:${release.versionId}`, origin: 'published' })
const matches = (current, target) => current !== null && (target.origin === 'builtin'
  ? current.origin === 'builtin' && current.sourceCommit === target.sourceCommit : current.digest === target.digest)

// The server state lock owns this ledger. Controllers retain their own writer/drain locks.
export async function createModuleUpdateExecutor({ root, catalog, adapters, host = null, notify = () => {}, now = Date.now }) {
  const directory = join(root, 'state/update-ledger'), path = join(directory, 'ledger.json')
  let state = { schema: 'bellteam.module-update.ledger.v1', plans: [], operations: [] }
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
          && (step.componentId === 'container' ? entry.hostPlan?.planId : adapters[step.componentId])
          && isDeepStrictEqual(step.target, entry.plan.targets[index].published)), 'UPDATE_LEDGER_INVALID')
      planIds.add(entry.plan.planId)
    }
    for (const entry of state.operations) {
      validateUpdateResponse('operation', { operation: entry.operation })
      const plan = state.plans.find(value => value.plan.planId === entry.operation.plan.planId)
      requireValue(plan && isDeepStrictEqual(plan.plan, entry.operation.plan) && !operationIds.has(entry.operation.requestId)
        && Array.isArray(entry.steps) && entry.steps.length === plan.steps.length
        && entry.steps.every(step => ['pending', 'applying', 'verifying', 'succeeded', 'failed', 'unknown'].includes(step.phase)), 'UPDATE_LEDGER_INVALID')
      operationIds.add(entry.operation.requestId)
    }
    let changed = false
    for (const entry of state.operations.filter(entry => !terminal(entry.operation))) {
      for (const step of entry.steps) if (step.phase !== 'succeeded') step.phase = 'unknown'
      Object.assign(entry.operation, { phase: 'unknown', execution: 'unknown', verification: 'unknown',
        error: { code: 'UPDATE_PARENT_INTERRUPTED', message: '処理が中断されました。同じ要求の結果を確認してください。' } })
      changed = true
    }
    if (changed) await save()
  } catch (error) { if (error.code !== 'ENOENT') throw failure('UPDATE_LEDGER_INVALID') }

  const exclusive = async operation => {
    requireValue(!closed && !fault, fault ?? 'UPDATE_EXECUTOR_CLOSED')
    requireValue(!busy, 'MODULE_EXCHANGE_BUSY', 409)
    busy = true
    try { return await operation() } finally { busy = false }
  }
  const findPlan = id => state.plans.find(entry => entry.plan.planId === id)
  const findOperation = id => state.operations.find(entry => entry.operation.requestId === id)
  const checkCurrent = entry => {
    for (const step of entry.steps.filter(step => step.componentId !== 'container')) {
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
  const work = async entry => {
    const planned = findPlan(entry.operation.plan.planId)
    try {
      requireValue(!closed, 'UPDATE_EXECUTOR_CLOSED')
      for (let index = 0; index < planned.steps.length; index++) {
        const step = planned.steps[index], progress = entry.steps[index]
        progress.phase = 'applying'; entry.operation.phase = 'applying'; await save()
        if (step.componentId === 'container') {
          // Persist issuance intent before Host admission; recovery only queries this UUID.
          entry.hostIssued = true; await save()
          const result = await host.start({ planId: planned.hostPlan.planId, requestId: entry.operation.requestId, confirmContainerRestart: true })
          requireValue(result.admission === 'accepted', 'UPDATE_ADMISSION_UNCONFIRMED')
          await refreshHost(entry); return
        }
        const adapter = adapters[step.componentId]
        requireValue(isDeepStrictEqual(adapter.current(), step.from) && isDeepStrictEqual(adapter.capture?.() ?? null, step.guard), 'UPDATE_CURRENT_CHANGED', 409)
        await adapter.apply(step)
        progress.phase = 'verifying'; entry.operation.phase = 'verifying'; entry.operation.execution = 'succeeded'; await save()
        requireValue(adapter.available() && matches(adapter.current(), step.target), 'UPDATE_VERIFICATION_FAILED')
        progress.phase = 'succeeded'; entry.operation.execution = 'pending'; await save()
      }
      await finish(entry)
    } catch (error) {
      const current = entry.steps.find(step => step.phase !== 'succeeded')
      if (current) current.phase = 'failed'
      Object.assign(entry.operation, { phase: 'failed', execution: 'failed', verification: 'unknown',
        error: { code: safeCode(error), message: '更新を完了できませんでした。保存された結果を確認してください。' } })
      if (entry.hostIssued || !error?.code) Object.assign(entry.operation, { phase: 'unknown', execution: 'unknown' })
      try { await save() } catch { fault = 'UPDATE_LEDGER_WRITE_FAILED'; entry.operation.phase = 'unknown'; entry.operation.execution = 'unknown' }
    }
  }
  return {
    reserveExchange() {
      requireValue(!closed && !fault, fault ?? 'UPDATE_EXECUTOR_CLOSED')
      requireValue(!state.operations.some(entry => entry.hostIssued && !['completed', 'failed'].includes(entry.operation.phase)), 'MODULE_EXCHANGE_BUSY', 409)
      return exchangeMutex.reserve()
    },
    hasPlan: id => Boolean(findPlan(id)),
    hasOperation: id => Boolean(findOperation(id)),
    async plan(input, inventory = null) {
      validateUpdateRequest('plan', input)
      return exclusive(async () => {
        requireValue(!active && !state.operations.some(entry => entry.hostIssued && !['completed', 'failed'].includes(entry.operation.phase)), 'MODULE_EXCHANGE_BUSY', 409)
        const action = input.action ?? 'update'
        requireValue(action !== 'rollback' || input.scope === 'component' && input.componentId !== 'container', 'UPDATE_ROLLBACK_UNSUPPORTED', 409)
        if (input.componentId === 'container') {
          requireValue(host, 'UPDATE_EXECUTOR_UNAVAILABLE')
          const plan = await host.plan(input)
          state.plans.push({ plan, hostPlan: plan, steps: plan.targets.map(target => ({ componentId: 'container', target: target.published })) })
          await save(); return copy(plan)
        }
        const ids = input.scope === 'all' ? Object.keys(adapters) : [input.componentId]
        requireValue(ids.every(id => adapters[id]), 'UPDATE_EXECUTOR_UNAVAILABLE')
        const steps = [], selections = []
        let expires = now() + 10 * 60 * 1000
        for (const id of ids) {
          const adapter = adapters[id], from = adapter.current()
          requireValue(from && adapter.available(), 'UPDATE_CURRENT_UNAVAILABLE')
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
            if (matches(from, published(value.release)) || from.origin === 'builtin' && from.sourceCommit === value.release.sourceCommit) continue
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
        for (const step of steps.filter(step => step.componentId !== 'container')) await adapters[step.componentId].prepare(step)
        const plan = { planId: randomUUID(), scope: input.scope, componentId: input.scope === 'all' ? null : input.componentId, action,
          expiresAt: new Date(expires).toISOString(), targets: steps.map(step => ({ componentId: step.componentId, current: step.from ?? hostPlan.targets[0].current, published: step.target })),
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
        const existing = findOperation(input.requestId)
        if (existing) {
          requireValue(existing.operation.plan.planId === input.planId, 'UPDATE_REQUEST_CONFLICT', 409)
          return publicOperation(existing)
        }
        requireValue(!active && !state.operations.some(entry => entry.hostIssued && !['completed', 'failed'].includes(entry.operation.phase)), 'MODULE_EXCHANGE_BUSY', 409)
        const planned = findPlan(input.planId)
        requireValue(planned, 'UPDATE_PLAN_NOT_FOUND', 404)
        requireValue(Date.parse(planned.plan.expiresAt) > now(), 'UPDATE_PLAN_EXPIRED', 409)
        requireValue(!planned.plan.impact.containerRestart || input.confirmContainerRestart, 'UPDATE_RESTART_CONFIRMATION_REQUIRED', 409)
        const release = exchangeMutex.reserve()
        try {
        checkCurrent(planned); await checkPublication(planned)
        for (const step of planned.steps.filter(step => step.componentId !== 'container')) await adapters[step.componentId].prepare(step)
        checkCurrent(planned)
        requireValue(!closed && Date.parse(planned.plan.expiresAt) > now(), 'UPDATE_PLAN_EXPIRED', 409)
        const entry = { operation: { requestId: input.requestId, plan: copy(planned.plan), admission: 'accepted', phase: 'preparing', execution: 'pending', verification: 'pending', error: null, reference: input.requestId },
          steps: planned.steps.map(() => ({ phase: 'pending' })), hostIssued: false }
        state.operations.push(entry)
        try { await save() } catch (error) {
          Object.assign(entry.operation, { admission: 'unknown', phase: 'unknown', execution: 'unknown', verification: 'unknown', error: { code: 'UPDATE_LEDGER_WRITE_FAILED', message: '受付を確認できません。同じ要求の結果を照会してください。' } })
          throw error
        }
        active = work(entry).finally(() => { active = null; release() })
        return publicOperation(entry)
        } catch (error) { release(); throw error }
      })
    },
    async operation(id) {
      validateUpdateRequest('requestId', id)
      const entry = findOperation(id); requireValue(entry, 'UPDATE_OPERATION_NOT_FOUND', 404)
      if (entry.hostIssued && !['completed', 'failed'].includes(entry.operation.phase) && !active) await exclusive(() => refreshHost(entry))
      return publicOperation(entry)
    },
    async snapshot(inventory) {
      const pendingHost = state.operations.find(entry => entry.hostIssued && !['completed', 'failed'].includes(entry.operation.phase))
      if (pendingHost && !active && !closed && !fault) { try { await exclusive(() => refreshHost(pendingHost)) } catch {} }
      const recent = state.operations.slice(-2).reverse()
      const blockedHost = Boolean(pendingHost)
      if (recent[0]) inventory.operation = publicOperation(recent[0])
      if (recent[1]) inventory.previousOperation = publicOperation(recent[1])
      inventory.plans = state.plans.filter(entry => Date.parse(entry.plan.expiresAt) > now()).slice(-16).map(entry => copy(entry.plan))
      for (const component of inventory.components) if (adapters[component.id] && component.published && component.comparison.state === 'update_available')
        component.capability = { supported: !closed && !fault && !active && !blockedHost, reason: closed ? 'UPDATE_EXECUTOR_CLOSED' : fault ?? (active || blockedHost ? 'MODULE_EXCHANGE_BUSY' : null) }
      if (fault || recent[0] && ['unknown', 'failed'].includes(recent[0].operation.phase)) inventory.notice = { state: 'attention', code: fault ?? recent[0].operation.error?.code ?? 'UPDATE_RESULT_UNKNOWN', message: '保存された更新結果を確認してください。同じ要求を自動で再実行しません。' }
      else if (recent[0] && !terminal(recent[0].operation)) inventory.notice = { state: 'updating', code: null, message: '更新処理の結果を保存しています。' }
      else if (inventory.components.some(component => component.capability.supported)) inventory.notice = { state: 'ready', code: null, message: '固定計画を作成して更新対象を確認できます。' }
      return inventory
    },
    async close() { closed = true; await active; await exchangeMutex.waitForIdle() },
  }
}
