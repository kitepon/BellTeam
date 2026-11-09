import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { writeAtomic } from '../json-file.mjs'

const fields = ['host', 'user', 'port', 'os', 'accountOwner', 'sshKeyRef', 'sudoKeyRef', 'hostTrust', 'keySource', 'sudoKeySource', 'bindingRef', 'sshKeyRequest', 'sudoKeyRequest']
// Set only by terminals itself (key setting, Aiterm binding); never taken from a caller's register/update input.
export const INTERNAL_FIELDS = ['hostTrust', 'keySource', 'sudoKeySource', 'bindingRef', 'sshKeyRequest', 'sudoKeyRequest']
const SOURCES = ['terminal-native', 'secret']
const STATUS = { INVALID_TERMINAL: 400, TERMINAL_NOT_FOUND: 404, TERMINAL_EXISTS: 409, INVALID_TERMINAL_STORE: 500 }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const slug = /^[a-z0-9][a-z0-9-]{0,62}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function invalid(message, code = 'INVALID_TERMINAL') {
  return Object.assign(new Error(message), { code, status: STATUS[code] })
}

// Messages name the field, the expected form and the next action; they never echo a submitted value (it may be a pasted secret).
const REF_HINT = 'the reference (UUID) issued by the secret input card or for a 1Password reference; never put a key or password in any argument'
const looksSecret = value => typeof value === 'string' && /-----BEGIN|PRIVATE KEY|^op:\/\/|^ssh-(ed25519|rsa)|^ecdsa-/i.test(value)

function checkRef(field, value, label) {
  if (looksSecret(value)) throw invalid(`${field} looks like a key or a raw secret reference; it was not saved. Remove it from your messages, enter the ${label} through the secret input card, and pass ${REF_HINT}`)
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid(`${field} must be ${REF_HINT}`)
}

function validate(record, stored = false) {
  const allowed = stored ? [...fields, 'terminalId', 'revision'] : fields
  if (!object(record)) throw invalid('Terminal fields must be one JSON object')
  if ('ingressUrl' in record) throw invalid('ingressUrl was removed: Aiterm routes the seat MCP over the terminal\'s SSH reverse forward. Omit it')
  const unknown = Object.keys(record).filter(key => !allowed.includes(key))
  if (unknown.length) throw invalid(`Unknown terminal fields: ${unknown.join(', ')}. Allowed: terminalId, ${fields.filter(key => !INTERNAL_FIELDS.includes(key)).join(', ')}, confirmHostKey`)
  if (stored && (!slug.test(record.terminalId ?? '') || !Number.isSafeInteger(record.revision) || record.revision < 1)) throw invalid('Invalid terminal identity or revision')
  if (typeof record.host !== 'string' || !(isIP(record.host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(record.host))) throw invalid('host must be the terminal\'s IP address or DNS name only (no user@, port, path or ssh options), for example 192.168.1.12')
  if (typeof record.user !== 'string' || !/^[a-z_][a-z0-9_.-]*[$]?$/i.test(record.user)) throw invalid('user must be the login user name on the terminal, for example kite')
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw invalid('port must be an integer SSH port 1-65535 (default 22)')
  if (record.os !== 'macos') throw invalid('os must be "macos" (the only supported terminal OS now)')
  if (!['owner', 'terminal-owner'].includes(record.accountOwner)) throw invalid('accountOwner must be "owner" (the Owner\'s own machine: seats may use the Owner\'s Claude accounts) or "terminal-owner" (someone else\'s machine: seats use that machine\'s own Claude login)')
  // Optional: a terminal is registered first and its key bound later (bind_terminal_key); until then targets are CREDENTIAL_UNAVAILABLE.
  if (record.sshKeyRef !== undefined) checkRef('sshKeyRef', record.sshKeyRef, 'SSH key')
  if (record.sudoKeyRef !== undefined) checkRef('sudoKeyRef', record.sudoKeyRef, 'sudo password')
  for (const field of ['keySource', 'sudoKeySource']) if (record[field] !== undefined && !SOURCES.includes(record[field])) throw invalid(`${field} must be terminal-native or secret`)
  for (const field of ['bindingRef', 'sshKeyRequest', 'sudoKeyRequest']) if (record[field] !== undefined && (typeof record[field] !== 'string' || !uuid.test(record[field]))) throw invalid(`${field} must be a UUID`)
  // hostTrust is Elegg's public trust ref: {provider:'aiterm.known-hosts.v1', revision:'sha256:<64hex>'}; set by terminals, not callers.
  if (record.hostTrust !== undefined && (!object(record.hostTrust) || Object.keys(record.hostTrust).length !== 2 || typeof record.hostTrust.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(record.hostTrust.provider) || typeof record.hostTrust.revision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.hostTrust.revision))) throw invalid('hostTrust is set by terminals from the trusted host key; to trust a changed host key pass confirmHostKey with the SHA256: fingerprint the Owner confirmed')
}

function projection(record) {
  const { sshKeyRef, sudoKeyRef, keySource, sudoKeySource, bindingRef: _binding, sshKeyRequest, sudoKeyRequest, ...publicRecord } = record
  return structuredClone({ ...publicRecord, sshKeyConfigured: Boolean(sshKeyRef), sudoKeyConfigured: Boolean(sudoKeyRef),
    keySource: sshKeyRef ? keySource ?? 'terminal-native' : null, sudoKeySource: sudoKeyRef ? sudoKeySource ?? 'secret' : null,
    sshKeyPending: Boolean(sshKeyRequest), sudoKeyPending: Boolean(sudoKeyRequest) })
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
        delete record.ingressUrl // legacy field before the reverse-forward ingress (#793); dropped on read, gone on the next save
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
        if (typeof terminalId !== 'string' || !slug.test(terminalId)) throw invalid('terminalId must be a lowercase slug of letters, digits and -, for example owner-macbook')
        if (records.some(item => item.terminalId === terminalId)) throw invalid('Terminal already registered; to change it call register_terminal again with only the fields to change', 'TERMINAL_EXISTS')
        const record = { ...candidate, terminalId, revision: 1 }
        records.push(record)
        return { changed: true, value: projection(record), event: { terminalId: record.terminalId, revision: record.revision, removed: false } }
      })
    },
    // `expect(stored)` makes the write conditional inside the writer: false -> no change, result null.
    update(terminalId, patch, expect) {
      return mutate(records => {
        if (!object(patch) || Object.keys(patch).some(key => !fields.includes(key))) throw invalid(`Unknown terminal fields. Allowed: ${fields.join(', ')}`)
        const index = records.findIndex(item => item.terminalId === terminalId)
        if (index < 0) throw invalid('Terminal not found; list_terminals shows the registered terminalIds', 'TERMINAL_NOT_FOUND')
        if (expect && !expect(structuredClone(records[index]))) return { changed: false, value: null }
        const record = { ...records[index], ...structuredClone(patch), revision: records[index].revision + 1 }
        for (const field of ['sshKeyRef', 'sudoKeyRef', 'hostTrust', ...INTERNAL_FIELDS]) if (record[field] === null) delete record[field]
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
