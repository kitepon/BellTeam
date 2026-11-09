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
const request = { terminalId: 'owner-macbook', memberId: 'bot-1', projectRoot: '/Users/kite/work/app', harness: 'claude-code' }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

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

test('target hands execution the Aiterm launch target and runs C8 once per Claude Code launch', async t => {
  const { connection, native, secrets } = setup(t)
  assert.deepEqual(await connection.target(request), {
    terminal: { ref: `native-${sshKeyRef}`, target: { host: '192.168.1.12', user: 'kite', port: 22 }, trustRevision: hostTrust.revision, credentialRevision: 3 },
    cwd: '/Users/kite/work/app',
    accountOwner: 'owner'
  })
  assert.deepEqual(secrets.calls[0], { handle: sshKeyRef, context: { terminalId: 'owner-macbook', memberId: 'bot-1', purpose: 'terminal.ssh' } })
  assert.deepEqual(native.calls.filter(call => call.op === 'command').map(call => call.command), ['claude_version', 'claude_update', 'claude_version'])
  assert.equal(native.sessions.every(session => session.closed), true, 'C8 process is transient')
  assert.deepEqual((({ before, after, outcome }) => ({ before, after, outcome }))(connection.maintenance.last('owner-macbook')), { before: '1.0.0', after: '1.0.1', outcome: 'updated' })

  const before = native.sessions.length
  await connection.target({ ...request, harness: 'codex' })
  assert.equal(native.sessions.length, before, 'no upkeep for other CLIs')
  await Promise.all([connection.target(request), connection.target(request)])
  assert.equal(native.sessions.length, before + 1, 'concurrent launches share one upkeep run')
})

test('installs when Claude is missing and a failed update still returns the target', async t => {
  const missing = setup(t, { native: fakeNative({ versions: [null, '2.0.0'] }) })
  await missing.connection.target(request)
  assert.equal(missing.native.calls.filter(call => call.op === 'command')[1].command, 'claude_install')
  assert.equal(missing.connection.maintenance.last('owner-macbook').outcome, 'updated')
  const failing = setup(t, { native: fakeNative({ updateCode: 1 }) })
  assert.equal((await failing.connection.target(request)).cwd, request.projectRoot)
  assert.equal(failing.connection.maintenance.last('owner-macbook').outcome, 'failed')
})

test('classifies failures as not_started without echoing native or secret text', async t => {
  const leaking = setup(t, { native: fakeNative({ connectError: new Error(`ssh: native-${sshKeyRef} key body`) }) })
  await assert.rejects(leaking.connection.target(request), error => error.code === 'TERMINAL_UNAVAILABLE' && error.effect === 'not_started' && !error.message.includes('native-'))
  const mismatch = setup(t, { native: fakeNative({ connectError: Object.assign(new Error('x'), { code: 'HOST_KEY_MISMATCH', action: 'confirm the new host key' }) }) })
  await assert.rejects(mismatch.connection.target(request), { code: 'TARGET_MISMATCH', reason: 'HOST_KEY_MISMATCH', action: 'confirm the new host key on 192.168.1.12' })
  const stale = setup(t, { native: fakeNative({ connectError: Object.assign(new Error('x'), { code: 'HOST_TRUST_STALE' }) }) })
  await assert.rejects(stale.connection.target(request), { code: 'TARGET_MISMATCH' })
  assert.deepEqual(stale.updates, [{ id: 'owner-macbook', patch: { hostTrust: { provider: 'aiterm.known-hosts.v1', revision: `sha256:${'b'.repeat(64)}` } } }])
  const auth = setup(t, { native: fakeNative({ connectError: Object.assign(new Error('x'), { code: 'AUTH_FAILED' }) }) })
  await assert.rejects(auth.connection.target(request), { code: 'CREDENTIAL_UNAVAILABLE' })
  const keyless = setup(t, { target: { ...base, sshKeyRef: undefined } })
  await assert.rejects(keyless.connection.target(request), { code: 'CREDENTIAL_UNAVAILABLE', reason: 'SSH_KEY_UNSET' })
  assert.equal(keyless.native.calls.length + keyless.secrets.calls.length, 0)
  const untrusted = setup(t, { target: { ...base, hostTrust: undefined } })
  await assert.rejects(untrusted.connection.target(request), { code: 'TARGET_MISMATCH', reason: 'HOST_TRUST_MISSING' })
  assert.equal(untrusted.native.calls.length, 0)
  await assert.rejects(setup(t, { secrets: fakeSecrets({ unavailable: true }) }).connection.target(request), { code: 'CREDENTIAL_UNAVAILABLE' })
  const keyValue = setup(t, { secrets: { withResolved: (handle, context, consume) => consume('-----BEGIN key') } })
  await assert.rejects(keyValue.connection.target(request), { code: 'CREDENTIAL_UNAVAILABLE' })
  const { connection } = setup(t)
  await assert.rejects(connection.target({ ...request, projectRoot: 'work/app' }), { code: 'TARGET_MISMATCH' })
  await assert.rejects(connection.target({ ...request, memberId: undefined }), { code: 'TARGET_MISMATCH' })
  assert.equal((await setup(t, { target: { ...base, accountOwner: 'terminal-owner' } }).connection.target(request)).accountOwner, 'terminal-owner')
})

test('emits available on credential, observer and registry exits', async t => {
  const native = fakeNative({ connectError: Object.assign(new Error('x'), { code: 'UNREACHABLE' }) })
  const { connection } = setup(t, { native })
  const seen = []
  connection.onAvailable(event => seen.push(event.terminalId))
  await assert.rejects(connection.target(request), { code: 'TERMINAL_UNAVAILABLE' })
  await connection.onCredentialEvent({ handle: sshKeyRef, available: true, reason: 'availability' })
  assert.deepEqual(seen, ['owner-macbook'])

  await assert.rejects(connection.target(request))
  native.connectError = undefined
  await wait(30)
  assert.deepEqual(seen, ['owner-macbook', 'owner-macbook'], 'observer check succeeded once and stopped')
  connection.onRegistryChange({ terminalId: 'owner-macbook', revision: 2, removed: false })
  assert.equal(seen.length, 3)
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
  const created = await core.registry.put({ terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', os: 'macos', accountOwner: 'owner', sshKeyRef })
  assert.equal(created.hostTrust.revision, `sha256:${'b'.repeat(64)}`, 'binds the trust Aiterm already holds')
  assert.deepEqual(native.calls[0], { op: 'trust', ref: `native-${sshKeyRef}` })
  await core.registry.put({ terminalId: 'owner-macbook', confirmHostKey: fingerprint })
  assert.deepEqual(native.calls[1], { op: 'confirmHostKey', ref: `native-${sshKeyRef}`, fingerprint })
  assert.equal(created.sshKeyConfigured, true)
  assert.equal((await core.registry.get('owner-macbook')).maintenance, null)
  assert.equal('sshKeyRef' in created, false)
  assert.deepEqual(events.map(event => [event.terminalId, event.reachable]), [['owner-macbook', true], ['owner-macbook', true]], 'each registry revision publishes availability')
  assert.equal((await core.reachability.check('owner-macbook')).reachable, true)

  native.connectError = Object.assign(new Error('x'), { code: 'HOST_KEY_MISMATCH', action: 'confirm the new host key' })
  await assert.rejects(core.connection.target(request), { code: 'TARGET_MISMATCH' })
  assert.deepEqual(reports, [{ module: 'terminals', code: 'TERMINAL_TARGET_MISMATCH', terminalId: 'owner-macbook', action: 'confirm the new host key on 192.168.1.12' }])
  const noCredentials = createTerminalsCore({ stateRoot, adapter: native })
  t.after(() => noCredentials.close())
  native.connectError = undefined
  await assert.rejects(noCredentials.connection.target(request), { code: 'CREDENTIAL_UNAVAILABLE' })
})

test('a target read across a registry change is never handed out; dispose awaits in-flight runs', async t => {
  const native = fakeNative()
  const targetGate = deferred()
  const closeGate = deferred()
  let gateNext = true
  const registry = { async target(id) { if (gateNext) { gateNext = false; await targetGate.promise } return id === base.terminalId ? structuredClone(base) : null } }
  const connection = createTerminalConnection({ registry, secrets: fakeSecrets(), native, probeDelays: { first: 5, max: 10 } })
  t.after(() => connection.dispose())
  const acrossChange = connection.target(request)
  await wait(1)
  connection.onRegistryChange({ terminalId: 'owner-macbook', revision: 2, removed: false })
  targetGate.resolve()
  await assert.rejects(acrossChange, { code: 'TERMINAL_UNAVAILABLE', effect: 'not_started' })
  assert.equal(native.sessions.length, 0, 'no upkeep against the old revision')

  const realConnect = native.connect
  native.connect = async req => { const session = await realConnect(req); const close = session.close; session.close = async () => { await closeGate.promise; return close() }; return session }
  const probe = connection.check('owner-macbook')
  await wait(1)
  let disposed = false
  const disposing = connection.dispose().then(() => { disposed = true })
  await wait(1)
  assert.equal(disposed, false, 'dispose waits for the probe close')
  closeGate.resolve()
  await disposing
  assert.equal((await probe).reachable, true)
  const before = native.sessions.length
  await assert.rejects(connection.target(request), { code: 'TERMINAL_UNAVAILABLE' })
  assert.equal((await connection.check('owner-macbook')).reachable, false)
  assert.equal(native.sessions.length, before, 'nothing starts after dispose')
  const seen = []
  connection.onAvailable(event => seen.push(event))
  await connection.onCredentialEvent({ handle: sshKeyRef, available: true })
  await wait(20)
  assert.deepEqual(seen, [], 'no wanted terminal or observer after dispose')
})

test('a connect suspended across a registry change or dispose runs no C8 command and is closed before dispose resolves', async t => {
  const native = fakeNative()
  const realConnect = native.connect
  let gate = deferred()
  native.connect = async req => { const session = await realConnect(req); await gate.promise; return session }
  const { connection } = setup(t, { native })
  const revised = connection.target(request)
  const probe = connection.check('owner-macbook')
  await wait(1)
  connection.onRegistryChange({ terminalId: 'owner-macbook', revision: 2, removed: false })
  gate.resolve()
  await assert.rejects(revised, { code: 'TERMINAL_UNAVAILABLE', effect: 'not_started' })
  assert.equal((await probe).reachable, false)
  assert.equal(native.calls.some(call => call.op === 'command'), false, 'no claude_* against the old revision')
  assert.equal(connection.maintenance.last('owner-macbook'), null, 'no C8 record for a discarded run')
  assert.ok(native.sessions.every(session => session.closed))

  gate = deferred()
  const closeGate = deferred()
  native.connect = async req => { const session = await realConnect(req); const close = session.close; session.close = async () => { await closeGate.promise; return close() }; await gate.promise; return session }
  const inFlight = connection.target(request)
  await wait(1)
  let disposed = false
  const disposing = connection.dispose().then(() => { disposed = true })
  gate.resolve()
  await wait(1)
  assert.equal(disposed, false, 'dispose waits for the discard-close')
  closeGate.resolve()
  await disposing
  await assert.rejects(inFlight, { code: 'TERMINAL_UNAVAILABLE' })
  assert.equal(native.calls.some(call => call.op === 'command'), false, 'no C8 command after dispose')
  assert.equal(connection.maintenance.last('owner-macbook'), null)
  assert.ok(native.sessions.every(session => session.closed))

  // First claude_version suspended across a revision: no later C8 command starts, no stale record.
  const later = fakeNative()
  const versionGate = deferred()
  const realLaterConnect = later.connect
  later.connect = async req => { const session = await realLaterConnect(req); const command = session.command; session.command = async op => { const result = await command(op); if (op === 'claude_version') await versionGate.promise; return result }; return session }
  const second = setup(t, { native: later })
  const suspended = second.connection.target(request)
  await wait(1)
  second.connection.onRegistryChange({ terminalId: 'owner-macbook', revision: 2, removed: false })
  versionGate.resolve()
  await assert.rejects(suspended, { code: 'TERMINAL_UNAVAILABLE' })
  assert.deepEqual(later.calls.filter(call => call.op === 'command').map(call => call.command), ['claude_version'])
  assert.equal(second.connection.maintenance.last('owner-macbook'), null)
  assert.ok(later.sessions.every(session => session.closed))
})
