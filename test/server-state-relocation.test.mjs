import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { relocateServerRoots } from '../src/server-state-transfer.mjs'

const names = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-relocation-')), legacyRoot = join(parent, 'legacy'), serverRoot = join(parent, 'server')
  await mkdir(legacyRoot); await mkdir(serverRoot)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const put = async (root, name, text) => { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), text) }
  return { parent, legacyRoot, serverRoot, put, run: direction => relocateServerRoots({ legacyRoot, serverRoot, direction, transaction: direction }) }
}

test('固定6領域を独立copyし、元inodeをretiredへ保持して席文書とHOMEを移さない', async t => {
  const f = await fixture(t)
  for (const name of names) await f.put(f.legacyRoot, name + '/nested/value', 'synthetic ' + name)
  await f.put(f.legacyRoot, 'bots/bot-a/docs/keep', 'seat document')
  await f.put(f.legacyRoot, 'home/auth.json', 'synthetic excluded')
  const inodes = await Promise.all(names.map(name => lstat(join(f.legacyRoot, name))))
  assert.deepEqual(await f.run('to-server'), { direction: 'to-server', status: 'relocated' })
  for (const [index, name] of names.entries()) {
    const leaf = name.split('/').at(-1), retired = join(f.parent, 'retired/to-server', leaf)
    assert.notEqual((await lstat(join(f.serverRoot, leaf))).ino, inodes[index].ino)
    assert.equal((await lstat(retired)).ino, inodes[index].ino)
    assert.equal(await readFile(join(retired, 'nested/value'), 'utf8'), 'synthetic ' + name)
    assert.equal(await readFile(join(f.serverRoot, name.split('/').at(-1), 'nested/value'), 'utf8'), 'synthetic ' + name)
    await assert.rejects(lstat(join(f.legacyRoot, name)), { code: 'ENOENT' })
  }
  assert.equal(await readFile(join(f.legacyRoot, 'bots/bot-a/docs/keep'), 'utf8'), 'seat document')
  assert.equal(await readFile(join(f.legacyRoot, 'home/auth.json'), 'utf8'), 'synthetic excluded')
})

test('最新の6領域を逆方向へcopyし、volume原本と現在の会話・設定を保持する', async t => {
  const f = await fixture(t)
  await f.put(f.legacyRoot, 'state/value', 'old'); await f.run('to-server')
  await f.put(f.serverRoot, 'state/value', 'latest'); await f.put(f.serverRoot, 'rooms/new/message', 'latest conversation')
  await f.run('to-legacy')
  assert.equal(await readFile(join(f.legacyRoot, 'state/value'), 'utf8'), 'latest')
  assert.equal(await readFile(join(f.legacyRoot, 'rooms/new/message'), 'utf8'), 'latest conversation')
  assert.equal(await readFile(join(f.serverRoot, 'retired/to-legacy/state/value'), 'utf8'), 'latest')
  for (const name of ['state', 'rooms']) await assert.rejects(lstat(join(f.serverRoot, name)), { code: 'ENOENT' })
  for (const name of ['owner', 'logs', 'bellteam-settings', 'apns'])
    assert.deepEqual(await readdir(join(f.serverRoot, name)), [])
})

test('空targetを到着済みと扱わず、非空sourceをcopyしてから元をretireする', async t => {
  const f = await fixture(t)
  await f.put(f.legacyRoot, 'state/current', 'current bytes')
  await mkdir(join(f.serverRoot, 'state'))
  const source = await lstat(join(f.legacyRoot, 'state'))
  await f.run('to-server')
  assert.equal(await readFile(join(f.serverRoot, 'state/current'), 'utf8'), 'current bytes')
  const retired = join(f.parent, 'retired/to-server/state')
  assert.equal((await lstat(retired)).ino, source.ino)
  assert.equal(await readFile(join(retired, 'current'), 'utf8'), 'current bytes')
})

test('copy途中の失敗は元の全bytesを保持し、同transactionのincomingだけを作り直す', async t => {
  const f = await fixture(t)
  await f.put(f.legacyRoot, 'state/a', 'complete first')
  await f.put(f.legacyRoot, 'state/b', 'complete second')
  const original = fs.promises.copyFile, fault = Object.assign(new Error('partial copy'), { code: 'EIO' })
  fs.promises.copyFile = async (source, destination, flags) => {
    if (source === join(f.legacyRoot, 'state/b')) { await writeFile(destination, 'partial'); throw fault }
    return original(source, destination, flags)
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.copyFile = original; syncBuiltinESMExports() })
  await assert.rejects(f.run('to-server'), error => error === fault)
  for (const [name, bytes] of [['a', 'complete first'], ['b', 'complete second']])
    assert.equal(await readFile(join(f.legacyRoot, 'state', name), 'utf8'), bytes)
  await assert.rejects(lstat(join(f.serverRoot, 'state')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.serverRoot, '.incoming-to-server/state/b'), 'utf8'), 'partial')
  fs.promises.copyFile = original; syncBuiltinESMExports()
  await f.run('to-server')
  assert.equal(await readFile(join(f.serverRoot, 'state/b'), 'utf8'), 'complete second')
  assert.equal(await readFile(join(f.parent, 'retired/to-server/state/b'), 'utf8'), 'complete second')
  await assert.rejects(lstat(join(f.serverRoot, '.incoming-to-server')), { code: 'ENOENT' })
})

test('実mount差のEXDEVを確認してから両方向へcopyし、それぞれの元bytesをretireする', async t => {
  const f = await fixture(t)
  let serverRoot
  try { serverRoot = await mkdtemp('/dev/shm/sec014-copy-') } catch (error) {
    if (['ENOENT', 'EACCES', 'EROFS'].includes(error.code)) { t.skip('/dev/shm is unavailable'); return }
    throw error
  }
  t.after(() => rm(serverRoot, { recursive: true, force: true }))
  assert.notEqual((await lstat(f.legacyRoot)).dev, (await lstat(serverRoot)).dev)
  await f.put(f.legacyRoot, 'state/value', 'cross filesystem original')
  await assert.rejects(rename(join(f.legacyRoot, 'state/value'), join(serverRoot, 'must-not-arrive')), { code: 'EXDEV' })
  await relocateServerRoots({ legacyRoot: f.legacyRoot, serverRoot, direction: 'to-server', transaction: 'cross-forward' })
  assert.equal(await readFile(join(serverRoot, 'state/value'), 'utf8'), 'cross filesystem original')
  assert.equal(await readFile(join(f.parent, 'retired/cross-forward/state/value'), 'utf8'), 'cross filesystem original')
  await writeFile(join(serverRoot, 'state/value'), 'cross filesystem latest')
  await relocateServerRoots({ legacyRoot: f.legacyRoot, serverRoot, direction: 'to-legacy', transaction: 'cross-inverse' })
  assert.equal(await readFile(join(f.legacyRoot, 'state/value'), 'utf8'), 'cross filesystem latest')
  assert.equal(await readFile(join(serverRoot, 'retired/cross-inverse/state/value'), 'utf8'), 'cross filesystem latest')
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
