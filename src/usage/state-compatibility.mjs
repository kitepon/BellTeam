import { isDeepStrictEqual } from 'node:util'
import { usageError } from './process-schema.mjs'

// Reference sources must not be restored by a version that expects only value files.
export const USAGE_STATE_COMPATIBILITY = Object.freeze({
  settingsFeatures: Object.freeze(['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush', 'onePassword', 'thinkingDisplay']),
  onboardingSchema: 'bellteam.onboarding.v1', subscriptionSchema: 'bellteam.subscription.v1',
  requestEncoding: 'json-files', secretEncoding: 'stored-or-private-reference-v2', handoffSchema: 'bellteam.usage-volatile.v1',
})
// a479 / a487n: the body ships before the usage module, so a child that predates thinkingDisplay, or that has dropped webPush, must still start.
// shortcut: the optional ids are the two that moved; drop this when every shipped usage module has the same list.
const OPTIONAL_FEATURES = ['webPush', 'thinkingDisplay']
const settingsFeaturesAccepted = list => Array.isArray(list)
  && isDeepStrictEqual(list.filter(id => !OPTIONAL_FEATURES.includes(id)), USAGE_STATE_COMPATIBILITY.settingsFeatures.filter(id => !OPTIONAL_FEATURES.includes(id)))
  && isDeepStrictEqual(list, USAGE_STATE_COMPATIBILITY.settingsFeatures.filter(id => list.includes(id)))
export function assertUsageStateCompatibility(value) {
  if (!value || typeof value !== 'object' || !settingsFeaturesAccepted(value.settingsFeatures)
    || !isDeepStrictEqual({ ...value, settingsFeatures: null }, { ...USAGE_STATE_COMPATIBILITY, settingsFeatures: null })) throw usageError('USAGE_STATE_INCOMPATIBLE')
}
