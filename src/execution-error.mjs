export const ERROR_META = 'aiterm/execution_error'
const codes = new Set(['INVALID', 'NOT_FOUND', 'CONFLICT', 'STOPPING', 'STALE_GENERATION', 'UNCONFIRMED', 'BUSY', 'STATE_UNAVAILABLE', 'UNSUPPORTED'].map(value => `EXECUTION_${value}`))
export const isExecutionErrorCode = code => codes.has(code)

export function returnedExecutionError(value) {
  return value?.schema === 'aiterm.execution-error.v1' && isExecutionErrorCode(value.code)
    && ['not_started', 'possible'].includes(value.effect) && ['none', 'status_only'].includes(value.follow_up)
    ? { schema: value.schema, code: value.code, effect: value.effect, follow_up: value.follow_up } : null
}
