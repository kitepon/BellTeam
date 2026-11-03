import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

// Only immutable metadata from this image can identify the built-in gateway.
export async function readServerSourceCommit(openMetadata = open) {
  let file
  try {
    file = await openMetadata('/app/distribution.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o22 || info.size > 4096) return null
    const value = JSON.parse(await file.readFile('utf8'))
    return value?.schema === 'bellteam.server.distribution.v1' && /^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') ? value.sourceCommit : null
  } catch { return null }
  finally { await file?.close() }
}
