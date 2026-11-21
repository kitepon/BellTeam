import assert from 'node:assert/strict'
import test from 'node:test'
import { assertUsageStateCompatibility, USAGE_STATE_COMPATIBILITY } from '../src/usage/state-compatibility.mjs'
import { usageFeatureIdsValid } from '../src/usage/projection.mjs'
import { usageHandoffValid } from '../src/usage/services.mjs'
import { notificationsReadyValid } from '../src/notifications-ipc.mjs'

// a487n stage 1: webPush is leaving. Every reader accepts the shipped shape (with webPush) and the shape without it,
// before any writer stops sending it (module-ipc.md "Records between halves that ship apart").
const all = USAGE_STATE_COMPATIBILITY.settingsFeatures
const without = (...ids) => all.filter(id => !ids.includes(id))

test('the usage state compatibility accepts every combination of the two optional features and nothing else', () => {
  for (const list of [all, without('webPush'), without('thinkingDisplay'), without('webPush', 'thinkingDisplay')]) {
    assertUsageStateCompatibility({ ...USAGE_STATE_COMPATIBILITY, settingsFeatures: list })
  }
  for (const list of [without('onePassword'), without('routing', 'webPush'), [...all].reverse(), [...all, 'extra']]) {
    assert.throws(() => assertUsageStateCompatibility({ ...USAGE_STATE_COMPATIBILITY, settingsFeatures: list }), { code: 'USAGE_STATE_INCOMPATIBLE' })
  }
  assert.throws(() => assertUsageStateCompatibility({ ...USAGE_STATE_COMPATIBILITY, secretEncoding: 'utf8-exclusive-0600' }), { code: 'USAGE_STATE_INCOMPATIBLE' })
})

test('the settings list check accepts a list without webPush, still refuses one missing a core feature', () => {
  assert.equal(usageFeatureIdsValid(all), true)
  assert.equal(usageFeatureIdsValid(without('webPush')), true)
  assert.equal(usageFeatureIdsValid(without('webPush', 'thinkingDisplay')), true)
  assert.equal(usageFeatureIdsValid(without('routing')), false)
})

test('a usage handoff with or without webPush epochs is read; a missing core epoch is refused', () => {
  const handoff = ids => ({ schema: 'bellteam.usage-volatile.v1', epochs: ids.map(id => [id, 0]), errors: [], sessions: [], receipts: [], onboardingAuth: null })
  assert.equal(usageHandoffValid(handoff(all)), true)
  assert.equal(usageHandoffValid(handoff(without('webPush'))), true)
  assert.equal(usageHandoffValid(handoff(without('webPush', 'thinkingDisplay'))), true)
  assert.equal(usageHandoffValid(handoff(without('routing'))), false)
})

test('the notifications ready answer is read with and without webPush in status and applyError', () => {
  const apns = { configured: false, environments: [] }
  const web = { enabled: false, configured: false, publicKey: null, error: null }
  assert.equal(notificationsReadyValid({ status: { apns, webPush: web }, applyError: { apns: null, webPush: null } }), true)
  assert.equal(notificationsReadyValid({ status: { apns }, applyError: { apns: null } }), true)
  assert.equal(notificationsReadyValid({ status: { apns }, applyError: { apns: 'PUSH_CONFIGURATION_FAILED' } }), true)
  assert.equal(notificationsReadyValid({ status: { webPush: web }, applyError: { apns: null } }), false)
  assert.equal(notificationsReadyValid({ status: { apns }, applyError: { apns: null, other: null } }), false)
})
