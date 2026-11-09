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
  assert.deepEqual(events.at(-1), { ...dto, available: false, reason: 'availability' })
  failed = false; await service.refresh()
  assert.deepEqual(events.at(-1), { ...dto, reason: 'availability' })
  version = 2; await service.refresh()
  assert.deepEqual(events.at(-1), { ...dto, revision: 2, reason: 'revision' })
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
