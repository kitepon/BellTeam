import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { writeAtomic } from '../json-file.mjs'

const fields = ['host', 'user', 'port', 'os', 'accountOwner', 'ingressUrl', 'sshKeyRef', 'sudoKeyRef', 'hostTrust']
const STATUS = { INVALID_TERMINAL: 400, TERMINAL_NOT_FOUND: 404, TERMINAL_EXISTS: 409, INVALID_TERMINAL_STORE: 500 }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const slug = /^[a-z0-9][a-z0-9-]{0,62}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function invalid(message, code = 'INVALID_TERMINAL') {
  return Object.assign(new Error(message), { code, status: STATUS[code] })
}

function validate(record, stored = false) {
  const allowed = stored ? [...fields, 'terminalId', 'revision'] : fields
  if (!object(record) || Object.keys(record).some(key => !allowed.includes(key))) throw invalid('Invalid terminal fields')
  if (stored && (!slug.test(record.terminalId ?? '') || !Number.isSafeInteger(record.revision) || record.revision < 1)) throw invalid('Invalid terminal identity or revision')
  if (typeof record.host !== 'string' || !(isIP(record.host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(record.host))) throw invalid('Invalid host')
  if (typeof record.user !== 'string' || !/^[a-z_][a-z0-9_.-]*[$]?$/i.test(record.user)) throw invalid('Invalid user')
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw invalid('Invalid port')
  if (record.os !== 'macos' || !['owner', 'terminal-owner'].includes(record.accountOwner)) throw invalid('Invalid OS or account owner')
  if (typeof record.sshKeyRef !== 'string' || !uuid.test(record.sshKeyRef)) throw invalid('Invalid SSH credential reference')
  if (record.sudoKeyRef !== undefined && (typeof record.sudoKeyRef !== 'string' || !uuid.test(record.sudoKeyRef))) throw invalid('Invalid sudo credential reference')
  // hostTrust is Elegg's public trust ref: {provider:'aiterm.known-hosts.v1', revision:'sha256:<64hex>'}.
  if (record.hostTrust !== undefined && (!object(record.hostTrust) || Object.keys(record.hostTrust).length !== 2 || typeof record.hostTrust.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(record.hostTrust.provider) || typeof record.hostTrust.revision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.hostTrust.revision))) throw invalid('Invalid host trust')
  if (record.ingressUrl !== undefined && (typeof record.ingressUrl !== 'string' || !/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(record.ingressUrl))) throw invalid('Invalid ingress URL')
}

function projection(record) {
  const { sshKeyRef, sudoKeyRef, ...publicRecord } = record
  return structuredClone({ ...publicRecord, sshKeyConfigured: Boolean(sshKeyRef), sudoKeyConfigured: Boolean(sudoKeyRef) })
}

export function createTerminalRegistry({ stateRoot, onChange } = {}) {
  if (typeof stateRoot !== 'string' || !stateRoot || (onChange !== undefined && typeof onChange !== 'function')) throw invalid('Invalid registry configuration')
  const path = join(stateRoot, 'terminals.json')
  let pending = Promise.resolve()

  async function load() {
    let data
    try { data = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return []
      if (error instanceof SyntaxError) throw invalid('Invalid terminal store', 'INVALID_TERMINAL_STORE')
      throw error
    }
    try {
      if (!object(data) || Object.keys(data).length !== 1 || !Array.isArray(data.terminals)) throw invalid('Invalid terminal store')
      const ids = new Set()
      for (const record of data.terminals) {
        validate(record, true)
        if (ids.has(record.terminalId)) throw invalid('Duplicate terminal identity')
        ids.add(record.terminalId)
      }
    } catch { throw invalid('Invalid terminal store', 'INVALID_TERMINAL_STORE') }
    return data.terminals
  }

  function mutate(action) {
    const operation = pending.then(async () => {
      const records = await load()
      const result = action(records)
      if (!result.changed) return result.value
      await writeAtomic(path, { terminals: records })
      if (onChange) {
        try { await onChange(result.event) } catch {}
      }
      return result.value
    })
    pending = operation.catch(() => {})
    return operation
  }

  return {
    async list() { return (await load()).map(projection) },
    async get(terminalId) { const record = (await load()).find(item => item.terminalId === terminalId); return record ? projection(record) : null },
    async target(terminalId) { const record = (await load()).find(item => item.terminalId === terminalId); return record ? structuredClone(record) : null },
    register(input) {
      return mutate(records => {
        const { terminalId = randomUUID(), ...candidate } = { port: 22, ...structuredClone(input) }
        validate(candidate)
        if (typeof terminalId !== 'string' || !slug.test(terminalId)) throw invalid('Invalid terminal identity')
        if (records.some(item => item.terminalId === terminalId)) throw invalid('Terminal already registered', 'TERMINAL_EXISTS')
        const record = { ...candidate, terminalId, revision: 1 }
        records.push(record)
        return { changed: true, value: projection(record), event: { terminalId: record.terminalId, revision: record.revision, removed: false } }
      })
    },
    update(terminalId, patch) {
      return mutate(records => {
        if (!object(patch) || Object.keys(patch).some(key => !fields.includes(key))) throw invalid('Invalid terminal fields')
        const index = records.findIndex(item => item.terminalId === terminalId)
        if (index < 0) throw invalid('Terminal not found', 'TERMINAL_NOT_FOUND')
        const record = { ...records[index], ...structuredClone(patch), revision: records[index].revision + 1 }
        if (record.sudoKeyRef === null) delete record.sudoKeyRef
        if (record.hostTrust === null) delete record.hostTrust
        if (record.ingressUrl === null) delete record.ingressUrl
        validate(record, true)
        records[index] = record
        return { changed: true, value: projection(record), event: { terminalId, revision: record.revision, removed: false } }
      })
    },
    remove(terminalId) {
      return mutate(records => {
        const index = records.findIndex(item => item.terminalId === terminalId)
        if (index < 0) return { changed: false, value: null }
        const [record] = records.splice(index, 1)
        return { changed: true, value: projection(record), event: { terminalId, revision: record.revision + 1, removed: true } }
      })
    }
  }
}
