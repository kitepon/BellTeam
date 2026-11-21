import { isDeepStrictEqual } from 'node:util'
import { usageError } from './process-schema.mjs'

// Reference sources must not be restored by a version that expects only value files.
export const USAGE_STATE_COMPATIBILITY = Object.freeze({
  settingsFeatures: Object.freeze(['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush', 'onePassword', 'thinkingDisplay']),
  onboardingSchema: 'bellteam.onboarding.v1', subscriptionSchema: 'bellteam.subscription.v1',
  requestEncoding: 'json-files', secretEncoding: 'stored-or-private-reference-v2', handoffSchema: 'bellteam.usage-volatile.v1',
})
// a479: the body ships before the usage module, so a child that predates thinkingDisplay must still start. shortcut: drop when every shipped usage module has it.
const BEFORE_THINKING_DISPLAY = Object.freeze({ ...USAGE_STATE_COMPATIBILITY, settingsFeatures: Object.freeze(USAGE_STATE_COMPATIBILITY.settingsFeatures.slice(0, 7)) })
export function assertUsageStateCompatibility(value) {
  if (!isDeepStrictEqual(value, USAGE_STATE_COMPATIBILITY) && !isDeepStrictEqual(value, BEFORE_THINKING_DISPLAY)) throw usageError('USAGE_STATE_INCOMPATIBLE')
}
