import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

function failure(code) { return Object.assign(new Error(code), { code }) }

async function readRegular(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw failure('AI_CONTROL_TRANSFER_NOT_FILE')
    return await file.readFile()
  } finally { await file.close() }
}

function validate(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw failure('AI_CONTROL_TRANSFER_INVALID') }
  if (value?.schema !== 'bellteam.ai-control.v1' || typeof value.paused !== 'boolean'
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !(value.resumedAt == null || typeof value.resumedAt === 'string' && Number.isFinite(Date.parse(value.resumedAt)))) {
    throw failure('AI_CONTROL_TRANSFER_INVALID')
  }
}

// Offline preparation only: both writers must already be stopped. No source
// deletion, automatic startup, backup selection or native stop is performed.
// Rollback reads the CURRENT server file, never the pre-migration copy.
export async function transferAiControlState({ legacyRoot, stateRoot, direction }) {
  if (!['to-server', 'to-legacy'].includes(direction)
    || typeof legacyRoot !== 'string' || !isAbsolute(legacyRoot)
    || typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) throw failure('AI_CONTROL_TRANSFER_OPTIONS')
  const legacy = join(resolve(legacyRoot), 'shared/ai-control.json')
  const server = join(resolve(stateRoot), 'ai-control.json')
  if (legacy === server) throw failure('AI_CONTROL_TRANSFER_OPTIONS')
  const [source, destination] = direction === 'to-server' ? [legacy, server] : [server, legacy]
  const bytes = await readRegular(source) // ENOENT must not become an enabled default.
  validate(bytes)
  let previous
  try {
    if (!(await lstat(destination)).isFile()) throw failure('AI_CONTROL_TRANSFER_NOT_FILE')
    previous = await readRegular(destination)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous?.equals(bytes)) return { direction, status: 'unchanged' }
  // An initial/repeated migration cannot overwrite a different server intent.
  // Only explicit rollback replaces the obsolete legacy copy with current data.
  if (previous && direction === 'to-server') throw failure('AI_CONTROL_TRANSFER_CONFLICT')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  let file
  try {
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    file = null
    await rename(temporary, destination)
    const directory = await open(dirname(destination), 'r')
    try { await directory.sync() } finally { await directory.close() }
    return { direction, status: 'copied' }
  } finally {
    await file?.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
