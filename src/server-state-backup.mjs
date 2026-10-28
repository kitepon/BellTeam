import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readdir, mkdir, open, statfs, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const failure = code => Object.assign(new Error(code), { code })
const roots = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings']
const legacy = ['bots/.initialized', 'shared/subscription.json', 'shared/onboarding.json',
  'shared/ai-control.json', 'shared/tools/call-bridge/headers']

// The offline caller holds the writer exclusion throughout backup and transfer.
// APNs keys, HOME, seat documents/memory and the external BugHub are not copied.
export async function backupServerState({ root, backupRoot, direction }) {
  if (![root, backupRoot].every(value => typeof value === 'string' && isAbsolute(value))
    || !['to-server', 'to-legacy'].includes(direction)) throw failure('SERVER_STATE_BACKUP_OPTIONS')
  root = resolve(root); backupRoot = resolve(backupRoot)
  const inside = (parent, path) => { const part = relative(parent, path); return !part || !part.startsWith('../') && part !== '..' && !isAbsolute(part) }
  if (inside(root, backupRoot) || inside(backupRoot, root)) throw failure('SERVER_STATE_BACKUP_LOCATION')
  async function directory(path) {
    if (dirname(path) !== path) await directory(dirname(path))
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SERVER_STATE_BACKUP_DIRECTORY')
    return info
  }
  async function optional(path) {
    try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
  }
  await directory(root)
  const parent = await directory(backupRoot)
  if (parent.uid !== process.geteuid() || parent.gid !== process.getegid() || (parent.mode & 0o777) !== 0o700)
    throw failure('SERVER_STATE_BACKUP_PARENT')
  const nodes = []
  async function collect(name, fileOnly = false) {
    const path = join(root, name), info = await optional(path)
    if (!info) return
    await directory(dirname(path))
    if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1) || fileOnly && !info.isFile())
      throw failure('SERVER_STATE_BACKUP_FILE')
    nodes.push({ name, info })
    if (info.isDirectory()) for (const child of await readdir(path)) await collect(join(name, child))
  }
  for (const name of roots) await collect(name)
  for (const name of legacy) await collect(name, true)
  const bots = join(root, 'bots')
  if (await optional(bots)) {
    await directory(bots)
    for (const id of await readdir(bots)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) continue
      for (const name of ['bot.json', 'schedule.json', 'messages/assets']) await collect(join('bots', id, name), name !== 'messages/assets')
    }
  }
  const space = await statfs(backupRoot, { bigint: true })
  const needed = nodes.reduce((bytes, node) => bytes + BigInt(node.info.size) + 4096n, 1048576n)
  if (space.bavail * space.bsize < needed) throw failure('SERVER_STATE_BACKUP_CAPACITY')
  const destination = join(backupRoot, `before-${direction}`)
  await mkdir(destination, { mode: 0o700 }) // Existing complete or partial backups require an operator decision.
  async function using(file, run) {
    let result, error
    try { result = await run(file) } catch (failure) { error = failure }
    try { await file.close() } catch (failure) { error = error ? new AggregateError([error, failure], 'SERVER_STATE_BACKUP_CLOSE') : failure }
    if (error) throw error
    return result
  }
  async function syncDirectory(path) {
    await using(await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), file => file.sync())
  }
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  for (const { name, info } of nodes) {
    const source = join(root, name), target = join(destination, name)
    await directory(dirname(source))
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (info.isDirectory() ? constants.O_DIRECTORY : 0)
    await using(await open(source, flags), async input => {
      const before = await input.stat()
      if (!same(info, before) || before.isDirectory() !== info.isDirectory() || !before.isDirectory() && (!before.isFile() || before.nlink !== 1))
        throw failure('SERVER_STATE_BACKUP_CHANGED')
      if (before.isDirectory()) await mkdir(target, { mode: 0o700, recursive: true })
      else {
        await mkdir(dirname(target), { mode: 0o700, recursive: true })
        await using(await open(target, 'wx', 0o600), async output => {
          const buffer = Buffer.alloc(65536)
          for (;;) {
            const { bytesRead } = await input.read(buffer)
            if (!bytesRead) break
            for (let offset = 0; offset < bytesRead;) {
              const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset)
              if (!bytesWritten) throw failure('SERVER_STATE_BACKUP_WRITE')
              offset += bytesWritten
            }
          }
          await output.sync()
        })
      }
      if (!same(before, await input.stat()) || !same(before, await lstat(source))) throw failure('SERVER_STATE_BACKUP_CHANGED')
    })
  }
  // Sync every created parent before committing the private completion record.
  const parents = new Set([destination])
  for (const { name, info } of nodes) {
    for (let path = info.isDirectory() ? join(destination, name) : dirname(join(destination, name));;) {
      parents.add(path)
      if (path === destination) break
      path = dirname(path)
    }
  }
  for (const path of [...parents].sort((a, b) => b.length - a.length)) await syncDirectory(path)
  for (const { name, info } of nodes) {
    await directory(dirname(join(root, name)))
    if (!same(info, await lstat(join(root, name)))) throw failure('SERVER_STATE_BACKUP_CHANGED')
  }
  const receipt = join(destination, 'complete.json')
  const raw = JSON.stringify({ schema: 'bellteam.state-backup.v1', direction, status: 'complete' }) + '\n'
  let written
  try {
    await using(await open(receipt, 'wx', 0o600), async file => {
      await file.writeFile(raw)
      await file.sync()
      written = await file.stat()
    })
    await syncDirectory(destination); await syncDirectory(backupRoot)
  } catch (error) {
    try { await unlink(receipt) } catch (failure) {
      if (failure.code !== 'ENOENT') throw new AggregateError([error, failure], 'SERVER_STATE_BACKUP_RECEIPT')
    }
    throw error
  }
  // A replaced completion file is unknown; retain it and the backup for inspection.
  const linked = await lstat(receipt)
  if (!same(written, linked) || !linked.isFile() || linked.nlink !== 1
    || linked.uid !== process.geteuid() || linked.gid !== process.getegid() || (linked.mode & 0o777) !== 0o600)
    throw failure('SERVER_STATE_BACKUP_RECEIPT_CHANGED')
  return { status: 'created', root, destination, receipt: { path: receipt,
    device: String(written.dev), inode: String(written.ino), sha256: createHash('sha256').update(raw).digest('hex') } }
}
