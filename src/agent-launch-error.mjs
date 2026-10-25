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
