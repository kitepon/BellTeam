import { constants } from 'node:fs'
import { lstat, readdir, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const leaves = ['state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns']
const failure = code => Object.assign(new Error(code), { code })
const mode = info => Number(info.mode & 0o777n)
const identity = info => ({ device: String(info.dev), inode: String(info.ino) })
const same = (a, b) => a.dev === b.dev && a.ino === b.ino

async function using(file, run) {
  let value, error
  try { value = await run(file) } catch (failure) { error = failure }
  try { await file.close() } catch (failure) { error = error ? new AggregateError([error, failure], 'SERVER_STATE_PREPARE_CLOSE') : failure }
  if (error) throw error
  return value
}

// The host owner has already prepared and excluded writers to this parent.
// Never adopt unknown old directories by recursively changing their owners.
export async function prepareServerStateDirectories({ root }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw failure('SERVER_STATE_PREPARE_OPTIONS')
  root = resolve(root)
  for (let path = root;; path = dirname(path)) {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SERVER_STATE_PREPARE_PARENT')
    if (path === dirname(path)) break
  }
  const parent = await lstat(root, { bigint: true })
  if (parent.uid !== BigInt(process.geteuid()) || parent.gid !== BigInt(process.getegid()) || mode(parent) !== 0o700)
    throw failure('SERVER_STATE_PREPARE_PARENT')
  const sameParent = current => same(parent, current) && current.isDirectory()
    && current.uid === parent.uid && current.gid === parent.gid && mode(current) === 0o700
  const receipt = join(root, '.prepared.json'), names = await readdir(root)
  return using(await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), async directory => {
    if (!sameParent(await directory.stat({ bigint: true }))) throw failure('SERVER_STATE_PREPARE_CHANGED')
    if (names.includes('.prepared.json')) {
      if (names.length !== leaves.length + 1 || leaves.some(name => !names.includes(name))) throw failure('SERVER_STATE_PREPARE_COLLISION')
      const info = await lstat(receipt, { bigint: true })
      if (!info.isFile() || info.nlink !== 1n || info.uid !== parent.uid || info.gid !== parent.gid || mode(info) !== 0o600 || info.size > 65536n)
        throw failure('SERVER_STATE_PREPARE_RECEIPT')
      const saved = await using(await open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), async file => {
        if (!same(info, await file.stat({ bigint: true }))) throw failure('SERVER_STATE_PREPARE_CHANGED')
        return JSON.parse(await file.readFile('utf8'))
      })
      if (saved.schema !== 'bellteam.state-directories.v1' || saved.parent?.device !== String(parent.dev)
        || saved.parent?.inode !== String(parent.ino) || !Array.isArray(saved.leaves) || saved.leaves.length !== leaves.length)
        throw failure('SERVER_STATE_PREPARE_RECEIPT')
      for (const [index, name] of leaves.entries()) {
        const info = await lstat(join(root, name), { bigint: true }), recorded = saved.leaves[index]
        if (recorded?.name !== name || !info.isDirectory() || info.uid !== 1001n || info.gid !== 1001n || mode(info) !== 0o711
          || recorded.device !== String(info.dev) || recorded.inode !== String(info.ino)) throw failure('SERVER_STATE_PREPARE_CHANGED')
      }
      if (!sameParent(await lstat(root, { bigint: true }))) throw failure('SERVER_STATE_PREPARE_CHANGED')
      return { status: 'already-prepared' }
    }
    if (names.length) throw failure('SERVER_STATE_PREPARE_COLLISION')
    const prepared = []
    for (const name of leaves) {
      const path = join(root, name)
      await mkdir(path, { mode: 0o700 })
      const info = await lstat(path, { bigint: true })
      await using(await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), async file => {
        if (!same(info, await file.stat({ bigint: true }))) throw failure('SERVER_STATE_PREPARE_CHANGED')
        await file.chmod(0o711); await file.chown(1001, 1001); await file.sync()
        prepared.push({ name, ...identity(info) })
      })
    }
    await directory.sync()
    if (!sameParent(await lstat(root, { bigint: true }))) throw failure('SERVER_STATE_PREPARE_CHANGED')
    try {
      await using(await open(receipt, 'wx', 0o600), async file => {
        await file.writeFile(JSON.stringify({ schema: 'bellteam.state-directories.v1', parent: identity(parent), leaves: prepared }) + '\n')
        await file.sync()
      })
      await directory.sync()
    } catch (error) {
      try { await unlink(receipt) } catch (failure) {
        if (failure.code !== 'ENOENT') throw new AggregateError([error, failure], 'SERVER_STATE_PREPARE_RECEIPT')
      }
      throw error
    }
    return { status: 'prepared' }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw failure('SERVER_STATE_PREPARE_ARGUMENTS')
    if ([process.getuid?.(), process.geteuid?.(), process.getgid?.(), process.getegid?.()].some(id => id !== 0))
      throw failure('SERVER_STATE_PREPARE_IDENTITY')
    console.log(JSON.stringify(await prepareServerStateDirectories({ root: '/srv/bellteam-state-parent' })))
  } catch (error) {
    console.error(/^[A-Z][A-Z_0-9]*$/u.test(error.code ?? '') ? error.code : 'SERVER_STATE_PREPARE_FAILED')
    process.exitCode = 1
  }
}
