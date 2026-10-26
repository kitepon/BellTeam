import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { relocateServerRoots, migrateServerState } from '../src/server-state-transfer.mjs'
import { backupServerState } from '../src/server-state-backup.mjs'

const names = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-relocation-')), legacyRoot = join(parent, 'legacy'), serverRoot = join(parent, 'server')
  await mkdir(legacyRoot); await mkdir(serverRoot)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const put = async (root, name, text) => { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), text) }
  return { parent, legacyRoot, serverRoot, put, run: direction => relocateServerRoots({ legacyRoot, serverRoot, direction }) }
}

test('旧viewを控えてから固定6領域だけを独立先へ移し、元mountルートを削除しない', async t => {
  const f = await fixture(t), backupRoot = join(f.parent, 'backup'); await mkdir(backupRoot, { mode: 0o700 })
  for (const name of names) await f.put(f.legacyRoot, name + '/nested/value', 'synthetic ' + name)
  await f.put(f.legacyRoot, 'bots/bot-a/docs/keep', 'seat document')
  await f.put(f.legacyRoot, 'home/auth.json', 'synthetic excluded')
  await backupServerState({ root: f.legacyRoot, backupRoot, direction: 'to-server' })
  assert.equal(await readFile(join(backupRoot, 'before-to-server/state/nested/value'), 'utf8'), 'synthetic state')
  assert.deepEqual(await f.run('to-server'), { direction: 'to-server', status: 'relocated' })
  for (const name of names) {
    assert.equal(await readFile(join(f.serverRoot, name, 'nested/value'), 'utf8'), 'synthetic ' + name)
    assert.deepEqual(await readdir(join(f.legacyRoot, name)), [])
  }
  assert.equal(await readFile(join(f.legacyRoot, 'bots/bot-a/docs/keep'), 'utf8'), 'seat document')
  assert.equal(await readFile(join(f.legacyRoot, 'home/auth.json'), 'utf8'), 'synthetic excluded')
})

test('最新の6領域を逆方向へ返し、空になった新mountルートと最新会話/設定を保持する', async t => {
  const f = await fixture(t)
  await f.put(f.legacyRoot, 'state/value', 'old'); await f.run('to-server')
  await f.put(f.serverRoot, 'state/value', 'latest'); await f.put(f.serverRoot, 'rooms/new/message', 'latest conversation')
  await f.run('to-legacy')
  assert.equal(await readFile(join(f.legacyRoot, 'state/value'), 'utf8'), 'latest')
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/new/message'), 'utf8'), 'latest conversation')
  for (const name of names) assert.ok((await lstat(join(f.serverRoot, name))).isDirectory())
})

test('途中の競合では両世代を保持し、担当が衝突を解いた後だけ残りから再開する', async t => {
  const f = await fixture(t)
  await f.put(f.legacyRoot, 'state/value', 'state'); await f.put(f.legacyRoot, 'rooms/value', 'original room')
  await f.put(f.serverRoot, 'rooms/value', 'conflicting room')
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  assert.equal(await readFile(join(f.serverRoot, 'state/value'), 'utf8'), 'state')
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/value'), 'utf8'), 'original room')
  assert.equal(await readFile(join(f.serverRoot, 'rooms/value'), 'utf8'), 'conflicting room')
  await rm(join(f.serverRoot, 'rooms/value')); await f.run('to-server')
  assert.equal(await readFile(join(f.serverRoot, 'rooms/value'), 'utf8'), 'original room')
})

test('同じroot・link祖先・6対応の未知file衝突を内容移動前に拒否する', async t => {
  const f = await fixture(t); await f.put(f.legacyRoot, 'state/value', 'must stay')
  await assert.rejects(relocateServerRoots({ legacyRoot: f.legacyRoot, serverRoot: f.legacyRoot, direction: 'to-server' }), { code: 'SERVER_STATE_RELOCATION_ALIAS' })
  await symlink(join(f.legacyRoot, 'state'), join(f.serverRoot, 'state'))
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_DIRECTORY_INVALID' })
  await rm(join(f.serverRoot, 'state')); await f.put(f.serverRoot, 'rooms', 'unknown file')
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_DIRECTORY_INVALID' })
  assert.equal(await readFile(join(f.legacyRoot, 'state/value'), 'utf8'), 'must stay')
})

test('途中世代は旧新両viewを控え、片方のbackup失敗中は内容移行を開始しない', async t => {
  const f = await fixture(t), backup = join(f.parent, 'backup')
  await f.put(f.legacyRoot, 'rooms/old/message', 'legacy remainder')
  await f.put(f.serverRoot, 'state/already-copied', 'current independent state')
  for (const view of ['legacy', 'server']) await mkdir(join(backup, view), { recursive: true, mode: 0o700 })
  for (const [view, root] of [['legacy', f.legacyRoot], ['server', f.serverRoot]])
    await backupServerState({ root, backupRoot: join(backup, view), direction: 'to-server' })
  assert.equal(await readFile(join(backup, 'legacy/before-to-server/rooms/old/message'), 'utf8'), 'legacy remainder')
  assert.equal(await readFile(join(backup, 'server/before-to-server/state/already-copied'), 'utf8'), 'current independent state')
  await f.put(f.serverRoot, 'state/latest', 'after operator review')
  await assert.rejects(backupServerState({ root: f.serverRoot, backupRoot: join(backup, 'server'), direction: 'to-server' }), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/old/message'), 'utf8'), 'legacy remainder')
  assert.equal(await readFile(join(f.serverRoot, 'state/latest'), 'utf8'), 'after operator review')
  // Exercise the actual maintenance flow: the second existing backup stops
  // relocation even when the first view's new backup completed successfully.
  await rm(join(backup, 'legacy/before-to-server'), { recursive: true })
  await assert.rejects(migrateServerState({ ...f, backupRoot: backup, direction: 'to-server' }), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/old/message'), 'utf8'), 'legacy remainder')
  assert.equal(await readFile(join(f.serverRoot, 'state/latest'), 'utf8'), 'after operator review')
})

test('実保守flowは両世代backup後に6移動/metadata/所有へ進む（chownのみ記録置換）', async t => {
  const f = await fixture(t), backupRoot = join(f.parent, 'backup'); await mkdir(backupRoot, { mode: 0o700 })
  await f.put(f.legacyRoot, 'rooms/old/message', 'legacy remainder')
  await f.put(f.serverRoot, 'state/already-copied', 'current independent state')
  const original = fs.promises.open, owners = []
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    file.chown = async (uid, gid) => { owners.push({ path: args[0], uid, gid }) }
    return file
  }
  syncBuiltinESMExports(); t.after(() => { fs.promises.open = original; syncBuiltinESMExports() })
  const result = await migrateServerState({ ...f, backupRoot, direction: 'to-server' })
  assert.equal(result.status, 'fresh')
  assert.equal(await readFile(join(backupRoot, 'legacy/before-to-server/rooms/old/message'), 'utf8'), 'legacy remainder')
  assert.equal(await readFile(join(backupRoot, 'server/before-to-server/state/already-copied'), 'utf8'), 'current independent state')
  assert.equal(await readFile(join(f.serverRoot, 'rooms/old/message'), 'utf8'), 'legacy remainder')
  assert.deepEqual(await readdir(join(f.legacyRoot, 'rooms')), [])
  assert.ok(owners.some(row => row.path === join(f.serverRoot, 'rooms/old/message') && row.uid === 1001 && row.gid === 1001))
})
