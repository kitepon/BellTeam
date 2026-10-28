import assert from 'node:assert/strict'
import test from 'node:test'
import { writerSnapshotPlan } from '../distribution/internal/sec014-writer-snapshot.mjs'

const image = 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a'.repeat(64)
const imageId = 'sha256:' + 'b'.repeat(64)
const bind = (source, target) => ({ type: 'bind', source, target })
const config = () => ({ services: {
  bellteam: { image: imageId, volumes: [bind('/legacy', '/srv/bellteam'), bind('/home', '/home/bell'),
    { type: 'volume', source: 'cursor', target: '/home/bell/.local' }] },
  'state-maintenance': { image: imageId, volumes: [bind('/legacy', '/srv/bellteam-legacy'),
    bind('/legacy', '/srv/bellteam'), bind('/backup', '/srv/bellteam-maintenance-backups'),
    ...['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
      .map((leaf, i) => bind('/private/leaf' + i, '/srv/bellteam/' + leaf))] },
}, volumes: { cursor: { name: 'fixture_cursor' } } })

test('writer input: current normal must carry the selected raw image', () => {
  for (const value of ['sha256:' + 'c'.repeat(64), undefined, image]) {
    const c = config()
    c.services.bellteam.image = value
    assert.throws(() => writerSnapshotPlan(c, image, imageId), /SEC014_WRITER_SNAPSHOT_UNAVAILABLE/u)
  }
})

test('writer input: present maintenance must carry that same raw image', () => {
  for (const value of ['sha256:' + 'c'.repeat(64), undefined, image]) {
    const c = config()
    c.services['state-maintenance'].image = value
    assert.throws(() => writerSnapshotPlan(c, image, imageId), /SEC014_WRITER_SNAPSHOT_UNAVAILABLE/u)
  }
})

test('writer input: matching current and maintenance remain metadata only; normal-only input still works', () => {
  const c = config(), plan = writerSnapshotPlan(c, image, imageId)
  assert.equal(plan.imageId, imageId)
  assert.equal(plan.stage, 'docker-writer-metadata-only')
  assert.equal(plan.phaseReceiptProduced, false)
  assert.ok(plan.mounts.roots.includes('/private/leaf0'))
  delete c.services['state-maintenance']
  assert.equal(writerSnapshotPlan(c, image, imageId).phaseReceiptProduced, false)
})
