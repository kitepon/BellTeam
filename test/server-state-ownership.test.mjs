import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, link, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareServerStateOwnership } from '../src/server-state-ownership.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'state-ownership-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
  const mode = async path => (await lstat(join(root, path))).mode & 0o777
  // Only chown is substituted: tests cannot acquire UID0. Mode and filesystem
  // identity checks run against actual temporary files and open descriptors.
  const original = fs.promises.open, owners = [], handles = []
  fs.promises.open = async (...args) => {
    const file = await original(...args), close = file.close.bind(file)
    const entry = { path: args[0], closed: false }; handles.push(entry)
    file.chown = async (uid, gid) => { owners.push({ path: args[0], uid, gid }) }
    file.close = async () => { try { await close() } finally { entry.closed = true } }
    return file
  }
  syncBuiltinESMExports()
  t.after(() => { fs.promises.open = original; syncBuiltinESMExports() })
  return { root, put, mode, owners, handles, run: direction => prepareServerStateOwnership({ root, direction }) }
}

test('本体5状態とAPNsだけを専用owner/modeへ準備し、席の文書・memory・HOMEは触らない', async t => {
  const f = await fixture(t)
  for (const path of ['state/bots/bot-a/bot.json', 'rooms/a/messages.jsonl', 'owner/profile.json', 'logs/direct-messages.jsonl',
    'shared/tools/bellteam-settings/settings.json', 'shared/tools/apns/config.json', 'state/call-bridge/headers']) await f.put(path, 'synthetic')
  await f.put('bots/bot-a/docs/keep.md', 'seat document'); await f.put('bots/bot-a/memory/memory.db', 'synthetic memory')
  await f.put('home/auth.json', 'synthetic excluded'); await f.put('shared/tools/bughub/headers', 'external owner')
  await mkdir(join(f.root, 'state/call-bridge-socket'))
  const untouched = ['bots/bot-a/docs/keep.md', 'bots/bot-a/memory/memory.db', 'home/auth.json', 'shared/tools/bughub/headers']
  const before = await Promise.all(untouched.map(path => f.mode(path)))
  const result = await f.run('to-server'); assert.equal(result.files, 7)
  for (const path of ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns', 'state/call-bridge', 'state/call-bridge-socket']) assert.equal(await f.mode(path), 0o711)
  assert.equal(await f.mode('state/bots'), 0o700); assert.equal(await f.mode('state/bots/bot-a/bot.json'), 0o600)
  for (const path of ['', 'bots', 'shared', 'shared/tools']) assert.ok(f.owners.some(record => record.path === join(f.root, path) && record.uid === 1000 && record.gid === 1000))
  assert.ok(f.owners.some(record => record.path === join(f.root, 'state/bots/bot-a/bot.json') && record.uid === 1001 && record.gid === 1001))
  assert.deepEqual(await Promise.all(untouched.map(path => f.mode(path))), before)
  assert.equal(f.owners.some(record => untouched.some(path => record.path === join(f.root, path))), false)
  assert.ok(f.handles.every(file => file.closed))
  assert.equal(await readFile(join(f.root, 'state/call-bridge/headers'), 'utf8'), 'synthetic')
})

test('逆方向は現在の全本体ファイルをUID1000へ戻し、新しい状態の内容を巻き戻さない', async t => {
  const f = await fixture(t)
  await f.put('state/ai-control.json', '{"paused":true}'); await f.run('to-server')
  await f.put('state/ai-control.json', '{"paused":false}'); await f.put('rooms/new/messages.jsonl', 'newest conversation')
  f.owners.length = 0; await f.run('to-legacy')
  assert.ok(f.owners.length && f.owners.every(owner => owner.uid === 1000 && owner.gid === 1000))
  assert.equal(await readFile(join(f.root, 'state/ai-control.json'), 'utf8'), '{"paused":false}')
  assert.equal(await readFile(join(f.root, 'rooms/new/messages.jsonl'), 'utf8'), 'newest conversation')
  assert.ok(f.handles.every(file => file.closed))
})

test('symlink祖先と所有範囲内のsymlink/hardlinkは全owner変更の前に拒否する', async t => {
  const f = await fixture(t)
  await f.put('outside/keep', 'synthetic excluded')
  await symlink(join(f.root, 'outside'), join(f.root, 'shared'))
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_OWNERSHIP_DIRECTORY' }); assert.equal(f.owners.length, 0)
  await rm(join(f.root, 'shared')); await mkdir(join(f.root, 'state'), { recursive: true })
  await symlink(join(f.root, 'outside/keep'), join(f.root, 'state/linked'))
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_OWNERSHIP_FILE' }); assert.equal(f.owners.length, 0)
  await rm(join(f.root, 'state/linked')); await link(join(f.root, 'outside/keep'), join(f.root, 'state/linked'))
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_OWNERSHIP_FILE' }); assert.equal(f.owners.length, 0)
  assert.equal(await readFile(join(f.root, 'outside/keep'), 'utf8'), 'synthetic excluded')
})

test('検証後に置換されたfileと権限変更失敗は未完了で返し、取得handleを回収する', async t => {
  const f = await fixture(t); await f.put('state/value.json', 'original')
  const original = fs.promises.open; let replace = true, fail = false
  fs.promises.open = async (...args) => {
    if (args[0] === join(f.root, 'state/value.json') && replace) {
      replace = false; await rename(args[0], join(f.root, 'state/retained.json')); await writeFile(args[0], 'replacement')
    }
    const file = await original(...args)
    if (fail) file.chmod = async () => { throw Object.assign(new Error('synthetic chmod failure'), { code: 'EACCES' }) }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_OWNERSHIP_CHANGED' })
  assert.ok(f.handles.every(file => file.closed))
  fail = true; await assert.rejects(f.run('to-server'), { code: 'EACCES' }); assert.ok(f.handles.every(file => file.closed))
  fs.promises.open = original; syncBuiltinESMExports()
})
