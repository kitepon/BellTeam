// Offline operation: both generations and seat writers must already be stopped.
// A failed operation must not be followed by starting either server generation.
import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open, copyFile, chmod, rename, unlink, rmdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateAiControlState } from './ai-control-state-transfer.mjs'
import { prepareServerStateOwnership } from './server-state-ownership.mjs'

const botId = /^[a-z0-9][a-z0-9-]{0,63}$/u
const failure = code => Object.assign(new Error(code), { code })
const exists = async path => { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const execute = promisify(execFile)

function assertSeparateRoots(a, b, code = 'SERVER_STATE_RELOCATION_ALIAS') {
  for (const [root, target] of [[a, b], [b, a]]) {
    const path = relative(root, target)
    if (!path || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)))
      throw failure(code)
  }
}

async function directory(path) {
  if (dirname(path) !== path) await directory(dirname(path))
  const info = await exists(path)
  if (!info) { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); return }
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SERVER_STATE_DIRECTORY_INVALID')
}
async function useFile(file, run) {
  let value, error
  try { value = await run(file) } catch (failure) { error = failure }
  try { await file.close() } catch (failure) {
    error = error ? new AggregateError([error, failure], 'SERVER_STATE_CLOSE_FAILED') : failure
  }
  if (error) throw error
  return value
}
async function syncDirectory(path) {
  await useFile(await open(path, 'r'), file => file.sync())
}
async function syncAncestors(path, root) {
  for (;;) {
    await syncDirectory(path)
    if (path === root) return
    path = dirname(path)
  }
}
async function regular(path, peer) {
  await directory(dirname(path))
  const info = await lstat(path)
  const paired = peer && await exists(peer)
  if (!info.isFile() || info.nlink !== 1 && !(info.nlink === 2 && paired?.isFile()
    && paired.dev === info.dev && paired.ino === info.ino)) throw failure('SERVER_STATE_FILE_INVALID')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw failure('SERVER_STATE_FILE_CHANGED')
    return file
  } catch (error) { return useFile(file, () => { throw error }) }
}
async function equalFiles(a, b) {
  return useFile(await regular(a, b), async left => useFile(await regular(b, a), async right => {
    const x = Buffer.alloc(65536), y = Buffer.alloc(65536)
    while (true) {
      const [l, r] = await Promise.all([left.read(x), right.read(y)])
      if (l.bytesRead !== r.bytesRead || !x.subarray(0, l.bytesRead).equals(y.subarray(0, r.bytesRead))) return false
      if (!l.bytesRead) return true
    }
  }))
}
async function removeUnchangedSource(source, destination, before) {
  const after = await lstat(source), target = await lstat(destination)
  const paired = after.dev === target.dev && after.ino === target.ino
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || !after.isFile() || after.nlink !== (paired ? 2 : 1))
    throw failure('SERVER_STATE_FILE_CHANGED')
  await unlink(source)
  await syncDirectory(dirname(source))
}
async function moveFile(source, destination, root, transaction) {
  const before = await useFile(await regular(source, destination), file => file.stat())
  await directory(dirname(destination))
  if (await exists(destination)) {
    if (!await equalFiles(source, destination)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
  } else {
    // Publish a complete copy on the destination filesystem before retiring the source.
    const temporary = join(dirname(destination), `.incoming-${transaction}-${destination.split('/').at(-1)}`)
    const pending = await exists(temporary)
    if (pending) {
      if (!pending.isFile() || pending.nlink !== 1) throw failure('SERVER_STATE_FILE_INVALID')
      await unlink(temporary)
    }
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL)
      await useFile(await regular(temporary), file => file.sync())
      if (!await equalFiles(source, temporary)) throw failure('SERVER_STATE_FILE_CHANGED')
      if (await exists(destination)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
      await rename(temporary, destination)
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  await useFile(await regular(destination, source), file => file.sync())
  await syncAncestors(dirname(destination), root)
  await removeUnchangedSource(source, destination, before)
  await chmod(destination, 0o600)
}
async function moveTree(source, destination, root, transaction) {
  const info = await exists(source)
  if (!info) return
  await directory(source)
  await directory(dirname(destination))
  await directory(destination)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.isDirectory()) await moveTree(from, to, root, transaction)
    else if (entry.isFile()) await moveFile(from, to, root, transaction)
    else throw failure('SERVER_STATE_FILE_INVALID')
  }
  await rmdir(source); await syncDirectory(dirname(source))
}
async function validateTree(path) {
  const info = await lstat(path)
  if (info.isDirectory()) {
    await directory(path)
    for (const name of await readdir(path)) await validateTree(join(path, name))
  } else await useFile(await regular(path), () => {})
}

const protectedRoots = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']

async function copyTree(source, destination, socket) {
  const info = await lstat(source)
  if (info.isSocket() && source === socket) return
  if (info.isDirectory()) {
    await directory(source); await directory(destination)
    for (const name of await readdir(source)) await copyTree(join(source, name), join(destination, name), socket)
    await syncDirectory(destination)
  } else {
    await useFile(await regular(source), () => {})
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await useFile(await regular(destination), file => file.sync())
    if (!await equalFiles(source, destination)) throw failure('SERVER_STATE_FILE_CHANGED')
  }
}
async function equalTrees(source, destination, socket) {
  const left = await lstat(source), right = await exists(destination)
  if (left.isSocket() && source === socket) return !right
  if (!right || left.isDirectory() !== right.isDirectory()) return false
  if (!left.isDirectory()) return equalFiles(source, destination)
  const names = (await readdir(source)).filter(name => join(source, name) !== socket).sort()
  if (JSON.stringify(names) !== JSON.stringify((await readdir(destination)).sort())) return false
  for (const name of names) if (!await equalTrees(join(source, name), join(destination, name), socket)) return false
  return true
}

// The source and volume may be different filesystems. Keep each original outside the live view.
export async function relocateServerRoots({ legacyRoot, serverRoot, direction, transaction = randomUUID(), retiredRoot }) {
  if (![legacyRoot, serverRoot].every(value => typeof value === 'string' && isAbsolute(value))
    || !['to-server', 'to-legacy'].includes(direction) || !/^[a-zA-Z0-9-]{1,64}$/u.test(transaction))
    throw failure('SERVER_STATE_RELOCATION_OPTIONS')
  legacyRoot = resolve(legacyRoot); serverRoot = resolve(serverRoot)
  assertSeparateRoots(legacyRoot, serverRoot)
  retiredRoot ??= join(direction === 'to-server' ? dirname(legacyRoot) : serverRoot, 'retired', transaction)
  if (!isAbsolute(retiredRoot)) throw failure('SERVER_STATE_RELOCATION_OPTIONS')
  await directory(legacyRoot); await directory(serverRoot)
  const stagingRoot = join(direction === 'to-server' ? serverRoot : legacyRoot, `.incoming-${transaction}`)
  for (const name of protectedRoots) {
    const legacy = join(legacyRoot, name), current = join(serverRoot, name.split('/').at(-1))
    const [source, target] = direction === 'to-server' ? [legacy, current] : [current, legacy]
    const info = await exists(source)
    await directory(dirname(target))
    if (!info) { await directory(target); continue }
    await directory(source)
    const socket = name === 'state' ? join(source, 'call-bridge-socket/bellteam.sock') : null
    const destination = await exists(target)
    if (destination) {
      await directory(target)
      if (info.dev === destination.dev && info.ino === destination.ino) throw failure('SERVER_STATE_RELOCATION_ALIAS')
    }
    const sourceEmpty = !(await readdir(source)).length
    const targetEmpty = !destination || !(await readdir(target)).length
    // An empty mount point is not a completed copy of a nonempty source.
    if (sourceEmpty) { if (!destination) await directory(target); continue }
    if (destination && !targetEmpty) {
      if (!await equalTrees(source, target, socket)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
    } else {
      const staged = join(stagingRoot, name.split('/').at(-1))
      await directory(stagingRoot)
      if (await exists(staged)) await rm(staged, { recursive: true })
      await copyTree(source, staged, socket)
      if (!await equalTrees(source, staged, socket)) throw failure('SERVER_STATE_FILE_CHANGED')
      if (destination) await rmdir(target)
      await rename(staged, target); await syncDirectory(dirname(target))
    }
    const retired = join(retiredRoot, name.split('/').at(-1))
    await directory(retiredRoot)
    if (await exists(retired)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
    await rename(source, retired)
    await syncDirectory(retiredRoot); await syncDirectory(dirname(source))
  }
  if (await exists(stagingRoot)) { await rmdir(stagingRoot); await syncDirectory(dirname(stagingRoot)) }
  return { direction, status: 'relocated' }
}
async function validateJson(path, valid, peer) {
  return useFile(await regular(path, peer), async file => {
    try { if (!valid(JSON.parse(await file.readFile('utf8')))) throw failure('SERVER_STATE_DOCUMENT_INVALID') }
    catch (error) { if (error instanceof SyntaxError) throw failure('SERVER_STATE_DOCUMENT_INVALID'); throw error }
  })
}
async function marker(path) {
  await directory(dirname(path))
  await useFile(await open(path, 'wx', 0o600), file => file.sync())
  await syncDirectory(dirname(path))
}

// Paths stay under the same data root. Ownership and independent mount setup
// belong to the privileged offline installer, not this content transfer.
export async function transferServerState({ root, stateRoot = join(root, 'state'), direction, recovering = false, transaction = randomUUID() }) {
  if (!/^[a-zA-Z0-9-]{1,64}$/u.test(transaction) || !['to-server', 'to-legacy'].includes(direction) || typeof root !== 'string' || !isAbsolute(root)
    || typeof stateRoot !== 'string' || !isAbsolute(stateRoot))
    throw failure('SERVER_STATE_TRANSFER_OPTIONS')
  root = resolve(root); stateRoot = resolve(stateRoot)
  let syncRoot = root
  while (relative(syncRoot, stateRoot).startsWith('..')) syncRoot = dirname(syncRoot)
  const legacy = join(root, 'bots'), server = join(stateRoot, 'bots')
  await directory(root)
  for (const path of [legacy, server, join(root, 'shared'), stateRoot]) await directory(path)
  const [from, to] = direction === 'to-server' ? [legacy, server] : [server, legacy]
  const fromMarker = join(from, '.initialized'), toMarker = join(to, '.initialized')
  // An in-progress deletion needs the new registry's recovery, not a partial
  // legacy reconstruction that could resurrect a removed member.
  const deleting = join(server, '.deleting')
  if (await exists(deleting)) {
    await directory(deleting)
    if ((await readdir(deleting)).length) throw failure('SERVER_STATE_PENDING_REMOVAL')
  }
  const pairs = [
    [join(root, 'shared/subscription.json'), join(stateRoot, 'subscription.json')],
    [join(root, 'shared/onboarding.json'), join(stateRoot, 'onboarding.json')],
    [join(root, 'shared/ai-control.json'), join(stateRoot, 'ai-control.json')],
    [join(root, 'shared/tools/call-bridge/headers'), join(stateRoot, 'call-bridge/headers')],
    [join(root, 'shared/tools/bughub/endpoint'), join(stateRoot, 'bughub/endpoint')],
    [join(root, 'shared/tools/bughub/headers'), join(stateRoot, 'bughub/headers')],
  ]
  const ids = new Set()
  for (const base of [from, to]) for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !botId.test(entry.name)) continue
    if (!entry.isDirectory()) throw failure('SERVER_STATE_DIRECTORY_INVALID')
    if ((await Promise.all(['bot.json', 'schedule.json', 'messages/assets'].map(name => exists(join(base, entry.name, name))))).some(Boolean)) ids.add(entry.name)
  }
  const fromFiles = [
    ...[...ids].flatMap(id => ['bot.json', 'schedule.json', 'messages/assets'].map(name => join(from, id, name))),
    ...pairs.map(([a, b]) => direction === 'to-server' ? a : b),
  ]
  const remaining = (await Promise.all(fromFiles.map(exists))).some(Boolean)
  if (await exists(toMarker) && !(recovering && remaining)) {
    await useFile(await regular(toMarker), () => {})
    if (await exists(fromMarker)) await useFile(await regular(fromMarker), () => {})
    if (remaining) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
    // A prior attempt may have created the marker but failed its directory
    // sync. Re-establish durability before retiring the source commit marker.
    await useFile(await regular(toMarker), file => file.sync())
    await syncAncestors(to, syncRoot)
    if (await exists(fromMarker)) { await unlink(fromMarker); await syncDirectory(from) }
    return { direction, status: 'already-transferred' }
  }
  if (!await exists(fromMarker) && !(recovering && await exists(toMarker))) {
    if (!ids.size && !remaining) return { direction, status: 'fresh' }
    throw failure('SERVER_STATE_MIGRATION_MARKER_MISSING')
  }
  if (await exists(fromMarker)) await useFile(await regular(fromMarker), () => {})
  // A killed copy may leave only this transaction's unpublished destination temporary.
  for (const path of [...[...ids].flatMap(id => ['bot.json', 'schedule.json'].flatMap(name => [join(from, id, name), join(to, id, name)])), ...pairs.flat()]) {
    const temporary = join(dirname(path), `.incoming-${transaction}-${path.split('/').at(-1)}`)
    const info = await exists(temporary)
    if (!info) continue
    if (!info.isFile() || info.nlink !== 1) throw failure('SERVER_STATE_FILE_INVALID')
    await unlink(temporary); await syncDirectory(dirname(temporary))
  }
  // Validate every remaining profile/schedule before removing any source file.
  for (const id of ids) {
    for (const name of ['bot.json', 'schedule.json']) {
      const path = await exists(join(from, id, name)) ? join(from, id, name) : join(to, id, name)
      await validateJson(path, value => name === 'bot.json'
        ? /^bellteam\.bot\.v[1-8]$/u.test(value?.schema) && (!value.id || value.id === id)
        : value?.schema === 'bellteam.schedule.v1' && Array.isArray(value.schedules),
        path === join(from, id, name) ? join(to, id, name) : join(from, id, name))
    }
  }
  for (const id of ids) {
    for (const name of ['bot.json', 'schedule.json']) if (await exists(join(from, id, name))) await moveFile(join(from, id, name), join(to, id, name), syncRoot, transaction)
    await moveTree(join(from, id, 'messages/assets'), join(to, id, 'messages/assets'), syncRoot, transaction)
  }
  for (const pair of pairs) {
    const [a, b] = direction === 'to-server' ? pair : [...pair].reverse()
    const source = a, target = b
    if (!await exists(source)) continue
    if (a.endsWith('/ai-control.json'))
      await useFile(await regular(source, target), async file => validateAiControlState(await file.readFile()))
    await moveFile(source, target, syncRoot, transaction)
  }
  await syncAncestors(to, syncRoot)
  if (!await exists(toMarker)) await marker(toMarker)
  await useFile(await regular(toMarker), file => file.sync())
  await syncAncestors(to, syncRoot)
  if (await exists(fromMarker)) await unlink(fromMarker)
  await syncDirectory(from)
  return { direction, status: 'transferred', bots: ids.size }
}

async function setDirectoryOwner(path, uid, gid, mode) {
  await useFile(await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), async file => {
    await file.chown(uid, gid); await file.chmod(mode); await file.sync()
    const info = await file.stat(), linked = await lstat(path)
    if (info.dev !== linked.dev || info.ino !== linked.ino || info.uid !== uid || info.gid !== gid
      || (info.mode & 0o7777) !== mode) throw failure('SERVER_STATE_SEAL_UNSUPPORTED')
  })
}

async function writeRecord(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await useFile(await open(temporary, 'wx', 0o600), async file => {
      await file.writeFile(JSON.stringify(value) + '\n'); await file.sync()
    })
    await rename(temporary, path); await syncDirectory(dirname(path))
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

export async function prepareServerStateRuntime({ root, privateRoot = join(root, 'server-only/state-data') }) {
  if (![root, privateRoot].every(value => typeof value === 'string' && isAbsolute(value)))
    throw failure('SERVER_STATE_PREPARE_OPTIONS')
  root = resolve(root); privateRoot = resolve(privateRoot)
  await directory(root); await directory(privateRoot)
  await setDirectoryOwner(privateRoot, 0, 1001, 0o750)
  const home = join(root, 'home')
  if (!await exists(home)) {
    // HOME and its staging stay on the same bind; the private volume is a different mount.
    const stagedHome = join(root, 'server-only/.new-home')
    await directory(stagedHome)
    await setDirectoryOwner(stagedHome, 1000, 1000, 0o700)
    await rename(stagedHome, home)
    await syncDirectory(dirname(stagedHome)); await syncDirectory(root)
  } else await directory(home)
  const info = await lstat(privateRoot), receipt = join(privateRoot, '.prepared.json')
  const expected = { schema: 'bellteam.state-directory.v2', device: String(info.dev), inode: String(info.ino) }
  if (await exists(receipt)) {
    const saved = await useFile(await regular(receipt), async file => JSON.parse(await file.readFile('utf8')))
    if (JSON.stringify(saved) !== JSON.stringify(expected)) throw failure('SERVER_STATE_PREPARE_CHANGED')
    return { status: 'already-prepared' }
  }
  await writeRecord(receipt, expected)
  return { status: 'prepared' }
}

async function readTransaction(path) {
  const value = await useFile(await regular(path), async file => JSON.parse(await file.readFile('utf8')))
  if (value?.schema !== 'bellteam.state-transaction.v2' || !/^[a-zA-Z0-9-]{1,64}$/u.test(value.id)
    || !['to-server', 'to-legacy'].includes(value.direction) || !Number.isFinite(Date.parse(value.startedAt)))
    throw failure('SERVER_STATE_TRANSACTION_INVALID')
  return value
}
async function exchange(a, b) {
  const left = await lstat(a), right = await lstat(b)
  try { await execute('/usr/bin/mv', ['--exchange', '-T', '--no-copy', a, b], { env: { PATH: '/usr/bin:/bin', LANG: 'C' } }) }
  catch { throw failure('SERVER_STATE_EXCHANGE_UNSUPPORTED') }
  const nextLeft = await lstat(a), nextRight = await lstat(b)
  if (left.dev !== nextRight.dev || left.ino !== nextRight.ino || right.dev !== nextLeft.dev || right.ino !== nextLeft.ino)
    throw failure('SERVER_STATE_EXCHANGE_CHANGED')
  await syncDirectory(dirname(a)); await syncDirectory(dirname(b))
}
async function checkExchange(root) {
  const scratch = join(root, 'server-only', `.exchange-${randomUUID()}`)
  await directory(scratch)
  try {
    const a = join(scratch, 'directory'), b = join(scratch, 'file')
    await mkdir(a); await useFile(await open(b, 'wx', 0o600), file => file.sync())
    await exchange(a, b)
    if (!(await lstat(a)).isFile() || !(await lstat(b)).isDirectory()) throw failure('SERVER_STATE_EXCHANGE_CHANGED')
  } finally { await rm(scratch, { recursive: true }) }
}
async function treeHasFiles(path) {
  const info = await exists(path)
  if (!info) return false
  if (info.isFile()) { await useFile(await regular(path), () => {}); return true }
  if (!info.isDirectory()) throw failure('SERVER_STATE_FILE_INVALID')
  for (const name of await readdir(path)) {
    const child = join(path, name), entry = await lstat(child)
    if (entry.isSocket() && child.endsWith('/state/call-bridge-socket/bellteam.sock')) continue
    if (await treeHasFiles(child)) return true
  }
  return false
}
async function legacyContents(data) {
  for (const name of [...protectedRoots, 'bots/.initialized', 'shared/subscription.json', 'shared/onboarding.json',
    'shared/ai-control.json', 'shared/tools/call-bridge/headers', 'shared/tools/bughub/headers', 'shared/tools/bughub/endpoint'])
    if (await treeHasFiles(join(data, name))) return true
  const bots = join(data, 'bots')
  if (await exists(bots)) for (const name of await readdir(bots)) {
    if (!botId.test(name)) continue
    for (const file of ['bot.json', 'schedule.json', 'messages/assets']) if (await treeHasFiles(join(bots, name, file))) return true
  }
  return false
}

export async function migrateServerState({ root, direction, privateRoot = join(root, 'server-only/state-data') }) {
  if (![root, privateRoot].every(value => typeof value === 'string' && isAbsolute(value))
    || !['to-server', 'to-legacy'].includes(direction)) throw failure('SERVER_STATE_TRANSFER_OPTIONS')
  root = resolve(root); privateRoot = resolve(privateRoot)
  await prepareServerStateRuntime({ root, privateRoot })
  const data = join(root, 'data'), hidden = join(root, 'server-only/data'), record = join(privateRoot, '.transaction.json')
  let transaction = await exists(record) ? await readTransaction(record) : null
  let dataInfo = await exists(data), hiddenInfo = await exists(hidden)
  if (!dataInfo && !hiddenInfo && !transaction) { await directory(data); dataInfo = await lstat(data) }
  if (!dataInfo || dataInfo.isSymbolicLink() || !dataInfo.isDirectory() && !dataInfo.isFile()
    || hiddenInfo?.isSymbolicLink()) throw failure('SERVER_STATE_LAYOUT_INVALID')
  if (!transaction && (!dataInfo.isDirectory() || hiddenInfo)) throw failure('SERVER_STATE_LAYOUT_INVALID')
  if (transaction && (dataInfo.isFile() ? !hiddenInfo?.isDirectory() : hiddenInfo && !hiddenInfo.isFile()))
    throw failure('SERVER_STATE_LAYOUT_INVALID')
  if (dataInfo.isFile()) {
    const copy = await readTransaction(data)
    if (JSON.stringify(copy) !== JSON.stringify(transaction)) throw failure('SERVER_STATE_TRANSACTION_INVALID')
  }
  let live = dataInfo.isDirectory() ? data : hidden
  let hasLegacy = await legacyContents(live), hasPrivate = false
  for (const name of protectedRoots) if (await treeHasFiles(join(privateRoot, name.split('/').at(-1)))) hasPrivate = true
  let settled = direction === 'to-server' && !hasLegacy && !!await exists(join(privateRoot, 'state/bots/.initialized'))
  for (const name of protectedRoots) {
    const info = await exists(join(privateRoot, name.split('/').at(-1)))
    if (!info?.isDirectory() || info.uid !== 1001 || info.gid !== 1001 || (info.mode & 0o7777) !== 0o711) settled = false
  }
  if (!transaction && settled) {
    const result = await transferServerState({ root: data, stateRoot: join(privateRoot, 'state'), direction })
    return { ...result, ownership: 'unchanged' }
  }
  if (!transaction) {
    // Reject independent live versions before changing the data-root type.
    for (const name of protectedRoots) if (await treeHasFiles(join(live, name))
      && await treeHasFiles(join(privateRoot, name.split('/').at(-1)))) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
    if (hasLegacy || hasPrivate) await checkExchange(root)
    transaction = { schema: 'bellteam.state-transaction.v2', id: randomUUID(), direction, startedAt: new Date().toISOString() }
    await writeRecord(record, transaction)
  }
  const fresh = !hasLegacy && !hasPrivate
  if (!fresh && dataInfo.isDirectory()) {
    if (!hiddenInfo) await writeRecord(hidden, transaction)
    else if (JSON.stringify(await readTransaction(hidden)) !== JSON.stringify(transaction)) throw failure('SERVER_STATE_TRANSACTION_INVALID')
    await exchange(data, hidden)
    live = hidden; dataInfo = await lstat(data)
  }
  const roots = { legacyRoot: live, serverRoot: privateRoot, direction, transaction: transaction.id,
    retiredRoot: join(direction === 'to-server' ? join(root, 'server-only') : privateRoot, 'retired', transaction.id) }
  if (direction === 'to-server') await relocateServerRoots(roots)
  const stateRoot = await exists(join(privateRoot, 'state')) ? join(privateRoot, 'state') : join(live, 'state')
  const result = await transferServerState({ root: live, stateRoot, direction, recovering: true, transaction: transaction.id })
  if (direction === 'to-legacy') await relocateServerRoots(roots)
  const ownership = await prepareServerStateOwnership({ root: live, privateRoot: direction === 'to-server' ? privateRoot : live, direction })
  for (const parent of [live, privateRoot]) {
    const staged = join(parent, `.incoming-${transaction.id}`), info = await exists(staged)
    if (!info) continue
    if (!info.isDirectory()) throw failure('SERVER_STATE_DIRECTORY_INVALID')
    await rm(staged, { recursive: true }); await syncDirectory(parent)
  }
  if ((await lstat(data)).isFile()) await exchange(data, hidden)
  hiddenInfo = await exists(hidden)
  if (hiddenInfo) {
    if (!hiddenInfo.isFile() || JSON.stringify(await readTransaction(hidden)) !== JSON.stringify(transaction))
      throw failure('SERVER_STATE_TRANSACTION_INVALID')
    await unlink(hidden); await syncDirectory(dirname(hidden))
  }
  await unlink(record); await syncDirectory(privateRoot); await syncDirectory(root)
  return { ...result, ownership, transaction: transaction.id }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || !['prepare', 'to-server', 'to-legacy'].includes(process.argv[2]))
      throw failure('SERVER_STATE_TRANSFER_ARGUMENTS')
    if ([process.getuid?.(), process.geteuid?.(), process.getgid?.(), process.getegid?.()].some(id => id !== 0))
      throw failure('SERVER_STATE_TRANSFER_IDENTITY')
    const root = '/srv/bellteam-runtime', privateRoot = '/srv/bellteam-private'
    console.log(JSON.stringify(await (process.argv[2] === 'prepare' ? prepareServerStateRuntime({ root, privateRoot })
      : migrateServerState({ root, privateRoot, direction: process.argv[2] }))))
  } catch (error) {
    // Maintenance errors must not print paths, parsed documents or headers.
    console.error(/^[A-Z][A-Z_0-9]*$/u.test(error.code ?? '') ? error.code : 'SERVER_STATE_TRANSFER_FAILED')
    process.exitCode = 1
  }
}
