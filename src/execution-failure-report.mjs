import { constants } from 'node:os'
import { returnedExecutionError } from './execution-error.mjs'
import { diagnosticFailureDetails } from './diagnostic-report-context.mjs'
import { mcpRequestContext } from './mcp-request-context.mjs'
import { configurationBinding, configurationRequestFailure } from './configuration-request.mjs'

const processCodes = new Set(['ABORT_ERR', 'SEAT_PROCESS_FAILED', 'SEAT_PROCESS_START_FAILED',
  'SEAT_BUFFER_EXCEEDED', 'SEAT_INPUT_FAILED', 'AITERM_WAIT_INVALID', 'AITERM_FAST_UNAVAILABLE'])
const waitOutcomes = new Set(['done', 'running', 'timeout', 'closed', 'error', 'rate_limited', 'not_taken'])
const configurationCodes = new Set(['CONFIGURATION_INTENT_SAVE_UNCONFIRMED', 'CONFIGURATION_STORAGE_INVALID'])

export function executionFailureReport(botId, phase, error, context = {}) {
  if (!['configuration', 'delivery_wait', 'seat_watch', 'delivery_completion'].includes(phase)) return null
  if (phase === 'delivery_completion') return completionFailureReport(botId, error, context)
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
    detail.failure = diagnosticFailureDetails(error)
    // Any internal code token names the cause (wait-contract.md); free messages stay out.
    const token = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value)
    if (configurationCodes.has(error?.code) || token(error?.code)) detail.failure.error_code = error.code
    if (configurationCodes.has(error?.cause?.code) || token(error?.cause?.code)) detail.failure.cause_code = error.cause.code
    const configuration = configurationRequestFailure(error)
    if (configuration) {
      try { detail.configuration_request = configurationBinding(configuration.binding) } catch { /* Invalid supplemental data is not diagnostic evidence. */ }
      const preparation = configuration.preparation
      if (preparation?.state === 'not_returned' && ['not_started', 'unknown', 'confirmed'].includes(preparation.publication)
        && Object.keys(preparation).sort().join(',') === 'publication,state') detail.preparation = { ...preparation }
    }
    const request = mcpRequestContext(error)
    if (request) detail.mcp_request = request
    if (error?.aitermResponseReturned === true) detail.responseReturned = true
    const receipt = error?.agentConfigureResult
    if (receipt?.schema === 'aiterm.agent-configure-error.v1'
      && Object.keys(receipt).sort().join(',') === 'effect,outcome,schema,session_id'
      && typeof receipt.session_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(receipt.session_id)
      && (receipt.outcome === 'not_applied' && receipt.effect === 'not_started'
        || receipt.outcome === 'outcome_unknown' && receipt.effect === 'possible'))
      detail.configureFailure = { outcome: receipt.outcome, effect: receipt.effect }
    const notStarted = ['not_started', 'not_issued'].includes(error?.effect)
      || error?.agentConfigureResult?.outcome === 'not_applied' && error.agentConfigureResult.effect === 'not_started'
    detail.outcome = notStarted ? 'not_applied' : 'outcome_unknown'
    detail.effect = notStarted ? 'not_started' : 'possible'
  }
  return { code: phase === 'configuration' ? 'SERVER_MODEL_CONFIGURATION_FAILED' : 'SERVER_TURN_TRACKING_FAILED',
    module: phase === 'configuration' ? 'bots' : 'queue', diagnostic_log: JSON.stringify(detail) }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
// An accepted delivery that failed before its end: which step, and a code token only (wait-contract.md).
function completionFailureReport(botId, error, context) {
  const detail = { schema: 'bellteam.execution-failure.v1',
    botId: typeof botId === 'string' && /^bot-[a-z0-9-]{1,100}$/u.test(botId) ? botId : null, phase: 'delivery_completion',
    step: ['answer', 'delivered', 'turn_end'].includes(context?.step) ? context.step : 'other' }
  for (const key of ['jobId', 'groupId']) if (uuid.test(context?.[key] ?? '')) detail[key] = context[key]
  const code = returnedExecutionError(error?.executionError)?.code ?? error?.code
  // Aiterm tool errors arrive as "aiterm: <CODE>: <text>"; only the code token is kept.
  const token = String(error?.message ?? '').match(/^(?:aiterm: )?((?:AITERM_)?[A-Z][A-Z0-9_]{2,96}):/u)?.[1]
    ?? String(error?.message ?? '').match(/^(AITERM_[A-Z0-9_]{1,96})\b/u)?.[1]
  detail.errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(code) ? code : token ?? 'UNKNOWN'
  const request = mcpRequestContext(error)
  if (request) detail.mcp_request = request
  return { code: 'SERVER_TURN_TRACKING_FAILED', module: 'queue', diagnostic_log: JSON.stringify(detail) }
}

export async function reportExecutionFailure(reportError, botId, phase, error, context) {
  try {
    const report = executionFailureReport(botId, phase, error, context)
    if (report) await reportError(report)
  } catch { /* Diagnostic failures must not change the operation or trigger retries. */ }
}
