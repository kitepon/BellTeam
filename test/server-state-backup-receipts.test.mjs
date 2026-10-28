import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.env.BELLTEAM_BACKUP_RECEIPTS_SOURCE
  ? pathToFileURL(process.env.BELLTEAM_BACKUP_RECEIPTS_SOURCE + '/') : new URL('../', import.meta.url)
const { backupServerState } = await import(new URL('src/server-state-backup.mjs', source))
const { migrateServerState } = await import(new URL('src/server-state-transfer.mjs', source))

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-backup-receipts-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const roots = Object.fromEntries(['legacyRoot', 'serverRoot', 'backupRoot'].map(name => [name, join(parent, name)]))
  for (const path of Object.values(roots)) await mkdir(path, { mode: 0o700 })
  await mkdir(join(roots.legacyRoot, 'rooms'))
  await writeFile(join(roots.legacyRoot, 'rooms/value'), 'synthetic current data')
  return roots
}

async function checkReceipt(result, root, destination, direction) {
  assert.equal(result.status, 'created')
  assert.equal(result.root, root)
  assert.equal(result.destination, destination)
  const path = join(destination, 'complete.json'), raw = await readFile(path), info = await lstat(path)
  assert.deepEqual(result.receipt, { path, device: String(info.dev), inode: String(info.ino),
    sha256: createHash('sha256').update(raw).digest('hex') })
  assert.deepEqual(JSON.parse(raw), { schema: 'bellteam.state-backup.v1', direction, status: 'complete' })
}

test('backup returns the actual private completion file identity and exact bytes hash', async t => {
  const f = await fixture(t)
  const result = await backupServerState({ root: f.legacyRoot, backupRoot: f.backupRoot, direction: 'to-server' })
  await checkReceipt(result, f.legacyRoot, join(f.backupRoot, 'before-to-server'), 'to-server')
  assert.equal((await lstat(result.receipt.path)).mode & 0o777, 0o600)
})

test('migration retains both real backup references in each direction without copying data into the result', async t => {
  const original = fs.promises.open
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    file.chown = async () => {} // Filesystem migration is real; privileged owner changes are outside this test.
    return file
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.open = original; syncBuiltinESMExports() })
  for (const direction of ['to-server', 'to-legacy']) {
    const f = await fixture(t)
    const result = await migrateServerState({ ...f, direction })
    assert.deepEqual(Object.keys(result.backups), ['legacy', 'server'])
    for (const [view, root] of [['legacy', f.legacyRoot], ['server', f.serverRoot]])
      await checkReceipt(result.backups[view], root, join(f.backupRoot, view, 'before-' + direction), direction)
    assert.doesNotMatch(JSON.stringify(result), /synthetic current data/)
  }
})

test('replacement after completion close is retained and rejected before either view is moved', async t => {
  const f = await fixture(t), receipt = join(f.backupRoot, 'legacy/before-to-server/complete.json')
  const original = fs.promises.open
  let replacement = false
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    file.chown = async () => {} // Let the old source reach its incorrect success without privileged syscalls.
    if (args[0] === receipt && args[1] === 'wx') {
      const close = file.close.bind(file)
      file.close = async () => {
        await close()
        await rename(receipt, receipt + '.original')
        await writeFile(receipt, await readFile(receipt + '.original'), { mode: 0o600, flag: 'wx' })
        replacement = true
      }
    }
    return file
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.open = original; syncBuiltinESMExports() })
  await assert.rejects(migrateServerState({ ...f, direction: 'to-server' }), { code: 'SERVER_STATE_BACKUP_RECEIPT_CHANGED' })
  assert.equal(replacement, true)
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/value'), 'utf8'), 'synthetic current data')
  await assert.rejects(lstat(join(f.serverRoot, 'rooms')), { code: 'ENOENT' })
  assert.notEqual((await lstat(receipt)).ino, (await lstat(receipt + '.original')).ino)
})
