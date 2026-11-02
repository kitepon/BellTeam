import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-client.mjs'
import { mcpRequestContext } from '../src/mcp-request-context.mjs'

const binding = { session_id: 'auth-fixture', launch_id: 'a'.repeat(32), metadata_identity: 'synthetic-metadata',
  native_id: 'native-fixture', pane_id: 'pane-fixture', server_pid: 100, server_started: 'server-start',
  pane_pid: 101, pane_started: 'pane-start' }

for (const action of ['status', 'cancel', 'respond']) {
  for (const effect of ['not_issued', 'unknown']) {
    test(`agent_auth ${action} ${effect} keeps the original typed error result`, async () => {
      const failure = action === 'respond'
        ? { schema: 'aiterm.auth-response-error.v1', harness: 'claude-code', session_id: 'auth-fixture',
          code: 'AUTH_STAGE_CHANGED', effect, message: 'synthetic refusal' }
        : { schema: 'aiterm.auth-operation-error.v1', harness: 'claude-code', session_id: 'auth-fixture',
          action, code: effect === 'not_issued' ? 'AGENT_AUTH_OPERATION_NOT_ISSUED' : 'AGENT_AUTH_OPERATION_UNKNOWN', effect }
      const result = { isError: true, content: [{ type: 'text', text: 'synthetic refusal' }], structuredContent: failure }
      const client = new AitermClient({ command: 'must-not-spawn', env: {} }), calls = []
      client.client = { async callTool(request) { calls.push(request); return result } }
      const args = { harness: 'claude-code', action, session_id: 'auth-fixture', expected_binding: binding }
      const returned = await client.call('agent_auth', args)
      assert.equal(returned, result)
      assert.equal(returned.structuredContent, failure)
      assert.equal(returned.isError, true)
      assert.deepEqual(calls, [{ name: 'agent_auth', arguments: args }])
    })
  }
}

test('recognized auth schema remains raw for strict consumer validation', async () => {
  const result = { isError: true, content: [], structuredContent: {
    schema: 'aiterm.auth-operation-error.v1', harness: 'wrong-harness', session_id: 'wrong-session',
    action: 'start', code: 'UNEXPECTED', effect: 'invalid', extra: true,
  } }
  const client = new AitermClient({ command: 'must-not-spawn', env: {} })
  client.client = { async callTool() { return result } }
  assert.equal(await client.call('agent_auth', { harness: 'claude-code', action: 'status', session_id: 'auth-fixture', expected_binding: binding }), result)
})

for (const schema of ['aiterm.auth-response-error.v1', 'aiterm.auth-operation-error.v1']) {
  test(`${schema} on another tool remains a generic returned failure`, async () => {
    const client = new AitermClient({ command: 'must-not-spawn', env: {} })
    client.client = { async callTool() { return { isError: true, content: [], structuredContent: { schema } } } }
    await assert.rejects(client.call('pty_list'), error => {
      assert.equal(error.aitermResponseReturned, true)
      assert.equal(mcpRequestContext(error), null)
      return true
    })
  })
}

for (const structuredContent of [undefined, { schema: 'aiterm.auth-operation-error.v2' }]) {
  test(`unrecognized agent_auth failure ${structuredContent?.schema ?? 'without schema'} still throws`, async () => {
    const client = new AitermClient({ command: 'must-not-spawn', env: {} })
    client.client = { async callTool() { return { isError: true, content: [], structuredContent } } }
    await assert.rejects(client.call('agent_auth', { action: 'status' }), error => {
      assert.equal(error.message, 'AITERM_TOOL_FAILED: agent_auth')
      assert.equal(error.aitermResponseReturned, true)
      assert.equal(error.mcp_error, undefined)
      return true
    })
  })
}

test('agent_auth RPC failure keeps the original unknown exception and calls once', async () => {
  const client = new AitermClient({ command: 'must-not-spawn', env: {} }), failure = new Error('synthetic disconnect')
  let calls = 0
  client.client = { async callTool() { calls++; throw failure } }
  await assert.rejects(client.call('agent_auth', { action: 'cancel' }), error => error === failure)
  assert.equal(calls, 1)
  assert.equal(failure.aitermResponseReturned, undefined)
  assert.deepEqual(mcpRequestContext(failure), { phase: 'call', tool: 'agent_auth', outcome: 'unknown' })
})

test('successful auth receipt is unchanged', async () => {
  const client = new AitermClient({ command: 'must-not-spawn', env: {} })
  const result = { content: [], structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting' } }
  client.client = { async callTool() { return result } }
  assert.equal(await client.call('agent_auth', { action: 'status' }), result)
})
