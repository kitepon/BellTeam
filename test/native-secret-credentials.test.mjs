import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeSecretCredentials } from '../src/usage/native-secret-credentials.mjs'

const ref = '01234567-89ab-cdef-0123-456789abcdef'
const target = { host: 'example.test', user: 'owner', port: 22 }
const scope = { terminalId: 'mac', purpose: 'terminal.ssh' }
const context = { ...scope, memberId: 'bot-a' }
const revision = n => 'sha256:' + String(n).repeat(64)

test('native binding keeps capabilities private and recovers durable revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-credentials-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new NativeSecretCredentials({ root })
  let calls = 0, failed = false, available = true, version = 1, actualTarget = target
  const provider = { async status(id) {
    calls++
    if (failed) throw new Error('sensitive provider error')
    return { structuredContent: { ref: id, target: actualTarget, credential: { provider: 'aiterm.native-ssh-key.v1', revision: revision(version), available } } }
  } }
  service.setProvider(provider)
  assert.throws(() => service.setProvider(provider), { code: 'SECRET_CREDENTIAL_INVALID' })
  actualTarget = { ...target, host: 'wrong.test' }
  await assert.rejects(service.register({ ref, target }, scope), { code: 'SECRET_SOURCE_UNAVAILABLE', status: 503 })
  actualTarget = target
  const dto = await service.register({ ref, target }, scope)
  assert.deepEqual(Object.keys(dto).sort(), ['available', 'handle', 'revision'])
  assert.equal(dto.available, true); assert.equal(service.owns(dto.handle), true)
  const dir = join(root, 'state/secret-native-credentials')
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  const files = await readdir(dir); assert.equal(files.length, 1)
  assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify(dto).includes(ref))
  assert.ok((await readFile(join(dir, files[0]), 'utf8')).includes(ref))
  const before = calls
  await assert.rejects(service.withResolved(dto.handle, { ...context, terminalId: 'wrong' }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_FORBIDDEN' })
  await assert.rejects(service.withResolved(dto.handle, { ...context, purpose: 'terminal.sudo' }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_FORBIDDEN' })
  assert.equal(calls, before)
  await service.withResolved(dto.handle, context, capability => assert.deepEqual(capability, { nativeKeyRef: ref, revision: revision(1) }))
  const events = []; service.watch(event => events.push(event))
  failed = true
  await assert.rejects(service.withResolved(dto.handle, context, () => assert.fail()), e => e.code === 'SECRET_SOURCE_UNAVAILABLE' && e.status === 503 && !String(e.stack).includes('sensitive'))
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: null, available: false, reason: 'availability' })
  failed = false; await service.refresh()
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: null, reason: 'availability' })
  version = 2; await service.refresh()
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: null, revision: 2, reason: 'revision' })
  assert.ok(!JSON.stringify(events).includes(ref))
  service.close()
  const restored = new NativeSecretCredentials({ root }); restored.setProvider(provider)
  await restored.ready(); assert.equal(restored.has(dto.handle), true)
  assert.deepEqual(await restored.credential(dto.handle, { ...context, memberId: null }), { ...dto, revision: 2 })
  const nextRef = '11234567-89ab-cdef-0123-456789abcdef'
  assert.deepEqual(await restored.replace(dto.handle, { ref: nextRef, target }, context), { ...dto, revision: 3 })
  available = false
  assert.deepEqual(await restored.credential(dto.handle, context), { ...dto, revision: 3, available: false })
  await assert.rejects(restored.withResolved(dto.handle, context, () => assert.fail()), { code: 'SECRET_SOURCE_UNAVAILABLE' })
  restored.close()
})

test('restored handle reports initial outage and recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const provider = { async status(id) { return { ref: id, target, credential: { provider: 'aiterm.native-ssh-key.v1', revision: revision(1), available: true } } } }
  const initial = new NativeSecretCredentials({ root }); initial.setProvider(provider)
  const dto = await initial.register({ ref, target }, scope)
  initial.close()
  const restored = new NativeSecretCredentials({ root })
  await restored.ready()
  const events = []; restored.watch(event => events.push(event))
  await restored.refresh()
  assert.deepEqual(events, [{ ...dto, ...scope, requestId: null, available: false, reason: 'availability' }])
  restored.setProvider(provider)
  await restored.refresh()
  assert.deepEqual(events.at(-1), { ...dto, ...scope, requestId: null, reason: 'availability' })
  assert.equal(events.length, 2)
  restored.close()
})

test('owner key selection persists replacement and ignores stale events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-key-selection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new NativeSecretCredentials({ root })
  const first = { ...scope, handle: 'first', revision: 1, available: true, requestId: 'request-first', reason: 'bound' }
  const second = { ...first, handle: 'second', requestId: 'request-second' }
  await service.selectCredential(first)
  await service.selectCredential(second)
  await service.selectCredential({ ...first, reason: 'availability', available: false })
  await service.selectCredential({ ...first, reason: 'unbound', available: false })
  assert.deepEqual(await service.selection({ ...scope, purpose: 'ssh-key' }), { present: true, credential: { handle: 'second', revision: 1, available: true, requestId: 'request-second' } })
  await assert.rejects(service.assertSelected('first', scope), { code: 'SECRET_CREDENTIAL_REVOKED', status: 403 })
  await service.selectCredential({ ...second, reason: 'unbound', available: false })
  await service.selectCredential({ ...second, reason: 'revision', revision: 2 })
  service.close()
  const restored = new NativeSecretCredentials({ root })
  assert.deepEqual(await restored.selection(scope), { present: true, credential: null })
  const dir = join(root, 'state/secret-credential-selections')
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  const [file] = await readdir(dir)
  assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(join(dir, file), 'utf8')), { ...scope, credential: null })
  restored.close()
})

test('native scoped unbind revokes before provider and allows new binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-unbind-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let calls = 0
  const service = new NativeSecretCredentials({ root })
  service.setProvider({ async status(id) { calls++; return { ref: id, target, credential: { provider: 'aiterm.native-ssh-key.v1', revision: revision(1), available: true } } } })
  const events = []; service.watch(event => events.push(event))
  const first = await service.register({ ref, target }, { ...scope, purpose: 'ssh-key' })
  await assert.rejects(service.unbind(first.handle, { ...scope, terminalId: 'other' }), { code: 'SECRET_CREDENTIAL_FORBIDDEN' })
  await service.unbind(first.handle, scope)
  await service.unbind(first.handle, scope)
  const before = calls
  await assert.rejects(service.withResolved(first.handle, context, () => assert.fail()), { code: 'SECRET_CREDENTIAL_REVOKED', status: 403 })
  assert.equal(calls, before)
  assert.deepEqual(events.at(-1), { ...first, ...scope, requestId: null, available: false, reason: 'unbound' })
  const next = await service.register({ ref, target }, scope)
  await service.withResolved(next.handle, context, capability => assert.equal(capability.nativeKeyRef, ref))
  assert.deepEqual(await service.selection(scope), { present: true, credential: { ...next, requestId: null } })
  service.close()
})

test('native expected revision rejects cached mismatch and rotation before callback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-revision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let calls = 0, version = 1
  const service = new NativeSecretCredentials({ root })
  service.setProvider({ async status(id) { calls++; return { ref: id, target, credential: { provider: 'aiterm.native-ssh-key.v1', revision: revision(version), available: true } } } })
  const dto = await service.register({ ref, target }, scope)
  const before = calls
  await assert.rejects(service.withResolved(dto.handle, { ...context, expectedRevision: 2 }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_STALE', status: 409 })
  assert.equal(calls, before)
  version = 2
  await assert.rejects(service.withResolved(dto.handle, { ...context, expectedRevision: 1 }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_STALE', status: 409 })
  assert.equal(calls, before + 1)
  service.close()
})

test('empty owner key selection tombstone persists and permits later binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'empty-key-selection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new NativeSecretCredentials({ root })
  assert.deepEqual(await service.selection(scope), { present: false, credential: null })
  await service.clearSelection({ ...scope, purpose: 'ssh-key' })
  service.close()
  const restored = new NativeSecretCredentials({ root })
  assert.deepEqual(await restored.selection(scope), { present: true, credential: null })
  const event = { ...scope, handle: 'new-key', revision: 1, available: true, requestId: 'new-request', reason: 'bound' }
  await restored.selectCredential(event)
  assert.deepEqual(await restored.selection(scope), { present: true, credential: { handle: 'new-key', revision: 1, available: true, requestId: 'new-request' } })
  restored.close()
})

test('native unbind result DTO is stable without further provider probes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-unbind-result-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let calls = 0
  const service = new NativeSecretCredentials({ root })
  service.setProvider({ async status(id) { calls++; return { ref: id, target, credential: { provider: 'aiterm.native-ssh-key.v1', revision: revision(1), available: true } } } })
  const dto = await service.register({ ref, target }, scope)
  const before = calls, expected = { ...dto, available: false }
  assert.deepEqual(await service.unbind(dto.handle, scope), expected)
  assert.deepEqual(await service.unbind(dto.handle, scope), expected)
  assert.equal(calls, before)
  service.close()
})
