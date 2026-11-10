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
function fakeSource() {
  const events = new EventEmitter()
  return { available: true, value: 'synthetic-SSH-value\n', failed: false, reads: [],
    async refresh() {}, close() {}, watch(listener) { events.on('change', listener); return () => events.off('change', listener) },
    async resolve(ref) { this.reads.push(ref); if (this.failed) throw new Error('PRIVATE ERROR ' + ref + this.value); return this.value },
    connected(value) { this.available = value; events.emit('change', { available: value }) },
    token: null, setToken(reader) { this.token = reader },
    keys: [{ title: 'MacBook key', vault: '開発工場', reference }], async listSshKeys() { return this.keys },
    passwords: [{ title: 'Mac sudo', vault: '開発工場', reference: `op://${'a'.repeat(26)}/${'c'.repeat(26)}/password` }], async listPasswords() { return this.passwords },
    async inventory() { return { vaults: ['開発工場'], keys: this.keys } },
  }
}

test('read-only restore creates new secret stores only when writing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-readonly-secret-credentials-'))
  const source = fakeSource()
  const requests = new Map([
    ['11111111-1111-4111-8111-111111111111', { id: '11111111-1111-4111-8111-111111111111', status: 'submitted', botId: null, terminalId: scope.terminalId, purpose: scope.purpose, terminalSuperseded: false, toolId: input.toolId }],
    ['22222222-2222-4222-8222-222222222222', { id: '22222222-2222-4222-8222-222222222222', status: 'submitted', botId: null, terminalId: scope.terminalId, purpose: scope.purpose, terminalSuperseded: false, toolId: input.toolId }],
  ])
  const credentials = new SecretCredentials({ root, getRequest: requestId => requests.get(requestId), onePassword: source })
  t.after(async () => { credentials.close(); await rm(root, { recursive: true, force: true }) })

  await credentials.initialize({ readOnly: true })
  assert.deepEqual(await readdir(root), [])
  await assert.rejects(stat(join(root, 'state')), { code: 'ENOENT' })

  const first = '11111111-1111-4111-8111-111111111111'
  const second = '22222222-2222-4222-8222-222222222222'
  const firstDto = await credentials.bind(first, scope)
  await credentials.registerSource(second, { source: 'onepassword', reference })
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
  const service = new SecretRequests({ root, bots, rooms, onePassword: source, credentialRetryMs: 0, notify: item => visible.push(item), ...options })
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  await service.initialize()
  return { root, bots, rooms, source, service, visible }
}
async function submitted(service, source = { source: 'onepassword', reference }) {
  const item = await service.create(input)
  return service.submit(item.id, source)
}

test('reference submissions are private, input options reach direct/room history, and resolution never stores op values', async t => {
  const { root, source, service, visible } = await fixture(t)
  const item = await submitted(service)
  assert.equal(item.status, 'submitted'); assert.equal(item.path, undefined)
  const room = await service.create({ ...input, roomId: 'room-a' })
  assert.deepEqual(service.timeline({ botId: 'bot-a' })[0].secret_request.inputOptions, { preferred: 'onepassword', onePasswordAvailable: true })
  assert.deepEqual(service.timeline({ roomId: 'room-a' })[0].secret_request.inputOptions, room.inputOptions)
  source.connected(false)
  assert.equal(service.timeline({ roomId: 'room-a' })[0].secret_request.inputOptions.preferred, 'stored')
  source.connected(true)
  const dto = await service.bindCredential(item.id, scope)
  assert.deepEqual(Object.keys(dto).sort(), ['available', 'handle', 'revision'])
  const events = []; service.watchCredentials(event => events.push(event))
  await service.withResolved(dto.handle, context, value => assert.equal(value, source.value))
  assert.equal(source.reads.length, 1)
  for (const memberId of ['bot-b', null]) await service.withResolved(dto.handle, { ...context, memberId }, value => assert.equal(value, source.value))
  const publicState = JSON.stringify([item, dto, visible, events, service.timeline({ botId: 'bot-a' })])
  assert.ok(!publicState.includes(reference)); assert.ok(!publicState.includes(source.value))
  const files = await readdir(root, { recursive: true, withFileTypes: true })
  for (const file of files) if (file.isFile()) {
    const path = join(file.parentPath, file.name), text = await readFile(path, 'utf8')
    assert.ok(!text.includes(source.value))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    if (!path.includes('/secret-sources/')) assert.ok(!text.includes(reference))
  }
  await assert.rejects(service.submit(item.id, 'overwrite'), /SECRET_REQUEST_CLOSED/)
  const invalid = await service.create(input)
  await assert.rejects(service.submit(invalid.id, { source: 'onepassword', reference: 'op://vault/item/field' }), { code: 'SECRET_REFERENCE_INVALID' })
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
  await assert.rejects(service.withResolved(dto.handle, context, () => assert.fail()), error => error.code === 'SECRET_SOURCE_UNAVAILABLE' && !String(error.stack).includes(reference))
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, available: false, reason: 'availability' })
  source.failed = false
  await service.credentials.refreshAvailability()
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, reason: 'availability' })
  const replacement = await submitted(service, 'stored-fallback-value')
  const next = await service.replaceCredential(dto.handle, replacement.id, context)
  assert.equal(next.handle, dto.handle); assert.equal(next.revision, 2)
  assert.deepEqual(events.at(-1), { ...next, ...scope, requestId: replacement.id, reason: 'revision' })
  service.close()
  const restored = new SecretRequests({ root, bots, rooms, onePassword: fakeSource(), credentialRetryMs: 0, notify() {} })
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

test('private usage API requires a captured system capability and keeps values and references out of projections/handoff', async t => {
  const { root, bots, rooms, source } = await fixture(t)
  const rows = [], service = createUsageServices({ root, bots, rooms, onePassword: source, effect: async () => {}, onProjection: row => rows.push(row) })
  await service.initializeSettings(); await service.initialize()
  t.after(async () => { await service.quiesce(); service.close() })
  const projection = createUsageProjection({ bots }); projection.begin('test'); for (const row of service.snapshot()) projection.accept(row, 'test'); projection.commit('test')
  const authority = createUsageAuthority()
  const facade = createUsageFacade({ projection, request: (method, params, token) => service.request(method, params, authority.authorizeActor(method, token)) })
  const item = await service.request('secrets.create', { toolId: input.toolId, label: input.label, message: input.message }, bot)
  const saved = await service.request('secrets.submit', { id: item.id, value: { source: 'onepassword', reference } }, owner)
  assert.equal(saved.inputOptions.onePasswordAvailable, true)
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
  assert.ok(!visible.includes(reference)); assert.ok(!visible.includes(source.value))
  service.resume()
})

test('settings and public HTTP accept reference input through the shared resolver without returning it', async t => {
  const { root, bots, rooms, source, service } = await fixture(t)
  const server = createBellTeamServer({ bots, rooms, secretRequests: service,
    store: { timeline: async () => [], watch: async () => () => {} }, transport: {}, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const request = await service.create({ ...input, toolId: 'bellteam-settings' })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/secret-requests/${request.id}/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ source: 'onepassword', reference }),
  })
  assert.equal(response.status, 200)
  assert.ok(!JSON.stringify(await response.json()).includes(reference))
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
  await service.credentials.registerSource(retry.id, { source: 'onepassword', reference })
  await service.submit(retry.id, { source: 'onepassword', reference })
  assert.equal(service.get(retry.id).status, 'submitted')
})

test('restored child handles announce initial availability and recover under the parent refresh contract', async t => {
  const { root, bots, rooms, service } = await fixture(t)
  const item = await submitted(service), dto = await service.bindCredential(item.id, scope)
  service.close()
  const source = fakeSource(); source.available = false; source.failed = true
  const restored = new SecretRequests({ root, bots, rooms, onePassword: source, credentialRetryMs: 0, notify() {} })
  t.after(() => restored.close())
  const events = []; restored.watchCredentials(event => events.push(event))
  await restored.initialize({ readOnly: true })
  assert.deepEqual(await restored.credentials.refreshAvailability(), { recoveryNeeded: true })
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, available: false, reason: 'availability' })
  source.failed = false; source.connected(true)
  assert.deepEqual(await restored.credentials.refreshAvailability(), { recoveryNeeded: false })
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: item.id, available: true, reason: 'availability' })
})

test('Settings 1Password連携 supplies the token to op only while enabled and reports the result as the feature status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-onepassword-settings-'))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]]), rooms = new Map()
  const source = fakeSource()
  let accept = false
  source.available = false
  source.refresh = async () => { const token = await source.token(); source.reason = 'rejected'; source.connected(accept && token === 'ops_synthetic') }
  const service = createUsageServices({ root, bots, rooms, onePassword: source, effect: async () => {}, onProjection: () => {} })
  t.after(async () => { await service.quiesce(); service.close(); await rm(root, { recursive: true, force: true }) })
  await service.initializeSettings(); await service.initialize()
  assert.equal(await source.token(), null)
  const status = async () => (await service.request('settings.list', {}, owner)).find(row => row.id === 'onePassword')
  let saved = await service.request('settings.update', { id: 'onePassword', input: { enabled: true, values: { token: 'ops_synthetic' } } }, owner)
  assert.equal(saved.error.code, 'ONEPASSWORD_TOKEN_REJECTED'); assert.equal(saved.fields[0].value, '')
  accept = true
  saved = await service.request('settings.update', { id: 'onePassword', input: { enabled: true } }, owner)
  assert.equal(saved.error, undefined); assert.equal(saved.status, 'enabled'); assert.equal(source.available, true)
  assert.deepEqual(saved.connection, { vaults: ['開発工場'], sshKeys: 1 })
  assert.equal(usageResultValid('settings.list', await service.request('settings.list', {}, owner)), true)
  await service.request('settings.update', { id: 'onePassword', input: { enabled: false } }, owner)
  assert.equal(await source.token(), null); assert.equal((await status()).status, 'disabled'); assert.equal((await status()).error, undefined)
  assert.equal((await status()).connection, undefined)
})

test('the SSH card lists existing keys to the Owner only', async t => {
  const { bots, rooms, source, service } = await fixture(t)
  const server = createBellTeamServer({ bots, rooms, secretRequests: service,
    store: { timeline: async () => [], watch: async () => () => {} }, transport: {}, authorize: () => true })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const card = await service.create(input)
  const url = `http://127.0.0.1:${server.address().port}/api/secret-requests/${card.id}/onepassword-items`
  const listed = await fetch(url)
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), { items: source.keys })
  assert.equal(usageResultValid('secrets.onePasswordItems', source.keys), true)
  assert.equal(usageResultValid('secrets.onePasswordItems', [{ ...source.keys[0], value: 'x' }]), false)
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  await service.submit(card.id, { source: 'onepassword', reference: source.keys[0].reference })
  assert.equal((await fetch(url)).status, 409)
})

test('the sudo card lists password items through the same route and DTO', async t => {
  const { source, service } = await fixture(t)
  const { secretRequest } = await service.requestTerminalKey({ terminalId: 'owner-macbook', purpose: 'terminal.sudo', label: '端末 owner-macbook のsudoパスワード' })
  assert.deepEqual(await service.onePasswordItems(secretRequest.id), source.passwords)
  assert.equal(usageResultValid('secrets.onePasswordItems', source.passwords), true)
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
  const restarted = new SecretRequests({ root, bots: new Map(), rooms: new Map(), onePassword: source, credentialRetryMs: 0, notify: () => {} })
  t.after(() => restarted.close())
  await restarted.initialize({ readOnly: true })
  assert.equal(restarted.credentials.current(login), null)
  assert.equal(await restarted.currentCredential(login), null)
})
