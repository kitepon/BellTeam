import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { stateWriterPlan } from '../src/server-state-writers.mjs'

const maintenance = JSON.parse(await readFile(new URL('../compose.state-maintenance.json', import.meta.url))).services['state-maintenance']
maintenance.volumes[0].source = '/runtime'

function fixture() {
  return { services: {
    bellteam: { volumes: [
      { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' },
      { type: 'bind', source: '/runtime/home', target: '/home/bell' },
      { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' },
      ...['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'].map(name=>({type:'volume',source:'server-state',volume:{nocopy:true,subpath:name.split('/').at(-1)},target:'/srv/bellteam/'+name})),
      {type:'volume',source:'server-state',target:'/run/bellteam-maintenance',read_only:true,volume:{nocopy:true}},
    ] },
    'state-maintenance': structuredClone(maintenance),
  }, volumes: { 'cursor-cli': { name: 'fixture_cursor' }, 'server-state': {name:'fixture_state',external:true} } }
}

test('normalとmaintenanceは同じvolumeの六subpathへ結合し、別sourceの内容を移行先にしない', () => {
  assert.equal(stateWriterPlan(fixture()).roots.length, 3)
  for (const mutate of [
    c => { c.services.bellteam.volumes[3].source = '/other/state' },
    c => { c.services['state-maintenance'].volumes[0].source = '/other/legacy' },
    c => { c.services['state-maintenance'].volumes[0].source = '/other/base' },
  ]) {
    const c = fixture(); mutate(c)
    assert.throws(() => stateWriterPlan(c), /WRITER_METADATA_INVALID/)
  }
})

test('新stateは異なるvolume・欠測subpath・異なるleafへ差替えない', () => {
  for (const source of ['/runtime/data/state', '/runtime/home/state', '/runtime/server-only/state-data/rooms']) {
    const c = fixture()
    c.services.bellteam.volumes[3].volume.subpath = source
    assert.throws(() => stateWriterPlan(c), /WRITER_METADATA_INVALID/)
  }
})

test('normalは旧二view/backup用targetを露出しない', () => {
  for (const mount of [
    { type: 'bind', source: '/elsewhere', target: '/srv/bellteam-legacy' },
    { type: 'bind', source: '/elsewhere', target: '/srv/bellteam-maintenance-backups/one' },
  ]) {
    const c = fixture(); c.services.bellteam.volumes.push(mount)
    assert.throws(() => stateWriterPlan(c), /WRITER_METADATA_INVALID/)
  }
})

test('既shared socketのbindは通常の独立stateと重ねず保持できる', () => {
  const c = fixture()
  c.services.bellteam.volumes.push({ type: 'bind', source: '/runtime/data/shared/sockets',
    target: '/srv/bellteam/shared/sockets', read_only: true })
  assert.equal(stateWriterPlan(c).roots.length, 3)
})
