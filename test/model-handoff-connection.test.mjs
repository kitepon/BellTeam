import test from 'node:test'
import assert from 'node:assert/strict'
import { AitermClient } from '../src/aiterm-client.mjs'

// bd05: Aiterm never released model-handoff-*; without a capture connection ModelHandoff.prepare returns null (dormant).
test('the Aiterm client offers no handoff capture, so BellTeam loads no unreleased Aiterm file', () => {
  const client = new AitermClient()
  client.client = { transport: {} }; client.transport = client.client.transport
  assert.equal(client.captureHandoffConnection, undefined)
})
