import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

// Read the seat-owned source on every regeneration; never rewrite it from a profile.
export async function composeProjectInstructions(project, body) {
  let fd, local
  try {
    fd = await open(join(project, 'AGENTS.local.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await fd.stat()
    const invalid = () => { throw Object.assign(new Error('MEMBERS_PROJECT_INVALID'), { code: 'MEMBERS_PROJECT_INVALID' }) }
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) invalid()
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await fd.read(buffer, size, buffer.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    const after = await fd.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid()
    local = buffer.subarray(0, size).toString('utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return body
    throw error
  } finally { await fd?.close() }
  if (!local.trim()) return body
  const memory = body.indexOf('\n# 前セッションの短期記憶\n')
  const at = memory < 0 ? body.length : memory
  return `${body.slice(0, at)}\n# 個別追加指示（AGENTS.local.md）\n\n${local}\n${body.slice(at)}`
}
