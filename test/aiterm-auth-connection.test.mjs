import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-client.mjs'
import { mcpRequestContext } from '../src/mcp-request-context.mjs'

const version = 'synthetic-version'
function fixture() {
  const client = new AitermClient({ command: 'must-not-spawn', env: {} })
  const transport = { pid: 123 }, result = { content: [], structuredContent: { status: 'waiting' } }, calls = []
  const sdk = { transport, getServerVersion: () => ({ name: 'aiterm', version }),
    async callTool(request) { assert.equal(this, sdk); calls.push(request); return result } }
  const counts = { connect: 0 }
  client.client = sdk
  client.transport = transport
  client.connect = async () => { counts.connect++; throw new Error('must not connect') }
  return { client, sdk, transport, result, calls, counts,
    options: { expectedAuthConnection: sdk, expectedAuthServerVersion: version } }
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

test('bound auth checks initialized version and calls the same SDK once without connect', async () => {
  const f = fixture(), args = { action: 'status', session_id: 'synthetic-auth' }, meta = { test: 'synthetic' }
  assert.equal(await f.client.call('agent_auth', args, { ...f.options, meta }), f.result)
  assert.deepEqual(f.calls, [{ name: 'agent_auth', arguments: args, _meta: meta }])
  assert.equal(f.counts.connect, 0)
})

for (const [label, server] of [
  ['missing initialize info', undefined], ['missing version', { name: 'aiterm' }],
  ['wrong version', { name: 'aiterm', version: 'different' }],
  ['non-string version', { name: 'aiterm', version: 1 }],
  ['wrong server name', { name: 'another-server', version }],
]) test(`${label} refuses before auth RPC`, async () => {
  const f = fixture()
  f.sdk.getServerVersion = () => server
  await refused(f, f.options, 'AITERM_AUTH_SERVER_VERSION_UNCONFIRMED')
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
  const f = fixture()
  change(f)
  await refused(f, f.options, 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
})

for (const [label, options, name] of [
  ['another tool', f => f.options, 'pty_list'],
  ['short-lived env', f => ({ ...f.options, env: {} })],
  ['explicit undefined env', f => ({ ...f.options, env: undefined })],
  ['launchProject', f => ({ ...f.options, launchProject: '/synthetic' })],
  ['version alone', () => ({ expectedAuthServerVersion: version })],
  ['connection alone', f => ({ expectedAuthConnection: f.sdk })],
  ['empty expected version', f => ({ ...f.options, expectedAuthServerVersion: '' })],
  ['non-string expected version', f => ({ ...f.options, expectedAuthServerVersion: 1 })],
]) test(`${label} rejects the auth options before any connection`, async () => {
  const f = fixture()
  await refused(f, options(f), 'AITERM_AUTH_CONNECTION_ARGUMENTS', name)
})

test('disconnect after initial version check cannot start a replacement MCP on the next call', async () => {
  const f = fixture()
  assert.deepEqual(f.sdk.getServerVersion(), { name: 'aiterm', version })
  f.client.client = null
  f.client.transport = null
  f.client.connect = async () => { f.counts.connect++; f.client.client = f.sdk; f.client.transport = f.transport }
  await refused(f, f.options, 'AITERM_AUTH_CONNECTION_UNCONFIRMED')
})

test('call uses the captured SDK reference instead of reading a replacement after version lookup', async () => {
  const f = fixture()
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
  const f = fixture(), failure = new Error('synthetic disconnect')
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
  const f = fixture()
  f.client.connect = async () => { f.counts.connect++ }
  f.sdk.getServerVersion = () => { throw new Error('must not inspect version') }
  assert.equal(await f.client.call('pty_list'), f.result)
  assert.equal(f.counts.connect, 1)
  assert.equal(f.calls.length, 1)
})
