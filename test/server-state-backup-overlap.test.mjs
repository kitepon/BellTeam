import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {migrateServerState} from '../src/server-state-transfer.mjs'

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-backup-overlap-'))
  t.after(() => rm(parent, {recursive:true, force:true}))
  const legacyRoot = join(parent, 'legacy-data'), serverRoot = join(parent, 'server-data')
  for (const root of [legacyRoot, serverRoot]) {
    await mkdir(join(root, 'rooms'), {recursive:true})
    await writeFile(join(root, 'rooms/message'), root === legacyRoot ? 'legacy original' : 'server latest')
  }
  return {parent, legacyRoot, serverRoot}
}

test('both backup destinations are rejected before partial backups can enter either migration view', async t => {
  for (const view of ['legacyRoot', 'serverRoot']) for (const direction of ['to-server', 'to-legacy']) {
    const f = await fixture(t), backupRoot = join(f[view], 'state/backup')
    await mkdir(backupRoot, {recursive:true, mode:0o700})
    await assert.rejects(migrateServerState({...f, backupRoot, direction}), {code:'SERVER_STATE_BACKUP_LOCATION'})
    assert.equal(await readFile(join(f.legacyRoot, 'rooms/message'), 'utf8'), 'legacy original')
    assert.equal(await readFile(join(f.serverRoot, 'rooms/message'), 'utf8'), 'server latest')
    assert.deepEqual(await readdir(backupRoot), [])
  }
})

test('separate backup destinations under a common parent preserve forward and latest return data', async t => {
  const f = await fixture(t)
  await rm(join(f.serverRoot, 'rooms/message'))
  const original = fs.promises.open, owners = []
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    file.chown = async (uid, gid) => { owners.push({path:args[0], uid, gid}) }
    return file
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.open = original; syncBuiltinESMExports() })
  await migrateServerState({...f, backupRoot:f.parent, direction:'to-server'})
  assert.equal(await readFile(join(f.parent, 'legacy/before-to-server/rooms/message'), 'utf8'), 'legacy original')
  assert.equal(await readFile(join(f.serverRoot, 'rooms/message'), 'utf8'), 'legacy original')
  await writeFile(join(f.serverRoot, 'rooms/message'), 'newest after forward')
  await migrateServerState({...f, backupRoot:f.parent, direction:'to-legacy'})
  assert.equal(await readFile(join(f.parent, 'server/before-to-legacy/rooms/message'), 'utf8'), 'newest after forward')
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/message'), 'utf8'), 'newest after forward')
  assert.ok(owners.some(x => x.path === join(f.serverRoot, 'rooms/message') && x.uid === 1001))
  assert.ok(owners.some(x => x.path === join(f.legacyRoot, 'rooms/message') && x.uid === 1000))
})
