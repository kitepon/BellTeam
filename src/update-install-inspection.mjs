import { randomBytes } from 'node:crypto'
import { validateUpdateRequest } from './update-center-contract.mjs'
import { installReconciliationHash, validateInstallReconciliation, validateInstallReconciliationFence } from './container-update-client.mjs'

const grants = new WeakMap()
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }) }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const decisionKeys = 'schema,publicRequestId,publicPlanId,requestId,planId,originalOperationSha256,publicOperationSha256,inspectionSha256,targetSha256,storageBindingSha256,runtimeCurrentSha256,currentSha256,catalogSha256,action,issuedAt,expiresAt,ownerGrantRef'
const proofKeys = 'schema,publicRequestId,publicPlanId,requestId,planId,originalOperationSha256,publicOperationSha256,decisionSha256,currentSha256,applyState,applyClaimSha256,resultSha256,claimedAt,verifiedAt,ownerGrantRef'
const envelope = (key, value) => ({ [key + 'Sha256']: installReconciliationHash(value), [key]: value })
const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const closed = value => Boolean(value?.close?.fence && value.close.completedAt)

function boundFence(value, close) {
  return validateInstallReconciliationFence(value)
    && ['requestId', 'planId', 'originalOperationSha256', 'action'].every(key => value.fence[key] === close.decision.decision[key])
    && value.fence.decisionSha256 === close.decision.decisionSha256
    && value.fence.commonProofSha256 === close.commonProof.proofSha256
    && Date.parse(value.fence.closedAt) >= Date.parse(close.commonProof.proof.claimedAt)
}

function savedClose(value, state, step, progress, operation) {
  if (!exact(value, 'decision,commonProof,current,fence,completedAt')
    || !exact(value.decision, 'decisionSha256,decision') || !exact(value.decision.decision, decisionKeys)
    || !exact(value.commonProof, 'proofSha256,proof') || !exact(value.commonProof.proof, proofKeys)
    || !exact(value.current, 'current,capture,available') || typeof value.current.available !== 'boolean'
    || !value.current.current || typeof value.current.capture?.generation !== 'string'
    || !value.current.capture.generation.length) return false
  const d = value.decision.decision, p = value.commonProof.proof
  const receipt = state.receipts.find(item => item.receiptSha256 === d.inspectionSha256)?.receipt
  if (!receipt || d.schema !== 'bellteam.module-install-decision.v1'
    || p.schema !== 'bellteam.module-install-common-proof.v1' || d.action !== 'close_without_activation'
    || d.publicRequestId !== operation.requestId || d.publicPlanId !== operation.plan.planId
    || d.requestId !== progress.installRequestId || d.planId !== step.installPlan.planId
    || d.originalOperationSha256 !== state.originalOperationSha256 || d.publicOperationSha256 !== state.publicOperationSha256
    || d.targetSha256 !== receipt.targetSha256 || d.storageBindingSha256 !== receipt.storageBindingSha256
    || d.runtimeCurrentSha256 !== receipt.runtimeCurrentSha256 || d.currentSha256 !== installReconciliationHash(value.current)
    || !sha(d.catalogSha256) || !sha(d.ownerGrantRef)
    || value.decision.decisionSha256 !== installReconciliationHash(d)
    || value.commonProof.proofSha256 !== installReconciliationHash(p)
    || p.decisionSha256 !== value.decision.decisionSha256
    || !['issuedAt','expiresAt'].every(key => date(d[key])) || !['claimedAt','verifiedAt'].every(key => date(p[key]))
    || Date.parse(d.expiresAt) <= Date.parse(d.issuedAt) || Date.parse(d.expiresAt) - Date.parse(d.issuedAt) > 600000
    || Date.parse(receipt.inspectionTime) > Date.parse(d.issuedAt)
    || Date.parse(p.claimedAt) < Date.parse(d.issuedAt) || Date.parse(p.claimedAt) > Date.parse(d.expiresAt)
    || Date.parse(p.verifiedAt) < Date.parse(p.claimedAt)
    || p.applyState !== 'not_issued' || p.applyClaimSha256 !== null || p.resultSha256 !== null
    || !['publicRequestId','publicPlanId','requestId','planId','originalOperationSha256','publicOperationSha256','currentSha256','ownerGrantRef']
      .every(key => p[key] === d[key])) return false
  return value.fence === null ? value.completedAt === null
    : boundFence(value.fence, value) && date(value.completedAt) && Date.parse(value.completedAt) >= Date.parse(value.fence.fence.closedAt)
}

// Only the authenticated HTTP composition supplies this live check; JSON is never a grant.
export function captureInstallInspectionOwner(check) {
  if (typeof check !== 'function') fail('UPDATE_OWNER_REQUIRED', 403)
  const grant = Object.freeze({})
  grants.set(grant, check)
  return grant
}

async function assertOwner(grant) {
  const check = grant && typeof grant === 'object' && grants.get(grant)
  if (!check || await check() !== true) fail('UPDATE_OWNER_REQUIRED', 403)
}

function boundReceipt(envelope, step, progress, originalOperationSha256) {
  try {
    const value = envelope?.receipt
    return validateInstallReconciliation(envelope)
      && value.requestId === progress.installRequestId && value.planId === step.installPlan?.planId
      && value.componentId === step.componentId && value.versionId === step.release?.versionId
      && value.sourceCommit === step.release?.sourceCommit
      && value.targetSha256 === installReconciliationHash(step.release)
      && value.originalOperationSha256 === originalOperationSha256
  } catch { return false }
}

export function validateSavedInstallInspection(value, step, progress, operation) {
  if (!(exact(value, 'schema,originalOperationSha256,publicOperationSha256,receipts')
      || exact(value, 'schema,originalOperationSha256,publicOperationSha256,receipts,close'))
    || value.schema !== 'bellteam.update-install-inspection-state.v1'
    || !sha(value.originalOperationSha256)
    || value.publicOperationSha256 !== installReconciliationHash(operation)
    || !Array.isArray(value.receipts) || !value.receipts.length || value.receipts.length > 64) return false
  const seen = new Set()
  return value.receipts.every(receipt => {
    if (!boundReceipt(receipt, step, progress, value.originalOperationSha256)
      || seen.has(receipt.receiptSha256)) return false
    seen.add(receipt.receiptSha256)
    return true
  }) && (!Object.hasOwn(value, 'close') || operation.phase === 'unknown' && progress.installIssued === true
    && progress.installPhase === 'unknown' && progress.applyIssued !== true
    && savedClose(value.close, value, step, progress, operation))
}

export function installReconciliationClosed(progress) { return closed(progress.installReconciliation) }

export function createInstallReconciliationProof({ execution, conversation, exchangeMutex }) {
  return (componentId, operation) => {
    if (componentId !== 'execution' || typeof operation !== 'function'
      || typeof execution?.withInstallReconciliationProof !== 'function'
      || typeof conversation?.withInstallReconciliationProof !== 'function') fail('UPDATE_RECONCILIATION_PROOF_UNAVAILABLE', 503)
    return exchangeMutex.runExclusive(() => execution.withInstallReconciliationProof(assertEngine =>
      conversation.withInstallReconciliationProof(async assertWriter => {
        const assertQuiescent = () => {
          if (typeof assertEngine !== 'function' || typeof assertWriter !== 'function'
            || assertEngine() !== true || assertWriter() !== true) fail('UPDATE_RECONCILIATION_PROOF_CHANGED')
          return true
        }
        assertQuiescent()
        const result = operation(assertQuiescent)
        try { return await result }
        finally { await (result?.completion ?? result); assertQuiescent() }
      })))
  }
}

export function createInstallInspection({ findOperation, findPlan, moduleHost, adapters, catalog, save, now, withCloseProof, isOpen }) {
  const context = (requestId, installRequestId) => {
    validateUpdateRequest('requestId', requestId)
    validateUpdateRequest('requestId', installRequestId)
    const entry = findOperation(requestId)
    if (!entry) fail('UPDATE_OPERATION_NOT_FOUND', 404)
    const index = entry.steps.findIndex(value => value.installRequestId === installRequestId)
    if (index < 0) fail('UPDATE_RECONCILIATION_STEP_NOT_FOUND', 404)
    return { entry, progress: entry.steps[index], step: findPlan(entry.operation.plan.planId).steps[index] }
  }
  const project = ({ entry, progress }) => {
    const last = progress.installReconciliation?.receipts.at(-1)
    const value = last?.receipt
    return {
      schema: 'bellteam.update-install-reconciliation.v1',
      requestId: entry.operation.requestId, installRequestId: progress.installRequestId,
      originalPhase: entry.operation.phase,
      inspection: value ? {
        receiptSha256: last.receiptSha256, observedAt: value.inspectionTime,
        placement: value.placement, quiescence: value.quiescence, stageState: value.stageState,
        recoveryState: value.recoveryState, fence: value.fence, reason: value.reason,
      } : null,
      resolution: progress.installReconciliation?.close ? {
        action: 'close_without_activation', state: closed(progress.installReconciliation) ? 'closed' : 'unknown',
        claimedAt: progress.installReconciliation.close.commonProof.proof.claimedAt,
        closedAt: progress.installReconciliation.close.completedAt,
        fenceSha256: progress.installReconciliation.close.fence?.fenceSha256 ?? null,
      } : null,
    }
  }
  return {
    read(requestId, installRequestId) { return structuredClone(project(context(requestId, installRequestId))) },
    async inspect(requestId, installRequestId, input, grant) {
      if (!(exact(input, 'action,originalOperationSha256') && input.action === 'inspect'
          || exact(input, 'action,originalOperationSha256,inspectionSha256') && input.action === 'close_without_activation' && sha(input.inspectionSha256))
        || !sha(input.originalOperationSha256)) fail('UPDATE_RECONCILIATION_INPUT_INVALID', 400)
      await assertOwner(grant)
      const state = context(requestId, installRequestId), { entry, progress, step } = state
      if (entry.operation.phase !== 'unknown' || !progress.installIssued
        || progress.installPhase !== 'unknown' || step.componentId !== 'execution')
        fail('UPDATE_RECONCILIATION_NOT_ELIGIBLE')
      const previous = progress.installReconciliation
      if (previous && previous.originalOperationSha256 !== input.originalOperationSha256)
        fail('UPDATE_RECONCILIATION_ORIGINAL_CHANGED')
      if (input.action === 'close_without_activation') {
        if (!previous) fail('UPDATE_RECONCILIATION_INSPECTION_REQUIRED')
        if (previous.close) {
          if (previous.close.decision.decision.inspectionSha256 !== input.inspectionSha256)
            fail('UPDATE_RECONCILIATION_REQUEST_CONFLICT')
          if (!closed(previous)) {
            if (typeof moduleHost?.readInstallReconciliationFence !== 'function') fail('UPDATE_RECONCILIATION_UNAVAILABLE', 503)
            const fence = structuredClone(await moduleHost.readInstallReconciliationFence({ requestId: installRequestId,
              originalOperationSha256: previous.originalOperationSha256 }))
            await assertOwner(grant)
            await completeClose(previous, fence)
          }
          return structuredClone(project(state))
        }
        const receipt = previous.receipts.find(item => item.receiptSha256 === input.inspectionSha256)?.receipt
        if (!receipt || receipt.quiescence !== 'confirmed' || receipt.stageState !== 'clear'
          || receipt.recoveryState !== 'not_issued' || receipt.fence !== 'open'
          || !['verified_present', 'absent'].includes(receipt.placement)) fail('UPDATE_RECONCILIATION_UNCONFIRMED')
        // Legacy install unknown is before the durable completed-install barrier and cannot reach apply.
        if (progress.applyIssued === true || entry.hostIssued || entry.steps.some(item => item !== progress
          && !['pending', 'succeeded'].includes(item.phase) || item.installIssued && item !== progress
          && !['completed', 'failed'].includes(item.installPhase))) fail('UPDATE_RECONCILIATION_APPLY_UNCONFIRMED')
        if (typeof withCloseProof !== 'function' || typeof moduleHost?.finalizeInstallReconciliation !== 'function')
          fail('UPDATE_RECONCILIATION_PROOF_UNAVAILABLE', 503)
        const issuedAt = now()
        return withCloseProof(step.componentId, async assertQuiescent => {
          if (typeof assertQuiescent !== 'function') fail('UPDATE_RECONCILIATION_PROOF_UNAVAILABLE', 503)
          const capture = () => ({ current: structuredClone(adapters[step.componentId].current()),
            capture: structuredClone(adapters[step.componentId].capture?.() ?? null), available: adapters[step.componentId].available() })
          const current = capture(), currentSha256 = installReconciliationHash(current)
          if (typeof current.available !== 'boolean' || !current.current || typeof current.capture?.generation !== 'string'
            || !current.capture.generation.length) fail('UPDATE_CURRENT_UNAVAILABLE')
          const selected = await catalog.select(step.componentId)
          if (!sha(selected.catalogSha256) || selected.publication?.status !== 'verified' || Date.parse(selected.expiresAt) <= now())
            fail('UPDATE_RECONCILIATION_CATALOG_UNCONFIRMED')
          const assertFresh = async () => {
            const freshCatalog = await catalog.select(step.componentId)
            if (freshCatalog.catalogSha256 !== selected.catalogSha256 || freshCatalog.publication?.status !== 'verified'
              || Date.parse(freshCatalog.expiresAt) <= now()) fail('UPDATE_RECONCILIATION_CATALOG_UNCONFIRMED')
            await assertOwner(grant)
            if (!isOpen() || assertQuiescent() !== true || now() >= issuedAt + 600000
              || currentSha256 !== installReconciliationHash(capture())
              || previous.publicOperationSha256 !== installReconciliationHash(entry.operation)) fail('UPDATE_RECONCILIATION_PROOF_CHANGED')
          }
          await assertFresh()
          const d = { schema: 'bellteam.module-install-decision.v1', publicRequestId: requestId,
            publicPlanId: entry.operation.plan.planId, requestId: installRequestId, planId: step.installPlan.planId,
            originalOperationSha256: previous.originalOperationSha256, publicOperationSha256: previous.publicOperationSha256,
            inspectionSha256: input.inspectionSha256, targetSha256: receipt.targetSha256,
            storageBindingSha256: receipt.storageBindingSha256, runtimeCurrentSha256: receipt.runtimeCurrentSha256,
            currentSha256, catalogSha256: selected.catalogSha256, action: 'close_without_activation',
            issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + 600000).toISOString(), ownerGrantRef: randomBytes(32).toString('hex') }
          const decision = envelope('decision', d), claimedAt = new Date(now()).toISOString()
          const commonProof = envelope('proof', { schema: 'bellteam.module-install-common-proof.v1', publicRequestId: requestId,
            publicPlanId: d.publicPlanId, requestId: installRequestId, planId: d.planId, originalOperationSha256: d.originalOperationSha256,
            publicOperationSha256: d.publicOperationSha256, decisionSha256: decision.decisionSha256, currentSha256,
            applyState: 'not_issued', applyClaimSha256: null, resultSha256: null, claimedAt, verifiedAt: claimedAt, ownerGrantRef: d.ownerGrantRef })
          const claim = { decision, commonProof, current, fence: null, completedAt: null }
          if (!savedClose(claim, previous, step, progress, entry.operation)) fail('UPDATE_RECONCILIATION_PROOF_CHANGED')
          previous.close = claim
          await save()
          await assertFresh()
          const fence = structuredClone(await moduleHost.finalizeInstallReconciliation({ requestId: installRequestId,
            originalOperationSha256: previous.originalOperationSha256, decision, commonProof }))
          await assertFresh()
          await completeClose(previous, fence)
          return structuredClone(project(state))
        })
      }
      if (previous?.close) fail('UPDATE_RECONCILIATION_INTENT_CLAIMED')
      if (typeof moduleHost?.inspectModuleInstall !== 'function') fail('UPDATE_RECONCILIATION_UNAVAILABLE', 503)
      const publicHash = installReconciliationHash(entry.operation)
      const receipt = structuredClone(await moduleHost.inspectModuleInstall({
        requestId: installRequestId, originalOperationSha256: input.originalOperationSha256,
      }))
      await assertOwner(grant)
      if (!boundReceipt(receipt, step, progress, input.originalOperationSha256)
        || Date.parse(receipt.receipt.inspectionTime) > now() + 300000
        || publicHash !== installReconciliationHash(entry.operation))
        fail('UPDATE_RECONCILIATION_RECEIPT_INVALID', 503)
      const receipts = previous?.receipts ?? []
      if (!receipts.some(value => value.receiptSha256 === receipt.receiptSha256)) {
        if (receipts.length >= 64) fail('UPDATE_RECONCILIATION_CAPACITY', 503)
        progress.installReconciliation = {
          schema: 'bellteam.update-install-inspection-state.v1',
          originalOperationSha256: input.originalOperationSha256,
          publicOperationSha256: publicHash, receipts: [...receipts, receipt],
        }
        try { await save() } catch (error) {
          if (previous) progress.installReconciliation = previous
          else delete progress.installReconciliation
          throw error
        }
      }
      return structuredClone(project(state))
    },
  }

  async function completeClose(state, fence) {
    if (!boundFence(fence, state.close) || Date.parse(fence.fence.closedAt) > now()) fail('UPDATE_RECONCILIATION_FENCE_INVALID', 503)
    state.close.fence = fence
    state.close.completedAt = new Date(now()).toISOString()
    try { await save() } catch (error) {
      state.close.fence = null; state.close.completedAt = null
      throw error
    }
  }
}
