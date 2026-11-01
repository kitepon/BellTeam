import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const protectedRoots = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
const failure = code => Object.assign(new Error(code), { code })

// Offline maintenance only. Seat projects, HOME, CLI credentials and memory
// are outside these paths. BugHub credentials and endpoint live in private state.
export async function prepareServerStateOwnership({ root, privateRoot = root, direction }) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof privateRoot !== 'string' || !isAbsolute(privateRoot) || !['to-server', 'to-legacy'].includes(direction))
    throw failure('SERVER_STATE_OWNERSHIP_OPTIONS')
  root = resolve(root); privateRoot = resolve(privateRoot)
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
    // The fixed listener replaces its stale socket after restart; never open it as a regular file.
    if (path === join(privateRoot, 'state/call-bridge-socket/bellteam.sock') && info.isSocket()) return
    const searchable = top || path === join(privateRoot, 'state/call-bridge') || path === join(privateRoot, 'state/call-bridge-socket')
      || path === join(privateRoot, 'state/bughub')
    const mode = info.isDirectory() ? (searchable ? 0o711 : 0o700) : 0o600
    add(path, info, serverUid, mode)
    if (info.isDirectory()) for (const name of await readdir(path)) await collect(join(path, name), false)
  }
  async function collectFile(path) {
    const info = await lstat(path)
    if (!info.isFile()) throw failure('SERVER_STATE_OWNERSHIP_FILE')
    add(path, info, serverUid, 0o600)
  }
  for (const name of ['bots', 'shared', 'shared/tools']) {
    const path = join(root, name)
    add(path, await directory(path), 1000, name === 'bots' ? 0o755 : 0o711)
  }
  for (const name of protectedRoots) {
    const path = privateRoot === root ? join(root, name) : join(privateRoot, name.split('/').at(-1))
    await directory(path)
    if (direction === 'to-server' && name === 'state') await directory(join(path, 'call-bridge-socket'))
    await collect(path, true)
  }
  if (direction === 'to-legacy') {
    const exists = async path => {
      try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }
    for (const name of ['bots/.initialized', 'shared/subscription.json', 'shared/onboarding.json', 'shared/ai-control.json', 'shared/tools/call-bridge/headers', 'shared/tools/bughub/endpoint', 'shared/tools/bughub/headers']) {
      const path = join(root, name)
      if (!await exists(path)) continue
      if (name.startsWith('shared/tools/')) add(dirname(path), await directory(dirname(path)), 1000, 0o711)
      await collectFile(path)
    }
    for (const name of await readdir(join(root, 'bots'))) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) continue
      const project = join(root, 'bots', name), info = await directory(project)
      const returned = []
      for (const path of ['bot.json', 'schedule.json', 'messages/assets']) if (await exists(join(project, path))) returned.push(path)
      if (!returned.length) continue
      add(project, info, 1000, 0o700)
      for (const path of returned) {
        if (path === 'messages/assets') {
          add(join(project, 'messages'), await directory(join(project, 'messages')), 1000, 0o700)
          await directory(join(project, path)); await collect(join(project, path), false)
        } else await collectFile(join(project, path))
      }
    }
  }
  add(root, await directory(root), 1000, 0o711)
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
