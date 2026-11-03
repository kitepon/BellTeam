import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-client.mjs'
import { mcpRequestContext } from '../src/mcp-request-context.mjs'

test('send admission is rechecked after async connect and before any SDK issuance', async () => {
  const client = new AitermClient(), original = Error('superseded')
  let ready = true, calls = 0
  client.connect = async () => { ready = false; client.client = { callTool: async () => { calls++ } } }
  await assert.rejects(client.call('pty_send', {}, { admissionCheck: () => { if (!ready) throw original } }), error => error === original)
  assert.equal(calls, 0)
  assert.equal(mcpRequestContext(original), null)
})

test('post-admission RPC rejection remains unknown with no retry and no guard serialization', async () => {
  const client = new AitermClient(), original = Error('lost reply')
  let calls = 0, checks = 0
  client.client = { callTool: async request => { calls++; assert.deepEqual(Object.keys(request).sort(), ['arguments', 'name']); throw original } }
  await assert.rejects(client.call('pty_send', {}, { admissionCheck: () => { checks++ } }), error => error === original)
  assert.equal(calls, 1); assert.equal(checks, 1)
  assert.deepEqual(mcpRequestContext(original), { phase: 'call', tool: 'pty_send', outcome: 'unknown' })
})

test('send guard cannot cross launch, dynamic environment or another tool boundary', async () => {
  const client = new AitermClient(); let connects = 0
  client.connect = async () => { connects++ }
  for (const [name, options] of [['agent_configure', { admissionCheck() {} }], ['pty_send', { admissionCheck: true }],
    ['pty_send', { admissionCheck() {}, env: {} }], ['pty_send', { admissionCheck() {}, launchProject: '/any' }]])
    await assert.rejects(client.call(name, {}, options), { code: 'AITERM_SEND_GUARD_INVALID', effect: 'not_issued' })
  assert.equal(connects, 0)
})
