import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { usageTools } from '../src/usage/mcp-tools.mjs'

test('valid legacy five-feature settings migrate losslessly to Web OFF and persist without credentials in public output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new FeatureSettings({ root, environment: { TYPESAFE_API_KEY: 'synthetic-existing-typesafe' } })
  await first.initialize()
  const legacy = JSON.parse(await readFile(first.path))
  delete legacy.webPush
  await writeFile(first.path, JSON.stringify(legacy))
  const restored = new FeatureSettings({ root, environment: {} })
  await restored.initialize()
  const saved = JSON.parse(await readFile(restored.path))
  assert.deepEqual(saved.webPush, { enabled: false, subject: '' })
  delete saved.webPush
  assert.deepEqual(saved, legacy)
  assert.deepEqual(restored.configuration('routing'), first.configuration('routing'))
  assert.doesNotMatch(JSON.stringify(restored.list()), /synthetic-existing-typesafe/u)
  const tools = usageTools((properties, required) => ({ properties, required }))
  assert.deepEqual(tools.find(tool => tool.name === 'update_settings').inputSchema.properties.featureId.enum,
    ['routing', 'callBridge', 'cloudflare', 'diagnostics', 'notifications'])
})

test('unknown/malformed legacy settings never migrate, Web enable requires contact, and saved apply failure is retained', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-settings-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const valid = JSON.parse(await readFile(settings.path))
  const legacy = { ...valid }; delete legacy.webPush
  for (const bad of [{ ...legacy, unknown: { enabled: false } }, { ...legacy, routing: { enabled: false } },
    { ...valid, webPush: { enabled: false, subject: '', privateKey: 'forbidden' } }]) {
    const bytes = JSON.stringify(bad)
    await writeFile(settings.path, bytes)
    await assert.rejects(new FeatureSettings({ root, environment: {} }).initialize(), { code: 'FEATURE_SETTINGS_INVALID' })
    assert.equal(await readFile(settings.path, 'utf8'), bytes)
  }
  await writeFile(settings.path, JSON.stringify(valid))
  await assert.rejects(settings.update('webPush', { enabled: true }), { code: 'FEATURE_UNCONFIGURED' })
  for (const subject of [' ', 'mailto:', 'https://user:secret@example.com/', 'https://example.com/#fragment']) {
    await assert.rejects(settings.update('webPush', { values: { subject } }), { code: 'FEATURE_VALUE_INVALID' })
  }
  settings.onChange = async () => { throw Object.assign(new Error('synthetic error'), { code: 'WEB_PUSH_KEY_SAVE_FAILED' }) }
  await assert.rejects(settings.update('webPush', { enabled: true, values: { subject: 'mailto:operator@example.com' } }), { code: 'FEATURE_APPLY_FAILED' })
  assert.deepEqual(settings.configuration('webPush'), { enabled: true, subject: 'mailto:operator@example.com' })
  assert.equal(settings.list().find(value => value.id === 'webPush').error.code, 'WEB_PUSH_KEY_SAVE_FAILED')
  assert.deepEqual(JSON.parse(await readFile(settings.path)).webPush, settings.configuration('webPush'))
})
