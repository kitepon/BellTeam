import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rename, link, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { transferServerState, migrateServerState, relocateServerRoots, prepareServerStateRuntime } from '../src/server-state-transfer.mjs'
import { createBugHubSecurity } from '../src/bughub-security.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sealed-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (name, value) => {
    const path = join(root, name); await mkdir(dirname(path), { recursive: true })
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const profile = { schema: 'bellteam.bot.v8', id: 'bot-a', name: 'A' }
  const schedule = { schema: 'bellteam.schedule.v1', schedules: [{ id: 'current', enabled: true }] }
  return { root, put, profile, schedule,
    get: name => readFile(join(root, name), 'utf8'),
    absent: name => assert.rejects(lstat(join(root, name)), { code: 'ENOENT' }) }
}

// Kernel UID0 is exercised by Docker CI. Only owner identity is substituted
// here; real inodes, modes, rename, link/unlink and all payload bytes are used.
function ownerFixture(t) {
  const original = { open: fs.promises.open, lstat: fs.promises.lstat }, owners = new Map()
  const identity = info => `${info.dev}:${info.ino}`
  const withOwner = info => Object.assign(info, owners.get(identity(info)))
  fs.promises.lstat = async (...args) => withOwner(await original.lstat(...args))
  fs.promises.open = async (...args) => {
    const file = await original.open(...args), stat = file.stat.bind(file)
    file.chown = async (uid, gid) => owners.set(identity(await stat()), { uid, gid })
    file.stat = async (...args) => withOwner(await stat(...args))
    return file
  }
  syncBuiltinESMExports()
  t.after(() => { Object.assign(fs.promises, original); syncBuiltinESMExports() })
  return original
}

test('fresh prepare creates writable seat HOME, while existing HOME identity and bytes remain intact', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.absent('home')
  await prepareServerStateRuntime({ root: f.root })
  const before = await lstat(join(f.root, 'home'))
  assert.equal(before.uid, 1000); assert.equal(before.gid, 1000); assert.equal(before.mode & 0o777, 0o700)
  await f.put('home/auth', 'retained credentials')
  await prepareServerStateRuntime({ root: f.root })
  const after = await lstat(join(f.root, 'home'))
  assert.equal(after.ino, before.ino); assert.equal(after.uid, before.uid); assert.equal(after.mode, before.mode)
  assert.equal(await f.get('home/auth'), 'retained credentials')
})

test('interruption between fresh HOME mkdir and chown leaves it unpublished and retry completes the same inode', async t => {
  const f = await fixture(t); ownerFixture(t)
  const staged = join(f.root, 'server-only/state-data/.new-home')
  await mkdir(staged, { recursive: true, mode: 0o700 })
  const created = await fs.promises.open(staged, 'r')
  await created.chown(0, 0); await created.close()
  const inode = (await lstat(staged)).ino, open = fs.promises.open
  const fault = Object.assign(new Error('interrupted HOME ownership'), { code: 'EINTR' })
  fs.promises.open = async (...args) => {
    const file = await open(...args)
    if (args[0] === staged) file.chown = async () => { throw fault }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(prepareServerStateRuntime({ root: f.root }), error => error === fault)
  await f.absent('home')
  assert.equal((await lstat(staged)).uid, 0)
  fs.promises.open = open; syncBuiltinESMExports()
  await prepareServerStateRuntime({ root: f.root })
  const home = await lstat(join(f.root, 'home'))
  assert.equal(home.ino, inode); assert.equal(home.uid, 1000); assert.equal(home.gid, 1000)
  assert.equal(home.mode & 0o777, 0o700)
  await f.absent('server-only/state-data/.new-home')
})

test('link後unlink前の同inode profileは初期validateを通り、正本1linkへ収束する', async t => {
  const f = await fixture(t)
  await f.put('bots/.initialized', ''); await f.put('bots/bot-a/bot.json', f.profile)
  await f.put('bots/bot-a/schedule.json', f.schedule)
  await mkdir(join(f.root, 'state/bots/bot-a'), { recursive: true })
  await link(join(f.root, 'bots/bot-a/bot.json'), join(f.root, 'state/bots/bot-a/bot.json'))
  const inode = (await lstat(join(f.root, 'bots/bot-a/bot.json'))).ino
  assert.equal((await lstat(join(f.root, 'bots/bot-a/bot.json'))).nlink, 2)
  assert.equal((await transferServerState({ root: f.root, direction: 'to-server' })).status, 'transferred')
  await f.absent('bots/bot-a/bot.json')
  const after = await lstat(join(f.root, 'state/bots/bot-a/bot.json'))
  assert.equal(after.ino, inode); assert.equal(after.nlink, 1)
  assert.deepEqual(JSON.parse(await f.get('state/bots/bot-a/bot.json')), f.profile)
})

test('途中forwardから逆方向を選び、残存旧markerに妨げられず現在の文書を戻す', async t => {
  const f = await fixture(t)
  await f.put('bots/.initialized', ''); await f.put('bots/bot-a/bot.json', f.profile)
  await f.put('bots/bot-a/schedule.json', f.schedule)
  await mkdir(join(f.root, 'state/bots/bot-a'), { recursive: true })
  await rename(join(f.root, 'bots/bot-a/bot.json'), join(f.root, 'state/bots/bot-a/bot.json'))
  const inode = (await lstat(join(f.root, 'state/bots/bot-a/bot.json'))).ino
  assert.equal((await transferServerState({ root: f.root, direction: 'to-legacy', recovering: true })).status, 'transferred')
  assert.equal((await lstat(join(f.root, 'bots/bot-a/bot.json'))).ino, inode)
  assert.deepEqual(JSON.parse(await f.get('bots/bot-a/schedule.json')), f.schedule)
  await f.absent('state/bots/bot-a/bot.json')
})

test('AI停止状態の同inode対もcopy/旧値上書きなしで収束し、異内容は両方保持する', async t => {
  const f = await fixture(t)
  await f.put('bots/.initialized', '')
  const ai = { schema: 'bellteam.ai-control.v1', paused: true, updatedAt: '2026-11-01T00:00:00Z' }
  await f.put('shared/ai-control.json', ai); await mkdir(join(f.root, 'state'), { recursive: true })
  await link(join(f.root, 'shared/ai-control.json'), join(f.root, 'state/ai-control.json'))
  const inode = (await lstat(join(f.root, 'shared/ai-control.json'))).ino
  await transferServerState({ root: f.root, direction: 'to-server' })
  assert.equal((await lstat(join(f.root, 'state/ai-control.json'))).ino, inode)
  await f.put('shared/ai-control.json', { ...ai, paused: false })
  await assert.rejects(transferServerState({ root: f.root, direction: 'to-legacy', recovering: true }),
    { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  assert.equal(JSON.parse(await f.get('shared/ai-control.json')).paused, false)
  assert.equal(JSON.parse(await f.get('state/ai-control.json')).paused, true)
})

test('6領域のrenameはinodeを維持し、非空衝突時に双方のbytesを保つ', async t => {
  const f = await fixture(t), data = join(f.root, 'data'), privateRoot = join(f.root, 'server-only/state-data')
  await f.put('data/logs/current', 'current log'); await f.put('data/shared/tools/apns/key', 'current APNs')
  await f.put('server-only/state-data/owner/other', 'other owner'); await f.put('data/owner/original', 'original owner')
  const inode = (await lstat(join(data, 'state')).catch(() => null))?.ino
  await assert.rejects(relocateServerRoots({ legacyRoot: data, serverRoot: privateRoot, direction: 'to-server' }),
    { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  assert.equal(await f.get('data/owner/original'), 'original owner')
  assert.equal(await f.get('server-only/state-data/owner/other'), 'other owner')
  await rm(join(privateRoot, 'owner/other'))
  const logInode = (await lstat(join(data, 'logs'))).ino
  await relocateServerRoots({ legacyRoot: data, serverRoot: privateRoot, direction: 'to-server' })
  assert.equal((await lstat(join(privateRoot, 'logs'))).ino, logInode)
  assert.equal(await f.get('server-only/state-data/apns/key'), 'current APNs')
  if (inode) assert.equal((await lstat(join(privateRoot, 'state'))).ino, inode)
})

test('sealed transactionのCONFLICTを保持し、逆方向選択でHOME/席文書を変えず復旧する', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule); await f.put('data/bots/bot-a/docs/keep', 'seat-owned')
  await f.put('home/auth', 'excluded HOME')
  // A current value left by a prior interrupted forward conflicts with legacy.
  await f.put('data/state/subscription.json', 'current subscription')
  await f.put('data/shared/subscription.json', 'legacy subscription')
  await assert.rejects(migrateServerState({ root: f.root, direction: 'to-server' }), { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  const sealed = await lstat(join(f.root, 'data'))
  assert.equal(sealed.uid, 0); assert.equal(sealed.mode & 0o777, 0o700)
  assert.ok(JSON.parse(await f.get('server-only/state-data/.transaction.json')).id)
  await rm(join(f.root, 'data/shared/subscription.json'))
  await migrateServerState({ root: f.root, direction: 'to-legacy' })
  assert.deepEqual(JSON.parse(await f.get('data/bots/bot-a/bot.json')), f.profile)
  assert.equal(await f.get('data/shared/subscription.json'), 'current subscription')
  assert.equal(await f.get('data/bots/bot-a/docs/keep'), 'seat-owned')
  assert.equal(await f.get('home/auth'), 'excluded HOME')
  assert.equal((await lstat(join(f.root, 'data'))).uid, 1000)
  assert.equal((await lstat(join(f.root, 'data'))).mode & 0o777, 0o711)
  await f.absent('server-only/state-data/.transaction.json')
})

test('record unlink後・unseal直前の中断からもmetadataを収束させる', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule)
  const open = fs.promises.open, fault = Object.assign(new Error('interrupted unseal'), { code: 'EINTR' })
  let interrupted = false
  fs.promises.open = async (...args) => {
    const file = await open(...args), chown = file.chown.bind(file)
    file.chown = async (uid, gid) => {
      if (!interrupted && args[0] === join(f.root, 'data') && uid === 1000) { interrupted = true; throw fault }
      return chown(uid, gid)
    }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(migrateServerState({ root: f.root, direction: 'to-server' }), e => e === fault)
  await f.absent('server-only/state-data/.transaction.json')
  assert.equal((await lstat(join(f.root, 'data'))).uid, 0)
  fs.promises.open = open; syncBuiltinESMExports()
  await migrateServerState({ root: f.root, direction: 'to-server' })
  assert.equal((await lstat(join(f.root, 'data'))).uid, 1000)
  assert.equal((await lstat(join(f.root, 'data'))).mode & 0o777, 0o711)
  assert.deepEqual(JSON.parse(await f.get('server-only/state-data/state/bots/bot-a/bot.json')), f.profile)
})

test('新本体の増分会話・予定・追加Botを両方向で保ち、settled更新はseal/chownしない', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule)
  await f.put('data/rooms/room-a/messages.jsonl', 'before\n')
  await migrateServerState({ root: f.root, direction: 'to-server' })
  await f.put('server-only/state-data/state/bots/bot-b/bot.json', { ...f.profile, id: 'bot-b' })
  await f.put('server-only/state-data/state/bots/bot-b/schedule.json', { ...f.schedule, schedules: [{ id: 'new', enabled: false }] })
  await f.put('server-only/state-data/rooms/room-a/messages.jsonl', 'before\nafter\n')
  const profileInode = (await lstat(join(f.root, 'server-only/state-data/state/bots/bot-b/bot.json'))).ino
  const normal = await migrateServerState({ root: f.root, direction: 'to-server' })
  assert.equal(normal.ownership, 'unchanged')
  await migrateServerState({ root: f.root, direction: 'to-legacy' })
  assert.equal(await f.get('data/rooms/room-a/messages.jsonl'), 'before\nafter\n')
  assert.equal((await lstat(join(f.root, 'data/bots/bot-b/bot.json'))).ino, profileInode)
  assert.equal(JSON.parse(await f.get('data/bots/bot-b/schedule.json')).schedules[0].id, 'new')
  await migrateServerState({ root: f.root, direction: 'to-server' })
  assert.equal(await f.get('server-only/state-data/rooms/room-a/messages.jsonl'), 'before\nafter\n')
  assert.equal((await lstat(join(f.root, 'server-only/state-data/state/bots/bot-b/bot.json'))).ino, profileInode)
})

test('BugHub endpoint and credential move together into private state and return current values on recovery', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', '')
  await f.put('data/shared/tools/bughub/endpoint', 'http://synthetic.invalid/api/security/v1\n')
  await f.put('data/shared/tools/bughub/headers', 'x-bughub-security-token: synthetic-first\n')
  const headerInode = (await lstat(join(f.root, 'data/shared/tools/bughub/headers'))).ino
  await migrateServerState({ root: f.root, direction: 'to-server' })
  const state = 'server-only/state-data/state/bughub/'
  for (const name of ['endpoint', 'headers']) {
    await f.absent('data/shared/tools/bughub/' + name)
    const info = await lstat(join(f.root, state + name))
    assert.equal(info.uid, 1001); assert.equal(info.gid, 1001); assert.equal(info.mode & 0o777, 0o600)
  }
  assert.equal((await lstat(join(f.root, state))).mode & 0o777, 0o711)
  assert.equal((await lstat(join(f.root, state + 'headers'))).ino, headerInode)
  const seen = []
  const call = createBugHubSecurity({ root: join(f.root, 'server-only/state-data'), request: async (url, options) => {
    seen.push({ url, actor: options.headers['x-bughub-actor'], token: options.headers['x-bughub-security-token'] })
    return Response.json({ findings: [] })
  } })
  await call({ name: 'bughub_list_security_findings', args: {}, from: 'bot-a' })
  assert.deepEqual(seen, [{ url: 'http://synthetic.invalid/api/security/v1/findings', actor: 'bot-a', token: 'synthetic-first' }])
  await f.put(state + 'headers', 'x-bughub-security-token: synthetic-latest\n')
  await migrateServerState({ root: f.root, direction: 'to-legacy' })
  assert.equal(await f.get('data/shared/tools/bughub/headers'), 'x-bughub-security-token: synthetic-latest\n')
  assert.equal((await lstat(join(f.root, 'data/shared/tools/bughub/headers'))).uid, 1000)
  assert.equal((await lstat(join(f.root, 'data/shared/tools/bughub/endpoint'))).mode & 0o777, 0o600)
  await f.absent(state + 'headers'); await f.absent(state + 'endpoint')
})
