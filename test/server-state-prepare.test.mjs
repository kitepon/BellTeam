import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, rm, chmod, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { prepareServerStateDirectories } from '../src/server-state-prepare.mjs'

const supported = { skip: typeof process.geteuid !== 'function' }
const leaves = ['state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns']
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-prepare-')), root = join(parent, 'private')
  await mkdir(root, { mode: 0o700 })
  t.after(() => rm(parent, { recursive: true, force: true }))
  // No UID0 in the test runner: chown and resulting owner metadata are
  // substituted. Modes, inodes, links, directory durability and FD close are real.
  const originalOpen = fs.promises.open, originalStat = fs.promises.lstat, owners = new Map(), handles = []
  function owner(path, info) {
    const saved = owners.get(String(path))
    if (saved) {
      info.uid = typeof info.uid === 'bigint' ? BigInt(saved.uid) : saved.uid
      info.gid = typeof info.gid === 'bigint' ? BigInt(saved.gid) : saved.gid
    }
    return info
  }
  fs.promises.lstat = async (path, ...args) => owner(path, await originalStat(path, ...args))
  fs.promises.open = async (...args) => {
    const file = await originalOpen(...args), stat = file.stat.bind(file), close = file.close.bind(file)
    const record = { path: args[0], closed: false }; handles.push(record)
    file.chown = async (uid, gid) => { owners.set(String(args[0]), { uid, gid }) }
    file.stat = async (...options) => owner(args[0], await stat(...options))
    file.close = async () => { try { await close() } finally { record.closed = true } }
    return file
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.open = originalOpen; fs.promises.lstat = originalStat; syncBuiltinESMExports() })
  return { parent, root, owners, handles, run: () => prepareServerStateDirectories({ root }) }
}

test('空の専用親だけに6leafを準備し、inode記録と一致する再利用だけを許す', supported, async t => {
  const f = await fixture(t)
  await writeFile(join(f.parent, 'old-key-canary'), 'synthetic untouched')
  assert.deepEqual(await f.run(), { status: 'prepared' })
  const receipt = JSON.parse(await readFile(join(f.root, '.prepared.json')))
  assert.equal(receipt.schema, 'bellteam.state-directories.v1')
  assert.deepEqual(receipt.leaves.map(row => row.name), leaves)
  for (const row of receipt.leaves) {
    const path = join(f.root, row.name), info = await lstat(path, { bigint: true })
    assert.equal(row.inode, String(info.ino)); assert.equal(row.device, String(info.dev))
    assert.equal(Number(info.mode & 0o777n), 0o711)
    assert.deepEqual(f.owners.get(path), { uid: 1001, gid: 1001 })
    assert.deepEqual(await readdir(path), [])
  }
  assert.equal((await lstat(join(f.root, '.prepared.json'))).mode & 0o777, 0o600)
  assert.deepEqual(await f.run(), { status: 'already-prepared' })
  assert.equal(await readFile(join(f.parent, 'old-key-canary'), 'utf8'), 'synthetic untouched')
  assert.ok(f.handles.every(handle => handle.closed))
})

test('記録なし既存leaf/未知内容/link・公開mode親を自動採用しない', supported, async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'state'))
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_COLLISION' })
  assert.equal(f.owners.size, 0)
  await rm(join(f.root, 'state'), { recursive: true }); await symlink(f.parent, join(f.root, 'state'))
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_COLLISION' })
  await rm(join(f.root, 'state')); await chmod(f.root, 0o755)
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_PARENT' })
  assert.equal(f.owners.size, 0); assert.ok(f.handles.every(handle => handle.closed))
})

test('記録後のleaf inodeやowner/modeの差替えを再帰chownで修理せず拒否する', supported, async t => {
  const f = await fixture(t); await f.run()
  await chmod(join(f.root, 'state'), 0o700)
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_CHANGED' })
  await chmod(join(f.root, 'state'), 0o711)
  await rename(join(f.root, 'state'), join(f.parent, 'old-state'))
  await mkdir(join(f.root, 'state'), { mode: 0o711 })
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_CHANGED' })
  assert.ok(f.handles.every(handle => handle.closed))
})

test('owner準備失敗は完了記録なし・FD回収、残った未完leafも勝手に再開しない', supported, async t => {
  const f = await fixture(t), original = fs.promises.open
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    if (args[0] === join(f.root, 'rooms')) file.chown = async () => { throw Object.assign(new Error('synthetic chown'), { code: 'EPERM' }) }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(f.run(), { code: 'EPERM' })
  await assert.rejects(lstat(join(f.root, '.prepared.json')), { code: 'ENOENT' })
  assert.ok(f.handles.every(handle => handle.closed))
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_COLLISION' })
})

test('準備中に親のprivate modeが変わったら完了記録を確定しない', supported, async t => {
  const f = await fixture(t), original = fs.promises.open
  fs.promises.open = async (...args) => {
    const file = await original(...args), chown = file.chown.bind(file)
    if (args[0] === join(f.root, 'rooms')) file.chown = async (...ids) => { await chown(...ids); await chmod(f.root, 0o755) }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(f.run(), { code: 'SERVER_STATE_PREPARE_CHANGED' })
  await assert.rejects(lstat(join(f.root, '.prepared.json')), { code: 'ENOENT' })
  assert.ok(f.handles.every(handle => handle.closed))
})

test('prepare CLIは追加引数と実/実効root identity不足を固定親へ触る前に拒否する', async () => {
  const exec = promisify(execFile), url = new URL('../src/server-state-prepare.mjs', import.meta.url)
  await assert.rejects(exec(process.execPath, [fileURLToPath(url), '/untrusted']), e => e.code === 1 && e.stdout === '' && e.stderr === 'SERVER_STATE_PREPARE_ARGUMENTS\n')
  for (const identity of ['getuid', 'geteuid', 'getgid', 'getegid']) {
    const code = `process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(url))}];
      for (const key of ['getuid','geteuid','getgid','getegid']) process[key] = () => key === ${JSON.stringify(identity)} ? 1000 : 0;
      await import(${JSON.stringify(url.href)});`
    await assert.rejects(exec(process.execPath, ['--input-type=module', '--eval', code]), e => e.code === 1 && e.stdout === '' && e.stderr === 'SERVER_STATE_PREPARE_IDENTITY\n')
  }
})
