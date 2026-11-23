import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalRegistry } from '../src/terminals/registry.mjs'
import { createTerminalConnection } from '../src/terminals/connection.mjs'
import { createCredentialAgent, socketPath, AGENT_ROOT } from '../src/terminals/credential-agent.mjs'
import { createTrustFile, trustFilePath } from '../src/terminals/trust-file.mjs'
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
  const used = calls.filter(call => /ssh-agent|ssh-add/.test(call.args[1]))
  const scripts = used.map(call => call.args[1])
  assert.deepEqual(scripts.map(script => /ssh-agent|ssh-add -l|ssh-add -D|ssh-add - /.exec(script)[0]), ['ssh-add -l', 'ssh-agent', 'ssh-add -l', 'ssh-add -D', 'ssh-add - '])
  assert.ok(scripts[1].includes('ssh-agent -a'))
  assert.ok(scripts[3].includes('ssh-add -D') && scripts[4].includes('ssh-add -'))
  assert.equal(calls.every(call => call.command === '/bin/sh' && call.args[3] === `${AGENT_ROOT}/owner-macbook.sock`), true)
  assert.equal(JSON.stringify(calls.map(call => call.args)).includes('SECRET'), false, 'the key is never in argv')
  assert.equal(used[4].input, key)
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

test('the agent directory must be this user\'s own, mode 700, before its socket is trusted (Epinel #2421); held() says whether a key is in it', async () => {
  const calls = []
  const run = async (command, args) => { calls.push(args[1]); return { code: args[1].includes('stat -c') ? 1 : 0 } }
  const agent = createCredentialAgent({ run })
  await assert.rejects(agent.load('owner-macbook', 'KEY'), { code: 'AGENT_START_FAILED' })
  assert.equal(calls.some(script => script.includes('ssh-add -')), false, 'no key is sent while the directory is not ours')
  assert.equal(await agent.held('owner-macbook'), false)
  const ok = fakeRun({ liveCodes: [0, 1] })
  const held = createCredentialAgent({ run: ok.run })
  assert.equal(await held.held('owner-macbook'), true)
})

test('trust file: rewritten from the copy at every target as UID1000 (tmp, then mv), the directory must be ours and 700, a planted file is never reused', async () => {
  const calls = []
  let exists = false, dirOurs = true
  const run = async (command, args, options = {}) => {
    calls.push({ script: args[1], path: args[3], input: options.input })
    exists = true
    return { code: dirOurs ? 0 : 1 }
  }
  const files = createTrustFile({ run })
  const request = { terminalId: 'owner-macbook', revision, lines: [LINE] }
  const path = await files.ensure(request)
  assert.equal(path, `/tmp/bellteam-terminals/trust/owner-macbook.${'b'.repeat(16)}.known_hosts`)
  assert.equal(calls.at(-1).input, `${LINE}\n`)
  assert.ok(calls[0].script.includes('stat -c %u,%a') && calls[0].script.includes('mv -f'))
  await files.ensure(request)
  assert.equal(calls.filter(call => call.input !== undefined).length, 2, 'an existing file of the same name is rewritten, not trusted')
  dirOurs = false
  await assert.rejects(files.ensure(request), { code: 'TRUST_FILE_FAILED' })
  for (const bad of [{ revision: 'x' }, { lines: [] }, { lines: ['a\nb'] }]) await assert.rejects(files.ensure({ ...request, ...bad }), { code: 'TRUST_FILE_INVALID' })
  assert.match(trustFilePath('../x', revision), /^\/tmp\/bellteam-terminals\/trust\/[0-9a-f]{32}\./)
})

function switched(extra = {}) {
  const native = fakeNative(); native.localVersion = native.remoteVersion = '0.70.102'
  Object.assign(native, { async exportBinding({ ref }) { return exported({ ref }) }, async loadAgent() {}, async agentHeld() { return true }, agentSocket: ({ terminalId }) => `/tmp/bellteam-terminals/agent/${terminalId}.sock`,
    async trustFile({ terminalId, revision: rev }) { return `/tmp/bellteam-terminals/trust/${terminalId}.${rev.slice(7, 23)}.known_hosts` } }, extra)
  return native
}
// A secret-handle key: the key bytes reach the agent, so the generic input can carry it.
async function switchedSetup(t, { native, launchInput = 'remote', trustCopy = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'trust-copy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = createTerminalRegistry({ stateRoot: root })
  await registry.register({ ...base, keySource: 'secret', bindingRef: sshKeyRef })
  if (launchInput) await registry.update('owner-macbook', { launchInput })
  if (trustCopy) await registry.setTrustCopy('owner-macbook', parseExport(exported({ ref: sshKeyRef }), sshKeyRef, 'now'), (await registry.target('owner-macbook')).revision)
  const secrets = { async withResolved(handle, context, consume) { return consume('KEY') }, credential: async handle => ({ handle, revision: 2, available: true }) }
  const connection = createTerminalConnection({ registry, secrets, native, probeDelays: { first: 5, max: 10 } })
  t.after(() => connection.dispose())
  return { registry, connection }
}

test('a switched terminal gets remote + ssh + forward beside terminal; every unmet condition keeps terminal alone and names why', async t => {
  const { connection } = await switchedSetup(t, { native: switched() })
  const target = await connection.target(request)
  assert.ok(target.terminal, 'terminal stays: the fallback and the old engine')
  assert.deepEqual(target.remote, { host: '192.168.1.12', user: 'kite', port: 22,
    ssh: { known_hosts_file: `/tmp/bellteam-terminals/trust/owner-macbook.${'b'.repeat(16)}.known_hosts`, host_key_alias: 'bt-mac', identity_agent: '/tmp/bellteam-terminals/agent/owner-macbook.sock', strict_host_key: true } })
  assert.deepEqual(target.forward, { id: sshKeyRef, to: { host: '127.0.0.1' } })
  assert.deepEqual(connection.maintenance.last('owner-macbook', 'claude-code').input, { outcome: 'remote' })
  const cases = [
    ['AITERM_TOO_OLD', { native: switched(), mutate: native => { native.remoteVersion = '0.70.100' } }],
    ['AITERM_TOO_OLD', { native: switched(), mutate: native => { native.localVersion = '0.70.100' } }],
    ['AGENT_EMPTY', { native: switched({ async agentHeld() { return false } }) }],
    ['TRUST_FILE_FAILED', { native: switched({ async trustFile() { throw new Error('x') } }) }],
    ['TRUST_COPY_MISSING', { native: switched(), trustCopy: false }],
    ['UNSUPPORTED', { native: (() => { const native = fakeNative(); native.localVersion = native.remoteVersion = '0.70.102'; return native })() }]
  ]
  for (const [reason, { native, mutate, trustCopy }] of cases) {
    mutate?.(native)
    const { connection: other } = await switchedSetup(t, { native, trustCopy })
    const result = await other.target(request)
    assert.ok(result.terminal)
    assert.equal('remote' in result || 'forward' in result, false, reason)
    assert.deepEqual(other.maintenance.last('owner-macbook', 'claude-code').input, { outcome: 'terminal', reason })
  }
  const { connection: off } = await switchedSetup(t, { native: switched(), launchInput: null })
  assert.equal('remote' in (await off.target(request)), false, 'a terminal that is not switched never gets the new input')
  assert.equal('input' in off.maintenance.last('owner-macbook', 'claude-code'), false)
})

test('the production core forwards the stage 2-3 native methods and the launchInput switch writes the registry', async t => {
  const { createTerminalsCore } = await import('../src/terminals/core.mjs')
  const root = await mkdtemp(join(tmpdir(), 'trust-core-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const native = switched()
  const seen = []
  for (const name of ['exportBinding', 'loadAgent', 'agentHeld', 'trustFile']) { const original = native[name]; native[name] = async (...args) => { seen.push(name); return original(...args) } }
  const credentials = { async withResolved(handle, context, consume) { return consume('KEY') }, credential: async handle => ({ handle, revision: 2, available: true }), watchCredentials() { return () => {} }, current: () => null }
  const core = createTerminalsCore({ stateRoot: root, credentials, adapter: native, probeDelays: { first: 5, max: 10 } })
  t.after(() => core.close())
  await core.ready
  const registry = createTerminalRegistry({ stateRoot: root })
  await registry.register({ ...base, keySource: 'secret', bindingRef: sshKeyRef })
  await core.launchInput.set('owner-macbook', 'remote')
  assert.equal((await registry.target('owner-macbook')).launchInput, 'remote')
  await core.connection.target(request); await settle()
  assert.deepEqual([...new Set(seen)].sort(), ['exportBinding', 'loadAgent'])
  const second = await core.connection.target(request)
  assert.ok(second.remote && second.forward, 'after the copy and the agent load the switched terminal gets the new input')
  assert.ok(seen.includes('agentHeld') && seen.includes('trustFile'))
  await core.launchInput.set('owner-macbook', null)
  assert.equal('launchInput' in (await registry.target('owner-macbook')), false)
})

test('set_terminal_launch_input is a listed tool that only takes a terminal and remote|terminal', async () => {
  const { terminalTools, callTerminalTool } = await import('../src/terminals-mcp.mjs')
  assert.ok(terminalTools.some(tool => tool.name === 'set_terminal_launch_input'))
  const calls = []
  const terminals = () => ({ launchInput: { set: async (id, input) => { calls.push([id, input]); return { terminalId: id } } } })
  await callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'remote' }, terminals })
  await callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'terminal' }, terminals })
  assert.deepEqual(calls, [['owner-macbook', 'remote'], ['owner-macbook', 'terminal']])
  await assert.rejects(callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'other' }, terminals }), { code: 'INVALID_TERMINAL' })
  await assert.rejects(callTerminalTool({ name: 'set_terminal_launch_input', args: { terminalId: 'owner-macbook', input: 'remote', extra: 1 }, terminals }))
})

test('remoteFor: the remote input of a switched terminal by id, no launch, no C8, no member; reasons otherwise (Tronie ruling B)', async t => {
  const native = switched()
  const { connection } = await switchedSetup(t, { native })
  const result = await connection.remoteFor('owner-macbook')
  assert.deepEqual(Object.keys(result).sort(), ['forward', 'remote', 'revision'])
  assert.equal(result.remote.ssh.identity_agent, '/tmp/bellteam-terminals/agent/owner-macbook.sock')
  assert.deepEqual(result.forward, { id: sshKeyRef, to: { host: '127.0.0.1' } })
  assert.match(result.revision, /^\d+:sha256:[0-9a-f]{64}$/)
  assert.equal(native.calls.some(call => call.op === 'open' || call.op === 'command'), false, 'no C8, no launch')
  assert.deepEqual(await connection.remoteFor('nope'), { reason: 'TERMINAL_NOT_FOUND' })
  const { connection: off } = await switchedSetup(t, { native: switched(), launchInput: null })
  assert.deepEqual(await off.remoteFor('owner-macbook'), { reason: 'NOT_SWITCHED' })
  const { connection: bare } = await switchedSetup(t, { native: switched(), trustCopy: false })
  assert.deepEqual(await bare.remoteFor('owner-macbook'), { reason: 'TRUST_COPY_MISSING' })
})

test('remoteFor after a body restart: an empty agent gets the key again first; if it stays empty the reason is AGENT_EMPTY and nothing falls back', async t => {
  let held = false
  const loaded = []
  const native = switched({ async agentHeld() { return held }, async loadAgent({ terminalId, key }) { loaded.push([terminalId, key]); held = true } })
  const { connection } = await switchedSetup(t, { native })
  const result = await connection.remoteFor('owner-macbook')
  assert.ok(result.remote)
  assert.deepEqual(loaded, [['owner-macbook', 'KEY']], 'the key came from the same callback as a launch')
  const stuck = switched({ async agentHeld() { return false }, async loadAgent() { throw new Error('x') } })
  const { connection: other } = await switchedSetup(t, { native: stuck })
  assert.deepEqual(await other.remoteFor('owner-macbook'), { reason: 'AGENT_EMPTY' })
})

test('a Windows terminal needs Aiterm 0.70.112 on both sides before it gets the remote input; the paths are the same for the same revision', async t => {
  const winRequest = { ...request, projectRoot: 'C:\\Users\\kite\\work' }
  const run = async (remoteVersion, localVersion) => {
    const native = switched(); native.remoteVersion = remoteVersion; native.localVersion = localVersion
    const root = await mkdtemp(join(tmpdir(), 'trust-win-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const registry = createTerminalRegistry({ stateRoot: root })
    await registry.register({ ...base, os: 'windows', keySource: 'secret', bindingRef: sshKeyRef })
    await registry.update('owner-macbook', { launchInput: 'remote' })
    await registry.setTrustCopy('owner-macbook', parseExport(exported({ ref: sshKeyRef }), sshKeyRef, 'now'), (await registry.target('owner-macbook')).revision)
    const connection = createTerminalConnection({ registry, secrets: { async withResolved(h, c, consume) { return consume('KEY') }, credential: async handle => ({ handle, revision: 2, available: true }) }, native, probeDelays: { first: 5, max: 10 } })
    t.after(() => connection.dispose())
    return connection
  }
  const old = await run('0.70.111', '0.70.112')
  assert.equal('remote' in await old.target(winRequest), false)
  assert.deepEqual(old.maintenance.last('owner-macbook', 'claude-code').input, { outcome: 'terminal', reason: 'AITERM_TOO_OLD' })
  const oldLocal = await run('0.70.112', '0.70.111')
  assert.equal('remote' in await oldLocal.target(winRequest), false)
  const ok = await run('0.70.112', '0.70.112')
  const first = await ok.target(winRequest), again = await ok.remoteFor('owner-macbook')
  assert.ok(first.remote)
  assert.equal(again.remote.ssh.known_hosts_file, first.remote.ssh.known_hosts_file, 'remoteFor names the same file for the same revision')
  assert.equal(again.remote.ssh.identity_agent, first.remote.ssh.identity_agent)
})
