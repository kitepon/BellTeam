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
  assert.match(refused.action, /リモートログイン/)
  native.connectError = Object.assign(new Error('x'), { code: 'AUTH_FAILED' })
  assert.match((await core.reachability.check('owner-macbook')).action, /このMacにこの鍵を入れる/)

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

test('folders: picker lists subfolders from home, opens one, and reports missing, permission and availability as reasons', async t => {
  const { core, native } = await setup(t)
  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })
  assert.throws(() => core.folders({ terminalId: 'owner-macbook', path: 'Developer' }), { code: 'INVALID_PATH' })

  const home = await core.folders({ terminalId: 'owner-macbook' })
  assert.deepEqual([home.reason, home.home, home.path, home.parent, home.truncated], [null, '/Users/kite', '/Users/kite', '/Users', false])
  assert.deepEqual(home.entries, [{ name: 'BellTeam', path: '/Users/kite/BellTeam' }, { name: 'Developer', path: '/Users/kite/Developer' }])
  assert.deepEqual(native.calls.filter(c => c.command === 'list_dirs').map(c => c.args), [{}], 'home = no path')

  native.listResult = ({ path }) => ({ op: 'list_dirs', home: '/Users/kite', path, entries: [{ name: '.git' }, { name: 'a/b' }, { name: 'app' }], truncated: false })
  const sub = await core.folders({ terminalId: 'owner-macbook', path: '/Users/kite/Developer' })
  assert.deepEqual([sub.path, sub.parent, sub.entries], ['/Users/kite/Developer', '/Users/kite', [{ name: 'app', path: '/Users/kite/Developer/app' }]], 'hidden and malformed names left out')
  native.listResult = () => ({ op: 'list_dirs', home: '/', path: '/', entries: Array.from({ length: 501 }, (_, i) => ({ name: `d${i}` })), truncated: false })
  const root = await core.folders({ terminalId: 'owner-macbook', path: '/' })
  assert.deepEqual([root.parent, root.entries.length, root.entries[0].path, root.truncated], [null, 500, '/d0', true])

  native.listResult = () => ({ op: 'list_dirs', exists: false, directory: false })
  assert.equal((await core.folders({ terminalId: 'owner-macbook', path: '/Users/kite/gone' })).reason, 'FOLDER_MISSING')
  native.listResult = () => { throw Object.assign(new Error('x'), { code: 'FOLDER_NOT_PERMITTED' }) }
  const denied = await core.folders({ terminalId: 'owner-macbook', path: '/Users/kite/Desktop' })
  assert.deepEqual([denied.reason, denied.entries], ['FOLDER_NOT_PERMITTED', []])
  assert.ok(denied.action)
  native.connectError = Object.assign(new Error('x'), { code: 'UNREACHABLE' })
  const offline = await core.folders({ terminalId: 'owner-macbook' })
  assert.deepEqual([offline.reason, offline.entries, offline.home], ['UNREACHABLE', [], null], 'offline is a reason, not an empty folder')
  assert.match(offline.action, /Macが起きて/)
  assert.equal((await core.folders({ terminalId: 'nope' })).reason, 'TERMINAL_NOT_FOUND')
})

test('Windows and Linux: native path forms for the picker, the folder check and the launch target', async t => {
  const { isTerminalPath, parentPath, defaultProjectRoot } = await import('../src/terminals/paths.mjs')
  for (const [os, path, ok] of [['windows', 'C:\\', true], ['windows', 'C:\\Users\\kite_', true], ['windows', 'C:/Users', false], ['windows', 'C:\\Users\\', false],
    ['windows', 'C:\\a\\..\\b', false], ['windows', '/home/kite', false], ['linux', '/home/kite', true], ['linux', 'C:\\Users', false], ['linux', '/home/', false]])
    assert.equal(isTerminalPath(os, path), ok, `${os} ${path}`)
  assert.deepEqual([parentPath('windows', 'C:\\Users'), parentPath('windows', 'C:\\'), parentPath('linux', '/home')], ['C:\\', null, '/'])
  assert.deepEqual([defaultProjectRoot('windows', 'kite_', 'a'), defaultProjectRoot('linux', 'kite', 'a')], ['C:\\Users\\kite_\\BellTeam\\a', '/home/kite/BellTeam/a'])

  const { core, native } = await setup(t)
  await core.registry.put({ ...mac, terminalId: 'fox', os: 'windows', user: 'kite_', sshKeyRef: nativeHandle })
  native.listResult = () => ({ op: 'list_dirs', home: 'C:\\Users\\kite_', path: 'C:\\Users\\kite_', entries: [{ name: 'Developer' }, { name: 'a\\b' }, { name: 'c:' }], truncated: false })
  const home = await core.folders({ terminalId: 'fox' })
  assert.deepEqual([home.reason, home.home, home.parent, home.entries], [null, 'C:\\Users\\kite_', 'C:\\Users', [{ name: 'Developer', path: 'C:\\Users\\kite_\\Developer' }]])
  await assert.rejects(core.folders({ terminalId: 'fox', path: '/Users/kite' }), { code: 'INVALID_PATH' }, 'a POSIX path is not a Windows folder')
  native.connectError = Object.assign(new Error('x'), { code: 'CONNECTION_REFUSED' })
  assert.match((await core.folders({ terminalId: 'fox' })).action, /OpenSSH/)
  native.connectError = null
  await assert.rejects(core.connection.target({ terminalId: 'fox', memberId: 'm', projectRoot: '/Users/kite/app', harness: 'claude-code' }), { code: 'TARGET_MISMATCH' })
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
  assert.equal((await call('GET', '/api/terminals/owner-macbook/folders?path=/Users/kite')).payload.path, '/Users/kite')
  assert.equal((await call('GET', '/api/terminals/owner-macbook/folders')).payload.home, '/Users/kite')
  assert.equal((await call('GET', '/api/terminals/owner-macbook/folders?depth=2')).error, 'INVALID_PATH')
  assert.equal((await call('POST', '/api/terminals/owner-macbook/folders')).status, 405)
})

test('authorize: pending stays true until the outcome is readable', async t => {
  const { core, native, credentials } = await setup(t)
  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })
  let release
  native.authorizeKey = ({ ref }) => new Promise(resolve => { release = () => resolve({ schema: 'aiterm.remote-key-authorization.v1', ref, result: 'ALREADY_AUTHORIZED' }) })
  const { secretRequest } = await core.keys.authorize('owner-macbook')
  credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: 'h1', revision: 1, available: true, requestId: secretRequest.id })
  credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: 'h1', revision: 1, available: true, requestId: secretRequest.id })
  await settle()
  const during = await core.registry.get('owner-macbook')
  assert.deepEqual([during.keyAuthorizationPending, during.keyAuthorization], [true, null])
  release()
  await settle()
  const after = await core.registry.get('owner-macbook')
  assert.deepEqual([after.keyAuthorizationPending, after.keyAuthorization.outcome], [false, 'ALREADY_AUTHORIZED'])
  assert.equal(credentials.calls.filter(c => c.op === 'consume').length, 1, 'a repeated event is not consumed twice')
})

test('authorize: success only from a valid receipt for this binding', async t => {
  const { core, native, credentials } = await setup(t)
  await core.registry.put({ ...mac, sshKeyRef: nativeHandle })
  const receipts = [null, {}, { schema: 'aiterm.remote-key-authorization.v1', ref: 'other-binding', result: 'AUTHORIZED' },
    { schema: 'aiterm.remote-key-authorization.v1', ref: 'native-binding', result: 'MAYBE' }]
  for (const [index, receipt] of receipts.entries()) {
    native.authorizeKey = async () => receipt
    const { secretRequest } = await core.keys.authorize('owner-macbook')
    credentials.emit({ terminalId: 'owner-macbook', purpose: 'terminal.login', handle: `h${index}`, revision: 1, available: true, requestId: secretRequest.id })
    await settle()
    assert.equal((await core.registry.get('owner-macbook')).keyAuthorization.outcome, 'AUTHORIZATION_UNCONFIRMED', JSON.stringify(receipt))
  }
})
