import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { isAbsolute, resolve as resolvePath } from 'node:path'

const execFile = promisify(nodeExecFile)
const maxBuffer = 16384
const listBuffer = 1048576
const sshKeyField = 'private key?ssh-format=openssh'
const timeout = 10000
const unavailable = () => Object.assign(new Error('SECRET_SOURCE_UNAVAILABLE'), { code: 'SECRET_SOURCE_UNAVAILABLE', status: 503 })
const invalidReference = () => Object.assign(new Error('SECRET_REFERENCE_INVALID'), { code: 'SECRET_REFERENCE_INVALID', status: 400 })

export function validateOnePasswordReference(reference) {
  if (typeof reference !== 'string' || reference.length > 2048) throw invalidReference()
  const match = /^op:\/\/([a-z0-9]{26})\/([a-z0-9]{26})\/([^/?#]+(?:\/[^/?#]+)?)(?:\?(ssh-format=openssh|attribute=otp))?$/u.exec(reference)
  if (!match) throw invalidReference()
  try {
    const valid = match[3].split('/').every(part => {
      const decoded = decodeURIComponent(part)
      return decoded.length > 0 && decoded !== '.' && decoded !== '..' && !/[\u0000-\u001f\u007f\\/?#]/u.test(decoded)
    })
    if (!valid) throw invalidReference()
  } catch { throw invalidReference() }
  return reference
}

export function createOnePasswordSource({ command, environment = process.env, execute, retryMs = 60000, autoRetry = true } = {}) {
  let closed = false
  let initialized = false
  let available = false
  let reason = null
  let retryTimer = null
  let flight = null
  let commandFlight = null
  let fixedCommand = null
  let token = async () => null
  const events = new EventEmitter()
  const run = execute ?? ((file, args, options) => execFile(file, args, options))

  async function executable(candidate) {
    if (candidate.includes('/')) {
      const path = isAbsolute(candidate) ? candidate : resolvePath(candidate)
      await access(path, constants.X_OK)
      return path
    }
    for (const directory of (environment.PATH ?? '').split(':')) {
      if (!directory) continue
      const path = resolvePath(directory, candidate)
      try { await access(path, constants.X_OK); return path } catch {}
    }
    throw unavailable()
  }

  async function selectedCommand() {
    if (fixedCommand) return fixedCommand
    if (!commandFlight) commandFlight = (async () => {
      const configured = command ?? environment.OP_CLI_PATH
      // The server child reaches the image's /usr/local/bin/op through PATH; it never uses the UID1000 shared wrapper.
      fixedCommand = await executable(configured || 'op')
      return fixedCommand
    })().finally(() => { commandFlight = null })
    return commandFlight
  }

  function setAvailable(value) {
    if (closed || available === value) return
    available = value
    events.emit('change', { available })
  }

  function scheduleRetry() {
    if (closed || !initialized || available || !autoRetry || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void refresh()
    }, Math.max(1, retryMs))
    retryTimer.unref?.()
  }

  async function invoke(args, limit = maxBuffer) {
    let file
    try { file = await selectedCommand() } catch { throw Object.assign(unavailable(), { reason: 'missing' }) }
    const secret = await token()
    // The token lives only in this call's env: never argv, files, logs or errors.
    const env = typeof secret === 'string' && secret ? { ...environment, OP_SERVICE_ACCOUNT_TOKEN: secret } : environment
    return run(file, args, { env, encoding: 'buffer', maxBuffer: limit, timeout })
  }

  async function listJson(args) {
    const result = await invoke([...args, '--format', 'json'], listBuffer)
    const stdout = typeof result === 'string' ? result : result?.stdout
    const rows = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout)
    if (!Array.isArray(rows)) throw unavailable()
    return rows
  }

  // Lists existing items of the given categories only; nothing here creates, edits or reads an item.
  async function listItems(categories, field) {
    if (closed) throw unavailable()
    try {
      const keys = [], vaults = []
      for (const vault of await listJson(['vault', 'list'])) {
        if (typeof vault?.id !== 'string' || !/^[a-z0-9]{26}$/u.test(vault.id)) continue
        vaults.push(String(vault.name ?? '').slice(0, 200))
        for (const item of await listJson(['item', 'list', '--vault', vault.id, '--categories', categories])) {
          if (typeof item?.id !== 'string' || !/^[a-z0-9]{26}$/u.test(item.id)) continue
          keys.push({ title: String(item.title ?? '').slice(0, 200), vault: String(vault.name ?? '').slice(0, 200),
            reference: validateOnePasswordReference(`op://${vault.id}/${item.id}/${field}`) })
        }
      }
      return { vaults: vaults.sort(), keys: keys.sort((a, b) => a.title.localeCompare(b.title) || a.vault.localeCompare(b.vault)) }
    } catch {
      throw unavailable()
    }
  }
  const inventory = () => listItems('SSH Key', sshKeyField)
  const listSshKeys = async () => (await inventory()).keys
  // Sudo passwords: Login and Password items, read later through their "password" field.
  const listPasswords = async () => (await listItems('Login,Password', 'password')).keys

  async function refresh() {
    if (closed) return false
    if (flight) return flight
    initialized = true
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    flight = (async () => {
      try {
        const result = await invoke(['whoami', '--format', 'json'])
        const stdout = typeof result === 'string' ? result : result?.stdout
        const identity = JSON.parse(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout)
        if (!identity || typeof identity !== 'object' || Array.isArray(identity)
          || !['account_uuid', 'user_uuid'].some(key => typeof identity[key] === 'string' && identity[key].trim())) throw unavailable()
        if (closed) return false
        reason = null
        setAvailable(true)
        return true
      } catch (failure) {
        // Only the Settings status reads this: no op in the body, or op refused the token / could not connect.
        reason = failure?.reason === 'missing' ? 'missing' : 'rejected'
        if (!closed) { setAvailable(false); scheduleRetry() }
        return false
      } finally {
        flight = null
      }
    })()
    return flight
  }

  async function resolve(reference) {
    validateOnePasswordReference(reference)
    if (closed) throw unavailable()
    try {
      const result = await invoke(['read', '-n', reference])
      const output = typeof result === 'string' ? Buffer.from(result) : result?.stdout
      if (!Buffer.isBuffer(output) || output.length === 0 || output.includes(0) || output.length > maxBuffer) throw unavailable()
      return output.toString('utf8')
    } catch {
      throw unavailable()
    }
  }

  return {
    get available() { return available },
    get reason() { return reason },
    refresh,
    resolve,
    listSshKeys,
    listPasswords,
    inventory,
    setToken(reader) { if (typeof reader === 'function') token = reader },
    watch(listener) { events.on('change', listener); return () => events.off('change', listener) },
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      events.removeAllListeners()
    },
  }
}
