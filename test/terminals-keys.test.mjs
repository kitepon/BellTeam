import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalsCore } from '../src/terminals/core.mjs'
import { createTerminalsApi } from '../src/http-terminals-api.mjs'
import { fakeNative } from './helpers/terminals-native-double.mjs'

const requestId = 'e1b2c3d4-1234-4234-8234-123456789abc'
const handle = 'f1b2c3d4-1234-4234-8234-123456789abc'
const terminal = { terminalId: 'friend-mac', host: '192.168.1.40', user: 'yui', os: 'macos', accountOwner: 'terminal-owner' }

// Mika's contract (2026-11-09): requestTerminalKey / watchCredentials event / current / unbind.
function fakeCredentials() {
  const listeners = new Set()
  const calls = []
  let current = null
  return {
    calls,
    setCurrent(value) { current = value },
    emit(event) { for (const listener of listeners) listener(event) },
    async requestTerminalKey(input) { calls.push({ op: 'request', input }); return { secretRequest: { id: requestId, label: input.label, inputOptions: { preferred: 'onepassword' } } } },
    watchCredentials(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    current(scope) { calls.push({ op: 'current', scope }); return current },
    async unbind(ref, scope) { calls.push({ op: 'unbind', ref, scope }) },
    credential(ref) { return { handle: ref, revision: 1, available: true } },
    async withResolved() { throw new Error('a secret key is never resolved by terminals') }
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

test('the app sets a key through the secret card; terminals never sees the value', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-keys-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const native = fakeNative()
  const credentials = fakeCredentials()
  const core = createTerminalsCore({ stateRoot, credentials, adapter: native })
  t.after(() => core.close())
  await core.registry.put(terminal)
  await assert.rejects(core.registry.put({ terminalId: 'friend-mac', keySource: 'secret' }), { code: 'INVALID_TERMINAL', status: 400 })

  const { secretRequest } = await core.keys.request('friend-mac', 'ssh')
  assert.equal(secretRequest.id, requestId)
  assert.deepEqual(credentials.calls[0].input, { terminalId: 'friend-mac', purpose: 'terminal.ssh', label: 'SSH key for terminal friend-mac' })
  assert.deepEqual(native.calls.find(call => call.op === 'register').target, { host: '192.168.1.40', user: 'yui', port: 22 }, 'keyless Aiterm binding')
  assert.equal((await core.registry.get('friend-mac')).sshKeyPending, true)

  credentials.emit({ terminalId: 'other', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision' })
  credentials.emit({ terminalId: 'friend-mac', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision' })
  await settle()
  const keyed = await core.registry.get('friend-mac')
  assert.deepEqual([keyed.sshKeyConfigured, keyed.keySource, keyed.sshKeyPending], [true, 'secret', false])
  assert.equal(JSON.stringify(keyed).includes(handle), false, 'the handle stays internal')
  assert.equal(await core.registry.get('other'), null)

  const removed = await core.keys.remove('friend-mac', 'ssh')
  assert.deepEqual(credentials.calls.find(call => call.op === 'unbind'), { op: 'unbind', ref: handle, scope: { terminalId: 'friend-mac', purpose: 'terminal.ssh' } })
  assert.deepEqual([removed.sshKeyConfigured, removed.keySource], [false, null])
  await assert.rejects(core.keys.request('friend-mac', 'root'), { code: 'INVALID_KEY_KIND', status: 400 })
  await assert.rejects(core.keys.request('nobody', 'ssh'), { code: 'TERMINAL_NOT_FOUND', status: 404 })

  // An event missed while BellTeam was down is recovered from Mika's current handle at start.
  await core.keys.request('friend-mac', 'sudo')
  credentials.setCurrent({ handle, revision: 1, available: true })
  const restarted = createTerminalsCore({ stateRoot, credentials, adapter: native })
  t.after(() => restarted.close())
  await restarted.ready
  const recovered = await restarted.registry.get('friend-mac')
  assert.deepEqual([recovered.sudoKeyConfigured, recovered.sudoKeySource, recovered.sudoKeyPending], [true, 'secret', false])
})

test('the key route refuses any key or reference in the request body', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-keys-http-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const core = createTerminalsCore({ stateRoot, credentials: fakeCredentials(), adapter: fakeNative() })
  t.after(() => core.close())
  await core.registry.put(terminal)
  const api = createTerminalsApi({ terminals: () => core, internal: false })
  const call = async (method, path, body) => {
    const request = Readable.from(body ? [Buffer.from(body)] : [])
    request.method = method
    request.headers = {}
    let status, payload
    const response = { writeHead(code) { status = code }, setHeader() {}, end(text) { payload = JSON.parse(text) } }
    await api(request, response, new URL(`http://h${path}`))
    return { status, payload }
  }
  const refused = await call('POST', '/api/terminals/friend-mac/keys/ssh', JSON.stringify({ key: '-----BEGIN OPENSSH PRIVATE KEY-----' }))
  assert.equal(refused.status, 400)
  assert.equal(refused.payload.error, 'KEY_IN_REQUEST_REFUSED')
  assert.equal(JSON.stringify(refused.payload).includes('BEGIN'), false)
  const opened = await call('POST', '/api/terminals/friend-mac/keys/ssh')
  assert.equal(opened.status, 200)
  assert.equal(opened.payload.secretRequest.id, requestId)
  assert.equal((await call('DELETE', '/api/terminals/friend-mac/keys/ssh')).payload.terminal.sshKeyConfigured, false)
})
