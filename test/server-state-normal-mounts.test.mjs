import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { stateWriterPlan } from '../src/server-state-writers.mjs'

const maintenance = JSON.parse(await readFile(new URL('../compose.state-maintenance.json', import.meta.url))).services['state-maintenance']
const bindings = {
  BELLTEAM_LEGACY_DATA: '/runtime/data', BELLTEAM_STATE_PARENT: '/private/state-data',
  BELLTEAM_MAINTENANCE_BACKUP_PARENT: '/private/backups',
}
for (const mount of maintenance.volumes) for (const [variable, value] of Object.entries(bindings))
  mount.source = mount.source.replace(new RegExp('^\\$\\{' + variable + ':[^}]+\\}'), value)

function fixture() {
  return { services: {
    bellteam: { volumes: [
      { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' },
      { type: 'bind', source: '/runtime/home', target: '/home/bell' },
      { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' },
      ...structuredClone(maintenance.volumes.slice(2, 8)),
    ] },
    'state-maintenance': structuredClone(maintenance),
  }, volumes: { 'cursor-cli': { name: 'fixture_cursor' } } }
}

test('normalとmaintenanceは同じ六sourceへ結合し、別sourceの内容を移行先にしない', () => {
  assert.equal(stateWriterPlan(fixture()).roots.length, 9)
  for (const mutate of [
    c => { c.services.bellteam.volumes[3].source = '/other/state' },
    c => { c.services['state-maintenance'].volumes[0].source = '/other/legacy' },
    c => { c.services['state-maintenance'].volumes[1].source = '/other/base' },
  ]) {
    const c = fixture(); mutate(c)
    assert.throws(() => stateWriterPlan(c), /WRITER_METADATA_INVALID/)
  }
})

test('新stateとbackupを旧data/HOMEや相互の親子sourceへ重ねない', () => {
  for (const source of ['/runtime/data/state', '/runtime/home/state', '/private/backups/state', '/private/state-data/rooms']) {
    const c = fixture()
    c.services.bellteam.volumes[3].source = source
    c.services['state-maintenance'].volumes[2].source = source
    assert.throws(() => stateWriterPlan(c), /WRITER_METADATA_INVALID/)
  }
})

test('normalはlegacy/backup viewや別target経由のbackupを露出しない', () => {
  for (const mount of [
    { type: 'bind', source: '/elsewhere', target: '/srv/bellteam-legacy' },
    { type: 'bind', source: '/elsewhere', target: '/srv/bellteam-maintenance-backups/one' },
    { type: 'bind', source: '/private/backups', target: '/unexpected', read_only: true },
  ]) {
    const c = fixture(); c.services.bellteam.volumes.push(mount)
    assert.throws(() => stateWriterPlan(c), /WRITER_METADATA_INVALID/)
  }
})

test('既shared socketのbindは通常の独立stateと重ねず保持できる', () => {
  const c = fixture()
  c.services.bellteam.volumes.push({ type: 'bind', source: '/runtime/data/shared/sockets',
    target: '/srv/bellteam/shared/sockets', read_only: true })
  assert.equal(stateWriterPlan(c).roots.length, 9)
})
