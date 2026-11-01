import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, link, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { prepareServerStateOwnership } from '../src/server-state-ownership.mjs'
import { transferServerState } from '../src/server-state-transfer.mjs'

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

test('the fixed call-bridge socket is excluded from regular-file ownership, while unknown sockets refuse', async t => {
  const f = await fixture(t)
  await f.run('to-server')
  assert.equal(await f.mode('state/call-bridge-socket'), 0o711)
  const path = join(f.root, 'state/call-bridge-socket/bellteam.sock')
  const listener = createServer()
  listener.listen(path); await once(listener, 'listening')
  t.after(() => new Promise(resolve => listener.close(resolve)))
  f.owners.length = 0
  await f.run('to-server')
  assert.equal(f.owners.some(owner => owner.path === path), false)
  assert.ok((await lstat(path)).isSocket())
  const other = createServer(), unknown = join(f.root, 'state/unknown.sock')
  other.listen(unknown); await once(other, 'listening')
  t.after(() => new Promise(resolve => other.close(resolve)))
  f.owners.length = 0
  await assert.rejects(f.run('to-server'), { code: 'SERVER_STATE_OWNERSHIP_FILE' })
  assert.equal(f.owners.length, 0)
})

test('実逆移行で戻した台帳・予定・画像・初期化印・共有文書も席UIDへ戻し、project内容は除外する', async t => {
  const f = await fixture(t)
  await f.put('bots/.initialized', '')
  await f.put('bots/bot-a/bot.json', JSON.stringify({ schema: 'bellteam.bot.v8', id: 'bot-a' }))
  await f.put('bots/bot-a/schedule.json', JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [] }))
  await f.put('bots/bot-a/docs/keep.md', 'seat document'); await f.put('bots/bot-a/memory/memory.db', 'seat memory')
  const ai = { schema: 'bellteam.ai-control.v1', paused: true, updatedAt: '2026-10-26T00:00:00Z', resumedAt: null }
  await f.put('shared/ai-control.json', JSON.stringify(ai)); await f.put('shared/tools/call-bridge/headers', 'synthetic header')
  await transferServerState({ root: f.root, direction: 'to-server' }); await f.run('to-server')
  await rm(join(f.root, 'state/bots/bot-a'), { recursive: true })
  await f.put('state/bots/bot-b/bot.json', JSON.stringify({ schema: 'bellteam.bot.v8', id: 'bot-b' }))
  await f.put('state/bots/bot-b/schedule.json', JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [{ id: 'newest' }] }))
  await f.put('state/bots/bot-b/messages/assets/image.png', 'newest synthetic image')
  await f.put('state/ai-control.json', JSON.stringify({ ...ai, paused: false }))
  await transferServerState({ root: f.root, direction: 'to-legacy' })
  f.owners.length = 0; await f.run('to-legacy')
  for (const path of ['bots/.initialized', 'bots/bot-b', 'bots/bot-b/bot.json', 'bots/bot-b/schedule.json', 'bots/bot-b/messages',
    'bots/bot-b/messages/assets', 'bots/bot-b/messages/assets/image.png', 'shared/ai-control.json', 'shared/tools/call-bridge/headers']) {
    assert.ok(f.owners.some(record => record.path === join(f.root, path) && record.uid === 1000 && record.gid === 1000), path)
  }
  assert.equal(JSON.parse(await readFile(join(f.root, 'bots/bot-b/schedule.json'), 'utf8')).schedules[0].id, 'newest')
  assert.equal(JSON.parse(await readFile(join(f.root, 'shared/ai-control.json'), 'utf8')).paused, false)
  assert.equal(f.owners.some(record => /\/bot-a\//u.test(record.path)), false)
  assert.equal(await readFile(join(f.root, 'bots/bot-a/docs/keep.md'), 'utf8'), 'seat document')
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
  await rm(join(f.root, 'state/linked')); await mkdir(join(f.root, 'bots/bot-a/bot.json'), { recursive: true })
  await assert.rejects(f.run('to-legacy'), { code: 'SERVER_STATE_OWNERSHIP_FILE' }); assert.equal(f.owners.length, 0)
  await mkdir(join(f.root, 'shared/ai-control.json'))
  await assert.rejects(f.run('to-legacy'), { code: 'SERVER_STATE_OWNERSHIP_FILE' }); assert.equal(f.owners.length, 0)
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
