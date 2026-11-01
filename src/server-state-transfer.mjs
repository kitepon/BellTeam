// Offline operation: both generations and seat writers must already be stopped.
// A failed operation must not be followed by starting either server generation.
import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open, link, chmod, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { validateAiControlState } from './ai-control-state-transfer.mjs'
import { prepareServerStateOwnership } from './server-state-ownership.mjs'

const botId = /^[a-z0-9][a-z0-9-]{0,63}$/u
const failure = code => Object.assign(new Error(code), { code })
const exists = async path => { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

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
async function moveFile(source, destination, root) {
  const before = await useFile(await regular(source, destination), file => file.stat())
  await directory(dirname(destination))
  if (await exists(destination)) {
    if (!await equalFiles(source, destination)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
  } else {
    // link is no-clobber and keeps the source until the destination is durable.
    await link(source, destination)
  }
  await useFile(await regular(destination, source), file => file.sync())
  await syncAncestors(dirname(destination), root)
  await removeUnchangedSource(source, destination, before)
  await chmod(destination, 0o600)
}
async function moveTree(source, destination, root) {
  const info = await exists(source)
  if (!info) return
  await directory(source)
  await directory(dirname(destination))
  if (!await exists(destination)) {
    await validateTree(source)
    await rename(source, destination)
    await syncAncestors(dirname(destination), root)
    await syncDirectory(dirname(source))
    return
  }
  await directory(destination)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.isDirectory()) await moveTree(from, to, root)
    else if (entry.isFile()) await moveFile(from, to, root)
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

// All roots share one filesystem; rename preserves each complete directory.
export async function relocateServerRoots({ legacyRoot, serverRoot, direction }) {
  if (![legacyRoot, serverRoot].every(value => typeof value === 'string' && isAbsolute(value))
    || !['to-server', 'to-legacy'].includes(direction)) throw failure('SERVER_STATE_RELOCATION_OPTIONS')
  legacyRoot = resolve(legacyRoot); serverRoot = resolve(serverRoot)
  assertSeparateRoots(legacyRoot, serverRoot)
  await directory(legacyRoot); await directory(serverRoot)
  for (const name of protectedRoots) {
    const legacy = join(legacyRoot, name), current = join(serverRoot, name.split('/').at(-1))
    const [source, target] = direction === 'to-server' ? [legacy, current] : [current, legacy]
    const info = await exists(source)
    await directory(dirname(target))
    if (!info) { await directory(target); continue }
    await directory(source)
    if (await exists(target)) {
      await directory(target)
      const destination = await lstat(target)
      if (info.dev === destination.dev && info.ino === destination.ino) throw failure('SERVER_STATE_RELOCATION_ALIAS')
      if ((await readdir(target)).length) {
        // Empty mount points left by normal startup contain no data to move.
        if (!(await readdir(source)).length) continue
        throw failure('SERVER_STATE_TRANSFER_CONFLICT')
      }
    }
    await rename(source, target)
    await syncDirectory(dirname(target)); await syncDirectory(dirname(source))
  }
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
export async function transferServerState({ root, stateRoot = join(root, 'state'), direction, recovering = false }) {
  if (!['to-server', 'to-legacy'].includes(direction) || typeof root !== 'string' || !isAbsolute(root)
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
    for (const name of ['bot.json', 'schedule.json']) if (await exists(join(from, id, name))) await moveFile(join(from, id, name), join(to, id, name), syncRoot)
    await moveTree(join(from, id, 'messages/assets'), join(to, id, 'messages/assets'), syncRoot)
  }
  for (const pair of pairs) {
    const [a, b] = direction === 'to-server' ? pair : [...pair].reverse()
    const source = a, target = b
    if (!await exists(source)) continue
    if (a.endsWith('/ai-control.json'))
      await useFile(await regular(source, target), async file => validateAiControlState(await file.readFile()))
    await moveFile(source, target, syncRoot)
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

export async function prepareServerStateRuntime({ root }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw failure('SERVER_STATE_PREPARE_OPTIONS')
  root = resolve(root)
  const home = join(root, 'home'), existingHome = await exists(home)
  await directory(home)
  if (!existingHome) await setDirectoryOwner(home, 1000, 1000, 0o700)
  const privateRoot = join(root, 'server-only/state-data')
  await directory(privateRoot)
  await setDirectoryOwner(privateRoot, 0, 1001, 0o750)
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

export async function migrateServerState({ root, direction }) {
  if (typeof root !== 'string' || !isAbsolute(root) || !['to-server', 'to-legacy'].includes(direction))
    throw failure('SERVER_STATE_TRANSFER_OPTIONS')
  root = resolve(root)
  const data = join(root, 'data'), privateRoot = join(root, 'server-only/state-data')
  await directory(data)
  await prepareServerStateRuntime({ root })
  const record = join(privateRoot, '.transaction.json')
  let transaction
  if (await exists(record)) {
    transaction = await useFile(await regular(record), async file => JSON.parse(await file.readFile('utf8')))
    if (transaction.schema !== 'bellteam.state-transaction.v1' || typeof transaction.id !== 'string'
      || !['to-server', 'to-legacy'].includes(transaction.direction) || !Number.isFinite(Date.parse(transaction.startedAt)))
      throw failure('SERVER_STATE_TRANSACTION_INVALID')
  }
  if (!transaction && direction === 'to-server') {
    const info = await lstat(data)
    let settled = info.uid === 1000 && info.gid === 1000 && (info.mode & 0o7777) === 0o711
      && !!await exists(join(privateRoot, 'state/bots/.initialized'))
    for (const name of protectedRoots) {
      const source = join(data, name), target = await exists(join(privateRoot, name.split('/').at(-1)))
      if (!target?.isDirectory() || target.uid !== 1001 || target.gid !== 1001 || (target.mode & 0o7777) !== 0o711
        || await exists(source) && (await readdir(source)).length) settled = false
    }
    if (settled) {
      // Reuse content validation; any newly appearing legacy state is a conflict.
      const result = await transferServerState({ root: data, stateRoot: join(privateRoot, 'state'), direction })
      return { ...result, ownership: 'unchanged' }
    }
  }
  // Effective kernel permissions, not a marker alone, exclude both old/new boot.
  await setDirectoryOwner(data, 0, 0, 0o700)
  if (!transaction) {
    transaction = { schema: 'bellteam.state-transaction.v1', id: randomUUID(), direction, startedAt: new Date().toISOString() }
    await writeRecord(record, transaction)
  }
  const roots = { legacyRoot: data, serverRoot: privateRoot, direction }
  if (direction === 'to-server') await relocateServerRoots(roots)
  // An interrupted inverse may already have renamed the state directory back.
  const stateRoot = await exists(join(privateRoot, 'state')) ? join(privateRoot, 'state') : join(data, 'state')
  const result = await transferServerState({ root: data, stateRoot, direction, recovering: true })
  if (direction === 'to-legacy') await relocateServerRoots(roots)
  const ownership = await prepareServerStateOwnership({ root: data, privateRoot: direction === 'to-server' ? privateRoot : data,
    direction, sealed: true })
  await unlink(record); await syncDirectory(privateRoot)
  await setDirectoryOwner(data, 1000, 1000, 0o711)
  await syncDirectory(root)
  return { ...result, ownership, transaction: transaction.id }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || !['prepare', 'to-server', 'to-legacy'].includes(process.argv[2]))
      throw failure('SERVER_STATE_TRANSFER_ARGUMENTS')
    if ([process.getuid?.(), process.geteuid?.(), process.getgid?.(), process.getegid?.()].some(id => id !== 0))
      throw failure('SERVER_STATE_TRANSFER_IDENTITY')
    const root = '/srv/bellteam-runtime'
    console.log(JSON.stringify(await (process.argv[2] === 'prepare' ? prepareServerStateRuntime({ root })
      : migrateServerState({ root, direction: process.argv[2] }))))
  } catch (error) {
    // Maintenance errors must not print paths, parsed documents or headers.
    console.error(/^[A-Z][A-Z_0-9]*$/u.test(error.code ?? '') ? error.code : 'SERVER_STATE_TRANSFER_FAILED')
    process.exitCode = 1
  }
}
