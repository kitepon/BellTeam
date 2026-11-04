const components = ['usage', 'diagnostics', 'conversation']
const stages = ['spawn', 'channel', 'initialize', 'ready', 'adoption', 'resume']
const rollbackStages = ['candidate_cleanup', 'prepare', ...stages]
const systemCodes = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EEXIST', 'EINVAL', 'ERR_MODULE_NOT_FOUND', 'ERR_REQUIRE_ASYNC_MODULE']
const suffixes = ['NOT_ACCEPTING', 'CLOSED', 'DRAIN_REQUIRED', 'CHANNEL_INVALID', 'READY_TIMEOUT', 'READY_INVALID', 'RESUME_FAILED', 'STATE_INCOMPATIBLE', 'CHILD_EXITED', 'IPC_DISCONNECTED', 'IPC_INVALID', 'IPC_TIMEOUT', 'IPC_ACK_TIMEOUT', 'IPC_SEND_FAILED', 'OPERATION_FAILED']
const codeValid = (component, code) => code === null || typeof code === 'string'
  && (systemCodes.includes(code) || suffixes.some(suffix => code === `${component.toUpperCase()}_${suffix}`))
const safeCode = (component, error) => {
  try { const code = error?.code; return codeValid(component, code) ? code : null } catch { return null }
}

export function validateModuleExchangeDiagnostic(value) {
  if (validateModuleDrainDiagnostic(value)) return true
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'code,component,rollback,rollbackCode,rollbackStage,schema,stage'
      && value.schema === 'bellteam.module-exchange-diagnostic.v1' && components.includes(value.component)
      && stages.includes(value.stage) && codeValid(value.component, value.code)
      && (value.rollback === 'succeeded' && value.rollbackStage === null && value.rollbackCode === null
        || value.rollback === 'failed' && rollbackStages.includes(value.rollbackStage) && codeValid(value.component, value.rollbackCode))
      && Buffer.byteLength(JSON.stringify(value)) <= 1024
  } catch { return false }
}

export function moduleExchangeDiagnostic(component, stage, error, rollbackStage, rollbackError) {
  return { schema: 'bellteam.module-exchange-diagnostic.v1', component, stage, code: safeCode(component, error),
    rollback: rollbackStage === null ? 'succeeded' : 'failed', rollbackStage,
    rollbackCode: rollbackStage === null ? null : safeCode(component, rollbackError) }
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
export function moduleDrainDiagnostic(component, stage, runnerActive, admission) {
  let snapshot
  try { snapshot = admission?.snapshot?.() } catch {}
  return { schema: 'bellteam.module-drain-diagnostic.v1', component, stage, runnerActive: count(runnerActive),
    admissionActive: count(snapshot?.active), admissionClosed: boolean(snapshot?.closed),
    admissionUnconfirmed: boolean(snapshot?.unconfirmed) }
}
export function validateModuleDrainDiagnostic(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value))
      && Object.keys(value).sort().join(',') === 'admissionActive,admissionClosed,admissionUnconfirmed,component,runnerActive,schema,stage'
      && value.schema === 'bellteam.module-drain-diagnostic.v1' && components.includes(value.component)
      && ['parent_drain', 'child_quiesce', 'handoff'].includes(value.stage)
      && [value.runnerActive, value.admissionActive].every(n => n === null || Number.isSafeInteger(n) && n >= 0)
      && [value.admissionClosed, value.admissionUnconfirmed].every(b => b === null || typeof b === 'boolean')
      && Buffer.byteLength(JSON.stringify(value)) <= 1024
  } catch { return false }
}

// Runtime console evidence only; this is not a public DTO or a ledger variant.
export function moduleRecoveryLog(component, stage, event, attempt, runnerActive, admission, error) {
  const recoveryStages = ['operation', 'mutex', 'runner', 'prepare', 'recover_admission', 'spawn', 'channel', 'initialize', 'ready', 'restore', 'resume']
  if (!components.includes(component) || !recoveryStages.includes(stage)
    || !['waiting', 'completed', 'failed', 'skipped'].includes(event)) return null
  let counts, failureCode = null
  try { counts = moduleDrainDiagnostic(component, 'parent_drain', runnerActive, admission) } catch {}
  if (event === 'failed') {
    try {
      const code = error?.code
      failureCode = ['MODULE_EXCHANGE_BUSY', 'CONVERSATION_NOT_ACCEPTED', 'CONVERSATION_PROTOCOL_UNCONFIRMED'].includes(code)
        ? code : safeCode(component, error)
    } catch {}
  }
  return { code: 'MODULE_CHILD_RECOVERY', component, stage, event, attempt: count(attempt), failureCode,
    runnerActive: count(runnerActive), admissionActive: counts?.admissionActive ?? null,
    admissionClosed: counts?.admissionClosed ?? null, admissionUnconfirmed: counts?.admissionUnconfirmed ?? null }
}
