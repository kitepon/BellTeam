import { validateDiagnosticReport } from './diagnostics.mjs'

export const DIAGNOSTICS_STATE_COMPATIBILITY = Object.freeze({
  diagnostics: 'unversioned-rows-array', investigations: 'optional-fingerprint-map',
})
export const DIAGNOSTICS_METHODS = Object.freeze(['record', 'list', 'setStatus', 'setNote', 'updateInvestigation'])
export const diagnosticsError = (code, status = 400) => Object.assign(new Error(code), { code, status, outcome: 'not_accepted' })
export const diagnosticsObject = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
export const validDiagnosticsGeneration = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\0]/u.test(value)

export function validateDiagnosticsRequest(method, params, context) {
  const check = condition => { if (!condition) throw diagnosticsError('DIAGNOSTIC_INVALID') }
  check(diagnosticsObject(context, ['generation']) && validDiagnosticsGeneration(context.generation))
  check(DIAGNOSTICS_METHODS.includes(method))
  if (method === 'record') {
    check(diagnosticsObject(params, ['report']) && diagnosticsObject(params.report, ['code', 'module'], ['app_version', 'diagnostic_log', 'severity']))
    validateDiagnosticReport(params.report)
  } else if (method === 'list') {
    check(diagnosticsObject(params, [], ['status', 'limit']))
    check(params.status === undefined || ['all', 'open', 'resolved'].includes(params.status))
    check(params.limit === undefined || Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 1000)
  } else {
    const required = method === 'setStatus' ? ['fingerprint', 'status'] : method === 'setNote' ? ['fingerprint', 'note'] : ['fingerprint']
    check(diagnosticsObject(params, required, method === 'setNote' ? [] : method === 'setStatus' ? ['note'] : ['status', 'note']))
    check(typeof params.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(params.fingerprint))
    check(params.status === undefined && method !== 'setStatus' || ['open', 'resolved'].includes(params.status))
    check(params.note === undefined && method !== 'setNote' || typeof params.note === 'string' && Boolean(params.note.trim()) && params.note.length <= 2000)
  }
}

export const DIAGNOSTICS_PROTOCOL_VERSION = 1
const controls = new Set(['initialize', 'quiesce', 'resume', 'exit'])
export function assertDiagnosticsStateCompatibility(value) {
  if (!diagnosticsObject(value, Object.keys(DIAGNOSTICS_STATE_COMPATIBILITY))
    || Object.entries(DIAGNOSTICS_STATE_COMPATIBILITY).some(([key, expected]) => value[key] !== expected))
    throw diagnosticsError('DIAGNOSTICS_STATE_INCOMPATIBLE', 503)
}

export function validateDiagnosticsControl(method, params) {
  if (!controls.has(method) || (method === 'initialize'
    ? !diagnosticsObject(params, ['generation', 'mode']) || !validDiagnosticsGeneration(params.generation)
      || !['bootstrap', 'restore'].includes(params.mode)
    : !diagnosticsObject(params, []))) throw diagnosticsError('DIAGNOSTICS_CONTROL_INVALID')
}

export function validateDiagnosticsControlResult(method, value) {
  if (method === 'initialize') {
    if (!diagnosticsObject(value, ['stateCompatibility'])) throw diagnosticsError('DIAGNOSTICS_IPC_INVALID', 503)
    assertDiagnosticsStateCompatibility(value.stateCompatibility)
  } else if (method === 'quiesce' ? !diagnosticsObject(value, ['quiesced']) || typeof value.quiesced !== 'boolean'
    : method === 'resume' ? !diagnosticsObject(value, ['resumed']) || value.resumed !== true
      : method !== 'exit' || !diagnosticsObject(value, ['closed']) || value.closed !== true)
    throw diagnosticsError('DIAGNOSTICS_IPC_INVALID', 503)
}

export function validateDiagnosticsReady(value) {
  if (!diagnosticsObject(value, ['versionId', 'protocolVersion', 'stateCompatibility'])
    || value.versionId !== null && (typeof value.versionId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.versionId))
    || value.protocolVersion !== DIAGNOSTICS_PROTOCOL_VERSION) throw diagnosticsError('DIAGNOSTICS_READY_INVALID', 503)
  assertDiagnosticsStateCompatibility(value.stateCompatibility)
}

export function validateDiagnosticsRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint)
    || !['fatal', 'high', 'warn', 'info'].includes(value.severity)
    || typeof value.message_template !== 'string' || typeof value.module !== 'string' || typeof value.category !== 'string'
    || !Number.isInteger(value.occurrence_count) || value.occurrence_count < 1
    || typeof value.last_seen !== 'string' || !Number.isFinite(Date.parse(value.last_seen))
    || !['open', 'resolved'].includes(value.status)) throw diagnosticsError('DIAGNOSTICS_RESULT_INVALID', 503)
  return true
}

const knownErrors = new Map([
  ['DIAGNOSTIC_INVALID', 400], ['DIAGNOSTIC_NOT_FOUND', 404],
  ['DIAGNOSTICS_NOT_ACCEPTED', 503], ['DIAGNOSTICS_UNAVAILABLE', 503],
  ['DIAGNOSTICS_CONTROL_INVALID', 400], ['DIAGNOSTICS_NOT_QUIESCED', 503],
])
export function diagnosticsWireError(error, outcome) {
  const code = knownErrors.has(error?.code) ? error.code : knownErrors.has(error?.message) ? error.message : 'DIAGNOSTICS_OPERATION_FAILED'
  return { code, status: knownErrors.get(code) ?? 503, outcome }
}
