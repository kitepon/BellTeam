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
