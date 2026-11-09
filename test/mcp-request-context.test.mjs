import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { captureMcpRequest, mcpRequestContext } from '../src/mcp-request-context.mjs'

const bot = { id: 'bot-fixture', session: 'fixture', harness: 'codex', project: process.cwd() }
for (const [label, error] of [
  ['SDK timeout', new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: 60000 })],
  ['connection closed', Object.assign(new Error('closed'), { code: -32000 })],
  ['frozen SDK error', Object.freeze(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))],
  ['metadata setter throws', Object.defineProperty(new Error('closed'), 'mcp_request', { set() { throw Error('cannot annotate') } })],
]) {
  test(`${label}: one send, no wake or state probe, identical exception`, async () => {
    const stack = error.stack, code = error.code
    let sends = 0, wakes = 0, probes = 0
    const client = new AitermClient()
    client.client = { async callTool({ name }) { assert.equal(name, 'pty_send'); sends++; throw error } }
    const transport = new AitermTransport({ client, handoffContext: async () => '' })
    transport.isRunning = async () => { probes++; return false }
    transport.wake = async () => { wakes++; throw Error('must not wake') }
    await assert.rejects(transport.turn(bot, 'private-canary-input'), actual => actual === error)
    assert.deepEqual([sends, wakes, probes], [1, 0, 0])
    assert.equal(error.stack, stack)
    assert.equal(error.code, code)
    assert.deepEqual(mcpRequestContext(error), { phase: 'call', tool: 'pty_send', outcome: 'unknown' })
    assert.equal(error.aitermResponseReturned, undefined)
  })
}

test('connection failure precedes call and carries no outcome', async () => {
  const client = new AitermClient(), error = new Error('connect')
  let calls = 0
  client.connect = async () => { throw error }
  client.client = { callTool() { calls++ } }
  await assert.rejects(client.call('pty_send', { message: 'canary' }), actual => actual === error)
  assert.equal(calls, 0)
  assert.deepEqual(mcpRequestContext(error), { phase: 'connect', tool: 'pty_send' })
})

test('returned refusal remains returned; explicit not-sent recovery still runs once', async () => {
  let sends = 0, wakes = 0
  const client = new AitermClient()
  client.client = { async callTool({ name }) {
    // The recovery's own observation (delivery-details.md wake-first) is not a send.
    if (name === 'pty_observe') return { content: [], structuredContent: { exists: false } }
    if (++sends === 1) return { isError: true, content: [{ type: 'text', text:
      'aiterm: AGENT_SESSION_REQUIRED: 文字列は送信していません。' }] }
    return { content: [], structuredContent: { mode: 'agent_steer' } }
  } }
  const first = await client.call('pty_send').catch(error => error)
  assert.equal(first.aitermResponseReturned, true)
  assert.equal(first.code, 'AGENT_SESSION_REQUIRED')
  assert.equal(mcpRequestContext(first), null)
  sends = 0
  const transport = new AitermTransport({ client, handoffContext: async () => '' })
  transport.isRunning = async () => false
  transport.wake = async () => { wakes++; return bot.session }
  const result = await transport.dispatch(bot, 'canary', [])
  assert.equal(result.receipt.mode, 'agent_steer')
  assert.deepEqual([sends, wakes], [2, 1])
})

test('normal success is unchanged', async () => {
  const client = new AitermClient(), response = { content: [] }
  client.client = { async callTool() { return response } }
  assert.equal(await client.call('pty_list'), response)
})

test('strict metadata validation excludes unknown tools, extra fields and secrets', async () => {
  const valid = { phase: 'call', tool: 'pty_send', outcome: 'unknown' }
  for (const value of [null, {}, { ...valid, tool: 'private-canary' },
    { ...valid, args: 'canary' }, { ...valid, meta: 'canary' }, { ...valid, id: 'canary' },
    { ...valid, message: 'canary' }, { ...valid, outcome: 'not_sent' },
    { phase: 'connect', tool: 'pty_send', outcome: 'unknown' },
    { phase: 'unknown', tool: 'pty_send' }, { ...valid, [Symbol('canary')]: true }]) {
    assert.equal(mcpRequestContext({ mcp_request: value }), null)
  }
  const error = new Error('private-canary')
  captureMcpRequest(error, 'call', 'pty_send')
  error.mcp_request.args = 'private-canary'
  const context = mcpRequestContext(error)
  assert.deepEqual(context, valid)
  context.tool = 'private-canary'
  assert.deepEqual(mcpRequestContext(error), valid)
  const client = new AitermClient()
  client.client = { async callTool() { throw new Error('private-canary') } }
  await assert.rejects(client.call('unknown-canary', { secret: 'private-canary' }), actual =>
    mcpRequestContext(actual) === null && !Object.hasOwn(actual, 'mcp_request'))
})


test('short-lived seat launch transfers only the request context with the original RPC code',
  { timeout: 5000, skip: process.getuid?.() !== 1000 || process.getgid?.() !== 1000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bellteam-request-launch-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const server = join(root, 'fixture.mjs')
    await writeFile(server, String.raw`import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const response = request.method === 'initialize'
    ? { result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }
    : { error: { code: -32001, message: 'fixture response unknown' } }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n')
})`)
    const child = spawn(process.execPath, [new URL('../src/run-seat-aiterm-launch.mjs', import.meta.url).pathname],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.stdin.end(JSON.stringify({ command: process.execPath, args: [server], launch: { cwd: root, prompt: 'private-canary' } }))
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, stderr)
    const { error } = JSON.parse(stdout)
    assert.equal(error.code, -32001)
    assert.equal(error.aitermResponseReturned, undefined)
    assert.deepEqual(mcpRequestContext(error), { phase: 'call', tool: 'agent_launch', outcome: 'unknown' })
    assert.equal(JSON.stringify(error.mcp_request).includes('private-canary'), false)
  })
