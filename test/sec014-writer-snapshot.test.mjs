import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { writerSnapshotPlan, verifyWriterSnapshot, writerContainerInspectArgv, writerVolumeInspectArgv } from '../distribution/internal/sec014-writer-snapshot.mjs'

const image = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a'.repeat(64)
const config = { services: { bellteam: { image: 'sha256:' + 'b'.repeat(64), environment: { SECRET: 'synthetic-only' }, volumes: [
  { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' },
  { type: 'bind', source: '/runtime/home', target: '/home/bell' },
  { type: 'volume', source: 'cursor', target: '/home/bell/.local' },
] } }, volumes: { cursor: { name: 'fixture_cursor' } } }
const plan = writerSnapshotPlan(config, image, 'sha256:' + 'b'.repeat(64))
const terminal = (argv, rawUtf8) => ({ argv, rawUtf8, clientPid: 123, clientStartTicks: 456,
  unknown: false, terminal: { kind: 'exit', code: 0 }, stdoutBytes: Buffer.byteLength(rawUtf8),
  stdoutSha256: createHash('sha256').update(rawUtf8).digest('hex') })
const imageArgv = ['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .Id}}', image]
const blank = () => ({ image: terminal(imageArgv, JSON.stringify(plan.imageId)), list: terminal(plan.listArgv, ''), containers: null, volumes: [],
  canonical: plan.mounts.roots.map(source => ({ source, canonical: source })) })

test('finite projected snapshot preserves metadata-only boundary and never copies Compose credentials', () => {
  assert.doesNotMatch(JSON.stringify(plan), /SECRET|synthetic-only/u)
  const result = verifyWriterSnapshot(plan, blank())
  assert.equal(result.phaseReceiptProduced, false)
  assert.equal(result.participatingWritersVerified, false)
  assert.equal(result.nonparticipatingWritersVerified, false)
  assert.equal(result.bothNormalIdentitiesVerified, false)
  assert.equal(plan.maxDockerCommands, 131)
})

test('terminal nonzero, unknown, changed raw and arbitrary argv are rejected', () => {
  for (const mutate of [b => { b.list.unknown = true }, b => { b.list.terminal.code = 2 },
    b => { b.list.rawUtf8 = 'changed' }, b => { b.list.argv = ['/usr/bin/docker', 'rm', 'synthetic'] }]) {
    const value = blank(); mutate(value)
    assert.throws(() => verifyWriterSnapshot(plan, value))
  }
})

test('container denominator cannot be omitted, duplicated or exceed fixed maximum', () => {
  for (const raw of ['a'.repeat(64) + '\n', ('a'.repeat(64) + '\n').repeat(2),
    Array.from({ length: 129 }, (_, i) => i.toString(16).padStart(64, '0')).join('\n')]) {
    const value = blank(); value.list = terminal(plan.listArgv, raw)
    assert.throws(() => verifyWriterSnapshot(plan, value))
  }
})

test('canonical denominator and source aliases remain required by the existing verifier', () => {
  const value = blank(); value.canonical.pop()
  assert.throws(() => verifyWriterSnapshot(plan, value))
  value.canonical = [{ source: '/runtime/data', canonical: '/runtime/data' },
    { source: '/runtime/data', canonical: '/runtime/home' }]
  assert.throws(() => verifyWriterSnapshot(plan, value))
})

test('bounded nonempty container and volume projection is consumed without arbitrary option values', () => {
  const cid = 'c'.repeat(64), volume = 'disjoint_volume'
  const container = { id: cid, running: true, restarting: false, restartPolicy: 'no',
    mounts: [{ Type: 'volume', Name: volume, Source: '/docker/disjoint', RW: true }] }
  const value = blank()
  value.list = terminal(plan.listArgv, cid + '\n')
  value.containers = terminal(writerContainerInspectArgv([cid]), JSON.stringify(container) + '\n')
  value.volumes = [terminal(writerVolumeInspectArgv(volume), JSON.stringify({ name: volume,
    driver: 'local', mountpoint: '/docker/disjoint', optionCount: 0, type: null, device: null, options: null }))]
  value.canonical.push({ source: '/docker/disjoint', canonical: '/docker/disjoint' })
  const result = verifyWriterSnapshot(plan, value)
  assert.deepEqual(result.containerIds, [cid]); assert.deepEqual(result.volumeNames, [volume])
  assert.equal(result.terminalRefs.length, 4)
  assert.throws(() => writerVolumeInspectArgv('bad;value'))
  value.canonical[0].SECRET = 'synthetic-only'
  assert.throws(() => verifyWriterSnapshot(plan, value))
})

test('serialized snapshot input cannot enlarge command budget or replace immutable image binding', () => {
  for (const change of [{ maxDockerCommands: 132 }, { image: 'latest' }, { imageId: 'short-id' }]) {
    assert.throws(() => verifyWriterSnapshot({ ...plan, ...change }, blank()))
  }
})

test('resolved fixed image ref must match selected raw ID before writer verification', () => {
  for (const raw of [JSON.stringify('sha256:' + 'c'.repeat(64)), '{}', 'null', 'bad json', 'x'.repeat(129)]) {
    const value = blank(); value.image = terminal(imageArgv, raw)
    assert.throws(() => verifyWriterSnapshot(plan, value))
  }
  const missing = blank(); delete missing.image
  assert.throws(() => verifyWriterSnapshot(plan, missing))
  const changed = blank(); changed.image.argv = [...imageArgv.slice(0,-1), 'latest']
  assert.throws(() => verifyWriterSnapshot(plan, changed))
})


test('raw selected image survives actual snapshot consumption and cannot change identity', () => {
  const rawPlan = writerSnapshotPlan(config, plan.imageId, plan.imageId), bundle = blank()
  bundle.image = terminal(rawPlan.imageArgv, JSON.stringify(rawPlan.imageId))
  assert.equal(verifyWriterSnapshot(rawPlan, bundle).phaseReceiptProduced, false)
  assert.throws(() => verifyWriterSnapshot({ ...rawPlan, image: 'sha256:' + 'c'.repeat(64) }, bundle))
})


const writerBundle = containers => {
  const bundle = blank(), ids = containers.map(c => c.id).sort()
  bundle.list = terminal(plan.listArgv, ids.join('\n')+'\n')
  bundle.containers = terminal(writerContainerInspectArgv(ids), containers.map(c => JSON.stringify(c)).join('\n')+'\n')
  return bundle
}
const writer = (id, running, restartPolicy = 'unless-stopped') => ({ id, running, restarting: false, restartPolicy,
  mounts: [{ Type: 'bind', Source: '/runtime/data', RW: true }] })

test('execution context admits only the captured stopped container and intended running normal', () => {
  const old = 'c'.repeat(64), selected = 'd'.repeat(64)
  const stopped = writerBundle([writer(old, false)])
  assert.throws(() => verifyWriterSnapshot(plan, stopped), /WRITERS_RUNNING/u)
  assert.equal(verifyWriterSnapshot(plan, stopped, { stoppedContainer: old }).phaseReceiptProduced, false)
  const active = writerBundle([writer(old, false), writer(selected, true)])
  assert.throws(() => verifyWriterSnapshot(plan, active, { stoppedContainer: old }), /WRITERS_RUNNING/u)
  const result = verifyWriterSnapshot(plan, active, { stoppedContainer: old, activeContainer: selected })
  assert.deepEqual(result.containerIds, [old, selected])
  assert.equal(result.hostWriterAuthorityVerified, false)
  assert.throws(() => verifyWriterSnapshot(plan, writerBundle([writer(old, true)]), { stoppedContainer: old }))
  assert.throws(() => verifyWriterSnapshot(plan, writerBundle([writer(old, false, 'always')]), { stoppedContainer: old }), /WRITERS_RUNNING/u)
  assert.throws(() => verifyWriterSnapshot(plan, writerBundle([writer(old, false), writer(selected, true), writer('e'.repeat(64), true)]),
    { stoppedContainer: old, activeContainer: selected }), /WRITERS_RUNNING/u)
})

test('serialized plan cannot supply trusted execution exceptions; malformed context is refused', () => {
  const old = 'c'.repeat(64), selected = 'd'.repeat(64), bundle = writerBundle([writer(old, false), writer(selected, true)])
  for (const context of [null, [], { stoppedContainer: 'short' }, { activeContainer: 'e'.repeat(64) },
    { stoppedContainer: old, activeContainer: old }, { unrelated: old }]) {
    assert.throws(() => verifyWriterSnapshot(plan, bundle, context))
  }
  for (const exception of [{ stoppedContainer: old }, { activeContainer: selected }]) {
    assert.throws(() => verifyWriterSnapshot({ ...plan, mounts: { ...plan.mounts, ...exception } }, bundle))
  }
})

test('saved JSON object key order does not alter the fixed numeric limits', () => {
  const saved = JSON.parse(JSON.stringify(plan, (key, value) => value && !Array.isArray(value) && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
  assert.equal(verifyWriterSnapshot(saved, blank()).phaseReceiptProduced, false)
  for (const limits of [{ ...saved.limits, containers: '128' }, { ...saved.limits, extra: 0 }, { ...saved.limits, volumes: 129 }]) {
    assert.throws(() => verifyWriterSnapshot({ ...saved, limits }, blank()))
  }
})
