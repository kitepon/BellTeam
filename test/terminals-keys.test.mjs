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
const requestB = 'e2b2c3d4-1234-4234-8234-123456789abc'
const nativeHandle = 'a9b2c3d4-1234-4234-8234-123456789abc'
const fingerprint = `SHA256:${'A'.repeat(43)}`
const handle = 'f1b2c3d4-1234-4234-8234-123456789abc'
const terminal = { terminalId: 'friend-mac', host: '192.168.1.40', user: 'yui', os: 'macos', accountOwner: 'terminal-owner' }

// Mika's contract (2026-11-09): requestTerminalKey / watchCredentials event / current / unbind.
function fakeCredentials() {
  const listeners = new Set()
  const calls = []
  let current = null
  const ids = [requestId, requestB]
  let next = 0
  return {
    calls,
    setCurrent(value) { current = value },
    emit(event) { for (const listener of listeners) listener(event) },
    async requestTerminalKey(input) { calls.push({ op: 'request', input }); return { secretRequest: { id: ids[next++ % ids.length], label: input.label, inputOptions: { preferred: 'onepassword' } } } },
    watchCredentials(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    current(scope) { calls.push({ op: 'current', scope }); return typeof current === 'function' ? current() : current },
    async unbind(ref, scope) { calls.push({ op: 'unbind', ref, scope }) },
    credential(ref) { return { handle: ref, revision: 1, available: true } },
    // Native handle -> Aiterm ref (registerNative); a card handle -> its value, only for terminals' own credential-load.
    async withResolved(ref, context, consume) { calls.push({ op: 'resolve', ref }); return consume(ref === nativeHandle ? { nativeKeyRef: 'native-binding', revision: 3 } : 'KEYBYTES') }
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
  assert.deepEqual(credentials.calls[0].input, { terminalId: 'friend-mac', purpose: 'terminal.ssh', label: '端末 friend-mac のSSH鍵' })
  assert.deepEqual(native.calls.find(call => call.op === 'register').target, { host: '192.168.1.40', user: 'yui', port: 22 }, 'keyless Aiterm binding')
  assert.equal((await core.registry.get('friend-mac')).sshKeyPending, true)

  credentials.emit({ terminalId: 'other', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision', requestId })
  credentials.emit({ terminalId: 'friend-mac', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision', requestId: requestB })
  await settle()
  assert.equal((await core.registry.get('friend-mac')).sshKeyConfigured, false, 'another request id is not the pending one')
  credentials.emit({ terminalId: 'friend-mac', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision', requestId })
  await settle()
  const keyed = await core.registry.get('friend-mac')
  assert.deepEqual([keyed.sshKeyConfigured, keyed.keySource, keyed.sshKeyPending], [true, 'secret', false])
  assert.equal(JSON.stringify(keyed).includes(handle), false, 'the handle stays internal')
  assert.equal(await core.registry.get('other'), null)

  const removed = await core.keys.remove('friend-mac', 'ssh')
  assert.deepEqual(credentials.calls.find(call => call.op === 'unbind'), { op: 'unbind', ref: handle, scope: { terminalId: 'friend-mac', purpose: 'terminal.ssh' } })
  assert.deepEqual([removed.sshKeyConfigured, removed.keySource], [false, null])
  for (const kind of ['root', 'constructor', '__proto__']) await assert.rejects(core.keys.request('friend-mac', kind), { code: 'INVALID_KEY_KIND', status: 400 })
  await assert.rejects(core.keys.request('nobody', 'ssh'), { code: 'TERMINAL_NOT_FOUND', status: 404 })

  // An event missed while BellTeam was down is recovered from Mika's current handle at start.
  await core.keys.request('friend-mac', 'sudo')
  credentials.setCurrent({ handle, revision: 1, available: true, requestId: requestB })
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

test('DELETE, replacement and a target change win over a late card; close joins in-flight key work', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-keys-stale-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const native = fakeNative()
  const credentials = fakeCredentials()
  const core = createTerminalsCore({ stateRoot, credentials, adapter: native })
  t.after(() => core.close())
  await core.registry.put(terminal)
  const late = id => credentials.emit({ terminalId: 'friend-mac', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision', requestId: id })

  await core.keys.request('friend-mac', 'ssh') // A
  await core.keys.remove('friend-mac', 'ssh')
  assert.deepEqual(credentials.calls.findLast(call => call.op === 'unbind'), { op: 'unbind', ref: null, scope: { terminalId: 'friend-mac', purpose: 'terminal.ssh' } }, 'pending-only DELETE cancels the scope')
  late(requestId)
  await settle()
  assert.equal((await core.registry.get('friend-mac')).sshKeyConfigured, false, 'DELETE wins over the late card')

  await core.keys.request('friend-mac', 'ssh') // B replaces nothing pending; then A again replaces B
  await core.keys.request('friend-mac', 'ssh')
  late(requestB)
  await settle()
  assert.equal((await core.registry.get('friend-mac')).sshKeyConfigured, false, 'a replaced request does not bind')

  const bound = await core.registry.get('friend-mac')
  await core.registry.put({ terminalId: 'friend-mac', host: '192.168.1.41' })
  const moved = await core.registry.get('friend-mac')
  assert.deepEqual([moved.sshKeyPending, moved.hostTrust], [false, undefined], 'a new target drops the old pending request and trust')
  late(requestId)
  await settle()
  assert.equal((await core.registry.get('friend-mac')).sshKeyConfigured, false, 'a late card for the old target is ignored')
  const registers = native.calls.filter(call => call.op === 'register').length
  await core.keys.request('friend-mac', 'ssh')
  assert.equal(native.calls.filter(call => call.op === 'register').length, registers + 1, 'the new target gets its own Aiterm binding')
  assert.deepEqual(native.calls.filter(call => call.op === 'register').at(-1).target, { host: '192.168.1.41', user: 'yui', port: 22 })
  await assert.rejects(core.registry.put({ terminalId: 'friend-mac', host: '192.168.1.42', confirmHostKey: `SHA256:${'A'.repeat(43)}` }), { code: 'INVALID_TERMINAL' })
  void bound

  // close joins startup reconciliation before the credential provider may close.
  let release
  credentials.setCurrent(() => new Promise(resolve => { release = () => resolve({ handle, revision: 1, available: true, requestId }) }))
  const restarted = createTerminalsCore({ stateRoot, credentials, adapter: native })
  let closed = false
  const closing = restarted.close().then(() => { closed = true })
  await settle()
  assert.equal(closed, false, 'close waits for reconciliation in flight')
  release()
  await closing
})

test('mounted core: a card key is loaded into Aiterm before its own check; a native terminal moved to a new host gets a new binding', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-keys-core-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const native = fakeNative()
  const credentials = fakeCredentials()
  const core = createTerminalsCore({ stateRoot, credentials, adapter: native })
  t.after(() => core.close())
  const registered = 'd1b2c3d4-1234-4234-8234-123456789abc'

  // Card key through the real core seam (lazy adapter forwards loadCredential).
  await core.registry.put(terminal)
  await core.keys.request('friend-mac', 'ssh')
  credentials.emit({ terminalId: 'friend-mac', purpose: 'terminal.ssh', handle, revision: 1, available: true, reason: 'revision', requestId })
  await settle()
  await core.registry.put({ terminalId: 'friend-mac', confirmHostKey: fingerprint })
  assert.equal(native.calls.find(call => call.op === 'confirmHostKey').ref, registered)
  assert.equal((await core.reachability.check('friend-mac')).reachable, true)
  const load = native.calls.findIndex(call => call.op === 'loadCredential')
  assert.ok(load >= 0 && load < native.calls.findIndex(call => call.op === 'open'), 'key loaded before the open')
  assert.deepEqual((({ op, ref, handle: h, purpose }) => ({ op, ref, h, purpose }))(native.calls[load]), { op: 'loadCredential', ref: registered, h: handle, purpose: 'ssh-key' })

  // Native Owner terminal -> host change: the old native binding is neither reused nor auto-trusted.
  await core.registry.put({ terminalId: 'owner-mac', host: '192.168.1.12', user: 'kite', os: 'macos', accountOwner: 'owner', sshKeyRef: nativeHandle })
  assert.equal((await core.registry.get('owner-mac')).keySource, 'terminal-native')
  const moved = await core.registry.put({ terminalId: 'owner-mac', host: '192.168.1.13' })
  assert.deepEqual([moved.sshKeyConfigured, moved.keySource, moved.hostTrust], [false, null, undefined])
  assert.deepEqual(credentials.calls.find(call => call.op === 'unbind'), { op: 'unbind', ref: nativeHandle, scope: { terminalId: 'owner-mac', purpose: 'terminal.ssh' } })
  const trustsBefore = native.calls.filter(call => call.op === 'trust').length
  await core.registry.put({ terminalId: 'owner-mac', user: 'kite' })
  assert.equal(native.calls.filter(call => call.op === 'trust').length, trustsBefore, 'no auto-trust from the old binding')
  await core.keys.request('owner-mac', 'ssh')
  assert.deepEqual(native.calls.filter(call => call.op === 'register').at(-1).target, { host: '192.168.1.13', user: 'kite', port: 22 }, 'a new binding for the new target')
  assert.equal(native.calls.some(call => call.op === 'confirmHostKey' && call.ref === 'native-binding'), false)
})

test('S2 trust attest: keyless binding first, trust only on Aiterm equality, key setting reuses the binding', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-trust-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const native = fakeNative()
  const core = createTerminalsCore({ stateRoot, credentials: fakeCredentials(), adapter: native })
  t.after(() => core.close())
  await core.registry.put(terminal)
  const api = createTerminalsApi({ terminals: () => core, internal: false })
  const call = async (method, path, body) => {
    const request = Readable.from(body ? [Buffer.from(body)] : [])
    request.method = method
    request.headers = {}
    let status, payload
    const response = { writeHead(code) { status = code }, setHeader() {}, end(text) { payload = JSON.parse(text) } }
    try { await api(request, response, new URL(`http://h${path}`)) } catch (error) { status = error.status; payload = { error: error.code } }
    return { status, payload }
  }

  assert.equal((await call('POST', '/api/terminals/friend-mac/trust', JSON.stringify({ fingerprint, host: 'x' }))).status, 400)
  assert.deepEqual((await call('POST', '/api/terminals/nope/trust', JSON.stringify({ fingerprint }))).payload, { error: 'TERMINAL_NOT_FOUND' })

  // Unreachable scan: nothing written, 503.
  native.confirmHostKey = async () => { throw Object.assign(new Error('x'), { code: 'UNREACHABLE' }) }
  assert.deepEqual(await call('POST', '/api/terminals/friend-mac/trust', JSON.stringify({ fingerprint })), { status: 503, payload: { error: 'TERMINAL_UNAVAILABLE' } })
  // Another machine answers: 409, nothing written.
  native.confirmHostKey = async () => { throw Object.assign(new Error('x'), { code: 'HOST_KEY_FINGERPRINT_MISMATCH' }) }
  assert.deepEqual(await call('POST', '/api/terminals/friend-mac/trust', JSON.stringify({ fingerprint })), { status: 409, payload: { error: 'HOST_KEY_FINGERPRINT_MISMATCH' } })
  assert.equal((await core.registry.get('friend-mac')).hostTrust, undefined)

  delete native.confirmHostKey
  native.confirmHostKey = async (ref, value) => { native.calls.push({ op: 'confirmHostKey', ref, fingerprint: value }); return { provider: 'aiterm.known-hosts.v1', revision: `sha256:${'b'.repeat(64)}` } }
  const ok = await call('POST', '/api/terminals/friend-mac/trust', JSON.stringify({ fingerprint }))
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.terminal.hostTrust.revision, `sha256:${'b'.repeat(64)}`)
  assert.equal(ok.payload.terminal.bindingRef, undefined, 'binding ref stays internal')
  const registered = 'd1b2c3d4-1234-4234-8234-123456789abc'
  assert.equal(native.calls.find(c => c.op === 'confirmHostKey').ref, registered)
  await core.keys.request('friend-mac', 'ssh')
  assert.equal(native.calls.filter(c => c.op === 'register').length, 1, 'key setting reuses the attest binding')
})
