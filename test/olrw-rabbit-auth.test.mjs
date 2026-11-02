import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-client.mjs'
import { createOlrwRabbitAuth, fixedRabbitClientOptions } from '../src/olrw-rabbit-auth.mjs'

const profile = { nodePath: '/approved/node', entryPath: '/approved/aiterm/dist/index.js', version: '99.1.2',
  sessionId: 'olrw-synthetic-auth', protectedHosted: 'original-protected-hosted' }
const receipt = { isError: false, structuredContent: { synthetic: true } }
function fixture(info = { name: 'aiterm', version: profile.version }) {
  const client = new AitermClient(), calls = []
  let connects = 0, closes = 0
  const transport = { pid: 1234 }
  const sdk = { transport, getServerVersion: () => info, callTool: async input => { calls.push(input); return receipt } }
  client.connect = async () => { connects++; client.client = sdk; client.transport = transport }
  client.close = async () => { closes++; client.client = null; client.transport = null }
  return { client, calls, sdk, get connects() { return connects }, get closes() { return closes } }
}

test('固定SSH/Node/entryを使い一接続だけで公開authを組み、remote/env launcher/metaを渡さない', async () => {
  const spec = fixedRabbitClientOptions(profile)
  assert.equal(spec.command, '/usr/bin/ssh')
  assert.deepEqual(spec.args, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-l', 'kite', 'rabbit', profile.nodePath, profile.entryPath])
  for (const path of ['/a;command', '/path with space', '/a/../b', '/a\ncommand'])
    assert.throws(() => fixedRabbitClientOptions({ ...profile, entryPath: path }), /ARGUMENTS_INVALID/)
  const f = fixture(), auth = createOlrwRabbitAuth({ ...profile, client: f.client })
  await auth.prepare()
  assert.equal(f.calls.length, 0)
  assert.equal(await auth.start(), receipt)
  const binding = { session_id: profile.sessionId }
  await auth.status({ binding }); await auth.respond({ binding, prompt_digest: 'a'.repeat(64), response: { kind: 'authorization_code', value: 'synthetic-code' } })
  await auth.cleanup({ binding })
  assert.equal(f.connects, 1)
  assert.deepEqual(f.calls.map(x => x.arguments.action), ['start', 'status', 'respond', 'cancel'])
  for (const call of f.calls) {
    assert.equal(call.name, 'agent_auth'); assert.equal(call.arguments.harness, 'claude-code')
    assert.equal(call.arguments.session_id, profile.sessionId)
    assert.equal(Object.hasOwn(call.arguments, 'remote'), false)
    assert.equal(Object.hasOwn(call, '_meta'), false)
  }
  assert.deepEqual(f.calls[0].arguments.env_vars, ['HOME'])
  assert.equal(f.calls[2].arguments.response.value, 'synthetic-code')
  await auth.close()
  await assert.rejects(auth.start(), /CONNECTION_CLOSED/)
  assert.equal(f.calls.length, 4)
})

test('版不一致/切断/別SDK/型付き失敗の後は新connectや後続RPCを発行しない', async () => {
  for (const info of [{ name: 'other', version: profile.version }, { name: 'aiterm', version: '0.0.0' }, {}]) {
    const f = fixture(info), auth = createOlrwRabbitAuth({ ...profile, client: f.client })
    await assert.rejects(auth.start(), /VERSION_UNCONFIRMED/)
    await assert.rejects(auth.start(), /CONNECTION_CLOSED/)
    assert.equal(f.connects, 1); assert.equal(f.calls.length, 0)
  }
  for (const disconnect of [client => { client.client = null; client.transport = null }, client => { client.client = { ...client.client } }]) {
    const f = fixture(), auth = createOlrwRabbitAuth({ ...profile, client: f.client })
    await auth.prepare(); disconnect(f.client)
    await assert.rejects(auth.status({ binding: { session_id: profile.sessionId } }), /AITERM_AUTH_CONNECTION_UNCONFIRMED/)
    await assert.rejects(auth.start(), /CONNECTION_CLOSED/)
    assert.equal(f.connects, 1); assert.equal(f.calls.length, 0)
  }
  const f = fixture(), auth = createOlrwRabbitAuth({ ...profile, client: f.client })
  const typed = { isError: true, structuredContent: { schema: 'aiterm.auth-operation-error.v1', effect: 'unknown' } }
  f.sdk.callTool = async input => { f.calls.push(input); return typed }
  assert.equal(await auth.status({ binding: { session_id: profile.sessionId } }), typed)
  await assert.rejects(auth.start(), /CONNECTION_CLOSED/)
  assert.equal(f.calls.length, 1); assert.equal(f.connects, 1)
})
