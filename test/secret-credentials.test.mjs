import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SecretRequests } from '../src/secret-requests.mjs'
import { SecretCredentials } from '../src/usage/secret-credentials.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageFacade } from '../src/usage/facade.mjs'
import { createUsageProjection, usageProjectionRecordValid } from '../src/usage/projection.mjs'
import { createUsageAuthority } from '../src/usage/authority.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const reference = `op://${'a'.repeat(26)}/${'b'.repeat(26)}/private key?ssh-format=openssh`
const input = { botId: 'bot-a', toolId: 'terminal-credentials', label: 'SSH key', message: 'Choose a credential.' }
const scope = { terminalId: 'owner-macbook', purpose: 'terminal.ssh' }
const context = { ...scope, memberId: 'bot-a' }
const owner = { kind: 'owner', botId: null }, system = { kind: 'system', botId: null }, bot = { kind: 'bot', botId: 'bot-a' }
// 2026-11-27: there is no 1Password source; a private provider (a fixed local key) is the only non-stored source, injected as a capability.
const providerRef = { source: 'provider', providerId: 'fake' }
function fakeSource() {
  return { available: true, value: 'synthetic-SSH-value\n', failed: false, reads: [],
    async resolve() { this.reads.push('read'); if (this.failed) throw new Error('PRIVATE ERROR ' + this.value); return this.value },
    connected(value) { this.available = value } }
}

test('read-only restore creates new secret stores only when writing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-readonly-secret-credentials-'))
  const source = fakeSource()
  const requests = new Map([
    ['11111111-1111-4111-8111-111111111111', { id: '11111111-1111-4111-8111-111111111111', status: 'submitted', botId: null, terminalId: scope.terminalId, purpose: scope.purpose, terminalSuperseded: false, toolId: input.toolId }],
    ['22222222-2222-4222-8222-222222222222', { id: '22222222-2222-4222-8222-222222222222', status: 'submitted', botId: null, terminalId: scope.terminalId, purpose: scope.purpose, terminalSuperseded: false, toolId: input.toolId }],
  ])
  const credentials = new SecretCredentials({ root, getRequest: requestId => requests.get(requestId), providers: { fake: source } })
  t.after(async () => { credentials.close(); await rm(root, { recursive: true, force: true }) })

  await credentials.initialize({ readOnly: true })
  assert.deepEqual(await readdir(root), [])
  await assert.rejects(stat(join(root, 'state')), { code: 'ENOENT' })

  const first = '11111111-1111-4111-8111-111111111111'
  const second = '22222222-2222-4222-8222-222222222222'
  const firstDto = await credentials.bind(first, scope)
  await credentials.registerSource(second, providerRef)
  const secondDto = await credentials.bind(second, scope)
  assert.equal(await credentials.resolveRequest(second), source.value)
  for (const directory of [credentials.directory, credentials.sourceDirectory]) assert.equal((await stat(directory)).mode & 0o777, 0o700)
  for (const directory of [credentials.directory, credentials.sourceDirectory]) {
    for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600)
  }
  assert.ok(firstDto.handle); assert.ok(secondDto.handle)
})

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-secret-credentials-'))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }], ['bot-b', { id: 'bot-b', name: 'B' }]])
  const rooms = new Map([['room-a', { id: 'room-a', memberIds: ['bot-a'] }]])
  rooms.refresh = async () => {}
  const source = fakeSource(), visible = []
  const service = new SecretRequests({ root, bots, rooms, credentialRetryMs: 0, notify: item => visible.push(item), ...options, secretProviders: { fake: source, ...options.secretProviders } })
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  await service.initialize()
  return { root, bots, rooms, source, service, visible }
}
async function submitted(service, value) {
  const item = await service.create(input)
  return value === undefined ? service.submitProvider(item.id, 'fake') : service.submit(item.id, value)
}

test('Owner cancel of a submitted bot request revokes its handle and erases the private source record', async t => {
  const { root, source, service, visible } = await fixture(t)
  const item = await submitted(service)
  const dto = await service.bindCredential(item.id, scope)
  const events = []; service.watchCredentials(event => events.push(event))
  const terminal = await service.requestTerminalKey({ ...scope, terminalId: 'other-mac', label: 'key' })
  const cancelled = await service.cancel(item.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(visible.at(-1).status, 'cancelled')
  assert.deepEqual(events.map(event => [event.handle, event.reason]), [[dto.handle, 'unbound']])
  await assert.rejects(stat(join(root, 'state/secret-sources', item.id + '.json')), { code: 'ENOENT' })
  await assert.rejects(service.withResolved(dto.handle, context, () => {}), /SECRET_CREDENTIAL/u)
  await assert.rejects(service.resolveValue(item.id), /SECRET_REQUEST_CLOSED/u)
  assert.equal(source.reads.length, 0)
  // Terminal-key requests keep their own rules: a submitted one is never erased by cancel.
  assert.equal(service.get(terminal.secretRequest.id).status, 'pending')
})

test('provider submissions are private, input options are stored only, and resolution never stores the value', async t => {
  const { root, source, service, visible } = await fixture(t)
  const item = await submitted(service)
  assert.equal(item.status, 'submitted'); assert.equal(item.path, undefined)
  const room = await service.create({ ...input, roomId: 'room-a' })
  assert.deepEqual(service.timeline({ botId: 'bot-a' })[0].secret_request.inputOptions, { preferred: 'stored', onePasswordAvailable: false })
  assert.deepEqual(service.timeline({ roomId: 'room-a' })[0].secret_request.inputOptions, room.inputOptions)
  const dto = await service.bindCredential(item.id, scope)
  assert.deepEqual(Object.keys(dto).sort(), ['available', 'handle', 'revision'])
  const events = []; service.watchCredentials(event => events.push(event))
  await service.withResolved(dto.handle, context, value => assert.equal(value, source.value))
  assert.equal(source.reads.length, 1)
  for (const memberId of ['bot-b', null]) await service.withResolved(dto.handle, { ...context, memberId }, value => assert.equal(value, source.value))
  const publicState = JSON.stringify([item, dto, visible, events, service.timeline({ botId: 'bot-a' })])
  assert.ok(!publicState.includes(source.value)); assert.ok(!publicState.includes('fake'))
  const files = await readdir(root, { recursive: true, withFileTypes: true })
  for (const file of files) if (file.isFile()) {
    const path = join(file.parentPath, file.name), text = await readFile(path, 'utf8')
    assert.ok(!text.includes(source.value))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  await assert.rejects(service.submit(item.id, 'overwrite'), /SECRET_REQUEST_CLOSED/)
  // No 1Password source any more: a reference submission is refused and leaves the request pending.
  const invalid = await service.create(input)
  await assert.rejects(service.submit(invalid.id, { source: 'onepassword', reference }), /SECRET_VALUE_INVALID/)
  assert.equal(service.get(invalid.id).status, 'pending')
})

test('credentials reject wrong target before reads, preserve revisions across restore, and notify same-binding recovery', async t => {
  const { root, bots, rooms, source, service } = await fixture(t)
  const item = await submitted(service), dto = await service.bindCredential(item.id, scope)
  const events = []; service.watchCredentials(event => events.push(event))
  await assert.rejects(service.withResolved(dto.handle, { ...context, terminalId: 'another' }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_FORBIDDEN' })
  await assert.rejects(service.withResolved(dto.handle, { ...context, purpose: 'terminal.sudo' }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_FORBIDDEN' })
  assert.equal(source.reads.length, 0)
  source.failed = true
  await assert.rejects(service.withResolved(dto.handle, context, () => assert.fail()), error => error.code === 'SECRET_SOURCE_UNAVAILABLE' && !String(error.stack).includes('synthetic-SSH-value'))
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, available: false, reason: 'availability' })
  source.failed = false
  await service.credentials.refreshAvailability()
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, reason: 'availability' })
  const replacement = await submitted(service, 'stored-fallback-value')
  const next = await service.replaceCredential(dto.handle, replacement.id, context)
  assert.equal(next.handle, dto.handle); assert.equal(next.revision, 2)
  assert.deepEqual(events.at(-1), { ...next, ...scope, requestId: replacement.id, reason: 'revision' })
  service.close()
  const restored = new SecretRequests({ root, bots, rooms, secretProviders: { fake: fakeSource() }, credentialRetryMs: 0, notify() {} })
  t.after(() => restored.close())
  await restored.initialize({ readOnly: true })
  assert.deepEqual(restored.credential(dto.handle, context), next)
  await restored.withResolved(dto.handle, context, value => assert.equal(value, 'stored-fallback-value'))
  await chmod(replacement.path, 0o644)
  await assert.rejects(restored.resolveValue(replacement.id), { code: 'SECRET_SOURCE_UNAVAILABLE' })
})

test('fixed private providers are injected capabilities and stored-file symlinks are rejected', async t => {
  const { root, service } = await fixture(t, { secretProviders: { 'mac-fixed': { available: true, resolve: async () => 'synthetic-local-key' } } })
  const item = await service.create(input)
  await assert.rejects(service.submit(item.id, { source: 'provider', providerId: 'mac-fixed' }), /SECRET_VALUE_INVALID/)
  const complete = await service.submitProvider(item.id, 'mac-fixed')
  assert.equal(complete.path, undefined)
  const dto = await service.bindCredential(item.id, scope)
  await service.withResolved(dto.handle, context, value => assert.equal(value, 'synthetic-local-key'))
  assert.ok(!JSON.stringify([dto, complete]).includes('mac-fixed'))
  const stored = await submitted(service, 'stored-private-value')
  const target = stored.path + '.target'
  const { rename } = await import('node:fs/promises')
  await rename(stored.path, target); await symlink(target, stored.path)
  await assert.rejects(service.resolveValue(stored.id), { code: 'SECRET_SOURCE_UNAVAILABLE' })
  assert.ok((await readdir(join(root, 'state/secret-sources'))).length > 0)
})

test('private usage API requires a captured system capability and keeps values out of projections/handoff', async t => {
  const { root, bots, rooms, source } = await fixture(t)
  const rows = [], service = createUsageServices({ root, bots, rooms, effect: async () => {}, onProjection: row => rows.push(row) })
  await service.initializeSettings(); await service.initialize()
  t.after(async () => { await service.quiesce(); service.close() })
  const projection = createUsageProjection({ bots }); projection.begin('test'); for (const row of service.snapshot()) projection.accept(row, 'test'); projection.commit('test')
  const authority = createUsageAuthority()
  const facade = createUsageFacade({ projection, request: (method, params, token) => service.request(method, params, authority.authorizeActor(method, token)) })
  const item = await service.request('secrets.create', { toolId: input.toolId, label: input.label, message: input.message }, bot)
  const saved = await service.request('secrets.submit', { id: item.id, value: source.value }, owner)
  assert.equal(saved.inputOptions.onePasswordAvailable, false)
  await assert.rejects(service.request('secrets.submit', { id: (await service.request('secrets.create', { toolId: input.toolId, label: input.label, message: input.message }, bot)).id, value: { source: 'onepassword', reference } }, owner), { code: 'USAGE_INPUT_INVALID' })
  await assert.rejects(service.request('secrets.resolveRequest', { id: item.id }, bot), { code: 'USAGE_ACTOR_FORBIDDEN' })
  await assert.rejects(service.request('secrets.bind', { id: item.id, scope }, owner), { code: 'USAGE_ACTOR_FORBIDDEN' })
  const dto = await facade.secretRequests.bindCredential(item.id, scope, authority.capture('secrets.bind', system))
  assert.throws(() => authority.authorizeActor('secrets.resolve', {}), { code: 'USAGE_ACTOR_FORBIDDEN' })
  await facade.secretRequests.withResolved(dto.handle, context, value => assert.equal(value, source.value), authority.capture('secrets.resolve', system))
  assert.equal(usageResultValid('secrets.resolve', source.value), true)
  assert.equal(usageResultValid('secrets.bind', { ...dto, source: 'onepassword' }), false)
  assert.ok(rows.every(usageProjectionRecordValid))
  await service.quiesce()
  const visible = JSON.stringify([rows, service.exportState()])
  assert.ok(!visible.includes(source.value))
  service.resume()
})

test('settings and public HTTP accept a stored value through the shared resolver without returning it, and refuse a 1Password reference', async t => {
  const { root, bots, rooms, source, service } = await fixture(t)
  const server = createBellTeamServer({ bots, rooms, secretRequests: service,
    store: { timeline: async () => [], watch: async () => () => {} }, transport: {}, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/api/secret-requests`
  const post = (id, body) => fetch(`${base}/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify(body) })
  const request = await service.create({ ...input, toolId: 'bellteam-settings' })
  const response = await post(request.id, { value: source.value })
  assert.equal(response.status, 200)
  assert.ok(!JSON.stringify(await response.json()).includes(source.value))
  const other = await service.create(input)
  assert.equal((await post(other.id, { source: 'onepassword', reference })).status, 400)
  assert.equal(service.get(other.id).status, 'pending')
  assert.equal((await fetch(`${base}/${other.id}/onepassword-items`)).status, 404)
  const settings = new FeatureSettings({ root, environment: {} })
  await settings.initialize()
  const result = await settings.update('routing', { enabled: true, secretRequestId: request.id }, { secretRequests: service, botId: 'bot-a' })
  assert.equal(result.enabled, true); assert.equal(settings.configuration('routing').apiKey, source.value)
  assert.equal(result.fields[0].value, '')
})

test('credential replacement during resolution rejects the old callback and source metadata retry recovers without overwriting', async t => {
  const { source, service } = await fixture(t)
  const item = await submitted(service), dto = await service.bindCredential(item.id, scope)
  const replacement = await submitted(service, 'new-fixed-value')
  let release, entered
  const resolving = new Promise(resolve => { entered = resolve })
  source.resolve = async () => { entered(); return new Promise(resolve => { release = resolve }) }
  let consumed = false
  const pending = service.withResolved(dto.handle, context, () => { consumed = true })
  await resolving
  await service.replaceCredential(dto.handle, replacement.id, context)
  release('old-synthetic-value')
  await assert.rejects(pending, { code: 'SECRET_CREDENTIAL_STALE' })
  assert.equal(consumed, false)
  const retry = await service.create(input)
  await service.credentials.registerSource(retry.id, providerRef)
  await service.submitProvider(retry.id, 'fake')
  assert.equal(service.get(retry.id).status, 'submitted')
})

test('restored child handles announce initial availability and recover under the parent refresh contract', async t => {
  const { root, bots, rooms, service } = await fixture(t)
  const item = await submitted(service), dto = await service.bindCredential(item.id, scope)
  service.close()
  const source = fakeSource(); source.available = false; source.failed = true
  const restored = new SecretRequests({ root, bots, rooms, secretProviders: { fake: source }, credentialRetryMs: 0, notify() {} })
  t.after(() => restored.close())
  const events = []; restored.watchCredentials(event => events.push(event))
  await restored.initialize({ readOnly: true })
  await restored.credentials.refreshAvailability()
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, available: false, reason: 'availability' })
  await assert.rejects(restored.resolveValue(item.id), { code: 'SECRET_SOURCE_UNAVAILABLE' })
  assert.deepEqual(restored.credentials.recoveryState(), { recoveryNeeded: true })
  source.failed = false; source.connected(true)
  assert.deepEqual(await restored.credentials.refreshAvailability(), { recoveryNeeded: false })
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, available: true, reason: 'availability' })
})

test('an old 1Password source record stays readable, its handle is unavailable until the secret is entered again, and nothing is read', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'bellteam-old-onepassword-record-'))
  const requestId = '33333333-3333-4333-8333-333333333333', handle = '44444444-4444-4444-8444-444444444444'
  await mkdir(join(root, 'state/secret-sources'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'state/secret-credentials'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'state/secret-sources', requestId + '.json'), JSON.stringify({ kind: 'onepassword', reference }), { mode: 0o600 })
  await writeFile(join(root, 'state/secret-credentials', handle + '.json'), JSON.stringify({ handle, requestId, ...scope, revision: 1, bindingOrder: 1 }), { mode: 0o600 })
  const credentials = new SecretCredentials({ root, getRequest: () => ({ id: requestId, status: 'submitted', botId: null, ...scope, toolId: input.toolId }) })
  t.after(async () => { credentials.close(); await rm(root, { recursive: true, force: true }) })
  await credentials.initialize()
  assert.deepEqual(await credentials.refreshAvailability(), { recoveryNeeded: true })
  assert.equal(credentials.credential(handle, context).available, false)
  await assert.rejects(credentials.resolveRequest(requestId), { code: 'SECRET_SOURCE_UNAVAILABLE' })
})

test('terminal.login is paste-only, kept in memory, resolved exactly once and gone after restart', async t => {
  const { root, source, service } = await fixture(t)
  const login = { terminalId: 'owner-macbook', purpose: 'terminal.login' }, target = { ...login, memberId: null }
  const events = []; service.watchCredentials(event => events.push(event))
  const { secretRequest: card } = await service.requestTerminalKey({ ...login, label: 'Login for owner-macbook' })
  assert.equal(card.message, 'このMacのログインパスワード（1回だけ使い、保存しません）')
  assert.deepEqual(card.inputOptions, { preferred: 'stored', onePasswordAvailable: false })
  assert.equal(usageProjectionRecordValid({ type: 'secret', revision: 1, value: card }), true)
  await assert.rejects(service.submit(card.id, { source: 'onepassword', reference }), /SECRET_VALUE_INVALID/)
  const done = await service.submit(card.id, 'synthetic-login-pass')
  assert.equal(done.status, 'submitted'); assert.equal(done.path, undefined)
  await assert.rejects(readdir(join(root, 'state/secret-values')), { code: 'ENOENT' })
  const bound = events.find(e => e.reason === 'bound')
  assert.deepEqual([bound.purpose, bound.requestId], ['terminal.login', card.id])
  assert.deepEqual(service.credentials.current(login).handle, bound.handle)
  const [first, second] = await Promise.allSettled([1, 2].map(() => service.withResolved(bound.handle, target, value => value)))
  assert.equal(first.value, 'synthetic-login-pass')
  assert.match(String(second.reason), /SECRET_CREDENTIAL_REVOKED|SECRET_REQUEST_CLOSED/)
  assert.equal(service.credentials.current(login), null)
  assert.ok(events.some(e => e.reason === 'unbound' && e.handle === bound.handle))
  // An unconsumed value is dropped by the next request and by a restart.
  const { secretRequest: next } = await service.requestTerminalKey({ ...login, label: 'Login for owner-macbook' })
  await service.submit(next.id, 'synthetic-login-pass-2')
  const restarted = new SecretRequests({ root, bots: new Map(), rooms: new Map(), credentialRetryMs: 0, notify: () => {} })
  t.after(() => restarted.close())
  await restarted.initialize({ readOnly: true })
  assert.equal(restarted.credentials.current(login), null)
  assert.equal(await restarted.currentCredential(login), null)
})

const moduleScope = { terminalId: 'approval-box-extension', purpose: 'approval-box.session' }
const moduleContext = { ...moduleScope, memberId: null }
const session = JSON.stringify({ token: 'synthetic-session-token', expiresAt: '2027-02-14T00:00:00Z' })

test('module-written secret (R7): put persists privately, revises in place, survives a restart and erase deletes the value', async t => {
  const { root, bots, rooms, source, service, visible } = await fixture(t)
  const events = []; service.watchCredentials(event => events.push(event))
  const dto = await service.putCredential(moduleScope, session)
  assert.deepEqual(Object.keys(dto).sort(), ['available', 'handle', 'revision'])
  assert.equal(dto.revision, 1)
  const file = join(root, 'state/secret-module-values', dto.handle)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal(await readFile(file, 'utf8'), session)
  assert.equal(service.credentials.current(moduleScope).handle, dto.handle)
  assert.equal(await service.withResolved(dto.handle, moduleContext, value => value), session)
  // A second put is revision n+1 of the same handle with the new value.
  const next = JSON.stringify({ token: 'synthetic-second-token', expiresAt: '2027-05-14T00:00:00Z' })
  assert.deepEqual(await service.putCredential(moduleScope, next), { ...dto, revision: 2 })
  assert.equal(await service.withResolved(dto.handle, moduleContext, value => value), next)
  // Nothing public: no request card, no event or notification carries the value.
  assert.equal(visible.length, 0); assert.equal(service.items.size, 0)
  assert.deepEqual(events.map(event => event.reason), ['bound', 'revision'])
  assert.ok(!JSON.stringify(events).includes('synthetic-'))
  // A usage restart keeps the handle and its value.
  service.close()
  const again = new SecretRequests({ root, bots, rooms, credentialRetryMs: 0, notify() {} })
  t.after(() => again.close())
  await again.initialize()
  assert.equal(await again.withResolved(dto.handle, moduleContext, value => value), next)
  const unbound = []; again.watchCredentials(event => unbound.push(event.reason))
  assert.equal(await again.eraseCredential(moduleScope), null)
  assert.deepEqual(unbound, ['unbound'])
  await assert.rejects(stat(file), { code: 'ENOENT' })
  assert.equal(again.credentials.current(moduleScope), null)
  await assert.rejects(again.withResolved(dto.handle, moduleContext, () => {}), /SECRET_CREDENTIAL_REVOKED/u)
  // Erase is retry-safe, also when the value is already gone or nothing was ever written.
  assert.equal(await again.eraseCredential(moduleScope), null)
  // After erase a new put reconnects with a new handle.
  const fresh = await again.putCredential(moduleScope, session)
  assert.notEqual(fresh.handle, dto.handle); assert.equal(again.credentials.current(moduleScope).handle, fresh.handle)
})

test('module-written secret (R7): the auth-mediation scope has its own handle and erase leaves the other scope alone', async t => {
  const { service } = await fixture(t)
  const authScope = { terminalId: 'auth-mediation', purpose: 'auth-mediation.op-read' }
  const authContext = { ...authScope, memberId: null }
  const a = await service.putCredential(moduleScope, session)
  const b = await service.putCredential(authScope, 'synthetic-op-read-token')
  assert.notEqual(a.handle, b.handle)
  assert.equal(await service.withResolved(b.handle, authContext, value => value), 'synthetic-op-read-token')
  assert.equal(await service.eraseCredential(authScope), null)
  assert.equal(service.credentials.current(authScope), null)
  assert.equal(await service.withResolved(a.handle, moduleContext, value => value), session)
})

test('module-written secret (R7) refuses other scopes and bad values before writing, and an erase retry finishes a leftover value', async t => {
  const { root, service } = await fixture(t)
  for (const other of [scope, { terminalId: 'lattice', purpose: 'approval-box.connector' }])
    await assert.rejects(service.putCredential(other, session), /SECRET_CREDENTIAL_FORBIDDEN/u)
  for (const value of ['', 'a\0b', 'x'.repeat(16385), 1]) await assert.rejects(service.putCredential(moduleScope, value), /SECRET_VALUE_INVALID/u)
  await assert.rejects(stat(join(root, 'state/secret-module-values')), { code: 'ENOENT' })
  const dto = await service.putCredential(moduleScope, session)
  const file = join(root, 'state/secret-module-values', dto.handle)
  // The consumer's own 401 path: the value file is lost while the handle is live.
  await rm(file)
  await assert.rejects(service.withResolved(dto.handle, moduleContext, () => {}), /SECRET_SOURCE_UNAVAILABLE/u)
  await service.eraseCredential(moduleScope)
  assert.equal(service.credentials.current(moduleScope), null)
})

test('module-written secret (R7) is system-only on the usage IPC and its results are handle DTOs or null', async t => {
  const { root, bots, rooms, source } = await fixture(t)
  const rows = [], service = createUsageServices({ root, bots, rooms, effect: async () => {}, onProjection: row => rows.push(row) })
  await service.initializeSettings(); await service.initialize()
  t.after(async () => { await service.quiesce(); service.close() })
  for (const actor of [owner, bot]) for (const [method, params] of [['secrets.put', { scope: moduleScope, value: session }], ['secrets.erase', { scope: moduleScope }]])
    await assert.rejects(service.request(method, params, actor), { code: 'USAGE_ACTOR_FORBIDDEN' })
  const dto = await service.request('secrets.put', { scope: moduleScope, value: session }, system)
  assert.equal(usageResultValid('secrets.put', dto), true)
  assert.equal(usageResultValid('secrets.put', { ...dto, value: session }), false)
  assert.equal(await service.request('secrets.erase', { scope: moduleScope }, system), null)
  assert.equal(usageResultValid('secrets.erase', null), true); assert.equal(usageResultValid('secrets.erase', dto), false)
  await service.quiesce()
  assert.ok(!JSON.stringify([rows, service.exportState()]).includes('synthetic-session-token'))
  service.resume()
})
