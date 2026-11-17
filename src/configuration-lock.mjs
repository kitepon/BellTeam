import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// a314: the launcher's key for Aiterm's seat lock (configuration-lock.md). Derived per Bot from one install secret, so it is the
// same after a body restart or an execution generation change, and Aiterm only ever sees it, never the seat's AI.
export class ConfigurationLock {
  constructor(secretPath) { this.secretPath = secretPath; this.secret = null }

  async secretValue() {
    if (this.secret) return this.secret
    let value
    try { value = await readFile(this.secretPath, 'utf8') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (!value) {
      await mkdir(dirname(this.secretPath), { recursive: true })
      try { await writeFile(this.secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error?.code !== 'EEXIST') throw error }
      value = await readFile(this.secretPath, 'utf8')
    }
    if (!/^[0-9a-f]{64}$/u.test(value)) throw Object.assign(new Error('CONFIGURATION_LOCK_SECRET_INVALID'), { code: 'CONFIGURATION_LOCK_SECRET_INVALID' })
    return this.secret = value
  }

  // 64 hex chars: inside Aiterm's 16-128 printable ASCII.
  async key(botId) { return createHmac('sha256', await this.secretValue()).update(`aiterm-configuration-lock:${botId}`).digest('hex') }
}
