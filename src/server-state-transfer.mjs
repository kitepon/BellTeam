// Offline operation: both generations and seat writers must already be stopped.
// A failed operation must not be followed by starting either server generation.
import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open, copyFile, chmod, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { transferAiControlState } from './ai-control-state-transfer.mjs'

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
async function moveTree(source, destination, root) {
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
  await rmdir(source)
  await syncDirectory(dirname(source))
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
