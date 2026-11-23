import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalRegistry } from '../src/terminals/registry.mjs'
import { createTerminalConnection } from '../src/terminals/connection.mjs'
import { createCredentialAgent, socketPath, AGENT_ROOT } from '../src/terminals/credential-agent.mjs'
import { EXPORT_SCHEMA, parseExport } from '../src/terminals/trust-copy.mjs'
import { fakeNative, fakeSecrets } from './helpers/terminals-native-double.mjs'

const sshKeyRef = 'a1b2c3d4-1234-4234-8234-123456789abc'
const revision = `sha256:${'b'.repeat(64)}`
const LINE = `[192.168.1.12]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(40)}`
const REF = 'native-' + sshKeyRef
const exported = (over = {}) => ({ schema: EXPORT_SCHEMA, ref: REF, target: { host: '192.168.1.12', user: 'kite', port: 22 }, host_key_alias: 'bt-mac', known_hosts_lines: [LINE],
  fingerprints: ['SHA256:abc'], trust_revision: revision, seat_forward_port: 41000, seat_ingress_port: 4183, ...over })
const request = { terminalId: 'owner-macbook', memberId: 'bot-1', projectRoot: '/Users/kite/work/app', harness: 'claude-code' }
const base = { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', port: 22, os: 'macos', accountOwner: 'owner', sshKeyRef, hostTrust: { provider: 'aiterm.known-hosts.v1', revision } }

async function setup(t, { native = fakeNative(), changes = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'trust-copy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = createTerminalRegistry({ stateRoot: root, onChange: event => changes.push(event) })
  await registry.register(base)
  changes.length = 0
  const connection = createTerminalConnection({ registry, secrets: fakeSecrets(), native, probeDelays: { first: 5, max: 10 } })
  t.after(() => connection.dispose())
  return { root, registry, connection, native }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('parseExport stores only public host-key lines of the asked ref', () => {
  const copy = parseExport(exported(), REF, '2026-11-23T00:00:00.000Z')
  assert.deepEqual(copy, { ref: REF, alias: 'bt-mac', lines: [LINE], fingerprints: ['SHA256:abc'], revision, copiedAt: '2026-11-23T00:00:00.000Z' })
  for (const bad of [{ schema: 'other' }, { ref: 'native-other' }, { known_hosts_lines: [] }, { known_hosts_lines: Array(9).fill(LINE) }, { known_hosts_lines: ['-----BEGIN OPENSSH PRIVATE KEY-----'] },
    { known_hosts_lines: ['host ssh-ed25519 short'] }, { trust_revision: 'sha256:short' }, { fingerprints: 'x' }, { host_key_alias: 'a b' }])
    assert.throws(() => parseExport(exported(bad), REF, 'now'), { code: 'TRUST_EXPORT_INVALID' })
  assert.throws(() => parseExport(null, REF, 'now'), { code: 'TRUST_EXPORT_INVALID' })
})

test('registry: the copy is derived data (no revision bump, no change event), hidden from the lists, cleared when the target changes, dropped when the record moved', async t => {
  const changes = []
  const { registry, root } = await setup(t, { changes })
  const copy = parseExport(exported(), REF, '2026-11-23T00:00:00.000Z')
  assert.equal(await registry.setTrustCopy('owner-macbook', copy, 1), true)
  assert.deepEqual(changes, [], 'no change event: it would re-target every launch in flight')
  assert.equal((await registry.target('owner-macbook')).revision, 1)
  assert.deepEqual((await registry.target('owner-macbook')).trustCopy, copy)
  assert.equal('trustCopy' in (await registry.get('owner-macbook')), false)
  assert.equal(JSON.stringify(await registry.list()).includes(LINE), false)
  assert.equal(await registry.setTrustCopy('owner-macbook', copy, 2), false, 'a copy made for an older revision is dropped')
  assert.equal(await registry.setTrustCopy('nope', copy, 1), false)
  await registry.update('owner-macbook', { port: 2222 })
  assert.equal('trustCopy' in (await registry.target('owner-macbook')), false, 'a different machine is a different host identity')
  await assert.rejects(registry.update('owner-macbook', { trustCopy: copy }), { code: 'INVALID_TERMINAL' })
  assert.match(await readFile(join(root, 'terminals.json'), 'utf8'), /"terminals"/)
})

test('C8 copies the host trust once in the background, joins concurrent launches, and a launch never waits for it', async t => {
  const native = fakeNative(); native.localVersion = native.remoteVersion = '0.70.102'
  const gate = Promise.withResolvers()
  let exports = 0
  native.exportBinding = async ({ ref }) => { exports++; assert.equal(ref, REF); await gate.promise; return exported() }
  const { registry, connection } = await setup(t, { native })
  const [a, b] = await Promise.all([connection.target(request), connection.target({ ...request, harness: 'codex-cli' })])
  assert.ok(a.terminal && b.terminal, 'launches went on while the export was still running')
  assert.equal(exports, 1)
  gate.resolve(); await settle()
  assert.equal((await registry.target('owner-macbook')).trustCopy.revision, revision)
  assert.equal(connection.maintenance.last('owner-macbook', 'claude-code').trust.outcome, 'copied')
  await connection.target(request)
  assert.equal(exports, 1, 'the next open sees the copy equal to Aiterm\'s revision')
  assert.equal(connection.maintenance.last('owner-macbook', 'claude-code').trust.outcome, 'current')
})

test('a failed or stale export never vetoes a launch, stores nothing, and the next open retries', async t => {
  const native = fakeNative()
  const answers = [() => { throw Object.assign(new Error('x'), { code: 'REMOTE_AITERM_UNAVAILABLE' }) }, () => exported({ trust_revision: `sha256:${'c'.repeat(64)}` }), () => ({ schema: 'wrong' }), () => exported()]
  native.exportBinding = async () => answers.shift()()
  const { registry, connection } = await setup(t, { native })
  const expected = [['failed', 'REMOTE_AITERM_UNAVAILABLE'], ['failed', 'TRUST_REVISION_CHANGED'], ['failed', 'TRUST_EXPORT_INVALID'], ['copied', undefined]]
  for (const [outcome, reason] of expected) {
    assert.ok((await connection.target(request)).terminal)
    await settle()
    const trust = connection.maintenance.last('owner-macbook', 'claude-code').trust
    assert.equal(trust.outcome, outcome); assert.equal(trust.reason, reason)
    assert.equal(Boolean((await registry.target('owner-macbook')).trustCopy), outcome === 'copied')
  }
})

test('without Aiterm 0.70.101 (no export) or a registry that cannot store the copy nothing changes', async t => {
  const { connection, registry } = await setup(t)
  assert.ok((await connection.target(request)).terminal)
  assert.equal('trust' in connection.maintenance.last('owner-macbook', 'claude-code'), false)
  assert.equal('trustCopy' in (await registry.target('owner-macbook')), false)
})

test('socket path: a registry slug is kept, anything else is hashed, never a separator', () => {
  assert.equal(socketPath('owner-macbook'), `${AGENT_ROOT}/owner-macbook.sock`)
  for (const odd of ['../etc/passwd', 'A/B', 'x y', '', 'é', 'a'.repeat(80)]) {
    const path = socketPath(odd)
    assert.match(path, /^\/tmp\/bellteam-terminals\/agent\/[0-9a-f]{32}\.sock$/)
  }
  assert.equal(socketPath('A/B'), socketPath('A/B'))
  assert.notEqual(socketPath('A/B'), socketPath('A/C'))
})

function fakeRun({ liveCodes = [2, 0], addCode = 0 } = {}) {
  const calls = []
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input })
    const script = args[1]
    if (script.includes('ssh-add -l')) return { code: liveCodes.shift() ?? 0 }
    if (script.includes('ssh-add - ')) return { code: addCode, stderr: 'key text must never surface' }
    return { code: 0 }
  }
  return { run, calls }
}

test('agent: started only when none answers, old identities deleted, the key only on stdin, never in argv', async () => {
  const { run, calls } = fakeRun()
  const agent = createCredentialAgent({ run })
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----\n'
  await agent.load('owner-macbook', key)
  const scripts = calls.map(call => call.args[1])
  assert.deepEqual(scripts.map(script => /ssh-agent|ssh-add -l|ssh-add -D|ssh-add - /.exec(script)[0]), ['ssh-add -l', 'ssh-agent', 'ssh-add -l', 'ssh-add -D', 'ssh-add - '])
  assert.ok(scripts[1].includes('ssh-agent -a'))
  assert.ok(scripts[3].includes('ssh-add -D') && scripts[4].includes('ssh-add -'))
  assert.equal(calls.every(call => call.command === '/bin/sh' && call.args[3] === `${AGENT_ROOT}/owner-macbook.sock`), true)
  assert.equal(JSON.stringify(calls.map(call => call.args)).includes('SECRET'), false, 'the key is never in argv')
  assert.equal(calls[4].input, key)
  assert.equal(calls.filter(call => call.input !== undefined).length, 1)
})

test('agent: a live agent is reused (no second start); a failed add reports a code and never the output', async () => {
  const live = fakeRun({ liveCodes: [1] })
  await createCredentialAgent({ run: live.run }).load('owner-macbook', 'KEY')
  assert.equal(live.calls.filter(call => call.args[1].includes('ssh-agent -a')).length, 0)
  const bad = fakeRun({ liveCodes: [0], addCode: 1 })
  await assert.rejects(createCredentialAgent({ run: bad.run }).load('owner-macbook', 'KEY'), error => error.code === 'AGENT_LOAD_FAILED' && !String(error.message + error.stack).includes('key text'))
  const none = fakeRun({ liveCodes: [2, 2] })
  await assert.rejects(createCredentialAgent({ run: none.run }).load('owner-macbook', 'KEY'), { code: 'AGENT_START_FAILED' })
  await assert.rejects(createCredentialAgent({ run: live.run }).load('owner-macbook', ''), { code: 'CREDENTIAL_UNUSABLE' })
})

test('loadKey feeds the same bytes to the agent after Aiterm took them; an agent failure never fails the launch and shows in the evidence', async t => {
  const native = fakeNative()
  const fed = []
  native.loadAgent = async ({ terminalId, key }) => { fed.push([terminalId, key.length]); if (native.agentFails) throw Object.assign(new Error('x'), { code: 'AGENT_LOAD_FAILED' }) }
  const root = await mkdtemp(join(tmpdir(), 'trust-copy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = createTerminalRegistry({ stateRoot: root })
  await registry.register({ ...base, keySource: 'terminal-native' })
  const secrets = { async withResolved(handle, context, consume) { return consume('KEY-BYTES') }, credential: async handle => ({ handle, revision: 2, available: true }) }
  const keyless = { ...base, keySource: 'secret', bindingRef: sshKeyRef }
  const target = { ...keyless }; await registry.remove('owner-macbook'); await registry.register(target)
  const connection = createTerminalConnection({ registry, secrets, native, probeDelays: { first: 5, max: 10 } })
  t.after(() => connection.dispose())
  assert.ok((await connection.target(request)).terminal)
  assert.deepEqual(fed, [['owner-macbook', 9]])
  assert.equal(connection.maintenance.last('owner-macbook', 'claude-code').agent.outcome, 'loaded')
  native.agentFails = true
  assert.ok((await connection.target(request)).terminal, 'the launch goes on')
  assert.deepEqual(connection.maintenance.last('owner-macbook', 'claude-code').agent, { outcome: 'failed', reason: 'AGENT_LOAD_FAILED' })
  assert.equal(native.calls.filter(call => call.op === 'loadCredential').length >= 2, true, 'Aiterm still got the key every time')
})
