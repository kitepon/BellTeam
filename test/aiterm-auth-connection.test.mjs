import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-client.mjs'
import { authTool } from './helpers/auth-capability.mjs'
import { createOlrwRabbitAuth } from '../src/olrw-rabbit-auth.mjs'
import { mcpRequestContext } from '../src/mcp-request-context.mjs'

const version = 'synthetic-version'
async function fixture() {
  const client = new AitermClient({ command: 'must-not-spawn', env: {} })
  const transport = { pid: 123 }, result = { content: [], structuredContent: { status: 'waiting' } }, calls = []
  const sdk = { transport, listTools: async () => ({ tools: [authTool()] }), getServerVersion: () => ({ name: 'aiterm', version }),
    async callTool(request) { assert.equal(this, sdk); calls.push(request); return result } }
  const counts = { connect: 0 }
  client.client = sdk
  client.transport = transport
  client.connect = async () => {}
  await client.prepareAuthConnection()
  client.connect = async () => { counts.connect++; throw new Error('must not connect') }
  return { client, sdk, transport, result, calls, counts,
    options: { expectedAuthConnection: sdk } }
}

async function refused(f, options, code, name = 'agent_auth') {
  await assert.rejects(f.client.call(name, { action: 'status' }, options), error => {
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(error.effect, 'not_issued')
    assert.equal(error.aitermResponseReturned, undefined)
    assert.equal(mcpRequestContext(error), null)
    return true
  })
  assert.equal(f.counts.connect, 0)
  assert.equal(f.calls.length, 0)
}

test('bound auth checks prepared capability and calls the same SDK once without connect', async () => {
  const f = await fixture(), args = { action: 'status', session_id: 'synthetic-auth' }, meta = { test: 'synthetic' }
  assert.equal(await f.client.call('agent_auth', args, { ...f.options, meta }), f.result)
  assert.deepEqual(f.calls, [{ name: 'agent_auth', arguments: args, _meta: meta }])
  assert.equal(f.counts.connect, 0)
})

for (const [label, server] of [
  ['missing initialize info', undefined],
  ['wrong server name', { name: 'another-server', version }],
]) test(`${label} refuses before auth RPC`, async () => {
  const f = await fixture()
  f.sdk.getServerVersion = () => server
  await refused(f, f.options, 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
})

for (const [label, change] of [
  ['closed client', f => { f.client.client = null }],
  ['replacement SDK', f => { f.client.client = { ...f.sdk } }],
  ['closed transport', f => { f.client.transport = null }],
  ['closed stdio process', f => { f.transport.pid = null }],
  ['missing stdio process', f => { delete f.transport.pid }],
  ['invalid stdio process', f => { f.transport.pid = 0 }],
  ['SDK transport detached', f => { f.sdk.transport = undefined }],
  ['different SDK transport', f => { f.sdk.transport = {} }],
  ['initialize still pending', f => { f.client.connecting = Promise.resolve() }],
  ['serialized reference', f => { f.options.expectedAuthConnection = JSON.parse(JSON.stringify(f.sdk)) }],
]) test(`${label} never reconnects or sends`, async () => {
  const f = await fixture()
  change(f)
  await refused(f, f.options, 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
})

for (const [label, options, name] of [
  ['another tool', f => f.options, 'pty_list'],
  ['short-lived env', f => ({ ...f.options, env: {} })],
  ['explicit undefined env', f => ({ ...f.options, env: undefined })],
  ['launchProject', f => ({ ...f.options, launchProject: '/synthetic' })],
  ['version alone', () => ({ expectedAuthServerVersion: version })],
  ['empty connection', () => ({ expectedAuthConnection: null })],
  ['empty expected version', f => ({ ...f.options, expectedAuthServerVersion: '' })],
  ['non-string expected version', f => ({ ...f.options, expectedAuthServerVersion: 1 })],
]) test(`${label} rejects the auth options before any connection`, async () => {
  const f = await fixture()
  await refused(f, options(f), 'AITERM_AUTH_CONNECTION_ARGUMENTS', name)
})

test('disconnect after initial capability check cannot start a replacement MCP on the next call', async () => {
  const f = await fixture()
  assert.deepEqual(f.sdk.getServerVersion(), { name: 'aiterm', version })
  f.client.client = null
  f.client.transport = null
  f.client.connect = async () => { f.counts.connect++; f.client.client = f.sdk; f.client.transport = f.transport }
  await refused(f, f.options, 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
})

test('call uses the captured SDK reference instead of reading a replacement after identity lookup', async () => {
  const f = await fixture()
  let replacements = 0
  f.sdk.getServerVersion = () => {
    f.client.client = { async callTool() { replacements++; throw new Error('wrong SDK') } }
    return { name: 'aiterm', version }
  }
  assert.equal(await f.client.call('agent_auth', {}, f.options), f.result)
  assert.equal(f.calls.length, 1)
  assert.equal(replacements, 0)
  assert.equal(f.counts.connect, 0)
})

test('disconnect during bound call keeps the original unknown exception without reconnect or resend', async () => {
  const f = await fixture(), failure = new Error('synthetic disconnect')
  f.sdk.callTool = async request => {
    f.calls.push(request)
    f.client.client = null
    f.client.transport = null
    throw failure
  }
  await assert.rejects(f.client.call('agent_auth', {}, f.options), error => error === failure)
  assert.equal(f.calls.length, 1)
  assert.equal(f.counts.connect, 0)
  assert.equal(failure.aitermResponseReturned, undefined)
  assert.deepEqual(mcpRequestContext(failure), { phase: 'call', tool: 'agent_auth', outcome: 'unknown' })
})

test('legacy call still connects and does not require initialize version metadata', async () => {
  const f = await fixture()
  f.client.connect = async () => { f.counts.connect++ }
  f.sdk.getServerVersion = () => { throw new Error('must not inspect version') }
  assert.equal(await f.client.call('pty_list'), f.result)
  assert.equal(f.counts.connect, 1)
  assert.equal(f.calls.length, 1)
})

test('auth capability accepts compatible releases and refuses incompatible or replaced connections', async () => {
  function make(version, tool = authTool()) {
    const client = new AitermClient({ command: 'must-not-spawn', env: {} }), calls = []
    let connects = 0, lists = 0
    const transport = { pid: 123 }, result = { content: [], structuredContent: { status: 'waiting' } }
    const sdk = { transport, getServerVersion: () => ({ name: 'aiterm', version }),
      listTools: async () => { lists++; return { tools: tool ? [tool] : [] } },
      callTool: async request => { calls.push(request); return result } }
    client.connect = async () => { connects++; client.client = sdk; client.transport = transport }
    client.close = async () => { client.client = null; client.transport = null }
    const auth = createOlrwRabbitAuth({ client, nodePath: '/approved/node', entryPath: '/approved/index.js',
      version: '0.1.0', sessionId: 'synthetic-auth', protectedHosted: 'preserved-hosted' })
    return { client, sdk, transport, result, calls, auth, get connects() { return connects }, get lists() { return lists } }
  }
  for (const version of ['0.63.7', '0.63.11', '999.0.0', undefined]) {
    const f = make(version)
    assert.equal(await f.auth.prepare(), f.sdk)
    assert.equal(await f.auth.status({ binding: { session_id: 'synthetic-auth' } }), f.result)
    assert.equal(await f.auth.status({ binding: { session_id: 'synthetic-auth' } }), f.result)
    assert.equal(f.connects, 1); assert.equal(f.lists, 1); assert.equal(f.calls.length, 2)
    await f.auth.close()
  }
  const malformed = [
    () => null,
    t => { t.inputSchema.properties.action.enum = ['start', 'status', 'cancel']; return t },
    t => { t.inputSchema.properties.expected_binding.properties.launch_id = { type: 'string' }; return t },
    t => { t.inputSchema.properties.expected_binding.properties.server_pid.type = 'number'; return t },
    t => { t.inputSchema.properties.expected_binding.additionalProperties = true; return t },
    t => { t.inputSchema.properties.expected_prompt_digest.pattern = '.*'; return t },
    t => { t.inputSchema.properties.response.oneOf.pop(); return t },
    t => { t.inputSchema.properties.response.oneOf = 'malformed'; return t },
    t => { t.inputSchema.properties.expected_binding.required = 'malformed'; return t },
    t => { t.outputSchema.properties.auth_ui.properties.binding = { type: 'object' }; return t },
    t => { t.outputSchema.properties.auth_ui.properties.schema.const = 'unrelated'; return t },
    t => { delete t.outputSchema.properties.auth_ui.properties.prompt_digest; return t },
  ]
  for (const change of malformed) {
    const f = make('999.0.0', change(authTool()))
    await assert.rejects(f.auth.prepare(), e => e.code === 'AITERM_AUTH_CAPABILITY_UNCONFIRMED' && e.effect === 'not_issued')
    await assert.rejects(f.auth.start(), /CONNECTION_CLOSED/)
    assert.equal(f.connects, 1); assert.equal(f.calls.length, 0)
  }
  for (const change of [
    f => { f.client.client = { ...f.sdk } },
    f => { f.client.transport = f.sdk.transport = { pid: 123 } },
    f => { f.transport.pid++ },
    f => { f.client.transport = null },
  ]) {
    const f = make('0.63.11'); await f.auth.prepare(); change(f)
    await assert.rejects(f.auth.status({ binding: { session_id: 'synthetic-auth' } }), e => e.code === 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
    assert.equal(f.connects, 1); assert.equal(f.calls.length, 0)
  }
  const interrupted = make('0.63.11')
  interrupted.sdk.listTools = async () => { interrupted.transport.pid++; return { tools: [authTool()] } }
  await assert.rejects(interrupted.auth.prepare(), e => e.code === 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
  assert.equal(interrupted.calls.length, 0)
  const failed = make('0.63.11'), failure = new Error('synthetic SDK output validation rejection')
  failed.sdk.callTool = async request => { failed.calls.push(request); throw failure }
  await assert.rejects(failed.auth.status({ binding: { session_id: 'synthetic-auth' } }), e => e === failure)
  assert.deepEqual(mcpRequestContext(failure), { phase: 'call', tool: 'agent_auth', outcome: 'unknown' })
  await assert.rejects(failed.auth.start(), /CONNECTION_CLOSED/)
  assert.equal(failed.connects, 1); assert.equal(failed.calls.length, 1)
})
