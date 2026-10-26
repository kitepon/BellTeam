import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const protectedRoots = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
const failure = code => Object.assign(new Error(code), { code })

// Offline maintenance only. Seat projects, HOME, CLI credentials and memory
// are outside these paths; BugHub's read-only host mount has a separate owner.
export async function prepareServerStateOwnership({ root, direction }) {
  if (typeof root !== 'string' || !isAbsolute(root) || !['to-server', 'to-legacy'].includes(direction))
    throw failure('SERVER_STATE_OWNERSHIP_OPTIONS')
  root = resolve(root)
  const serverUid = direction === 'to-server' ? 1001 : 1000
  const nodes = []
  async function directory(path) {
    if (dirname(path) !== path) await directory(dirname(path))
    let info
    try { info = await lstat(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(path, { mode: 0o700 }); info = await lstat(path)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SERVER_STATE_OWNERSHIP_DIRECTORY')
    return info
  }
  function add(path, info, uid, mode) {
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw failure('SERVER_STATE_OWNERSHIP_FILE')
    nodes.push({ path, info, uid, mode })
  }
  async function collect(path, top) {
    const info = await lstat(path)
    const searchable = top || path === join(root, 'state/call-bridge') || path === join(root, 'state/call-bridge-socket')
    const mode = info.isDirectory() ? (searchable ? 0o711 : 0o700) : 0o600
    add(path, info, serverUid, mode)
    if (info.isDirectory()) for (const name of await readdir(path)) await collect(join(path, name), false)
  }
  for (const name of ['', 'bots', 'shared', 'shared/tools']) {
    const path = join(root, name)
    add(path, await directory(path), 1000, 0o711)
  }
  for (const name of protectedRoots) {
    const path = join(root, name)
    await directory(path); await collect(path, true)
  }
  // Reject links and special files across the entire scope before any owner
  // change. Reopen without following a replaced name before changing metadata.
  for (const node of nodes) {
    const file = await open(node.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (node.info.isDirectory() ? constants.O_DIRECTORY : 0))
    let error
    try {
      const current = await file.stat()
      if (current.dev !== node.info.dev || current.ino !== node.info.ino
        || current.isDirectory() !== node.info.isDirectory() || !current.isDirectory() && (!current.isFile() || current.nlink !== 1))
        throw failure('SERVER_STATE_OWNERSHIP_CHANGED')
      await file.chown(node.uid, node.uid)
      await file.chmod(node.mode)
    } catch (failure) { error = failure }
    try { await file.close() } catch (failure) {
      error = error ? new AggregateError([error, failure], 'SERVER_STATE_OWNERSHIP_CLOSE') : failure
    }
    if (error) throw error
  }
  return { direction, directories: nodes.filter(node => node.info.isDirectory()).length, files: nodes.filter(node => node.info.isFile()).length }
}
