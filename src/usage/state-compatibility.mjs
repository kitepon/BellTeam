import { isDeepStrictEqual } from 'node:util'
import { usageError } from './process-schema.mjs'

// These are the existing formats; no new on-disk schema or migration is introduced.
export const USAGE_STATE_COMPATIBILITY = Object.freeze({
  settingsFeatures: Object.freeze(['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications', 'webPush']),
  onboardingSchema: 'bellteam.onboarding.v1', subscriptionSchema: 'bellteam.subscription.v1',
  requestEncoding: 'json-files', secretEncoding: 'utf8-exclusive-0600', handoffSchema: 'bellteam.usage-volatile.v1',
})
export function assertUsageStateCompatibility(value) {
  if (!isDeepStrictEqual(value, USAGE_STATE_COMPATIBILITY)) throw usageError('USAGE_STATE_INCOMPATIBLE')
}
