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
