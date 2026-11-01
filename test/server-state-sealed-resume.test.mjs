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
// here; copies, atomic exchanges, modes, inodes and all payload bytes are real.
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
  const staged = join(f.root, 'server-only/.new-home')
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
  await f.absent('server-only/.new-home')
})

test('旧link中断の同inode profileも初期validateを通り、正本1linkへ互換収束する', async t => {
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
  assert.notEqual((await lstat(join(f.root, 'bots/bot-a/bot.json'))).ino, inode)
  assert.deepEqual(JSON.parse(await f.get('bots/bot-a/bot.json')), f.profile)
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

test('6領域のcopyは元inodeをretiredへ保持し、非空衝突時に双方のbytesを保つ', async t => {
  const f = await fixture(t), data = join(f.root, 'data'), privateRoot = join(f.root, 'server-only/state-data')
  await f.put('data/logs/current', 'current log'); await f.put('data/shared/tools/apns/key', 'current APNs')
  await f.put('server-only/state-data/owner/other', 'other owner'); await f.put('data/owner/original', 'original owner')
  const options = { legacyRoot: data, serverRoot: privateRoot, direction: 'to-server', transaction: 'copy-retry' }
  await assert.rejects(relocateServerRoots(options),
    { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  assert.equal(await f.get('data/owner/original'), 'original owner')
  assert.equal(await f.get('server-only/state-data/owner/other'), 'other owner')
  await rm(join(privateRoot, 'owner/other'))
  const logInode = (await lstat(join(data, 'logs'))).ino
  await relocateServerRoots(options)
  assert.notEqual((await lstat(join(privateRoot, 'logs'))).ino, logInode)
  assert.equal((await lstat(join(f.root, 'retired/copy-retry/logs'))).ino, logInode)
  assert.equal(await f.get('retired/copy-retry/logs/current'), 'current log')
  assert.equal(await f.get('server-only/state-data/apns/key'), 'current APNs')
})

test('墓標file・hidden data・recordをCONFLICTで保持し、逆方向へ現在bytesを復旧する', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule); await f.put('data/bots/bot-a/docs/keep', 'seat-owned')
  await f.put('home/auth', 'excluded HOME')
  // A current value left by a prior interrupted forward conflicts with legacy.
  await f.put('data/state/subscription.json', 'current subscription')
  await f.put('data/shared/subscription.json', 'legacy subscription')
  await assert.rejects(migrateServerState({ root: f.root, direction: 'to-server' }), { code: 'SERVER_STATE_TRANSFER_CONFLICT' })
  const sealed = await lstat(join(f.root, 'data'))
  assert.ok(sealed.isFile()); assert.ok((await lstat(join(f.root, 'server-only/data'))).isDirectory())
  const record = JSON.parse(await f.get('server-only/state-data/.transaction.json'))
  assert.equal(record.schema, 'bellteam.state-transaction.v2')
  assert.deepEqual(JSON.parse(await f.get('data')), record)
  assert.equal(await f.get('server-only/data/shared/subscription.json'), 'legacy subscription')
  await rm(join(f.root, 'server-only/data/shared/subscription.json'))
  await migrateServerState({ root: f.root, direction: 'to-legacy' })
  assert.deepEqual(JSON.parse(await f.get('data/bots/bot-a/bot.json')), f.profile)
  assert.equal(await f.get('data/shared/subscription.json'), 'current subscription')
  assert.equal(await f.get('data/bots/bot-a/docs/keep'), 'seat-owned')
  assert.equal(await f.get('home/auth'), 'excluded HOME')
  assert.equal((await lstat(join(f.root, 'data'))).uid, 1000)
  assert.equal((await lstat(join(f.root, 'data'))).mode & 0o777, 0o711)
  await f.absent('server-only/state-data/.transaction.json')
  await f.absent('server-only/data')
})

test('leaf copy中断は墓標と元の全bytesを保持し、同transaction再開でincomingを収束する', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule)
  await f.put('data/state/value', 'original state'); await f.put('data/rooms/room-a/messages.jsonl', 'before\nafter\n')
  const copy = fs.promises.copyFile, fault = Object.assign(new Error('interrupted leaf copy'), { code: 'EINTR' })
  fs.promises.copyFile = async (source, destination, flags) => {
    if (source === join(f.root, 'server-only/data/rooms/room-a/messages.jsonl')) {
      await writeFile(destination, 'partial'); throw fault
    }
    return copy(source, destination, flags)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(migrateServerState({ root: f.root, direction: 'to-server' }), error => error === fault) }
  finally { fs.promises.copyFile = copy; syncBuiltinESMExports() }
  assert.ok((await lstat(join(f.root, 'data'))).isFile())
  assert.ok((await lstat(join(f.root, 'server-only/data'))).isDirectory())
  const record = JSON.parse(await f.get('server-only/state-data/.transaction.json'))
  assert.deepEqual(JSON.parse(await f.get('data')), record)
  assert.equal(await f.get('server-only/data/rooms/room-a/messages.jsonl'), 'before\nafter\n')
  assert.deepEqual(JSON.parse(await f.get('server-only/data/bots/bot-a/bot.json')), f.profile)
  assert.equal(await f.get(`server-only/retired/${record.id}/state/value`), 'original state')
  const incoming = `server-only/state-data/.incoming-${record.id}`
  assert.equal(await f.get(incoming + '/rooms/room-a/messages.jsonl'), 'partial')
  const resumed = await migrateServerState({ root: f.root, direction: 'to-server' })
  assert.equal(resumed.transaction, record.id)
  assert.ok((await lstat(join(f.root, 'data'))).isDirectory())
  assert.equal(await f.get('server-only/state-data/rooms/room-a/messages.jsonl'), 'before\nafter\n')
  assert.deepEqual(JSON.parse(await f.get('server-only/state-data/state/bots/bot-a/bot.json')), f.profile)
  assert.equal(await f.get(`server-only/retired/${record.id}/rooms/room-a/messages.jsonl`), 'before\nafter\n')
  await f.absent(incoming); await f.absent('server-only/data'); await f.absent('server-only/state-data/.transaction.json')
})

test('copy中断から逆方向を選ぶと元bytesを戻し、旧方向のincomingも残さない', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule)
  await f.put('data/state/value', 'original state'); await f.put('data/rooms/current', 'latest room')
  const copy = fs.promises.copyFile, fault = Object.assign(new Error('interrupted rooms copy'), { code: 'EINTR' })
  fs.promises.copyFile = async (source, destination, flags) => {
    if (source === join(f.root, 'server-only/data/rooms/current')) { await writeFile(destination, 'partial'); throw fault }
    return copy(source, destination, flags)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(migrateServerState({ root: f.root, direction: 'to-server' }), error => error === fault) }
  finally { fs.promises.copyFile = copy; syncBuiltinESMExports() }
  const record = JSON.parse(await f.get('server-only/state-data/.transaction.json'))
  const result = await migrateServerState({ root: f.root, direction: 'to-legacy' })
  assert.equal(result.transaction, record.id)
  assert.ok((await lstat(join(f.root, 'data'))).isDirectory())
  assert.equal(await f.get('data/state/value'), 'original state')
  assert.equal(await f.get('data/rooms/current'), 'latest room')
  assert.deepEqual(JSON.parse(await f.get('data/bots/bot-a/bot.json')), f.profile)
  await f.absent('server-only/data'); await f.absent('server-only/state-data/.transaction.json')
  await f.absent(`server-only/state-data/.incoming-${record.id}`)
})

test('unseal交換後のhidden record掃除が中断しても同transactionのbytesを収束させる', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule)
  const unlink = fs.promises.unlink, fault = Object.assign(new Error('interrupted unseal cleanup'), { code: 'EINTR' })
  let interrupted = false
  fs.promises.unlink = async (...args) => {
    if (!interrupted && args[0] === join(f.root, 'server-only/data')) { interrupted = true; throw fault }
    return unlink(...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(migrateServerState({ root: f.root, direction: 'to-server' }), e => e === fault) }
  finally { fs.promises.unlink = unlink; syncBuiltinESMExports() }
  assert.ok((await lstat(join(f.root, 'data'))).isDirectory())
  assert.ok((await lstat(join(f.root, 'server-only/data'))).isFile())
  const record = JSON.parse(await f.get('server-only/state-data/.transaction.json'))
  assert.deepEqual(JSON.parse(await f.get('server-only/data')), record)
  const recovered = await migrateServerState({ root: f.root, direction: 'to-server' })
  assert.equal(recovered.transaction, record.id)
  assert.equal((await lstat(join(f.root, 'data'))).uid, 1000)
  assert.equal((await lstat(join(f.root, 'data'))).mode & 0o777, 0o711)
  assert.deepEqual(JSON.parse(await f.get('server-only/state-data/state/bots/bot-a/bot.json')), f.profile)
  await f.absent('server-only/data'); await f.absent('server-only/state-data/.transaction.json')
})

test('増分会話・予定・追加Botを両方向で保ち、settled更新ではcopyしない', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', ''); await f.put('data/bots/bot-a/bot.json', f.profile)
  await f.put('data/bots/bot-a/schedule.json', f.schedule)
  await f.put('data/rooms/room-a/messages.jsonl', 'before\n')
  await migrateServerState({ root: f.root, direction: 'to-server' })
  await f.put('server-only/state-data/state/bots/bot-b/bot.json', { ...f.profile, id: 'bot-b' })
  await f.put('server-only/state-data/state/bots/bot-b/schedule.json', { ...f.schedule, schedules: [{ id: 'new', enabled: false }] })
  await f.put('server-only/state-data/rooms/room-a/messages.jsonl', 'before\nafter\n')
  const profileInode = (await lstat(join(f.root, 'server-only/state-data/state/bots/bot-b/bot.json'))).ino
  const copy = fs.promises.copyFile
  fs.promises.copyFile = async () => { throw new Error('settled update must not copy') }; syncBuiltinESMExports()
  let normal
  try { normal = await migrateServerState({ root: f.root, direction: 'to-server' }) }
  finally { fs.promises.copyFile = copy; syncBuiltinESMExports() }
  assert.equal(normal.ownership, 'unchanged')
  assert.equal((await lstat(join(f.root, 'server-only/state-data/state/bots/bot-b/bot.json'))).ino, profileInode)
  await migrateServerState({ root: f.root, direction: 'to-legacy' })
  assert.equal(await f.get('data/rooms/room-a/messages.jsonl'), 'before\nafter\n')
  assert.deepEqual(JSON.parse(await f.get('data/bots/bot-b/bot.json')), { ...f.profile, id: 'bot-b' })
  assert.equal(JSON.parse(await f.get('data/bots/bot-b/schedule.json')).schedules[0].id, 'new')
  await migrateServerState({ root: f.root, direction: 'to-server' })
  assert.equal(await f.get('server-only/state-data/rooms/room-a/messages.jsonl'), 'before\nafter\n')
  assert.deepEqual(JSON.parse(await f.get('server-only/state-data/state/bots/bot-b/bot.json')), { ...f.profile, id: 'bot-b' })
})

test('BugHub endpoint and credential move together into private state and return current values on recovery', async t => {
  const f = await fixture(t); ownerFixture(t)
  await f.put('data/bots/.initialized', '')
  await f.put('data/shared/tools/bughub/endpoint', 'http://synthetic.invalid/api/security/v1\n')
  await f.put('data/shared/tools/bughub/headers', 'x-bughub-security-token: synthetic-first\n')
  await migrateServerState({ root: f.root, direction: 'to-server' })
  const state = 'server-only/state-data/state/bughub/'
  for (const name of ['endpoint', 'headers']) {
    await f.absent('data/shared/tools/bughub/' + name)
    const info = await lstat(join(f.root, state + name))
    assert.equal(info.uid, 1001); assert.equal(info.gid, 1001); assert.equal(info.mode & 0o777, 0o600)
  }
  assert.equal((await lstat(join(f.root, state))).mode & 0o777, 0o711)
  assert.equal(await f.get(state + 'headers'), 'x-bughub-security-token: synthetic-first\n')
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
