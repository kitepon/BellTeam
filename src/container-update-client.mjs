import { createConnection } from 'node:net'
import { lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const socketPath = '/run/bellteam-updater/update.sock'
const failure = (code, outcome = 'not_accepted', status = 503) => Object.assign(new Error(code), { code, outcome, status })

export async function createUpdateClients() {
  const module = createContainerUpdateClient()
  try {
    const directory = await lstat('/run/bellteam-container-updater')
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('HOST_UPDATE_SOCKET_INVALID', 'not_accepted')
  } catch (error) {
    if (error.code === 'ENOENT') return { container: module, module }
    throw error
  }
  return { container: createContainerUpdateClient('/run/bellteam-container-updater/update.sock'), module }
}

export function createContainerUpdateClient(path = socketPath) {
  const call = (operation, params, timeout = 5000) => new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify({ operation, params }) + '\n')
    if (raw.length > 65536) return reject(failure('HOST_UPDATE_MESSAGE_LIMIT', 'not_accepted', 400))
    const deadline = Date.now() + timeout
    let settled = false, response = Buffer.alloc(0), socket
    const finish = (error, value) => {
      if (settled) return
      settled = true; socket?.destroy()
      error ? reject(error) : resolve(value)
    }
    const unreadable = reason => Object.assign(failure('UNREADABLE'), { path, reason })
    const unavailable = error => finish(unreadable(error?.code ?? 'CONNECTION_CLOSED'))
    const attempt = () => {
      if (settled) return
      let connected = false
      const current = socket = createConnection({ path })
      const live = handler => (...args) => { if (current === socket) handler(...args) }
      current.setTimeout(Math.max(1, deadline - Date.now()), live(() => finish(unreadable('ETIMEDOUT'))))
      current.once('error', live(error => {
        // A full listen backlog refuses the connect with EAGAIN before any byte is sent; connecting again replays nothing.
        if (!connected && error?.code === 'EAGAIN' && Date.now() < deadline) { socket = null; current.destroy(); return void setTimeout(attempt, 50) }
        unavailable(error)
      }))
      current.once('connect', live(() => { connected = true; current.write(raw, error => { if (error) unavailable() }) }))
      current.on('data', live(chunk => {
        response = Buffer.concat([response, chunk])
        if (response.length > 65536) return finish(unreadable('RESPONSE_LIMIT'))
        const end = response.indexOf(10)
        if (end < 0) return
        try {
          if (end !== response.length - 1) throw new Error()
          const value = JSON.parse(response.subarray(0, end).toString('utf8'))
          if (value?.ok === true && Object.keys(value).sort().join(',') === 'ok,value') return finish(null, value.value)
          const error = value?.error
          if (value?.ok !== false || Object.keys(value).sort().join(',') !== 'error,ok'
            || !error || ![ 'code,outcome,status', 'code,outcome,path,reason,status' ].includes(Object.keys(error).sort().join(','))
            || !/^[A-Z_0-9]{1,100}$/.test(error.code) || error.outcome !== 'not_accepted'
            || ![400,403,404,409,503].includes(error.status)) throw new Error()
          if (error.code === 'UNREADABLE' && (typeof error.path !== 'string' || typeof error.reason !== 'string')) throw new Error()
          finish(Object.assign(failure(error.code, error.outcome, error.status), error))
        } catch { finish(unreadable('RESPONSE_INVALID')) }
      }))
      current.once('end', live(() => { if (!settled) unavailable() }))
      current.once('close', live(() => { if (!settled) unavailable() }))
    }
    attempt()
  })
  const checkedJob = value => {
    const states = ['queued', 'downloading', 'verifying', 'swapping', 'ready', 'failed']
    if (!value || value.schema !== 'bellteam.update-job.v1' || !states.includes(value.state)
      || typeof value.jobId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.jobId)
      || (value.state === 'failed' ? typeof value.reason?.code !== 'string' || typeof value.reason?.message !== 'string' : value.reason !== null))
      throw Object.assign(failure('UNREADABLE'), { path, reason: 'JOB_RECORD_INVALID' })
    return value
  }
  return {
    capabilities: async () => { try { return await call('capabilities', {}) }
      catch { return { supported: false, reason: 'HOST_UPDATE_UNAVAILABLE', currentRequestId: null, previousRequestId: null } } },
    moduleInstallCapabilities: async () => {
      const value = await call('capabilities', {})
      // Owner 2026-11-08: the installer's source need not equal the body's; the module-install protocol is the contract.
      const supported = typeof value?.moduleInstallSupported === 'boolean' ? value.moduleInstallSupported : value?.supported
      return supported === true && value.moduleInstallProtocol === 1 ? { supported: true, reason: null }
        : { supported: false, reason: /^[A-Z_0-9]{1,100}$/.test(value?.moduleInstallReason ?? value?.reason ?? '') ? (value.moduleInstallReason ?? value.reason) : 'HOST_MODULE_INSTALL_UNAVAILABLE' }
    },
    catalog: componentId => call('catalog', { componentId }),
    // Official fetch (3 x 15 s) + verification (120 s), possibly queued behind one running refresh.
    checkCatalog: () => call('checkCatalog', {}, 360000),
    plan: params => call('plan', params),
    planModuleInstall: params => call('plan', params),
    startModuleInstall: ({ requestId, planId, idempotencyKey }) => call('start', { requestId, planId, confirmContainerRestart: false, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
    start: params => call('start', params),
    operation: requestId => call('get', { requestId }),
    admitJob: async params => checkedJob(await call('admitJob', params)),
    job: async jobId => checkedJob(await call('getJob', { jobId })),
    jobs: async (limit = 16) => {
      const value = await call('listJobs', { limit })
      if (!Array.isArray(value?.jobs) || value.jobs.length > 16) throw Object.assign(failure('UNREADABLE'), { path, reason: 'JOB_RECORD_INVALID' })
      value.jobs.forEach(checkedJob); return value
    },
    updateJob: async params => checkedJob(await call('updateJob', params)),
    inspectModuleInstall: async params => checkedInstallReconciliation(await call('inspectModuleInstall', params)),
    readInstallReconciliation: async params => checkedInstallReconciliation(await call('readInstallReconciliation', params)),
    finalizeInstallReconciliation: async params => checkedInstallReconciliationFence(await call('finalizeInstallReconciliation', params)),
    readInstallReconciliationFence: async params => checkedInstallReconciliationFence(await call('readInstallReconciliationFence', params)),
  }
}

export function installReconciliationHash(value) {
  const canonical = item => item && typeof item === 'object'
    ? Array.isArray(item) ? item.map(canonical) : Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]))
    : item
  return createHash('sha256').update(JSON.stringify(canonical(value)) + '\n').digest('hex')
}

export function validateInstallReconciliation(value) {
  const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).sort().join(',') === keys.split(',').sort().join(',')
  const sha = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
  const uuid = item => typeof item === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item)
  if (!exact(value, 'receiptSha256,receipt') || !sha(value.receiptSha256)) return false
  const r = value.receipt
  if (!exact(r, 'schema,requestId,planId,componentId,versionId,sourceCommit,originalOperationSha256,planSha256,targetSha256,storageBindingSha256,runtimeCurrentSha256,inspectionTime,placement,quiescence,stageState,manifestSha256,recoveryState,fence,evidenceSha256,reason')) return false
  return r.schema === 'bellteam.module-install-inspection.v1' && uuid(r.requestId) && uuid(r.planId)
    && r.componentId === 'execution' && typeof r.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(r.sourceCommit)
    && ['versionId','originalOperationSha256','planSha256','targetSha256','storageBindingSha256','runtimeCurrentSha256','evidenceSha256'].every(key => sha(r[key]))
    && typeof r.inspectionTime === 'string' && r.inspectionTime.length <= 40 && Number.isFinite(Date.parse(r.inspectionTime))
    && ['verified_present','absent','unconfirmed'].includes(r.placement) && ['confirmed','busy','unconfirmed'].includes(r.quiescence)
    && ['clear','unconfirmed'].includes(r.stageState) && (r.manifestSha256 === null || sha(r.manifestSha256))
    && (r.placement === 'verified_present' ? sha(r.manifestSha256) : r.manifestSha256 === null)
    && ['not_issued','verified','unknown'].includes(r.recoveryState) && ['open','closed'].includes(r.fence)
    && [null,'HOST_UPDATE_BUSY','HOST_MODULE_UNOWNED_STAGE','HOST_MODULE_RECOVERY_UNCONFIRMED','HOST_MODULE_INSPECTION_UNCONFIRMED'].includes(r.reason)
    && (r.quiescence !== 'confirmed' || r.stageState === 'clear' && r.recoveryState !== 'unknown')
    && installReconciliationHash(r) === value.receiptSha256
}

function checkedInstallReconciliation(value) {
  if (!validateInstallReconciliation(value)) throw failure('HOST_MODULE_RECONCILIATION_INVALID')
  return value
}

export function validateInstallReconciliationFence(value) {
  const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).sort().join(',') === keys.split(',').sort().join(',')
  const sha = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
  const uuid = item => typeof item === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item)
  if (!exact(value, 'fenceSha256,fence') || !sha(value.fenceSha256)
    || !exact(value.fence, 'schema,requestId,planId,originalOperationSha256,decisionSha256,commonProofSha256,action,closedAt')) return false
  const f = value.fence
  return f.schema === 'bellteam.module-install-fence.v1' && uuid(f.requestId) && uuid(f.planId)
    && ['originalOperationSha256','decisionSha256','commonProofSha256'].every(key => sha(f[key]))
    && f.action === 'close_without_activation'
    && typeof f.closedAt === 'string' && f.closedAt.length <= 40 && Number.isFinite(Date.parse(f.closedAt))
    && installReconciliationHash(f) === value.fenceSha256
}

function checkedInstallReconciliationFence(value) {
  if (!validateInstallReconciliationFence(value)) throw failure('HOST_MODULE_FENCE_INVALID')
  return value
}
