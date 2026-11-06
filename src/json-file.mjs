import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

export async function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await unlink(temporary) } catch {}
    throw error
  }
}

export async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
