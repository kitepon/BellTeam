import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermClient } from '../src/aiterm-client.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { aitermConnectionRegistration } from '../src/aiterm-hooks.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aiterm-runtime # '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const capture = async name => {
    const dist = join(root, name, 'dist')
    await mkdir(dist, { recursive: true })
    await writeFile(join(root, name, 'package.json'), '{"type":"module"}')
    await writeFile(join(dist, 'model-handoff-transport.js'), `export const captureModelHandoffOverMcp = () => '${name}'`)
    await writeFile(join(dist, 'model-handoff-control-transport.js'), `export const modelHandoffOverMcp = () => '${name}'`)
    await writeFile(join(dist, 'model-handoff-control.js'), `export const handoffSnapshotSchema = {parse:v=>({...v,reader:'${name}'})}`)
    return { generation: name.repeat(64), components: { 'runtime-aiterm-mcp': { dist, bin: { 'aiterm-mcp': join(root, name, 'bin/aiterm-mcp') } } } }
  }
  return { root, a: await capture('a'), b: await capture('b') }
}

test('handoff transport closures keep the captured absolute imports after client replacement', async t => {
  const { a, b } = await fixture(t)
  const client = new AitermClient({ runtimeCapture: a })
  const transport = {}, sdk = { transport, getServerCapabilities: () => ({ experimental: {
    'ai.aiterm/handoff.control.v1': { version: 1 }, 'ai.aiterm/handoff.full.v1': { version: 1 },
  } }) }
  client.client = sdk; client.transport = transport
  const bound = client.captureHandoffConnection()
  client.runtimeCapture = b
  assert.equal(await bound.capture({}), 'a')
  assert.equal(await bound.control({}), 'a')
  assert.equal(client.captureHandoffConnection().expected.sdk, sdk)
})

test('stored handoff snapshot schema uses the owning native client capture', async t => {
  const { root, a, b } = await fixture(t)
  const binding = { id: 'synthetic' }
  await writeFile(join(root, 'synthetic.handoff.json'), JSON.stringify({ schema: 'bellteam.configuration-handoff-result.v1',
    snapshot: { operation: binding, state: 'terminal', later_effect: 'excluded' } }), { mode: 0o600 })
  const client = new AitermClient({ runtimeCapture: a })
  const store = new ConfigurationIntents(root, { runtimeCapture: () => client.runtime() })
  store.botDirectory = async () => root
  // The second consumer proves imports are selected by immutable path, without a cache-busting suffix.
  const second = new ConfigurationIntents(root, { runtimeCapture: b })
  second.botDirectory = async () => root
  assert.equal((await store.handoffTerminal('bot', binding)).reader, 'a')
  assert.equal((await second.handoffTerminal('bot', binding)).reader, 'b')
})

test('ordinary/native connection specs use the supplied capture and leave custom transports alone', async t => {
  const { a } = await fixture(t)
  const component = a.components['runtime-aiterm-mcp']
  const runtime = { ...a, components: { ...a.components, 'runtime-aiterm-mcp': { ...component, origin: 'release' } } }
  assert.deepEqual(aitermConnectionRegistration({ command: 'aiterm-mcp', args: ['--arg'] }, runtime),
    { command: a.components['runtime-aiterm-mcp'].bin['aiterm-mcp'], args: ['--arg'] })
  const native = aitermConnectionRegistration({ command: 'node', args: ['/usr/local/lib/node_modules/aiterm-mcp/dist/execution-native-server.js',
    '--execution-interrupt', '--state-root', '/state', '--socket', '/socket', '--steer-provider', '/old/provider'] }, a,
  entry => { assert.equal(entry, join(a.components['runtime-aiterm-mcp'].dist, 'execution-native-server.js')); return '/a/provider' })
  assert.equal(native.args[0], join(a.components['runtime-aiterm-mcp'].dist, 'execution-native-server.js'))
  assert.deepEqual(native.args.slice(1), ['--execution-interrupt', '--state-root', '/state', '--socket', '/socket', '--steer-provider', '/a/provider'])
  const custom = { command: process.execPath, args: ['/fake/transport.mjs'] }
  assert.deepEqual(aitermConnectionRegistration(custom, a), custom)
})

test('builtin Aiterm connection keeps PATH lookup and leaves the original node/dist descriptor unchanged', () => {
  const runtime = { components: { 'runtime-aiterm-mcp': {
    origin: 'builtin', dist: '/usr/local/lib/node_modules/aiterm-mcp/dist',
    bin: { 'aiterm-mcp': '/usr/local/bin/aiterm-mcp' },
  } } }
  assert.deepEqual(aitermConnectionRegistration({ command: 'aiterm-mcp', args: ['--direct'] }, runtime),
    { command: 'aiterm-mcp', args: ['--direct'] })
  const registration = { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/aiterm-mcp/dist/index.js'] }
  assert.deepEqual(aitermConnectionRegistration(registration, runtime), registration)
})

test('concurrent connect callers share capture resolution and SDK initialization', async t => {
  const { a } = await fixture(t)
  let release, calls = 0, command
  const gate = new Promise(resolve => { release = resolve })
  t.mock.method(Client.prototype, 'connect', async transport => {
    calls++; command = transport._serverParams.command
    await gate
  })
  const client = new AitermClient({ runtimeCapture: a })
  const first = client.connect(), second = client.connect()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(command, a.components['runtime-aiterm-mcp'].bin['aiterm-mcp'])
  assert.ok(client.connecting)
  release(); await Promise.all([first, second])
  assert.equal(client.connecting, null)
  await client.close()
})

