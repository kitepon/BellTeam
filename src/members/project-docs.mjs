// C6 member-scoped docs (docs/architecture/modules/members/remote-seat.md). Runs inside the runtime
// members-project operation; `project` is already the caller's own BellTeam project directory.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const MEMBER_DOC_MAX_BYTES = 1024 * 1024
const pathError = () => Object.assign(new Error('MEMBERS_DOC_PATH_INVALID'), { code: 'MEMBERS_DOC_PATH_INVALID', status: 400 })
const sizeError = () => Object.assign(new Error('MEMBERS_DOC_TOO_LARGE'), { code: 'MEMBERS_DOC_TOO_LARGE', status: 400 })

export function memberDocSegments(path) {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0')) throw pathError()
  if (path === 'AGENTS.local.md') return [path]
  const segments = path.split('/')
  if (segments[0] !== 'docs' || segments.length < 2 || segments.some(part => !part || part === '.' || part === '..')) throw pathError()
  return segments
}

async function ownedDirectory(path, create) {
  let info
  try { info = await lstat(path) } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error
    await mkdir(path)
    info = await lstat(path)
  }
  if (!info.isDirectory() || info.uid !== process.getuid()) throw pathError()
}

// shortcut: components are checked with lstat before O_NOFOLLOW open, not with openat; the project is single-owner, upgrade if another writer appears.
async function parent(project, segments, create = false) {
  let directory = project
  for (const part of segments.slice(0, -1)) {
    directory = join(directory, part)
    await ownedDirectory(directory, create)
  }
  return directory
}

const describe = (path, info) => ({ path, size: info.size, modifiedAt: info.mtime.toISOString() })

export async function listMemberDocs(project) {
  const files = []
  try {
    const local = await lstat(join(project, 'AGENTS.local.md'))
    if (local.isFile()) files.push(describe('AGENTS.local.md', local))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const walk = async relative => {
    // Same boundary as read/write: a symlinked or foreign-owned directory is never followed.
    try { await ownedDirectory(join(project, relative), false) } catch (error) {
      if (error.code === 'ENOENT' && relative === 'docs') return
      throw error
    }
    const entries = await readdir(join(project, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(describe(path, await lstat(join(project, path))))
    }
  }
  await walk('docs')
  return files
}

export async function readMemberDoc(project, path) {
  const segments = memberDocSegments(path)
  let fd
  try { fd = await open(join(await parent(project, segments), segments.at(-1)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { throw error.code === 'ELOOP' ? pathError() : error }
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.uid !== process.getuid()) throw pathError()
    if (info.size > MEMBER_DOC_MAX_BYTES) throw sizeError()
    const content = (await fd.readFile()).toString('utf8')
    return { path, content, modifiedAt: info.mtime.toISOString() }
  } finally { await fd.close() }
}

export async function writeMemberDoc(project, path, content) {
  const segments = memberDocSegments(path)
  if (typeof content !== 'string') throw pathError()
  if (Buffer.byteLength(content) > MEMBER_DOC_MAX_BYTES) throw sizeError()
  const directory = await parent(project, segments, true)
  const target = join(directory, segments.at(-1))
  try {
    const existing = await lstat(target)
    if (!existing.isFile() || existing.uid !== process.getuid()) throw pathError()
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = join(directory, `.${segments.at(-1)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try { await fd.writeFile(content); await fd.sync() } catch (error) {
    await fd.close(); await rm(temporary, { force: true }); throw error
  }
  await fd.close()
  try { await rename(temporary, target) } catch (error) { await rm(temporary, { force: true }); throw error }
  return describe(path, await lstat(target))
}
