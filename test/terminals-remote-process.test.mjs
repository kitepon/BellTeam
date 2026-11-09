import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteTerminalProcesses } from '../src/terminals/remote-process.mjs'

const revision = `sha256:${'c'.repeat(64)}`
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

function fakeClient(responses) {
  const calls = []
  const client = {
    calls,
    closed: false,
    async callTool({ name, arguments: args }) { calls.push({ name, args }); return responses[name]?.(args) ?? json({}) },
    async close() { client.closed = true; client.onclose?.() }
  }
  return client
}

const status = () => json({ trust: { provider: 'aiterm.known-hosts.v1', revision }, credential: { revision: 7, available: true } })
const request = { target: { host: '192.168.1.12', user: 'kite', port: 22, os: 'macos' }, hostTrust: { provider: 'aiterm.known-hosts.v1', revision }, binding: { ref: 'owner-macbook', credentialRevision: 7 } }

test('opens a transient process for C8 commands and closes it', async () => {
  const client = fakeClient({ remote_terminal_status: status, remote_terminal_command: ({ op }) => json({ op, exit_code: 0, version: '2.0.0' }) })
  const native = createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => client, run: async () => {} })
  const session = await native.connect(request)
  assert.deepEqual(client.calls[1], { name: 'remote_terminal_open', args: { ref: 'owner-macbook', target: request.target, trustRevision: revision, credentialRevision: 7 } })
  assert.equal((await session.command('claude_version')).version, '2.0.0')
  await session.close()
  assert.equal(client.calls.at(-1).name, 'remote_terminal_close')
  assert.equal(client.closed, true)

  // A secret-key terminal: Mika handle instead of the native revision (Elegg: never both).
  const keyed = fakeClient({ remote_terminal_status: status })
  await createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => keyed }).connect({ ...request, binding: { ref: 'b', credential: { handle: 'h', revision: 2 }, sudoCredential: { handle: 's', revision: 1 } } })
  const runs = []
  await createRemoteTerminalProcesses({ project: '/srv/bellteam', run: async (command, args, options) => { runs.push({ args, options }) } })
    .loadCredential({ ref: 'b', terminalId: 'friend-mac', handle: 'h', revision: 2, purpose: 'ssh-key', key: 'KEYBYTES' })
  assert.deepEqual(runs[0], { args: ['aiterm-remote-terminal', 'credential-load', '--ref', 'b', '--terminal-id', 'friend-mac', '--handle', 'h', '--revision', '2', '--purpose', 'ssh-key'], options: { input: 'KEYBYTES' } }, 'key on stdin only')
  assert.deepEqual(keyed.calls[1].args, { ref: 'b', target: request.target, trustRevision: revision, credential: { handle: 'h', revision: 2 }, sudoCredential: { handle: 's', revision: 1 } })
})

test('stale trust and tool errors become classified codes and close the process', async () => {
  const stale = fakeClient({ remote_terminal_status: () => json({ trust: { revision: `sha256:${'d'.repeat(64)}` } }) })
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => stale }).connect(request), { code: 'HOST_TRUST_STALE' })
  assert.equal(stale.closed, true)
  const mismatch = fakeClient({ remote_terminal_status: status, remote_terminal_open: () => ({ isError: true, ...json({ code: 'HOST_KEY_MISMATCH', message: 'Host key changed', action: 'confirm the new host key', stderr: 'raw' }) }) })
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => mismatch }).connect(request), error => error.code === 'HOST_KEY_MISMATCH' && error.action === 'confirm the new host key' && !('stderr' in error))
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => { throw new Error('spawn') } }).connect(request), { code: 'REMOTE_AITERM_UNAVAILABLE' })
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => fakeClient({}) }).connect({ ...request, binding: { privateKey: 'k' } }), { code: 'CREDENTIAL_UNUSABLE' })
})

test('trust-confirm exit 2 keeps only the Aiterm error code', async () => {
  const fingerprint = `SHA256:${'A'.repeat(43)}`
  const reply = code => async () => ({ code, stdout: code ? '{"schema":"aiterm.remote-binding-error.v1","code":"UNREACHABLE","message":"raw"}\n' : '' })
  const failing = createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => fakeClient({ remote_terminal_status: status }), run: reply(2) })
  await assert.rejects(failing.confirmHostKey('owner-macbook', fingerprint), error => error.code === 'UNREACHABLE' && error.message === 'Remote terminal command failed')
  const ok = createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => fakeClient({ remote_terminal_status: status }), run: reply(0) })
  assert.equal((await ok.confirmHostKey('owner-macbook', fingerprint)).revision, revision)
})
