import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalsCore } from '../src/terminals/core.mjs'
import { fakeNative } from './helpers/terminals-native-double.mjs'

// Self-service step 3 (terminals README "Self-service registration and assignment"): check evidence reasons,
// provisioning, folder inspect/create and the one-time login password -> authorize-key.
const nativeHandle = 'a9b2c3d4-1234-4234-8234-123456789abc'
const loginA = 'b1b2c3d4-1234-4234-8234-123456789abc'
const loginB = 'b2b2c3d4-1234-4234-8234-123456789abc'
const mac = { terminalId: 'owner-macbook', host: '192.168.1.12', user: 'kite', os: 'macos', accountOwner: 'owner' }

function fakeCredentials() {
  const listeners = new Set()
  const calls = []
  const ids = [loginA, loginB]
  let next = 0
  const consumed = new Set()
  return {
    calls,
    emit(event) { for (const listener of listeners) listener(event) },
    async requestTerminalKey(input) { calls.push({ op: 'request', purpose: input.purpose }); return { secretRequest: { id: ids[next++ % ids.length], label: input.label, inputOptions: { preferred: 'stored' } } } },
    watchCredentials(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async unbind(ref, scope) { calls.push({ op: 'unbind', ref, purpose: scope.purpose }) },
    credential(ref) { return { handle: ref, revision: 1, available: true } },
    async withResolved(ref, context, consume) {
      if (context.purpose === 'terminal.login') {
        // Mika #855: revoked first, consumed once.
        if (consumed.has(ref)) throw Object.assign(new Error('closed'), { code: 'SECRET_REQUEST_CLOSED' })
        consumed.add(ref)
        calls.push({ op: 'consume', ref })
        return consume('correct horse')
      }
      return consume({ nativeKeyRef: 'native-binding', revision: 3 })
    }
  }
}

async function setup(t, native = fakeNative()) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'terminals-self-service-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const credentials = fakeCredentials()
  const core = createTerminalsCore({ stateRoot, credentials, adapter: native })
  t.after(() => core.close())
  return { core, native, credentials }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

test('check passes evidence reasons with a fix, and provisions a Mac without Aiterm once', async t => {
  const { core, native } = await setup(t)
  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })

  native.connectError = Object.assign(new Error('x'), { code: 'CONNECTION_REFUSED' })
  const refused = await core.reachability.check('owner-macbook')
  assert.equal(refused.reason, 'CONNECTION_REFUSED')
  assert.match(refused.action, /Remote Login/)
  native.connectError = Object.assign(new Error('x'), { code: 'AUTH_FAILED' })
  assert.match((await core.reachability.check('owner-macbook')).action, /authorize/)

  // Missing Aiterm: provision once, then reopen once.
  let opens = 0
  const connect = native.connect
  native.connectError = undefined
  native.connect = async request => { if (opens++ === 0) throw Object.assign(new Error('x'), { code: 'REMOTE_AITERM_UNAVAILABLE' }); return connect(request) }
  assert.equal((await core.reachability.check('owner-macbook')).reachable, true)
  assert.deepEqual(native.calls.filter(c => c.op === 'provision'), [{ op: 'provision', ref: 'native-binding' }])

  // Provision failure keeps the original reason.
  native.connect = async () => { throw Object.assign(new Error('x'), { code: 'REMOTE_AITERM_TOO_OLD' }) }
  native.provision = async () => { throw Object.assign(new Error('x'), { code: 'PROVISION_FAILED' }) }
  assert.equal((await core.reachability.check('owner-macbook')).reason, 'REMOTE_AITERM_TOO_OLD')
})

test('folder: inspect, create on request, permission refusal and availability as reasons', async t => {
  const { core, native } = await setup(t)
  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })
  const path = '/Users/kite/BellTeam/crust'
  assert.throws(() => core.folder({ terminalId: 'owner-macbook', path: 'BellTeam/crust' }), { code: 'INVALID_PATH' })
  assert.throws(() => core.folder({ terminalId: 'owner-macbook', path: '/Users/kite/../x' }), { code: 'INVALID_PATH' })

  native.pathResult = () => ({ exists: false, directory: false, writable: false })
  const missing = await core.folder({ terminalId: 'owner-macbook', path })
  assert.equal(missing.reason, 'FOLDER_MISSING')
  assert.ok(missing.action)
  native.pathResult = op => (op === 'make_dir' ? { exists: true, directory: true, writable: true } : { exists: false, directory: false, writable: false })
  const created = await core.folder({ terminalId: 'owner-macbook', path, create: true })
  assert.deepEqual([created.reason, created.exists, created.directory, created.writable], [null, true, true, true])
  assert.deepEqual(native.calls.filter(c => c.op === 'command' && c.command === 'make_dir').map(c => c.args), [{ path }])

  native.pathResult = () => { throw Object.assign(new Error('x'), { code: 'FOLDER_NOT_PERMITTED' }) }
  assert.equal((await core.folder({ terminalId: 'owner-macbook', path: '/Users/kite/Documents/app' })).reason, 'FOLDER_NOT_PERMITTED')
  native.connectError = Object.assign(new Error('x'), { code: 'UNREACHABLE' })
  assert.equal((await core.folder({ terminalId: 'owner-macbook', path })).reason, 'UNREACHABLE', 'same evidence reason as check')
  assert.equal((await core.folder({ terminalId: 'nope', path })).reason, 'TERMINAL_NOT_FOUND')
})

test('authorize: no password before trust; one consume to authorize-key; stale or superseded cards are dropped', async t => {
  const { core, native, credentials } = await setup(t)
  await core.registry.put({ terminalId: 'friend-mac', host: '192.168.1.40', user: 'yui', os: 'macos', accountOwner: 'terminal-owner' })
  await assert.rejects(core.keys.authorize('friend-mac'), { code: 'HOST_TRUST_MISSING', status: 409 })
  assert.equal(credentials.calls.some(c => c.op === 'request'), false, 'no card before trust')

  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })
  const { secretRequest } = await core.keys.authorize('owner-macbook')
  assert.equal(credentials.calls.at(-1).purpose, 'terminal.login')
  assert.equal((await core.registry.get('owner-macbook')).keyAuthorizationPending, true)

  // An event for another request is dropped (Mika value unbound), the pending one is consumed once.
  credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: 'h-other', revision: 1, available: true, requestId: 'other' })
  credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: 'h-login', revision: 1, available: true, requestId: secretRequest.id })
  await settle()
  assert.deepEqual(credentials.calls.filter(c => c.op === 'unbind').map(c => c.ref), ['h-other'])
  assert.deepEqual(native.calls.filter(c => c.op === 'authorizeKey'), [{ op: 'authorizeKey', ref: 'native-binding', passwordLength: 13 }])
  const after = await core.registry.get('owner-macbook')
  assert.equal(after.keyAuthorizationPending, false)
  assert.deepEqual([after.keyAuthorization.requestId, after.keyAuthorization.outcome], [secretRequest.id, 'AUTHORIZED'])
  assert.equal(JSON.stringify(after).includes('correct horse'), false)

  // Wrong password: Aiterm's code becomes the outcome; a target change before submit drops the card unconsumed.
  native.authorizeKey = async () => { throw Object.assign(new Error('x'), { code: 'PASSWORD_REJECTED' }) }
  const second = await core.keys.authorize('owner-macbook')
  credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: 'h2', revision: 1, available: true, requestId: second.secretRequest.id })
  await settle()
  assert.equal((await core.registry.get('owner-macbook')).keyAuthorization.outcome, 'PASSWORD_REJECTED')

  const third = await core.keys.authorize('owner-macbook')
  await core.registry.put({ terminalId: 'owner-macbook', user: 'kite2' })
  credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: 'h3', revision: 1, available: true, requestId: third.secretRequest.id })
  await settle()
  assert.equal((await core.registry.get('owner-macbook')).keyAuthorization.outcome, 'TERMINAL_CHANGED')
  assert.equal(credentials.calls.some(c => c.op === 'consume' && c.ref === 'h3'), false)
  assert.ok(credentials.calls.some(c => c.op === 'unbind' && c.ref === 'h3'))
})

test('HTTP: authorize and folder routes refuse secrets and malformed bodies', async t => {
  const { createTerminalsApi } = await import('../src/http-terminals-api.mjs')
  const { Readable } = await import('node:stream')
  const { core } = await setup(t)
  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })
  const api = createTerminalsApi({ terminals: () => core, internal: false })
  const call = async (method, path, body) => {
    const request = Readable.from(body ? [Buffer.from(body)] : [])
    Object.assign(request, { method, headers: {} })
    let status, payload
    const response = { writeHead(code) { status = code }, setHeader() {}, end(text) { payload = JSON.parse(text) } }
    await api(request, response, new URL(`http://h${path}`))
    return { status, error: payload.error, payload }
  }
  assert.deepEqual((({ status, error }) => ({ status, error }))(await call('POST', '/api/terminals/owner-macbook/keys/ssh/authorize', '{"password":"x"}')), { status: 400, error: 'KEY_IN_REQUEST_REFUSED' })
  assert.equal((await call('POST', '/api/terminals/owner-macbook/keys/sudo/authorize')).error, 'INVALID_KEY_KIND')
  assert.ok((await call('POST', '/api/terminals/owner-macbook/keys/ssh/authorize')).payload.secretRequest.id)
  assert.equal((await call('POST', '/api/terminals/owner-macbook/folder', '{"path":"/Users/kite/x","mode":"x"}')).error, 'INVALID_PATH')
  assert.equal((await call('POST', '/api/terminals/owner-macbook/folder', '{"path":"/Users/kite/x"}')).payload.reason, null)
})
