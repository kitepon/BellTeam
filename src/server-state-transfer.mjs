// Offline operation: both generations and seat writers must already be stopped.
// A failed operation must not be followed by starting either server generation.
import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open, copyFile, chmod, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { transferAiControlState } from './ai-control-state-transfer.mjs'
import { prepareServerStateOwnership } from './server-state-ownership.mjs'
import { backupServerState } from './server-state-backup.mjs'

const botId = /^[a-z0-9][a-z0-9-]{0,63}$/u
const failure = code => Object.assign(new Error(code), { code })
const exists = async path => { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

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
async function regular(path) {
  await directory(dirname(path))
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1) throw failure('SERVER_STATE_FILE_INVALID')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw failure('SERVER_STATE_FILE_CHANGED')
    return file
  } catch (error) { return useFile(file, () => { throw error }) }
}
async function equalFiles(a, b) {
  return useFile(await regular(a), async left => useFile(await regular(b), async right => {
    const x = Buffer.alloc(65536), y = Buffer.alloc(65536)
    while (true) {
      const [l, r] = await Promise.all([left.read(x), right.read(y)])
      if (l.bytesRead !== r.bytesRead || !x.subarray(0, l.bytesRead).equals(y.subarray(0, r.bytesRead))) return false
      if (!l.bytesRead) return true
    }
  }))
}
async function moveFile(source, destination, root) {
  const before = await useFile(await regular(source), file => file.stat())
  await directory(dirname(destination))
  if (await exists(destination)) {
    if (!await equalFiles(source, destination)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
  } else {
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL)
      await chmod(temporary, 0o600)
      await useFile(await open(temporary, 'r+'), file => file.sync())
      // No stopped writer may have changed the source or created a target.
      if (await exists(destination)) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
      await rename(temporary, destination)
      await syncDirectory(dirname(destination))
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  await syncAncestors(dirname(destination), root)
  const after = await lstat(source)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs
    || before.mtimeMs !== after.mtimeMs || !after.isFile() || after.nlink !== 1) throw failure('SERVER_STATE_FILE_CHANGED')
  await unlink(source)
  await syncDirectory(dirname(source))
}
async function moveTree(source, destination, root, keepRoot = false) {
  const info = await exists(source)
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SERVER_STATE_DIRECTORY_INVALID')
  await directory(source)
  await directory(destination)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.isDirectory()) await moveTree(from, to, root)
    else if (entry.isFile()) await moveFile(from, to, root)
    else throw failure('SERVER_STATE_FILE_INVALID')
  }
  if (!keepRoot) { await rmdir(source); await syncDirectory(dirname(source)) }
}

// The two maintenance views share seat data, but these six destinations must
// be distinct, protected mounts. Never remove their mounted root directories.
export async function relocateServerRoots({ legacyRoot, serverRoot, direction }) {
  if (![legacyRoot, serverRoot].every(value => typeof value === 'string' && isAbsolute(value))
    || !['to-server', 'to-legacy'].includes(direction)) throw failure('SERVER_STATE_RELOCATION_OPTIONS')
  legacyRoot = resolve(legacyRoot); serverRoot = resolve(serverRoot)
  if (legacyRoot === serverRoot) throw failure('SERVER_STATE_RELOCATION_ALIAS')
  const names = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
  const [from, to] = direction === 'to-server' ? [legacyRoot, serverRoot] : [serverRoot, legacyRoot]
  await directory(from); await directory(to)
  // Validate the full fixed mapping before moving the first root's content.
  for (const name of names) {
    const source = join(from, name), target = join(to, name)
    const info = await exists(source)
    await directory(target)
    if (!info) continue
    await directory(source)
    const destination = await lstat(target)
    if (info.dev === destination.dev && info.ino === destination.ino) throw failure('SERVER_STATE_RELOCATION_ALIAS')
  }
  for (const name of names) await moveTree(join(from, name), join(to, name), to, true)
  return { direction, status: 'relocated' }
}
async function validateJson(path, valid) {
  return useFile(await regular(path), async file => {
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
export async function transferServerState({ root, direction }) {
  if (!['to-server', 'to-legacy'].includes(direction) || typeof root !== 'string' || !isAbsolute(root))
    throw failure('SERVER_STATE_TRANSFER_OPTIONS')
  root = resolve(root)
  const legacy = join(root, 'bots'), server = join(root, 'state/bots')
  await directory(root)
  for (const path of [legacy, server, join(root, 'shared'), join(root, 'state')]) await directory(path)
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
    ['shared/subscription.json', 'state/subscription.json'],
    ['shared/onboarding.json', 'state/onboarding.json'],
    ['shared/ai-control.json', 'state/ai-control.json'],
    ['shared/tools/call-bridge/headers', 'state/call-bridge/headers'],
  ]
  const ids = new Set()
  for (const base of [from, to]) for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !botId.test(entry.name)) continue
    if (!entry.isDirectory()) throw failure('SERVER_STATE_DIRECTORY_INVALID')
    if ((await Promise.all(['bot.json', 'schedule.json', 'messages/assets'].map(name => exists(join(base, entry.name, name))))).some(Boolean)) ids.add(entry.name)
  }
  const fromFiles = [
    ...[...ids].flatMap(id => ['bot.json', 'schedule.json', 'messages/assets'].map(name => join(from, id, name))),
    ...pairs.map(([a, b]) => join(root, direction === 'to-server' ? a : b)),
  ]
  const remaining = (await Promise.all(fromFiles.map(exists))).some(Boolean)
  if (await exists(toMarker)) {
    await useFile(await regular(toMarker), () => {})
    if (await exists(fromMarker)) await useFile(await regular(fromMarker), () => {})
    if (remaining) throw failure('SERVER_STATE_TRANSFER_CONFLICT')
    // A prior attempt may have created the marker but failed its directory
    // sync. Re-establish durability before retiring the source commit marker.
    await useFile(await regular(toMarker), file => file.sync())
    await syncAncestors(to, root)
    if (await exists(fromMarker)) { await unlink(fromMarker); await syncDirectory(from) }
    return { direction, status: 'already-transferred' }
  }
  if (!await exists(fromMarker)) {
    if (!ids.size && !remaining) return { direction, status: 'fresh' }
    throw failure('SERVER_STATE_MIGRATION_MARKER_MISSING')
  }
  await useFile(await regular(fromMarker), () => {})
  // Validate every remaining profile/schedule before removing any source file.
  for (const id of ids) {
    for (const name of ['bot.json', 'schedule.json']) {
      const path = await exists(join(from, id, name)) ? join(from, id, name) : join(to, id, name)
      await validateJson(path, value => name === 'bot.json'
        ? /^bellteam\.bot\.v[1-8]$/u.test(value?.schema) && (!value.id || value.id === id)
        : value?.schema === 'bellteam.schedule.v1' && Array.isArray(value.schedules))
    }
  }
  for (const id of ids) {
    for (const name of ['bot.json', 'schedule.json']) if (await exists(join(from, id, name))) await moveFile(join(from, id, name), join(to, id, name), root)
    await moveTree(join(from, id, 'messages/assets'), join(to, id, 'messages/assets'), root)
  }
  for (const pair of pairs) {
    const [a, b] = direction === 'to-server' ? pair : [...pair].reverse()
    const source = join(root, a), target = join(root, b)
    if (!await exists(source)) continue
    if (a.endsWith('/ai-control.json')) {
      await transferAiControlState({ legacyRoot: root, stateRoot: join(root, 'state'), direction })
      await syncAncestors(dirname(target), root)
      await unlink(source)
      await syncDirectory(dirname(source))
    } else await moveFile(source, target, root)
  }
  await syncAncestors(to, root)
  await marker(toMarker) // Complete all state before making the new registry bootable.
  await unlink(fromMarker)
  await syncDirectory(from)
  return { direction, status: 'transferred', bots: ids.size }
}

export async function migrateServerState({ legacyRoot, serverRoot, backupRoot, direction }) {
  if (![legacyRoot, serverRoot, backupRoot].every(value => typeof value === 'string' && isAbsolute(value))
    || !['to-server', 'to-legacy'].includes(direction)) throw failure('SERVER_STATE_TRANSFER_OPTIONS')
  const options = { root: serverRoot, direction }, roots = { legacyRoot, serverRoot, direction }
  const parent = await lstat(backupRoot)
  if (!parent.isDirectory() || parent.uid !== process.geteuid() || parent.gid !== process.getegid() || (parent.mode & 0o777) !== 0o700)
    throw failure('SERVER_STATE_BACKUP_PARENT')
  // Preserve both generations before a partial migration can hide current
  // content in either view. A failed second backup must stop all migration.
  for (const [view, root] of [['legacy', legacyRoot], ['server', serverRoot]]) {
    const destination = join(backupRoot, view)
    try { await mkdir(destination, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await backupServerState({ root, direction, backupRoot: destination })
  }
  if (direction === 'to-server') await relocateServerRoots(roots)
  const result = await transferServerState(options)
  if (direction === 'to-legacy') await relocateServerRoots(roots)
  const ownership = await prepareServerStateOwnership({ ...options, root: direction === 'to-server' ? serverRoot : legacyRoot })
  return { ...result, ownership }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || !['to-server', 'to-legacy'].includes(process.argv[2]))
      throw failure('SERVER_STATE_TRANSFER_ARGUMENTS')
    if ([process.getuid?.(), process.geteuid?.(), process.getgid?.(), process.getegid?.()].some(id => id !== 0))
      throw failure('SERVER_STATE_TRANSFER_IDENTITY')
    const [legacy, current] = await Promise.all(['/srv/bellteam-legacy', '/srv/bellteam'].map(path => lstat(path)))
    if (!legacy.isDirectory() || !current.isDirectory() || legacy.dev !== current.dev || legacy.ino !== current.ino)
      throw failure('SERVER_STATE_VIEW_IDENTITY')
    console.log(JSON.stringify(await migrateServerState({ legacyRoot: '/srv/bellteam-legacy', serverRoot: '/srv/bellteam',
      backupRoot: '/srv/bellteam-maintenance-backups', direction: process.argv[2] })))
  } catch (error) {
    // Maintenance errors must not print paths, parsed documents or headers.
    console.error(/^[A-Z][A-Z_0-9]*$/u.test(error.code ?? '') ? error.code : 'SERVER_STATE_TRANSFER_FAILED')
    process.exitCode = 1
  }
}
