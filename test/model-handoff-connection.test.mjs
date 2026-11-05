import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermClient } from '../src/aiterm-client.mjs'

test('handoff pins the authenticated SDK before awaits and rejects connection replacement without reconnecting', async () => {
  const client = new AitermClient(), transport = {}, sdk = { transport }
  let reconnects = 0
  client.connect = async () => { reconnects++ }
  assert.equal(client.captureHandoffConnection(), null)
  client.client = sdk; client.transport = transport
  const binding = client.captureHandoffConnection()
  assert.equal(binding.expected.sdk, sdk)
  assert.equal(binding.expected.transport, transport)
  assert.deepEqual(binding.currentConnection(), { sdk, transport })
  await Promise.resolve()
  client.client = { transport }; assert.equal(binding.currentConnection(), null)
  client.client = sdk; client.connecting = Promise.resolve(); assert.equal(binding.currentConnection(), null)
  client.connecting = null; client.transport = {}; assert.equal(binding.currentConnection(), null)
  client.transport = transport; sdk.transport = {}; assert.equal(client.captureHandoffConnection(), null)
  assert.equal(reconnects, 0)
})
