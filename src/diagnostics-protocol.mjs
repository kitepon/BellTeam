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
    check(!Object.hasOwn(params, 'status') || ['open', 'resolved'].includes(params.status))
    check(!Object.hasOwn(params, 'note') || typeof params.note === 'string' && Boolean(params.note.trim()) && params.note.length <= 2000)
  }
}
