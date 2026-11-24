import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalRegistry } from '../src/terminals/registry.mjs'
import { createTerminalConnection } from '../src/terminals/connection.mjs'
import { createRemoteTerminalProcesses } from '../src/terminals/remote-process.mjs'
import { EXPORT_SCHEMA, parseExport } from '../src/terminals/trust-copy.mjs'
import { fakeNative } from './helpers/terminals-native-double.mjs'

const sshKeyRef = 'a1b2c3d4-1234-4234-8234-123456789abc'
const revision = `sha256:${'b'.repeat(64)}`
const LINE = `[192.168.1.12]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(40)}`
const base = { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyRef, hostTrust: { provider: 'aiterm.known-hosts.v1', revision } }
const request = { terminalId: 'owner-macbook', memberId: 'bot-1', projectRoot: '/Users/kite/work/app', harness: 'claude-code' }
const remote = { host: '192.168.1.12', user: 'kite', port: 22, ssh: { known_hosts_file: '/tmp/k.known_hosts', host_key_alias: 'bt-mac', identity_agent: '/tmp/a.sock', strict_host_key: true } }

function fakeRun(answers) {
  const calls = []
  const run = async (command, args, options = {}) => {
    calls.push({ command, args })
    const answer = answers.shift()
    return { stdout: `${JSON.stringify(answer.line)}\n`, code: answer.code ?? 0 }
  }
  return { run, calls }
}

test('connectRemote runs aiterm-remote probe and command with the pinned flags; the result shape is the binding path\'s', async () => {
  const { run, calls } = fakeRun([{ line: { remoteVersion: '0.70.112', platform: 'macos' } }, { line: { op: 'cli_version', exit_code: 0, version: '2.1.330', output_tail: '' } },
    { line: { op: 'list_dirs', home: '/Users/kite', path: '/Users/kite/dev', entries: [], truncated: false } }])
  const native = createRemoteTerminalProcesses({ project: '/srv/x', run })
  const session = await native.connectRemote({ remote })
  assert.equal(session.remoteVersion, '0.70.112')
  const flags = ['--host', '192.168.1.12', '--user', 'kite', '--port', '22', '--known-hosts', '/tmp/k.known_hosts', '--host-key-alias', 'bt-mac', '--identity-agent', '/tmp/a.sock']
  assert.deepEqual(calls[0], { command: '/usr/bin/env', args: ['aiterm-remote', 'probe', ...flags] })
  assert.deepEqual(await session.command('cli_version', { harness: 'codex-cli' }), { op: 'cli_version', exit_code: 0, version: '2.1.330', output_tail: '' })
  assert.deepEqual(calls[1].args, ['aiterm-remote', 'command', '--op', 'cli_version', '--harness', 'codex-cli', ...flags])
  await session.command('list_dirs', { path: '/Users/kite/dev é' })
  assert.deepEqual(calls[2].args.slice(0, 5), ['aiterm-remote', 'command', '--op', 'list_dirs', '--path-base64'])
  assert.equal(Buffer.from(calls[2].args[5], 'base64').toString('utf8'), '/Users/kite/dev é', 'the path travels as base64, never as a shell word')
  assert.throws(() => session.command('rm_rf', {}), { code: 'COMMAND_INVALID' })
  assert.deepEqual(await session.close(), { closed: true })
})

test('connectRemote: an invalid probe is REMOTE_AITERM_UNAVAILABLE and a failure keeps the CLI\'s own code only', async () => {
  const bad = fakeRun([{ line: { remoteVersion: 7, platform: 'macos' } }])
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/x', run: bad.run }).connectRemote({ remote }), { code: 'REMOTE_AITERM_UNAVAILABLE' })
  const failed = fakeRun([{ line: { schema: 'aiterm.remote-binding-error.v1', code: 'AUTH_FAILED', message: 'secret text must not surface' }, code: 2 }])
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/x', run: failed.run }).connectRemote({ remote }), error => error.code === 'AUTH_FAILED' && !error.message.includes('secret'))
})

async function setup(t, { maintainInput = 'remote', containerVersion = '0.70.113', agentHeld = true, trustCopy = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maintain-remote-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = createTerminalRegistry({ stateRoot: root })
  await registry.register({ ...base, keySource: 'secret', bindingRef: sshKeyRef })
  if (maintainInput) await registry.update('owner-macbook', { maintainInput })
  if (trustCopy) await registry.setTrustCopy('owner-macbook', parseExport({ schema: EXPORT_SCHEMA, ref: sshKeyRef, known_hosts_lines: [LINE], host_key_alias: 'bt-mac', fingerprints: ['SHA256:abc'], trust_revision: revision }, sshKeyRef, 'now'), (await registry.target('owner-macbook')).revision)
  const native = fakeNative(); native.remoteVersion = '1.0.0'; native.localVersion = '1.0.1'
  const original = native.connect
  let bindingOpens = 0, remoteOpens = []
  native.connect = async value => { bindingOpens++; return original(value) }
  native.connectRemote = async ({ remote: input }) => { remoteOpens.push(input); return original({ target: {}, hostTrust: { revision }, binding: { ref: sshKeyRef } }) }
  Object.assign(native, { async containerAitermVersion() { return containerVersion }, async loadAgent() {}, async agentHeld() { return agentHeld }, agentSocket: ({ terminalId }) => `/tmp/bellteam-terminals/agent/${terminalId}.sock`,
    async trustFile({ terminalId }) { return `/tmp/bellteam-terminals/trust/${terminalId}.known_hosts` } })
  const secrets = { async withResolved(handle, context, consume) { return consume('KEY') }, credential: async handle => ({ handle, revision: 2, available: true }) }
  const connection = createTerminalConnection({ registry, secrets, native, probeDelays: { first: 5, max: 10 } })
  t.after(() => connection.dispose())
  return { connection, registry, native, opens: () => ({ bindingOpens, remoteOpens }) }
}

test('a terminal with maintainInput remote runs C8 and the check on the pinned-ssh CLIs; evidence says remote', async t => {
  const { connection, opens } = await setup(t)
  assert.ok((await connection.target(request)).terminal)
  assert.equal(opens().bindingOpens, 0, 'no binding open for C8')
  assert.deepEqual(opens().remoteOpens.at(0), { host: '192.168.1.12', user: 'kite', port: 22, ssh: { known_hosts_file: '/tmp/bellteam-terminals/trust/owner-macbook.known_hosts', host_key_alias: 'bt-mac', identity_agent: '/tmp/bellteam-terminals/agent/owner-macbook.sock', strict_host_key: true } })
  assert.deepEqual(connection.maintenance.last('owner-macbook', 'claude-code').maintain, { outcome: 'remote' })
  const observation = await connection.check('owner-macbook')
  assert.equal(observation.reachable, true)
  assert.equal(opens().bindingOpens, 0, 'the check uses the same input')
})

test('every unmet condition opens the binding path as before and names why; a terminal not switched shows no evidence', async t => {
  for (const [reason, options] of [['AITERM_TOO_OLD', { containerVersion: '0.70.112' }], ['AGENT_EMPTY', { agentHeld: false }], ['TRUST_COPY_MISSING', { trustCopy: false }]]) {
    const { connection, opens } = await setup(t, options)
    assert.ok((await connection.target(request)).terminal, 'the launch goes on')
    assert.equal(opens().remoteOpens.length, 0, reason)
    assert.equal(opens().bindingOpens >= 1, true, reason)
    assert.deepEqual(connection.maintenance.last('owner-macbook', 'claude-code').maintain, { outcome: 'binding', reason })
  }
  const { connection, opens } = await setup(t, { maintainInput: null })
  await connection.target(request)
  assert.equal(opens().remoteOpens.length, 0)
  assert.equal('maintain' in connection.maintenance.last('owner-macbook', 'claude-code'), false)
})

test('the switch has its own scope: maintenance does not touch the launch input, and the tool takes it', async t => {
  const { createTerminalsCore } = await import('../src/terminals/core.mjs')
  const { callTerminalTool } = await import('../src/terminals-mcp.mjs')
  const root = await mkdtemp(join(tmpdir(), 'maintain-core-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const core = createTerminalsCore({ stateRoot: root, adapter: fakeNative(), credentials: { async withResolved(h, c, consume) { return consume('KEY') }, credential: async h => ({ handle: h, revision: 1, available: true }), watchCredentials() { return () => {} }, current: () => null } })
  t.after(() => core.close())
  await core.ready
  const registry = createTerminalRegistry({ stateRoot: root })
  await registry.register(base)
  await callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'remote', scope: 'maintenance' }, terminals: () => core })
  let record = await registry.target('owner-macbook')
  assert.equal(record.maintainInput, 'remote'); assert.equal('launchInput' in record, false)
  await callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'remote' }, terminals: () => core })
  record = await registry.target('owner-macbook')
  assert.equal(record.launchInput, 'remote')
  await callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'terminal', scope: 'maintenance' }, terminals: () => core })
  record = await registry.target('owner-macbook')
  assert.equal('maintainInput' in record, false); assert.equal(record.launchInput, 'remote')
  await assert.rejects(callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'remote', scope: 'other' }, terminals: () => core }), { code: 'INVALID_TERMINAL' })
})
