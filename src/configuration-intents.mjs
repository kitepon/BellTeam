import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { publishResumeFile, readResumeFile } from './resume-storage.mjs'
import { configurationBinding, configurationBot, configurationDigest, configurationError, configurationReceipt, configurationSettings, configurationUUID, CONFIGURATION_INTENT_VERSIONS } from './configuration-request.mjs'

function intent(value, botId, id) {
  if (!value || Object.keys(value).sort().join(',') !== 'binding,botId,requested,schema,version'
    || value.schema !== 'bellteam.configuration-intent.v1' || value.botId !== botId || value.binding?.id !== id
    || !CONFIGURATION_INTENT_VERSIONS.includes(value.version)) throw configurationError('CONFIGURATION_INTENT_INVALID')
  configurationBinding(value.binding)
  const requested = configurationSettings(value.requested)
  if (JSON.stringify(requested) !== JSON.stringify(value.requested) || configurationDigest(requested) !== value.binding.digest)
    throw configurationError('CONFIGURATION_INTENT_INVALID')
  return structuredClone(value)
}

// The root comes only from trusted parent assembly, never an HTTP/MCP DTO.
export class ConfigurationIntents {
  constructor(root, { ownerUid = 1001 } = {}) {
    if (!isAbsolute(root) || root !== parse(root).root && root.endsWith('/')) throw configurationError('CONFIGURATION_STORAGE_INVALID')
    this.root = root
    this.ownerUid = ownerUid
  }

  async directory(path, create = false, privateDirectory = true) {
    if (process.getuid?.() !== this.ownerUid) throw configurationError('CONFIGURATION_STORAGE_INVALID')
    const paths = []
    for (let current = path; ; current = dirname(current)) {
      paths.unshift(current)
      if (current === dirname(current)) break
    }
    for (const current of paths) {
      let st
      try { st = await lstat(current) } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error
        await mkdir(current, { mode: 0o700 }); st = await lstat(current)
      }
      if (!st.isDirectory() || ![0, this.ownerUid].includes(st.uid) || await realpath(current) !== current
        || (st.mode & 0o022) && !(st.uid === 0 && st.mode & 0o1000)) throw configurationError('CONFIGURATION_STORAGE_INVALID')
      if (current === path && privateDirectory && (st.uid !== this.ownerUid || (st.mode & 0o777) !== 0o700))
        throw configurationError('CONFIGURATION_STORAGE_INVALID')
    }
    return path
  }

  async botDirectory(botId, create = false) {
    if (!configurationBot(botId)) throw configurationError('CONFIGURATION_INTENT_INVALID')
    await this.directory(this.root, create)
    return this.directory(join(this.root, botId), create)
  }

  async publish(botId, value) {
    const validated = intent(value, botId, value.binding?.id)
    const directory = await this.botDirectory(botId, true)
    const bytes = Buffer.from(JSON.stringify(validated) + '\n')
    if (bytes.length > 4096) throw configurationError('CONFIGURATION_INTENT_INVALID')
    await publishResumeFile(directory, `${validated.binding.id}.intent.json`, bytes)
    return validated
  }

  async read(botId, id) {
    if (!configurationUUID(id)) throw configurationError('CONFIGURATION_INTENT_INVALID')
    const directory = await this.botDirectory(botId)
    return intent(JSON.parse((await readResumeFile(join(directory, `${id}.intent.json`), 4096)).toString('utf8')), botId, id)
  }

  async terminal(botId, binding) {
    const directory = await this.botDirectory(botId)
    try {
      const value = JSON.parse((await readResumeFile(join(directory, `${binding.id}.receipt.json`), 4096)).toString('utf8'))
      if (!value || Object.keys(value).sort().join(',') !== 'origin,receipt,schema' || value.schema !== 'bellteam.configuration-receipt.v1'
        || !['apply', 'reconcile'].includes(value.origin)) throw configurationError('CONFIGURATION_RESULT_SAVE_UNCONFIRMED', 'possible')
      value.receipt = configurationReceipt(value.receipt, binding)
      if (value.receipt.request_state !== 'terminal') throw configurationError('CONFIGURATION_RESULT_SAVE_UNCONFIRMED', 'possible')
      return value
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }

  async notIssued(botId, binding) {
    const directory = await this.botDirectory(botId)
    try {
      const value = JSON.parse((await readResumeFile(join(directory, `${binding.id}.not-issued.json`), 4096)).toString('utf8'))
      if (!value || Object.keys(value).sort().join(',') !== 'binding,schema' || value.schema !== 'bellteam.configuration-not-issued.v1'
        || !isDeepStrictEqual(configurationBinding(value.binding), binding)) throw configurationError('CONFIGURATION_INTENT_INVALID')
      return true
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }

  async saveNotIssued(botId, binding) {
    const original = await this.read(botId, binding.id)
    if (!isDeepStrictEqual(original.binding, binding)) throw configurationError('CONFIGURATION_INTENT_INVALID')
    if (await this.terminal(botId, binding)) throw configurationError('CONFIGURATION_INTENT_INVALID')
    const directory = await this.botDirectory(botId)
    try { await publishResumeFile(directory, `${binding.id}.not-issued.json`, Buffer.from(JSON.stringify({ schema: 'bellteam.configuration-not-issued.v1', binding }) + '\n')) }
    catch (error) { if (error.code !== 'EEXIST' || !await this.notIssued(botId, binding)) throw error }
  }

  async saveTerminal(botId, receipt, origin) {
    if (receipt.request_state !== 'terminal') return
    if (!['apply', 'reconcile'].includes(origin)) throw configurationError('CONFIGURATION_RESULT_SAVE_UNCONFIRMED', 'possible')
    const original = await this.read(botId, receipt.binding.id)
    const value = { schema: 'bellteam.configuration-receipt.v1', origin, receipt: configurationReceipt(receipt, original.binding) }
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (bytes.length > 4096) throw configurationError('CONFIGURATION_RESULT_SAVE_UNCONFIRMED', 'possible')
    const directory = await this.botDirectory(botId)
    try { await publishResumeFile(directory, `${receipt.binding.id}.receipt.json`, bytes); return value }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const prior = await this.terminal(botId, receipt.binding)
      const stable = entry => ({ ...entry, observed_at: null })
      if (!prior || !isDeepStrictEqual(stable(prior.receipt), stable(value.receipt))) throw configurationError('CONFIGURATION_RESULT_SAVE_UNCONFIRMED', 'possible')
      return prior
    }
  }

  async pending() {
    let bots
    try { bots = await readdir(this.root) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    await this.directory(this.root)
    const pending = []
    for (const botId of bots) {
      const directory = await this.botDirectory(botId)
      const unresolved = []
      for (const name of await readdir(directory)) {
        if (name.startsWith('.') && name.endsWith('.tmp')) throw configurationError('CONFIGURATION_INTENTS_UNCONFIRMED')
        if (!name.endsWith('.intent.json')) continue
        const original = await this.read(botId, name.slice(0, -12))
        if (await this.notIssued(botId, original.binding)) {
          if (await this.terminal(botId, original.binding)) throw configurationError('CONFIGURATION_INTENT_INVALID')
          continue
        }
        const result = await this.terminal(botId, original.binding)
        if (!result || !(result.origin === 'apply' && result.receipt.outcome === 'applied') && result.receipt.later_effect !== 'excluded') unresolved.push(original)
      }
      if (unresolved.length > 1) throw configurationError('CONFIGURATION_INTENTS_UNCONFIRMED')
      if (unresolved.length) pending.push(unresolved[0])
    }
    return pending
  }
}
