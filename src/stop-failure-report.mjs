import { returnedExecutionError } from './execution-bridge.mjs'

const status = value => ['sent', 'idle', 'failed', 'partial'].includes(value) ? value : 'unknown'
const code = value => returnedExecutionError({ schema: 'aiterm.execution-error.v1', code: value,
  effect: 'possible', follow_up: 'status_only' })?.code
  ?? (['KEY_SEND_FAILED', 'RELATION_GRAPH_UNAVAILABLE', 'BOT_STOP_UNCONFIRMED'].includes(value) ? value : null)

// Fixed fields only: never log exception text, arbitrary target names or payloads.
// A returned cancel-key receipt does not prove that the harness has stopped.
export function stopFailureReport(botId, error) {
  const targets = Array.isArray(error?.cascade?.targets) ? error.cascade.targets : []
  const failures = targets.filter(target => target?.status === 'failed')
  const execution = returnedExecutionError(error?.executionError)
  return {
    schema: 'bellteam.stop-failure.v1', botId, httpStatus: 502,
    stopEffect: 'unconfirmed', cascadeStatus: status(error?.cascade?.status),
    botNamedTargetStatus: status(targets.find(target => target?.session_id === botId)?.status),
    targetCounts: Object.fromEntries(['sent', 'idle', 'failed'].map(value =>
      [value, targets.filter(target => target?.status === value).length])),
    failureCodes: [...new Set(failures.map(target => code(target?.error)).filter(Boolean))],
    executionCode: execution?.code ?? code(error?.code),
    executionEffect: execution?.effect ?? null,
    rpcResultReturned: error?.aitermResponseReturned === true || status(error?.cascade?.status) !== 'unknown',
  }
}
