import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-client.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { authenticationPreflightFailure, baseHarness } from '../src/agent-launch-error.mjs'

// remote-seat.md "Claude machine mode": machine mode is Aiterm's harness claude-machine (Elegg a471-harness-split).
test('the client asks the container Aiterm for the harness before it sends anything', async () => {
  const client = new AitermClient()
  let sent = 0
  client.client = { request: async () => ({ tools: [{ name: 'agent_launch', inputSchema: { properties: { harness: { enum: ['claude-code', 'codex-cli'] } } } }] }), callTool: async () => { sent++ } }
  await assert.rejects(client.call('agent_launch', { harness: 'claude-machine', session_name: 's' }), { code: 'AGENT_HARNESS_UNAVAILABLE', effect: 'not_started' })
  assert.equal(sent, 0)
  client.client.request = async () => ({ tools: [{ name: 'agent_launch', inputSchema: { properties: { harness: { enum: ['claude-code', 'claude-machine'] } } } }] })
  client.client.callTool = async () => { sent++; return { content: [], structuredContent: { schema: 'aiterm.agent-launch-result.v1', harness: 'claude-machine' } } }
  assert.equal((await client.call('agent_launch', { harness: 'claude-machine', session_name: 's' })).structuredContent.harness, 'claude-machine')
  assert.equal(sent, 1)
})

test('validators of an Aiterm value read claude-machine as claude-code', () => {
  assert.deepEqual([baseHarness('claude-machine'), baseHarness('claude-code'), baseHarness('codex-cli'), baseHarness(undefined)], ['claude-code', 'claude-code', 'codex-cli', undefined])
  const error = harness => ({ schema: 'aiterm.agent-launch-error.v1', harness, code: 'CLAUDE_AUTH_NOT_AUTHENTICATED', phase: 'authentication_preflight', effect: 'not_issued', session_created: false })
  assert.equal(authenticationPreflightFailure(error('claude-machine'))?.code, 'CLAUDE_AUTH_NOT_AUTHENTICATED')
  assert.equal(authenticationPreflightFailure(error('codex-cli')), null)
})

test('a restart resumes a machine seat with the machine harness and a TUI seat with its own', async () => {
  for (const [machine, expected] of [[true, 'claude-machine'], [false, 'claude-code']]) {
    const launched = []
    const transport = new AitermTransport({ runtimeLaunchesPath: '/nowhere/runtime-launches.json', captureRuntime: async () => ({ generation: 'g' }),
      client: { launchOptions: async () => ({}), async call(name, args) {
        launched.push([name, args.harness])
        return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name, startup: { status: 'ready' }, initial_prompt: { status: 'not_requested' } } }
      } } })
    transport.runtimeLaunches = { 'bot-m': machine ? { machine: true, harness: 'claude-code' } : { harness: 'claude-code' } }
    const bot = { id: 'bot-m', session: 'bot-m', harness: 'claude', project: '/tmp' }
    await transport.resumePreviouslyActive(bot, { harness: 'claude-code', sessionId: 'bot-m', launchId: 'a'.repeat(32) })
    assert.deepEqual(launched, [['agent_launch', expected]])
    await transport.close?.()
  }
})
