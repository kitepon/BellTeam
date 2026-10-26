import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, link, chmod, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { backupServerState } from '../src/server-state-backup.mjs'
import { transferServerState } from '../src/server-state-transfer.mjs'

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'state-backup-')), root = join(parent, 'data'), backupRoot = join(parent, 'backup')
  await mkdir(root); await mkdir(backupRoot, { mode: 0o700 })
  t.after(() => rm(parent, { recursive: true, force: true }))
  const put = async (name, value) => { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  return { parent, root, backupRoot, put, run: (direction = 'to-server') => backupServerState({ root, backupRoot, direction }) }
}

test('限定stateと移行元だけを0600で控え、HOME/席文書/個人記憶/APNs鍵/BugHubを含めない', async t => {
  const f = await fixture(t)
  const selected = ['state/bots/bot-b/bot.json', 'rooms/r/messages.jsonl', 'owner/profile.json', 'logs/direct-messages.jsonl',
    'shared/tools/bellteam-settings/settings.json', 'bots/.initialized', 'bots/bot-a/bot.json', 'bots/bot-a/schedule.json',
    'bots/bot-a/messages/assets/large.png', 'shared/tools/call-bridge/headers', 'shared/ai-control.json']
  for (const name of selected) await f.put(name, name.endsWith('.png') ? Buffer.alloc(150000, 7) : 'synthetic\n')
  const excluded = ['home/auth.json', 'bots/bot-a/docs/keep.md', 'bots/bot-a/memory/private.db',
    'shared/tools/apns/key.p8', 'shared/tools/bughub/headers']
  for (const name of excluded) await f.put(name, 'synthetic excluded')
  assert.deepEqual(await f.run(), { status: 'created' })
  const destination = join(f.backupRoot, 'before-to-server')
  for (const name of selected) {
    assert.deepEqual(await readFile(join(destination, name)), await readFile(join(f.root, name)))
    assert.equal((await lstat(join(destination, name))).mode & 0o777, 0o600)
  }
  for (const name of excluded) await assert.rejects(lstat(join(destination, name)), { code: 'ENOENT' })
  assert.equal((await lstat(destination)).mode & 0o777, 0o700)
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'complete.json'))),
    { schema: 'bellteam.state-backup.v1', direction: 'to-server', status: 'complete' })
  await assert.rejects(f.run(), { code: 'EEXIST' })
})

test('先行コピー後の元更新と完了sync失敗では完了印を残さず、元状態を巻き戻さない', async t => {
  const original = fs.promises.open
  t.after(() => { fs.promises.open = original; syncBuiltinESMExports() })
  const f = await fixture(t); await f.put('state/value', 'original'); await f.put('rooms/value', 'second')
  fs.promises.open = async (...args) => {
    if (args[0] === join(f.root, 'rooms/value')) await f.put('state/value', 'newest after earlier copy')
    return original(...args)
  }
  syncBuiltinESMExports(); await assert.rejects(f.run(), { code: 'SERVER_STATE_BACKUP_CHANGED' })
  await assert.rejects(lstat(join(f.backupRoot, 'before-to-server/complete.json')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.root, 'state/value'), 'utf8'), 'newest after earlier copy')
  fs.promises.open = original; syncBuiltinESMExports()
  const g = await fixture(t); await g.put('state/value', 'unchanged')
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    if (args[0] === join(g.backupRoot, 'before-to-server/complete.json')) file.sync = async () => { throw Object.assign(new Error('synthetic sync'), { code: 'EIO' }) }
    return file
  }
  syncBuiltinESMExports(); await assert.rejects(g.run(), { code: 'EIO' })
  await assert.rejects(lstat(join(g.backupRoot, 'before-to-server/complete.json')), { code: 'ENOENT' })
  assert.equal(await readFile(join(g.root, 'state/value'), 'utf8'), 'unchanged')
})

test('最新逆移行はbackupを復元せず現在stateから行い、各方向の控えを分ける', async t => {
  const f = await fixture(t)
  await f.put('bots/.initialized', '')
  await f.put('bots/bot-a/bot.json', JSON.stringify({ schema: 'bellteam.bot.v8', id: 'bot-a' }))
  await f.put('bots/bot-a/schedule.json', JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [] }))
  await f.run(); await transferServerState({ root: f.root, direction: 'to-server' })
  await f.put('state/bots/bot-a/schedule.json', JSON.stringify({ schema: 'bellteam.schedule.v1', schedules: [{ id: 'latest' }] }))
  await f.run('to-legacy'); await transferServerState({ root: f.root, direction: 'to-legacy' })
  assert.equal(JSON.parse(await readFile(join(f.root, 'bots/bot-a/schedule.json'))).schedules[0].id, 'latest')
  assert.deepEqual(JSON.parse(await readFile(join(f.backupRoot, 'before-to-server/bots/bot-a/schedule.json'))).schedules, [])
  assert.equal(JSON.parse(await readFile(join(f.backupRoot, 'before-to-legacy/state/bots/bot-a/schedule.json'))).schedules[0].id, 'latest')
})

test('リンクと不正親・保存先混在は内容読取/backup作成の前に拒否する', async t => {
  const f = await fixture(t); await f.put('state/value', 'synthetic')
  await symlink(join(f.root, 'state/value'), join(f.root, 'state/linked'))
  await assert.rejects(f.run(), { code: 'SERVER_STATE_BACKUP_FILE' }); assert.deepEqual(await readdir(f.backupRoot), [])
  await rm(join(f.root, 'state/linked')); await link(join(f.root, 'state/value'), join(f.root, 'state/linked'))
  await assert.rejects(f.run(), { code: 'SERVER_STATE_BACKUP_FILE' }); assert.deepEqual(await readdir(f.backupRoot), [])
  await rm(join(f.root, 'state/linked'))
  await chmod(f.backupRoot, 0o755); await assert.rejects(f.run(), { code: 'SERVER_STATE_BACKUP_PARENT' })
  await assert.rejects(backupServerState({ root: f.root, backupRoot: join(f.root, 'backup'), direction: 'to-server' }), { code: 'SERVER_STATE_BACKUP_LOCATION' })
  await rm(join(f.root, 'state'), { recursive: true }); await symlink(f.backupRoot, join(f.root, 'state'))
  await chmod(f.backupRoot, 0o700); await assert.rejects(f.run(), { code: 'SERVER_STATE_BACKUP_FILE' })
})

test('容量不足は作成前拒否し、書込み失敗は不完全な控えを残すが完了印を付けず全FDを閉じる', async t => {
  const f = await fixture(t); await f.put('state/value', 'synthetic')
  const originalStatfs = fs.promises.statfs, originalOpen = fs.promises.open, handles = []
  t.after(() => { fs.promises.statfs = originalStatfs; fs.promises.open = originalOpen; syncBuiltinESMExports() })
  fs.promises.statfs = async () => ({ bavail: 0n, bsize: 4096n }); syncBuiltinESMExports()
  await assert.rejects(f.run(), { code: 'SERVER_STATE_BACKUP_CAPACITY' }); assert.deepEqual(await readdir(f.backupRoot), [])
  fs.promises.statfs = originalStatfs
  fs.promises.open = async (...args) => {
    const file = await originalOpen(...args), close = file.close.bind(file), state = { closed: false }; handles.push(state)
    file.close = async () => { try { await close() } finally { state.closed = true } }
    if (args[0] === join(f.backupRoot, 'before-to-server/state/value')) file.write = async () => { throw Object.assign(new Error('synthetic full'), { code: 'ENOSPC' }) }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(f.run(), { code: 'ENOSPC' })
  await assert.rejects(lstat(join(f.backupRoot, 'before-to-server/complete.json')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.root, 'state/value'), 'utf8'), 'synthetic')
  assert.ok(handles.length && handles.every(handle => handle.closed))
  await assert.rejects(f.run(), { code: 'EEXIST' })
})
