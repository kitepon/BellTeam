import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { relocateServerRoots } from '../src/server-state-transfer.mjs'

const names = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-relocation-')), legacyRoot = join(parent, 'legacy'), serverRoot = join(parent, 'server')
  await mkdir(legacyRoot); await mkdir(serverRoot)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const put = async (root, name, text) => { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), text) }
  return { parent, legacyRoot, serverRoot, put, run: direction => relocateServerRoots({ legacyRoot, serverRoot, direction }) }
}

test('固定6領域はinodeを保ってrenameし、席文書とHOMEを移さない', async t => {
  const f = await fixture(t)
  for (const name of names) await f.put(f.legacyRoot, name + '/nested/value', 'synthetic ' + name)
  await f.put(f.legacyRoot, 'bots/bot-a/docs/keep', 'seat document')
  await f.put(f.legacyRoot, 'home/auth.json', 'synthetic excluded')
  const inodes = await Promise.all(names.map(name => lstat(join(f.legacyRoot, name))))
  assert.deepEqual(await f.run('to-server'), { direction: 'to-server', status: 'relocated' })
  for (const [index, name] of names.entries()) {
    assert.equal((await lstat(join(f.serverRoot, name.split('/').at(-1)))).ino, inodes[index].ino)
    assert.equal(await readFile(join(f.serverRoot, name.split('/').at(-1), 'nested/value'), 'utf8'), 'synthetic ' + name)
    await assert.rejects(lstat(join(f.legacyRoot, name)), { code: 'ENOENT' })
  }
  assert.equal(await readFile(join(f.legacyRoot, 'bots/bot-a/docs/keep'), 'utf8'), 'seat document')
  assert.equal(await readFile(join(f.legacyRoot, 'home/auth.json'), 'utf8'), 'synthetic excluded')
})

test('最新の6領域を逆方向へrenameし、現在の会話と設定を保持する', async t => {
  const f = await fixture(t)
  await f.put(f.legacyRoot, 'state/value', 'old'); await f.run('to-server')
  await f.put(f.serverRoot, 'state/value', 'latest'); await f.put(f.serverRoot, 'rooms/new/message', 'latest conversation')
  await f.run('to-legacy')
  assert.equal(await readFile(join(f.legacyRoot, 'state/value'), 'utf8'), 'latest')
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/new/message'), 'utf8'), 'latest conversation')
  for (const name of names) await assert.rejects(lstat(join(f.serverRoot, name.split('/').at(-1))), { code: 'ENOENT' })
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

test('同じrootとlinkを拒否し、途中の未知fileでも移動済み内容を保持する', async t => {
  const f = await fixture(t); await f.put(f.legacyRoot, 'state/value', 'must stay')
  await assert.rejects(relocateServerRoots({ legacyRoot: f.legacyRoot, serverRoot: f.legacyRoot, direction: 'to-server' }), { code: 'SERVER_STATE_RELOCATION_ALIAS' })
  await symlink(join(f.legacyRoot, 'state'), join(f.serverRoot, 'state'))
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_DIRECTORY_INVALID' })
  await rm(join(f.serverRoot, 'state')); await f.put(f.serverRoot, 'rooms', 'unknown file')
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_DIRECTORY_INVALID' })
  assert.equal(await readFile(join(f.serverRoot, 'state/value'), 'utf8'), 'must stay')
})
