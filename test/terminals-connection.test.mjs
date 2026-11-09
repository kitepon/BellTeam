import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalConnection } from '../src/terminals/connection.mjs'
import { createTerminalsCore } from '../src/terminals/core.mjs'
import { fakeNative, fakeSecrets } from './helpers/terminals-native-double.mjs'

const sshKeyRef = 'a1b2c3d4-1234-4234-8234-123456789abc'
const hostTrust = { provider: 'aiterm.known-hosts.v1', revision: `sha256:${'a'.repeat(64)}` }
const base = { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyRef, hostTrust, revision: 1 }
const request = { terminalId: 'owner-macbook', memberId: 'bot-1', projectRoot: '/Users/kite/work/app', seatBinding: { botId: 'bot-1', sessionName: 'bot-1' }, accountOwner: 'owner' }
const launch = { harness: 'claude-code', cwd: '/Users/kite/work/app', session_name: 'bot-1', trust_project: true }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function setup(t, { target = base, native = fakeNative(), secrets = fakeSecrets(), ...options } = {}) {
  const updates = []
  const registry = {
    async target(id) { return id === target?.terminalId ? structuredClone(target) : null },
    async update(id, patch) { updates.push({ id, patch }) }
  }
  const connection = createTerminalConnection({ registry, secrets, native, probeDelays: { first: 5, max: 10 }, ...options })
  t.after(() => connection.dispose())
  return { connection, native, secrets, updates }
}

test('opens a bound port, resolves the key inside the callback and maintains Claude once', async t => {
  const seatCredentials = { reveal: ref => (ref === 'seat-ref' ? 'mcp-token' : null) }
  const { connection, native, secrets } = setup(t, { seatCredentials, loginEnvironment: async slot => ({ CLAUDE_CODE_OAUTH_TOKEN: `login-${slot}` }) })
  const { connectionRef, native: port } = await connection.open({ ...request, credentials: { BELLTEAM_MCP_TOKEN: 'seat-ref', CLAUDE_CODE_OAUTH_TOKEN: { harness: 'claude', slot: '2nd' } } })
  assert.deepEqual(secrets.calls, [{ handle: sshKeyRef, context: { terminalId: 'owner-macbook', memberId: 'bot-1', purpose: 'terminal.ssh' } }])
  const opened = native.calls[0]
  assert.deepEqual(opened.target, { host: '192.168.1.12', user: 'kite', port: 22, os: 'macos' })
  assert.deepEqual(opened.hostTrust, hostTrust)
  assert.deepEqual(opened.credential, { nativeKeyRef: `native-${sshKeyRef}`, credentialRevision: 3 })
  assert.deepEqual(opened.privateEnv, { BELLTEAM_MCP_TOKEN: 'mcp-token', CLAUDE_CODE_OAUTH_TOKEN: 'login-2nd' })

  await port.callTool('agent_launch', launch, { private: { appendSystemPrompt: 'rules' } })
  await port.callTool('agent_launch', launch)
  assert.deepEqual(native.calls.filter(call => call.op === 'command').map(call => call.command), ['claude_version', 'claude_update', 'claude_version'])
  assert.deepEqual(native.calls.find(call => call.op === 'callTool').options, { private: { appendSystemPrompt: 'rules' } })
  assert.deepEqual((({ before, after, outcome }) => ({ before, after, outcome }))(connection.maintenance.last('owner-macbook')), { before: '1.0.0', after: '1.0.1', outcome: 'updated' })

  await assert.rejects(port.callTool('agent_launch', { ...launch, cwd: '/Users/kite' }), { code: 'TARGET_MISMATCH' })
  assert.deepEqual(await connection.close(connectionRef), { closed: true })
  assert.deepEqual(await connection.close(connectionRef), { closed: false })
  await assert.rejects(port.callTool('pty_send', {}), { code: 'TERMINAL_UNAVAILABLE' })
})

test('installs when Claude is missing and a failed update keeps the launch going', async t => {
  const missing = setup(t, { native: fakeNative({ versions: [null, '2.0.0'] }) })
  await (await missing.connection.open(request)).native.callTool('agent_launch', launch)
  assert.equal(missing.native.calls.filter(call => call.op === 'command')[1].command, 'claude_install')
  assert.equal(missing.connection.maintenance.last('owner-macbook').outcome, 'updated')
  const failing = setup(t, { native: fakeNative({ updateCode: 1 }) })
  await (await failing.connection.open(request)).native.callTool('agent_launch', launch)
  assert.equal(failing.connection.maintenance.last('owner-macbook').outcome, 'failed')
  assert.equal(failing.native.calls.filter(call => call.op === 'callTool').length, 1)
})

test('classifies failures as not_started without echoing native or secret text', async t => {
  const leaking = setup(t, { native: fakeNative({ connectError: new Error(`ssh: native-${sshKeyRef} key body`) }) })
  await assert.rejects(leaking.connection.open(request), error => error.code === 'TERMINAL_UNAVAILABLE' && error.effect === 'not_started' && !error.message.includes('native-'))
  const mismatch = setup(t, { native: fakeNative({ connectError: Object.assign(new Error('x'), { code: 'HOST_KEY_MISMATCH', action: 'confirm the new host key' }) }) })
  await assert.rejects(mismatch.connection.open(request), { code: 'TARGET_MISMATCH', reason: 'HOST_KEY_MISMATCH', action: 'confirm the new host key on 192.168.1.12' })
  const stale = setup(t, { native: fakeNative({ connectError: Object.assign(new Error('x'), { code: 'HOST_TRUST_STALE' }) }) })
  await assert.rejects(stale.connection.open(request), { code: 'TARGET_MISMATCH' })
  assert.deepEqual(stale.updates, [{ id: 'owner-macbook', patch: { hostTrust: { provider: 'aiterm.known-hosts.v1', revision: `sha256:${'b'.repeat(64)}` } } }])
  const auth = setup(t, { native: fakeNative({ connectError: Object.assign(new Error('x'), { code: 'AUTH_FAILED' }) }) })
  await assert.rejects(auth.connection.open(request), { code: 'CREDENTIAL_UNAVAILABLE' })
  const untrusted = setup(t, { target: { ...base, hostTrust: undefined } })
  await assert.rejects(untrusted.connection.open(request), { code: 'TARGET_MISMATCH', reason: 'HOST_TRUST_MISSING' })
  assert.equal(untrusted.native.calls.length, 0)
  await assert.rejects(setup(t, { secrets: fakeSecrets({ unavailable: true }) }).connection.open(request), { code: 'CREDENTIAL_UNAVAILABLE' })
  const { connection } = setup(t)
  await assert.rejects(connection.open({ ...request, accountOwner: 'terminal-owner' }), { code: 'TARGET_MISMATCH' })
  await assert.rejects(connection.open({ ...request, projectRoot: 'work/app' }), { code: 'TARGET_MISMATCH' })
  // The Owner's slot login never goes to another person's terminal.
  let read = false
  const other = setup(t, { target: { ...base, accountOwner: 'terminal-owner' }, loginEnvironment: async () => { read = true; return {} } })
  await assert.rejects(other.connection.open({ ...request, accountOwner: 'terminal-owner', credentials: { CLAUDE_CODE_OAUTH_TOKEN: { harness: 'claude', slot: '2nd' } } }), { code: 'CREDENTIAL_UNAVAILABLE' })
  assert.equal(read, false)
})

test('emits available on credential, observer, loss and registry exits', async t => {
  const native = fakeNative({ connectError: Object.assign(new Error('x'), { code: 'UNREACHABLE' }) })
  const { connection } = setup(t, { native })
  const seen = []
  connection.onAvailable(event => seen.push(event.terminalId))
  await assert.rejects(connection.open(request), { code: 'TERMINAL_UNAVAILABLE' })
  await connection.onCredentialEvent({ handle: sshKeyRef, available: true, reason: 'availability' })
  assert.deepEqual(seen, ['owner-macbook'])

  await assert.rejects(connection.open(request))
  native.connectError = undefined
  await wait(30)
  assert.deepEqual(seen, ['owner-macbook', 'owner-macbook'], 'observer check succeeded once and stopped')

  const { connectionRef, native: port } = await connection.open(request)
  native.sessions.at(-1).lose()
  await assert.rejects(port.callTool('pty_read', {}), { code: 'TERMINAL_UNAVAILABLE' })
  assert.deepEqual(await connection.close(connectionRef), { closed: false })
  await wait(30)
  assert.equal(seen.length, 3)

  const reopened = await connection.open(request)
  await connection.onRegistryChange({ terminalId: 'owner-macbook', revision: 2, removed: false })
  assert.equal(native.sessions.at(-1).closed, true)
  assert.equal(seen.length, 4)
  await assert.rejects(reopened.native.callTool('pty_read', {}), { code: 'TERMINAL_UNAVAILABLE' })
})

test('core mounts registry put/enroll, watch and target-mismatch reporting', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-core-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const native = fakeNative()
  const reports = []
  const core = createTerminalsCore({ stateRoot, credentials: fakeSecrets(), adapter: native, report: dto => reports.push(dto), probeDelays: { first: 5, max: 10 } })
  t.after(() => core.close())
  const events = []
  core.watch(event => events.push(event))
  const fingerprint = `SHA256:${'A'.repeat(43)}`
  const created = await core.registry.put({ terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', os: 'macos', accountOwner: 'owner', ingressUrl: 'http://192.168.1.20:18891', sshKeyRef })
  assert.equal(created.hostTrust.revision, `sha256:${'b'.repeat(64)}`, 'binds the trust Aiterm already holds')
  assert.deepEqual(native.calls[0], { op: 'trust', ref: `native-${sshKeyRef}` })
  await core.registry.put({ terminalId: 'owner-macbook', confirmHostKey: fingerprint })
  assert.deepEqual(native.calls[1], { op: 'confirmHostKey', ref: `native-${sshKeyRef}`, fingerprint })
  assert.equal(created.sshKeyConfigured, true)
  assert.equal((await core.registry.get('owner-macbook')).maintenance, null)
  assert.equal((await core.registry.list())[0].maintenance, null)
  assert.equal('sshKeyRef' in created, false)
  assert.deepEqual(events.map(event => [event.terminalId, event.reachable]), [['owner-macbook', true], ['owner-macbook', true]], 'each registry revision publishes availability')
  events.length = 0
  const updated = await core.registry.put({ terminalId: 'owner-macbook', user: 'kite2' })
  assert.equal(updated.revision, 3)
  assert.equal((await core.reachability.check('owner-macbook')).reachable, true)

  native.connectError = Object.assign(new Error('x'), { code: 'HOST_KEY_MISMATCH', action: 'confirm the new host key' })
  await assert.rejects(core.connection.open(request), { code: 'TARGET_MISMATCH' })
  assert.deepEqual(reports, [{ module: 'terminals', code: 'TERMINAL_TARGET_MISMATCH', terminalId: 'owner-macbook', action: 'confirm the new host key on 192.168.1.12' }])
  await assert.rejects(core.registry.put({ terminalId: 'Bad Id', host: 'h', user: 'u', os: 'macos', accountOwner: 'owner', sshKeyRef }), { code: 'INVALID_TERMINAL', status: 400 })
  const noCredentials = createTerminalsCore({ stateRoot, adapter: native })
  t.after(() => noCredentials.close())
  native.connectError = undefined
  await assert.rejects(noCredentials.connection.open(request), { code: 'CREDENTIAL_UNAVAILABLE' })
})
