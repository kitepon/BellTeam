import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermClient } from '../src/aiterm-client.mjs'
import { ConfigurationIntents } from '../src/configuration-intents.mjs'
import { aitermEntrySpec } from '../src/runtime-aiterm-entry.mjs'
import { aitermConnectionRegistration, AITERM_ADAPTER_DIST, RUNTIME_EXEC } from '../src/aiterm-hooks.mjs'
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
  assert.deepEqual(aitermConnectionRegistration({ command: 'node', args: [RUNTIME_EXEC, 'runtime-aiterm-mcp', 'aiterm-mcp', '--arg'] }, a),
    { command: a.components['runtime-aiterm-mcp'].bin['aiterm-mcp'], args: ['--arg'] })
  const native = aitermConnectionRegistration({ command: 'node', args: [join(AITERM_ADAPTER_DIST, 'execution-native-server.js'),
    '--execution-interrupt', '--state-root', '/state', '--socket', '/socket', '--steer-provider', '/old/provider'] }, a,
  entry => { assert.equal(entry, join(a.components['runtime-aiterm-mcp'].dist, 'execution-native-server.js')); return '/a/provider' })
  assert.equal(native.args[0], join(a.components['runtime-aiterm-mcp'].dist, 'execution-native-server.js'))
  assert.deepEqual(native.args.slice(1), ['--execution-interrupt', '--state-root', '/state', '--socket', '/socket', '--steer-provider', '/a/provider'])
  const custom = { command: process.execPath, args: ['/fake/transport.mjs'] }
  assert.deepEqual(aitermConnectionRegistration(custom, a), custom)
})

test('builtin Aiterm connection keeps PATH lookup for direct and stable-wrapper registrations', () => {
  const runtime = { components: { 'runtime-aiterm-mcp': {
    origin: 'builtin', dist: '/usr/local/lib/node_modules/aiterm-mcp/dist',
    bin: { 'aiterm-mcp': '/usr/local/bin/aiterm-mcp' },
  } } }
  assert.deepEqual(aitermConnectionRegistration({ command: 'aiterm-mcp', args: ['--direct'] }, runtime),
    { command: 'aiterm-mcp', args: ['--direct'] })
  assert.deepEqual(aitermConnectionRegistration({ command: '/usr/local/bin/node',
    args: [RUNTIME_EXEC, 'runtime-aiterm-mcp', 'aiterm-mcp', '--wrapped'] }, runtime),
  { command: 'aiterm-mcp', args: ['--wrapped'] })
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

test('delayed hook resolves the inherited generation once and keeps original arguments/environment', async t => {
  const { a } = await fixture(t)
  const env = { BELLTEAM_RUNTIME_GENERATION: '', AITERM_SESSION_ID: 'seat', PATH: '/bin' }
  let captured = 0, resolved = 0
  const options = { environment: env,
    capture: async input => { captured++; assert.equal(input.generation, null); return a },
    resolve: async input => { resolved++; assert.equal(input.BELLTEAM_RUNTIME_GENERATION, a.generation); return { stdout: a.components['runtime-aiterm-mcp'].dist + '\n' } },
  }
  const spec = await aitermEntrySpec('codex-parent-hook.js', ['/hook config'], options)
  assert.equal(captured, 1); assert.equal(resolved, 1)
  assert.deepEqual(spec.args, [join(a.components['runtime-aiterm-mcp'].dist, 'codex-parent-hook.js'), '/hook config'])
  assert.equal(spec.env.AITERM_SESSION_ID, 'seat')
  assert.equal(spec.env.BELLTEAM_RUNTIME_GENERATION, a.generation)
  await assert.rejects(aitermEntrySpec('index.js', [], { ...options, resolve: async () => ({ stdout: '/wrong/closure\n' }) }), /RUNTIME_BINDING_UNAVAILABLE/)
  await assert.rejects(aitermEntrySpec('../../wrong', [], options), /RUNTIME_ENTRY_INVALID/)
})

test('native adapter resolves its provider within the selected helper closure', async t => {
  const { root, a } = await fixture(t)
  const provider = join(root, 'a/node_modules/aiterm-steer-delivery')
  await mkdir(provider, { recursive: true })
  await writeFile(join(provider, 'package.json'), '{"main":"index.js"}')
  await writeFile(join(provider, 'index.js'), '')
  const spec = await aitermEntrySpec('execution-native-server.js', ['--execution-interrupt', '--steer-provider', '/old/provider'], {
    environment: {}, capture: async input => { assert.equal(input.generation, undefined); return a },
    resolve: async () => ({ stdout: a.components['runtime-aiterm-mcp'].dist + '\n' }),
  })
  assert.deepEqual(spec.args, [join(a.components['runtime-aiterm-mcp'].dist, 'execution-native-server.js'),
    '--execution-interrupt', '--steer-provider', join(provider, 'index.js')])
})

test('hook adapter forwards stdio, environment and child exit without loading live Aiterm', async () => {
  const { spawnSync } = await import('node:child_process')
  const runner = new URL('../src/runtime-aiterm-entry.mjs', import.meta.url).href
  const code = `import {runAitermEntry} from ${JSON.stringify(runner)};
    await runAitermEntry('codex-parent-hook.js',{spec:async(entry,args)=>({command:process.execPath,
      args:['--input-type=module','-e',"let s='';for await(const c of process.stdin)s+=c;process.stdout.write(s+process.env.FAKE_CAPTURE);process.exitCode=37"],
      env:{...process.env,FAKE_CAPTURE:'retained'}})});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: 'hook-payload:', encoding: 'utf8' })
  assert.equal(result.status, 37)
  assert.equal(result.stdout, 'hook-payload:retained')
  assert.equal(result.stderr, '')
})
