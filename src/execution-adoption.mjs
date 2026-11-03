import { constants } from 'node:fs'
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const failure = (code, outcome = 'not_accepted') => Object.assign(new Error(code), { code, status: 503, outcome })
const valid = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const shape = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === fields
const values = value => ({ currentVersionId: value.currentVersionId, previousVersionId: value.previousVersionId })

export function createExecutionAdoptionStore({ root }) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root.includes('\0'))
    throw failure('EXECUTION_ADOPTION_ROOT_INVALID')
  const state = join(root, 'state'), filename = 'execution-release.json'
  let saving = false
  const directory = async () => {
    if (await realpath(root) !== root) throw failure('EXECUTION_ADOPTION_ROOT_INVALID')
    const file = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (info.uid !== process.getuid() || info.gid !== process.getgid() || info.mode & 0o7022)
        throw failure('EXECUTION_ADOPTION_ROOT_INVALID')
      return file
    } catch (error) { await file.close(); throw error }
  }
  const stable = async file => {
    const [opened, linked] = await Promise.all([file.stat(), lstat(state)])
    if (!linked.isDirectory() || opened.dev !== linked.dev || opened.ino !== linked.ino)
      throw failure('EXECUTION_ADOPTION_ROOT_INVALID')
  }
  const readFrom = async parent => {
    let file
    try { file = await open(`/proc/self/fd/${parent.fd}/${filename}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.uid !== process.getuid() || info.gid !== process.getgid() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4096)
        throw failure('EXECUTION_ADOPTION_INVALID')
      const value = JSON.parse(await file.readFile('utf8'))
      if (!shape(value, 'currentVersionId,previousVersionId,schema') || value.schema !== 'bellteam.execution.adoption.v1'
        || !valid(value.currentVersionId) || !valid(value.previousVersionId)) throw failure('EXECUTION_ADOPTION_INVALID')
      return values(value)
    } finally { await file.close() }
  }
  return {
    async read() {
      let parent
      try {
        parent = await directory()
        const value = await readFrom(parent)
        await stable(parent)
        return value
      } catch (error) {
        if (!parent && error.code === 'ENOENT') return null
        throw failure('EXECUTION_ADOPTION_INVALID')
      } finally { await parent?.close() }
    },
    async save(value) {
      if (!shape(value, 'currentVersionId,previousVersionId') || !valid(value.currentVersionId) || !valid(value.previousVersionId))
        throw failure('EXECUTION_ADOPTION_INVALID')
      if (saving) throw failure('EXECUTION_ADOPTION_IN_PROGRESS')
      saving = true
      const selected = values(value)
      let parent, temporary, publishAttempted = false
      try {
        parent = await directory()
        await readFrom(parent)
        temporary = `/proc/self/fd/${parent.fd}/.execution-release-${randomUUID()}.tmp`
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await file.writeFile(JSON.stringify({ schema: 'bellteam.execution.adoption.v1', ...selected }) + '\n')
          await file.sync()
        } finally { await file.close() }
        await stable(parent)
        publishAttempted = true
        await rename(temporary, `/proc/self/fd/${parent.fd}/${filename}`)
        temporary = null
        await parent.sync()
        await stable(parent)
        await parent.close(); parent = null
        return selected
      } catch {
        throw failure('EXECUTION_ADOPTION_SAVE_FAILED', publishAttempted ? 'unknown' : 'not_accepted')
      } finally {
        // Cleanup cannot replace an already classified publication outcome.
        try { if (temporary) await unlink(temporary) } catch {}
        try { await parent?.close() } catch {}
        saving = false
      }
    },
  }
}
