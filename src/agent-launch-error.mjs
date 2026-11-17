// Nativeが起動前に返した認証拒否だけを保持する。状態本文や資格は扱わない。
export const authenticationPreflightCodes = [
  'CLAUDE_AUTH_NOT_AUTHENTICATED',
  'CLAUDE_AUTH_STATUS_UNCONFIRMED',
  'CLAUDE_AUTH_STATUS_TIMEOUT',
]

export function authenticationPreflightFailure(value) {
  if (value?.schema !== 'aiterm.agent-launch-error.v1' || value.harness !== 'claude-code'
    || !authenticationPreflightCodes.includes(value.code) || value.phase !== 'authentication_preflight'
    || value.effect !== 'not_issued' || value.session_created !== false) return null
  return { schema: value.schema, harness: value.harness, code: value.code,
    phase: value.phase, effect: value.effect, session_created: false }
}

// Aiterm >= 0.70.5 R19: a refused call's leading symbolic code (reason only, never the effect), so callers need not parse text.
export const ERROR_CODE_META = 'aiterm/error_code'
export function errorCode(value) {
  return value?.schema === 'aiterm.error-code.v1' && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value.code) ? value.code : null
}

// Aiterm >= 0.70.0 (c493df6, Elegg): a launch refused before any seat exists carries this in result._meta (in _meta because
// the SDK validates structuredContent even on isError). Codes that may have started get none, so its shape is the proof.
export const LAUNCH_ERROR_META = 'aiterm/launch_error'
export function launchRefusal(value) {
  if (value?.schema !== 'aiterm.agent-launch-error.v1' || typeof value.harness !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.harness)
    || typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.code)
    || !['terminal', 'native_create', 'authentication_preflight', 'input'].includes(value.phase) || !['not_started', 'not_issued'].includes(value.effect)
    || value.session_created !== false || typeof value.action !== 'string' || !value.action.trim() || value.action.length > 500
    || /[\u0000-\u001f\u007f]/u.test(value.action)) return null
  return { schema: value.schema, harness: value.harness, code: value.code, phase: value.phase, effect: value.effect,
    session_created: false, action: value.action.trim() }
}

export function resumeUnavailable(value, sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(sessionId) && value
    && Object.keys(value).sort().join(',') === 'code,effect,input,outcome,schema,session_id'
    && value.schema === 'aiterm.agent-resume-unavailable.v1' && value.code === 'AGENT_RESUME_UNAVAILABLE'
    && value.session_id === sessionId && value.outcome === 'unavailable' && value.effect === 'not_started' && value.input === 'not_sent'
    ? { ...value } : null
}

// Aiterm's native_reason symbols (tmux-runtime nativeTargetUnavailable 0.70.58, refusal classes 0.70.59).
// shortcut: a symbol Aiterm adds later reads as null, add it here when one appears.
const NATIVE_REASONS = new Set(['enclosing_target_differs', 'native_condition_refused', 'nested_creation', 'new_session_not_admitted',
  'receipt_name_differs', 'receipt_not_expected', 'send_target_differs', 'native_pane_gone', 'native_identity_changed',
  'native_pane_exited', 'native_creation_marker_changed', 'native_condition_unevaluated'])

// delivery-details.md (kiro-launch-fail-rapi): only Aiterm's closed tokens leave a refusal Aiterm answered; its text may hold private values.
export function aitermFailureCause(error) {
  const returned = error?.aitermResponseReturned === true
  const text = returned ? String(error?.message ?? '') : ''
  const cause = error?.aitermErrorCode ?? /^(?:aiterm: )?([A-Z][A-Z0-9_]{2,63}):/u.exec(text)?.[1] ?? null
  const reason = /\bnative_reason=([a-z_]{1,64})\b/u.exec(text)?.[1]
  return { cause, native_reason: NATIVE_REASONS.has(reason) ? reason : null }
}
