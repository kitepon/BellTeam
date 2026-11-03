import { constants } from 'node:os'
import { returnedExecutionError } from './execution-error.mjs'

const processCodes = new Set(['ABORT_ERR', 'SEAT_PROCESS_FAILED', 'SEAT_PROCESS_START_FAILED',
  'SEAT_BUFFER_EXCEEDED', 'SEAT_INPUT_FAILED', 'AITERM_WAIT_INVALID', 'AITERM_FAST_UNAVAILABLE'])
const waitOutcomes = new Set(['done', 'running', 'timeout', 'closed', 'error', 'rate_limited', 'not_taken'])

export function executionFailureReport(botId, phase, error, context = {}) {
  if (!['configuration', 'delivery_wait', 'seat_watch'].includes(phase)) return null
  if (phase !== 'configuration' && (error?.turnCompleted === true || ['timeout', 'running'].includes(error?.waitOutcome))) return null
  const detail = { schema: 'bellteam.execution-failure.v1',
    botId: typeof botId === 'string' && /^bot-[a-z0-9-]{1,100}$/u.test(botId) ? botId : null, phase }
  const code = returnedExecutionError(error?.executionError)?.code ?? error?.code
  if (processCodes.has(code) || Object.hasOwn(constants.errno, code ?? '') || returnedExecutionError(error?.executionError)) detail.errorCode = code
  else if (String(error?.message).startsWith('AITERM_WAIT_INVALID')) detail.errorCode = 'AITERM_WAIT_INVALID'
  if (Object.hasOwn(error ?? {}, 'exitCode') && (error.exitCode === null || Number.isSafeInteger(error.exitCode))) detail.exitCode = error.exitCode
  if (Object.hasOwn(error ?? {}, 'signal') && (error.signal === null || Object.hasOwn(constants.signals, error.signal))) detail.signal = error.signal
  if (Object.hasOwn(error ?? {}, 'waitOutcome')) detail.waitOutcome = waitOutcomes.has(error.waitOutcome) ? error.waitOutcome : 'unknown'
  if (phase === 'delivery_wait') {
    for (const key of ['jobId', 'groupId']) {
      if (typeof context?.[key] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(context[key])) detail[key] = context[key]
    }
    for (const key of ['stopRequested', 'stopped', 'waitAborted']) {
      if (typeof context?.[key] === 'boolean') detail[key] = context[key]
    }
  }
  if (phase === 'configuration') {
    const notStarted = error?.effect === 'not_started'
      || error?.agentConfigureResult?.outcome === 'not_applied' && error.agentConfigureResult.effect === 'not_started'
    detail.outcome = notStarted ? 'not_applied' : 'outcome_unknown'
    detail.effect = notStarted ? 'not_started' : 'possible'
  }
  return { code: phase === 'configuration' ? 'SERVER_MODEL_CONFIGURATION_FAILED' : 'SERVER_TURN_TRACKING_FAILED',
    module: phase === 'configuration' ? 'bots' : 'queue', diagnostic_log: JSON.stringify(detail) }
}

export async function reportExecutionFailure(reportError, botId, phase, error, context) {
  try {
    const report = executionFailureReport(botId, phase, error, context)
    if (report) await reportError(report)
  } catch { /* Diagnostic failures must not change the operation or trigger retries. */ }
}
