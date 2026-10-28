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
const blank = () => ({ list: terminal(plan.listArgv, ''), containers: null, volumes: [],
  canonical: plan.mounts.roots.map(source => ({ source, canonical: source })) })

test('finite projected snapshot preserves metadata-only boundary and never copies Compose credentials', () => {
  assert.doesNotMatch(JSON.stringify(plan), /SECRET|synthetic-only/u)
  const result = verifyWriterSnapshot(plan, blank())
  assert.equal(result.phaseReceiptProduced, false)
  assert.equal(result.participatingWritersVerified, false)
  assert.equal(result.nonparticipatingWritersVerified, false)
  assert.equal(result.bothNormalIdentitiesVerified, false)
  assert.equal(plan.maxDockerCommands, 130)
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
  assert.equal(result.terminalRefs.length, 3)
  assert.throws(() => writerVolumeInspectArgv('bad;value'))
  value.canonical[0].SECRET = 'synthetic-only'
  assert.throws(() => verifyWriterSnapshot(plan, value))
})

test('serialized snapshot input cannot enlarge command budget or replace immutable image binding', () => {
  for (const change of [{ maxDockerCommands: 131 }, { image: 'latest' }, { imageId: 'short-id' }]) {
    assert.throws(() => verifyWriterSnapshot({ ...plan, ...change }, blank()))
  }
})
