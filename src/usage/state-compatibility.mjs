import { isDeepStrictEqual } from 'node:util'
import { usageError } from './process-schema.mjs'

// Reference sources must not be restored by a version that expects only value files.
// a487n stage 2: webPush is gone from what the child writes; the readers below still accept a child that has it (a rolled-back usage module).
const FEATURES_IN_ORDER = ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush', 'onePassword', 'thinkingDisplay']
export const USAGE_STATE_COMPATIBILITY = Object.freeze({
  settingsFeatures: Object.freeze(FEATURES_IN_ORDER.filter(id => id !== 'webPush' && id !== 'onePassword')),
  onboardingSchema: 'bellteam.onboarding.v1', subscriptionSchema: 'bellteam.subscription.v1',
  requestEncoding: 'json-files', secretEncoding: 'stored-or-private-reference-v2', handoffSchema: 'bellteam.usage-volatile.v1',
})
// a479 / a487n: the body ships before the usage module, so a child that predates thinkingDisplay, or that still has webPush, must still start.
// shortcut: the optional ids are the two that moved; drop webPush from the readers when no shipped usage module has it.
// 2026-11-27: onePassword left the Settings; a child that still has it (a rolled-back usage module) is accepted too.
const OPTIONAL_FEATURES = ['webPush', 'onePassword', 'thinkingDisplay']
const settingsFeaturesAccepted = list => Array.isArray(list)
  && isDeepStrictEqual(list.filter(id => !OPTIONAL_FEATURES.includes(id)), FEATURES_IN_ORDER.filter(id => !OPTIONAL_FEATURES.includes(id)))
  && isDeepStrictEqual(list, FEATURES_IN_ORDER.filter(id => list.includes(id)))
export function assertUsageStateCompatibility(value) {
  if (!value || typeof value !== 'object' || !settingsFeaturesAccepted(value.settingsFeatures)
    || !isDeepStrictEqual({ ...value, settingsFeatures: null }, { ...USAGE_STATE_COMPATIBILITY, settingsFeatures: null })) throw usageError('USAGE_STATE_INCOMPATIBLE')
}
