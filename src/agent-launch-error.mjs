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

export function unpromptedLaunchActionRequired(value, args) {
  return value?.schema === 'aiterm.agent-launch-result.v1' && value.harness === 'antigravity-cli'
    && args.harness === value.harness && typeof args.session_name === 'string' && args.session_name.length > 0
    && value.session_id === args.session_name && args.prompt == null
    && (args.image == null || Array.isArray(args.image) && args.image.length === 0)
    && args.throughline_source_session == null && args.throughline_supplement_file == null
    && value.startup?.status === 'blocked' && value.startup.reason === 'vendor_action_required'
    && value.initial_prompt?.status === 'not_requested' && value.initial_prompt.reason === 'not_requested'
    && value.initial_prompt.turn_started === false && value.event_cursor === null && value.submit_residue === null
}

// The session was created, but the business message was never requested. Keep only safe native enums.
export function launchFailureDetails(error) {
  const value = error?.launch
  if (error?.launchActionRequired !== true
    || !unpromptedLaunchActionRequired(value, { harness: value?.harness, session_name: value?.session_id })) return null
  return { harness: value.harness, session_created: true,
    startup: { status: 'blocked', reason: 'vendor_action_required' },
    initial_prompt: { status: 'not_requested', reason: 'not_requested', turn_started: false } }
}
