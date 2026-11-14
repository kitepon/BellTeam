import test from 'node:test'
import assert from 'node:assert/strict'
import { callBridgeSettingsInput } from '../src/usage/call-bridge-import.mjs'
const ok = { schema: 'call-bridge.connection.v1', url: 'http://192.168.1.2:18910/mcp', token: 'synthetic-token' }
test('exported connection becomes the callBridge settings update input', () => {
  assert.deepEqual(callBridgeSettingsInput(Buffer.from(JSON.stringify(ok) + '\n')),
    { enabled: true, values: { url: ok.url, token: 'synthetic-token' } })
})
test('malformed export is refused without echoing the token', () => {
  for (const value of ['not json', '[]', { ...ok, extra: 1 }, { ...ok, schema: 'call-bridge.connection.v2' }, { ...ok, url: 'http://u:p@h/mcp' },
    { ...ok, url: 'http://h/mcp?x=1' }, { ...ok, url: 'http://h/mcp#f' }, { ...ok, url: 'http://h/other' }, { ...ok, url: 'ftp://h/mcp' },
    { ...ok, token: 'two words' }, { ...ok, token: '' }]) {
    assert.throws(() => callBridgeSettingsInput(typeof value === 'string' ? value : JSON.stringify(value)),
      error => error.code === 'CALL_BRIDGE_IMPORT_INVALID' && !error.message.includes('synthetic-token'))
  }
})
test('the live FeatureSettings accepts the input and keeps the secret out of list()', async () => {
  const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { FeatureSettings } = await import('../src/feature-settings.mjs')
  let applied
  const settings = new FeatureSettings({ root: await mkdtemp(join(tmpdir(), 'call-bridge-import-')), environment: {}, onChange: async (id, config) => { applied = { id, config } } })
  await settings.initialize()
  await settings.update('callBridge', callBridgeSettingsInput(JSON.stringify(ok)), { allowSecretValues: true })
  assert.deepEqual(applied, { id: 'callBridge', config: { enabled: true, url: ok.url, token: 'synthetic-token' } })
  assert.doesNotMatch(JSON.stringify(settings.list()), /synthetic-token/u)
})
