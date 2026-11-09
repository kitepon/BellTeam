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
const request = { target: { host: '192.168.1.12', user: 'kite', port: 22, os: 'macos' }, hostTrust: { provider: 'aiterm.known-hosts.v1', revision }, credential: { nativeKeyRef: 'owner-macbook', credentialRevision: 7 } }

test('opens a transient process for C8 commands and closes it', async () => {
  const client = fakeClient({ remote_terminal_status: status, remote_terminal_command: ({ op }) => json({ op, exit_code: 0, version: '2.0.0' }) })
  const native = createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => client, run: async () => {} })
  const session = await native.connect(request)
  assert.deepEqual(client.calls[1], { name: 'remote_terminal_open', args: { ref: 'owner-macbook', target: request.target, trustRevision: revision, credentialRevision: 7 } })
  assert.equal((await session.command('claude_version')).version, '2.0.0')
  await session.close()
  assert.equal(client.calls.at(-1).name, 'remote_terminal_close')
  assert.equal(client.closed, true)
})

test('stale trust and tool errors become classified codes and close the process', async () => {
  const stale = fakeClient({ remote_terminal_status: () => json({ trust: { revision: `sha256:${'d'.repeat(64)}` } }) })
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => stale }).connect(request), { code: 'HOST_TRUST_STALE' })
  assert.equal(stale.closed, true)
  const mismatch = fakeClient({ remote_terminal_status: status, remote_terminal_open: () => ({ isError: true, ...json({ code: 'HOST_KEY_MISMATCH', message: 'Host key changed', action: 'confirm the new host key', stderr: 'raw' }) }) })
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => mismatch }).connect(request), error => error.code === 'HOST_KEY_MISMATCH' && error.action === 'confirm the new host key' && !('stderr' in error))
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => { throw new Error('spawn') } }).connect(request), { code: 'REMOTE_AITERM_UNAVAILABLE' })
  await assert.rejects(createRemoteTerminalProcesses({ project: '/srv/bellteam', connectClient: async () => fakeClient({}) }).connect({ ...request, credential: { privateKey: 'k' } }), { code: 'CREDENTIAL_UNUSABLE' })
})
