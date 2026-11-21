import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { usageProjectionRecordValid } from '../src/usage/projection.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'
import { USAGE_STATE_COMPATIBILITY, assertUsageStateCompatibility } from '../src/usage/state-compatibility.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// a479: the body ships before the usage module, so it reads a child with 7 features and one with 8.
async function rows(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-thinking-rows-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = new FeatureSettings({ root, environment: {} })
  const list = await settings.initialize()
  return { list, configurations: Object.fromEntries(list.map(({ id }) => [id, settings.configuration(id)])), epochs: Object.fromEntries(list.map(({ id }) => [id, 0])) }
}
const without = (row, id) => ({ list: row.list.filter(item => item.id !== id), configurations: Object.fromEntries(Object.entries(row.configurations).filter(([key]) => key !== id)),
  epochs: Object.fromEntries(Object.entries(row.epochs).filter(([key]) => key !== id)) })

test('a479: the body accepts a settings list with and without thinkingDisplay, and nothing else missing', async t => {
  const row = await rows(t)
  assert.equal(row.list.length, 8)
  const record = value => ({ type: 'settings', revision: 1, ...value })
  assert.equal(usageProjectionRecordValid(record(row)), true)
  assert.equal(usageProjectionRecordValid(record(without(row, 'thinkingDisplay'))), true)
  assert.equal(usageProjectionRecordValid(record(without(row, 'routing'))), false)
  assert.equal(usageResultValid('settings.list', row.list), true)
  assert.equal(usageResultValid('settings.list', without(row, 'thinkingDisplay').list), true)
  assert.equal(usageResultValid('settings.list', without(row, 'routing').list), false)
  assert.equal(usageResultValid('settings.configuration', { enabled: false }, { id: 'thinkingDisplay' }), true)
  assert.equal(usageResultValid('settings.configuration', { enabled: false, x: '' }, { id: 'thinkingDisplay' }), false)
})

test('a479: the body starts a usage child that predates thinkingDisplay', () => {
  assertUsageStateCompatibility(structuredClone(USAGE_STATE_COMPATIBILITY))
  assertUsageStateCompatibility({ ...USAGE_STATE_COMPATIBILITY, settingsFeatures: USAGE_STATE_COMPATIBILITY.settingsFeatures.slice(0, 7) })
  assert.throws(() => assertUsageStateCompatibility({ ...USAGE_STATE_COMPATIBILITY, settingsFeatures: USAGE_STATE_COMPATIBILITY.settingsFeatures.slice(0, 6) }), { code: 'USAGE_STATE_INCOMPATIBLE' })
})
