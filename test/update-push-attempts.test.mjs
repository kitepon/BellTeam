import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UpdatePushAttempts, validateUpdateAttemptQuery } from '../src/update-push-attempts.mjs'

const candidateId = 'a'.repeat(64)
const at = seconds => new Date(Date.UTC(2026, 10, 8, 3, 0, seconds)).toISOString().replace('Z', '+09:00')

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'update-push-attempts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function rawAttempt(attemptId, { targetDeviceCount = 1, attemptedAt = at(0), state = 'completed' } = {}) {
  return {
    schema: 'bellteam.update-push-attempt.v1', attemptId, candidateId,
    attemptedAt, sentAt: attemptedAt, completedAt: attemptedAt, targetDeviceCount, state, errorReason: null,
    devices: Array.from({ length: targetDeviceCount }, (_, index) => ({ device: index + 1,
      environment: index % 2 ? 'production' : 'development', sentAt: attemptedAt,
      apnsStatus: 200, apnsId: '11111111-1111-4111-8111-111111111111', outcome: 'accepted', errorReason: null })),
  }
}

test('persists attempts in a private directory and private files', async t => {
  const root = await temporaryRoot(t)
  const attempts = new UpdatePushAttempts(root)
  await attempts.initialize()
  const item = attempts.create(candidateId, [{ environment: 'production' }], true)
  assert.equal(await attempts.save(item), true)

  const directory = join(root, 'state', 'update-push-attempts')
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, `${item.attemptId}.json`))).mode & 0o777, 0o600)
  const restarted = new UpdatePushAttempts(root)
  await restarted.initialize()
  const restored = restarted.status().updateAttempts.items[0]
  assert.equal(restored.attemptId, item.attemptId)
  assert.equal(restored.candidateId, item.candidateId)
  assert.equal(restored.targetDeviceCount, item.targetDeviceCount)
  assert.equal(restored.attemptedAt, item.attemptedAt)
  assert.equal(restored.state, 'unknown')
  assert.equal(restored.devices[0].outcome, 'unknown')
})

test('keeps a failed attempt save visible until that same attempt is saved', async t => {
  const root = await temporaryRoot(t)
  const attempts = new UpdatePushAttempts(root)
  await attempts.initialize()
  const first = attempts.create(candidateId, [{ environment: 'development' }], true)
  const second = attempts.create(candidateId, [{ environment: 'production' }], true)
  const directory = join(root, 'state', 'update-push-attempts')
  await mkdir(directory, { recursive: true })
  await mkdir(join(directory, `${first.attemptId}.json`))

  assert.equal(await attempts.save(first), false)
  assert.equal(attempts.status().updateAttemptStorageError, 'PUSH_ATTEMPT_SAVE_FAILED')
  assert.equal(await attempts.save(second), true)
  assert.equal(attempts.status().updateAttemptStorageError, 'PUSH_ATTEMPT_SAVE_FAILED')
  await rm(join(directory, `${first.attemptId}.json`), { recursive: true })
  assert.equal(await attempts.save(first), true)
  assert.equal(attempts.status().updateAttemptStorageError, undefined)
})

test('recovers a saved pending attempt as unknown without a resend side effect', async t => {
  const root = await temporaryRoot(t)
  const original = new UpdatePushAttempts(root)
  await original.initialize()
  const item = original.create(candidateId, [{ environment: 'development' }], true)
  assert.equal(await original.save(item), true)
  let sends = 0
  sends += item.devices.length

  const restarted = new UpdatePushAttempts(root)
  await restarted.initialize()
  const recovered = restarted.status().updateAttempts.items[0]
  assert.equal(sends, 1)
  assert.equal(recovered.state, 'unknown')
  assert.equal(recovered.devices[0].outcome, 'unknown')
  assert.equal(recovered.attemptId, item.attemptId)
})

test('projects valid saved records through the closed receipt schema', async t => {
  const root = await temporaryRoot(t)
  const directory = join(root, 'state', 'update-push-attempts')
  await mkdir(directory, { recursive: true })
  const attemptId = '22222222-2222-4222-8222-222222222222'
  const record = rawAttempt(attemptId)
  record.deviceToken = 'SYNTHETIC_DEVICE_TOKEN_SECRET'
  record.rawResponse = 'SYNTHETIC_PROVIDER_BODY_SECRET'
  record.devices[0].tokenHash = 'SYNTHETIC_TOKEN_HASH_SECRET'
  record.devices[0].responseHeaders = { authorization: 'SYNTHETIC_HEADER_SECRET' }
  await writeFile(join(directory, `${attemptId}.json`), JSON.stringify(record))

  const attempts = new UpdatePushAttempts(root)
  await attempts.initialize()
  const projection = attempts.status().updateAttempts.items[0]
  assert.deepEqual(Object.keys(projection).sort(), ['attemptId', 'attemptedAt', 'candidateId', 'completedAt',
    'deviceOffset', 'devices', 'errorReason', 'nextDeviceOffset', 'sentAt', 'state', 'targetDeviceCount', 'schema'].sort())
  assert.deepEqual(Object.keys(projection.devices[0]).sort(), ['apnsId', 'apnsStatus', 'device',
    'environment', 'errorReason', 'outcome', 'sentAt'].sort())
  assert(!JSON.stringify(projection).includes('SYNTHETIC_'))
})

test('preserves malformed history on disk and does not expose it as an attempt', async t => {
  const root = await temporaryRoot(t)
  const directory = join(root, 'state', 'update-push-attempts')
  await mkdir(directory, { recursive: true })
  const attemptId = '33333333-3333-4333-8333-333333333333'
  const path = join(directory, `${attemptId}.json`)
  const bytes = Buffer.from('{"schema":"wrong","private":"SYNTHETIC_MALFORMED_SECRET"}\n')
  await writeFile(path, bytes)

  const attempts = new UpdatePushAttempts(root)
  await attempts.initialize()
  assert.deepEqual(attempts.status(), { updateAttemptStorageError: 'PUSH_ATTEMPT_READ_FAILED' })
  assert.deepEqual(await readFile(path), bytes)
})

test('pages history and devices while keeping a full status page under 64 KiB', async t => {
  const root = await temporaryRoot(t)
  const attempts = new UpdatePushAttempts(root)
  await attempts.initialize()
  const records = []
  for (let index = 0; index < 6; index++) {
    const devices = Array.from({ length: 25 }, (_, device) => ({ environment: device % 2 ? 'production' : 'development' }))
    const item = attempts.create(candidateId, devices, true)
    item.attemptedAt = at(index)
    assert.equal(await attempts.save(item), true)
    records.push(item)
  }

  const restarted = new UpdatePushAttempts(root)
  await restarted.initialize()
  const first = restarted.status().updateAttempts
  assert.equal(first.total, 6)
  assert.deepEqual(first.items.map(item => item.attemptId), records.slice().reverse().slice(0, 5).map(item => item.attemptId))
  assert.equal(first.items[0].devices.length, 20)
  assert.equal(first.items[0].nextDeviceOffset, 20)
  assert.equal(first.nextBefore, first.items[4].attemptId)
  assert(Buffer.byteLength(JSON.stringify(restarted.status())) < 64 * 1024)

  const older = restarted.status({ before: first.nextBefore }).updateAttempts
  assert.deepEqual(older.items.map(item => item.attemptId), [records[0].attemptId])
  assert.equal(older.nextBefore, null)
  const remainingDevices = restarted.status({ attemptId: records[5].attemptId, deviceOffset: 20 }).updateAttempts.items[0]
  assert.equal(remainingDevices.deviceOffset, 20)
  assert.equal(remainingDevices.devices.length, 5)
  assert.equal(remainingDevices.nextDeviceOffset, null)
})

test('rejects malformed and conflicting query options', () => {
  const valid = '44444444-4444-4444-8444-444444444444'
  for (const query of [{ unknown: 'x' }, { attemptId: 'bad' }, { before: valid, attemptId: valid },
    { deviceOffset: -1 }, { deviceOffset: 1.5 }, [], null]) {
    assert.throws(() => validateUpdateAttemptQuery(query), error => error.code === 'PUSH_INPUT_INVALID' && error.status === 400)
  }
  assert.doesNotThrow(() => validateUpdateAttemptQuery({ attemptId: valid, deviceOffset: 20 }))
  assert.doesNotThrow(() => validateUpdateAttemptQuery({ before: valid }))
})
