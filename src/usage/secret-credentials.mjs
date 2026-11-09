import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createOnePasswordSource, validateOnePasswordReference } from './onepassword-source.mjs'

const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value)
const error = (code, status = 400) => Object.assign(new Error(code), { code, status })
export function normalizeCredentialScope(value) {
  if (!credentialScopeValid(value)) throw error('SECRET_CREDENTIAL_INVALID')
  return { terminalId: value.terminalId, purpose: ({ 'ssh-key': 'terminal.ssh', 'sudo-key': 'terminal.sudo' })[value.purpose] ?? value.purpose }
}
export const credentialScopeValid = value => value && Object.keys(value).sort().join(',') === 'purpose,terminalId'
  && id(value.terminalId) && id(value.purpose)
export const credentialContextValid = value => value && Object.keys(value).every(key => ['memberId', 'purpose', 'terminalId', 'expectedRevision'].includes(key))
  && Object.hasOwn(value, 'memberId') && credentialScopeValid({ terminalId: value.terminalId, purpose: value.purpose }) && (value.memberId === null || id(value.memberId))
  && (value.expectedRevision === undefined || Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0)
export const credentialDtoValid = value => value && Object.keys(value).sort().join(',') === 'available,handle,revision'
  && id(value.handle) && Number.isSafeInteger(value.revision) && value.revision > 0 && typeof value.available === 'boolean'

export async function readPrivateSecret(path, limit = 16384) {
  if (await realpath(path) !== path) throw error('SECRET_STORAGE_INVALID', 503)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
      || stat.size < 1 || stat.size > limit) throw error('SECRET_STORAGE_INVALID', 503)
    bytes = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== stat.size || bytesRead > limit) throw error('SECRET_STORAGE_INVALID', 503)
    const value = bytes.subarray(0, bytesRead).toString('utf8')
    if (value.includes('\0')) throw error('SECRET_VALUE_INVALID')
    return value
  } finally { bytes?.fill(0); await file.close() }
}

// Private source records never enter request cards, projections or consumer DTOs.
export class SecretCredentials {
  #sources = new Map()
  #handles = new Map()
  #providers
  #availability = new Map()
  #events = new EventEmitter()
  #tail = Promise.resolve()
  #retry
  #announced = new Set()
  #recovery
  #closed = false
  #bindingOrder = 0
  constructor({ root, getRequest, onePassword = createOnePasswordSource(), providers = {}, retryMs = 60000 }) {
    this.sourceDirectory = join(root, 'state/secret-sources')
    this.directory = join(root, 'state/secret-credentials')
    this.toolsDirectory = join(root, 'state/secret-values')
    this.getRequest = getRequest
    this.onePassword = onePassword
    this.retryMs = retryMs
    this.#providers = new Map(Object.entries(providers))
    this.onePassword.watch(() => this.#publishRecovery())
  }

  async initialize({ readOnly = false } = {}) {
    for (const [directory, items] of [[this.sourceDirectory, this.#sources], [this.directory, this.#handles]]) {
      if (!readOnly) await mkdir(directory, { recursive: true, mode: 0o700 })
      let files
      try { files = await readdir(directory) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
      for (const name of files) {
        if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue
        const record = JSON.parse(await readPrivateSecret(join(directory, name), 8192))
        const key = name.slice(0, -5)
        if (items === this.#sources) {
          if (record.kind === 'onepassword') validateOnePasswordReference(record.reference)
          else if (record.kind !== 'provider' || !id(record.providerId)) throw error('SECRET_STORAGE_INVALID', 503)
        } else if (record.handle !== key || !credentialScopeValid({ terminalId: record.terminalId, purpose: record.purpose })
          || !id(record.requestId) || !Number.isSafeInteger(record.revision) || record.revision < 1
          || record.revoked !== undefined && typeof record.revoked !== 'boolean'
          || record.bindingOrder !== undefined && (!Number.isSafeInteger(record.bindingOrder) || record.bindingOrder < 1)) throw error('SECRET_STORAGE_INVALID', 503)
        items.set(key, record)
        if (items === this.#handles) this.#bindingOrder = Math.max(this.#bindingOrder, record.bindingOrder ?? 0)
      }
    }
    await this.onePassword.refresh()
  }

  inputOptions() { return { preferred: this.onePassword.available ? 'onepassword' : 'stored', onePasswordAvailable: this.onePassword.available } }
  watch(listener) { this.#events.on('change', listener); return () => this.#events.off('change', listener) }
  watchRecovery(listener) { this.#events.on('recovery', listener); return () => this.#events.off('recovery', listener) }
  recoveryState() { return { recoveryNeeded: !this.onePassword.available || [...this.#availability.values()].some(available => !available) } }
  #publishRecovery() {
    const state = this.recoveryState()
    if (!this.#closed && state.recoveryNeeded !== this.#recovery) {
      this.#recovery = state.recoveryNeeded
      this.#events.emit('recovery', state)
    }
    return state
  }
  #serialize(operation) {
    const run = this.#tail.then(() => { if (this.#closed) throw error('SECRET_SOURCE_UNAVAILABLE', 503); return operation() })
    this.#tail = run.catch(() => {})
    return run
  }
  async #save(record, fresh = false) {
    const path = join(this.directory, record.handle + '.json')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (fresh) await writeFile(path, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    else {
      await writeFile(path + '.tmp', JSON.stringify(record), { mode: 0o600 })
      await rename(path + '.tmp', path)
    }
    this.#handles.set(record.handle, record)
  }
  async registerSource(requestId, source) {
    if (!id(requestId)) throw error('SECRET_REQUEST_INVALID')
    let record
    if (source?.source === 'onepassword') {
      validateOnePasswordReference(source.reference)
      record = { kind: 'onepassword', reference: source.reference }
    } else if (source?.source === 'provider' && this.#providers.has(source.providerId)) record = { kind: 'provider', providerId: source.providerId }
    else throw error('SECRET_VALUE_INVALID')
    const path = join(this.sourceDirectory, requestId + '.json')
    await mkdir(this.sourceDirectory, { recursive: true, mode: 0o700 })
    try { await writeFile(path, JSON.stringify(record), { mode: 0o600, flag: 'wx' }) }
    catch (failure) {
      if (failure.code !== 'EEXIST') throw failure
      const existing = JSON.parse(await readPrivateSecret(path, 8192))
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw error('SECRET_REQUEST_CLOSED', 409)
    }
    this.#sources.set(requestId, record)
  }
  #request(requestId) {
    const item = this.getRequest(requestId)
    if (item.id !== requestId || item.status !== 'submitted') throw error('SECRET_REQUEST_CLOSED', 409)
    return item
  }
  #available(requestId) {
    if (this.#availability.has(requestId)) return this.#availability.get(requestId)
    const source = this.#sources.get(requestId)
    if (!source) return true
    return source.kind === 'onepassword' ? this.onePassword.available : this.#providers.get(source.providerId)?.available === true
  }
  #dto(record) { return { handle: record.handle, revision: record.revision, available: !record.revoked && this.#available(record.requestId) } }
  #event(record, reason) { return { ...this.#dto(record), terminalId: record.terminalId, purpose: record.purpose, requestId: record.requestId, reason } }
  #record(handle, context) {
    context = credentialContextValid(context) ? { ...context, ...normalizeCredentialScope({ terminalId: context.terminalId, purpose: context.purpose }) } : context
    const record = this.#handles.get(handle)
    if (!credentialContextValid(context) || !record || context.terminalId !== record.terminalId || context.purpose !== record.purpose) throw error('SECRET_CREDENTIAL_FORBIDDEN', 403)
    if (record.revoked) throw error('SECRET_CREDENTIAL_REVOKED', 403)
    if (context.expectedRevision !== undefined && context.expectedRevision !== record.revision) throw error('SECRET_CREDENTIAL_STALE', 409)
    return record
  }
  bind(requestId, scope) {
    return this.#serialize(async () => {
      scope = normalizeCredentialScope(scope)
      const item = this.#request(requestId)
      if (item.terminalSuperseded) throw error('SECRET_REQUEST_CLOSED', 409)
      if (item.botId === null && (item.terminalId !== scope.terminalId || item.purpose !== scope.purpose)) throw error('SECRET_CREDENTIAL_FORBIDDEN', 403)
      const existing = [...this.#handles.values()].find(row => !row.revoked && row.requestId === requestId && row.terminalId === scope.terminalId && row.purpose === scope.purpose)
      if (existing) {
        this.#events.emit('change', this.#event(existing, 'bound'))
        return this.#dto(existing)
      }
      if ([...this.#handles.values()].some(row => row.revoked && row.requestId === requestId && row.terminalId === scope.terminalId && row.purpose === scope.purpose)) throw error('SECRET_CREDENTIAL_REVOKED', 403)
      const record = { handle: randomUUID(), requestId, ...scope, revision: 1, bindingOrder: ++this.#bindingOrder }
      await this.#save(record, true)
      this.#availability.set(requestId, this.#available(requestId))
      this.#events.emit('change', this.#event(record, 'bound'))
      this.#announced.add(record.handle)
      return this.#dto(record)
    })
  }
  credential(handle, context) { return this.#dto(this.#record(handle, context)) }
  current(scope) {
    scope = normalizeCredentialScope(scope)
    const rows = [...this.#handles.values()].filter(row => row.terminalId === scope.terminalId && row.purpose === scope.purpose)
      .sort((a, b) => (a.bindingOrder ?? 0) - (b.bindingOrder ?? 0))
    const record = rows.at(-1)
    return record && !record.revoked ? { ...this.#dto(record), requestId: record.requestId } : null
  }
  hasRequestBinding(requestId, scope) {
    scope = normalizeCredentialScope(scope)
    return [...this.#handles.values()].some(row => row.requestId === requestId && row.terminalId === scope.terminalId && row.purpose === scope.purpose)
  }
  unbind(handle, scope) {
    return this.#serialize(async () => {
      scope = normalizeCredentialScope(scope)
      const record = this.#handles.get(handle)
      if (!record || record.terminalId !== scope.terminalId || record.purpose !== scope.purpose) throw error('SECRET_CREDENTIAL_FORBIDDEN', 403)
      const next = record.revoked ? record : { ...record, revoked: true, revision: record.revision + 1 }
      if (!record.revoked) await this.#save(next)
      this.#events.emit('change', this.#event(next, 'unbound'))
      if (![...this.#handles.values()].some(row => !row.revoked && row.requestId === record.requestId)) this.#availability.delete(record.requestId)
      this.#publishRecovery()
      return this.#dto(next)
    })
  }
  unbindScope(scope) {
    return this.#serialize(async () => {
      scope = normalizeCredentialScope(scope)
      for (const record of this.#handles.values()) if (!record.revoked && record.terminalId === scope.terminalId && record.purpose === scope.purpose) {
        const next = { ...record, revoked: true, revision: record.revision + 1 }
        await this.#save(next)
        this.#events.emit('change', this.#event(next, 'unbound'))
        this.#availability.delete(record.requestId)
      }
      this.#publishRecovery()
    })
  }
  replace(handle, requestId, context) {
    return this.#serialize(async () => {
      const record = this.#record(handle, context)
      const item = this.#request(requestId)
      if (item.terminalSuperseded) throw error('SECRET_REQUEST_CLOSED', 409)
      if (item.botId === null && (item.terminalId !== record.terminalId || item.purpose !== record.purpose)) throw error('SECRET_CREDENTIAL_FORBIDDEN', 403)
      const next = { ...record, requestId, revision: record.revision + 1, bindingOrder: ++this.#bindingOrder }
      await this.#save(next)
      const event = this.#event(next, 'revision')
      this.#events.emit('change', event)
      this.#announced.add(handle)
      return this.#dto(next)
    })
  }
  #setAvailable(requestId, available) {
    if (this.#closed) return
    const before = this.#available(requestId)
    this.#availability.set(requestId, available)
    for (const record of this.#handles.values()) {
      if (!record.revoked && record.requestId === requestId && (before !== available || !this.#announced.has(record.handle))) {
        this.#events.emit('change', this.#event(record, 'availability'))
        this.#announced.add(record.handle)
      }
    }
    this.#publishRecovery()
    if (!available && this.retryMs > 0 && !this.#retry) {
      this.#retry = setTimeout(() => {
        this.#retry = null
        void this.refreshAvailability().catch(() => {})
      }, this.retryMs)
      this.#retry.unref?.()
    }
  }
  async resolveRequest(requestId) {
    if (this.#closed) throw error('SECRET_SOURCE_UNAVAILABLE', 503)
    const item = this.#request(requestId), source = this.#sources.get(requestId)
    try {
      let value
      if (source?.kind === 'onepassword') value = await this.onePassword.resolve(source.reference)
      else if (source?.kind === 'provider') {
        const provider = this.#providers.get(source.providerId)
        if (!provider) throw error('SECRET_SOURCE_UNAVAILABLE', 503)
        value = await provider.resolve()
      } else {
        const expected = join(this.toolsDirectory, item.toolId, 'secrets', item.id)
        if (item.path !== expected) throw error('SECRET_STORAGE_INVALID', 503)
        value = await readPrivateSecret(expected)
      }
      if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 16384 || value.includes('\0')) throw error('SECRET_VALUE_INVALID')
      this.#setAvailable(requestId, true)
      return value
    } catch {
      this.#setAvailable(requestId, false)
      throw error('SECRET_SOURCE_UNAVAILABLE', 503)
    }
  }
  async withResolved(handle, context, consume) {
    if (typeof consume !== 'function') throw error('SECRET_CREDENTIAL_INVALID')
    const record = this.#record(handle, context)
    let value = await this.resolveRequest(record.requestId)
    try {
      if (this.#handles.get(handle) !== record) throw error('SECRET_CREDENTIAL_STALE', 409)
      return await consume(value)
    } finally { value = null }
  }
  async refreshAvailability() {
    await this.onePassword.refresh()
    const pending = new Set([...this.#availability].filter(([, available]) => !available).map(([id]) => id))
    if (!this.onePassword.available) for (const record of this.#handles.values()) {
      if (!record.revoked && this.#sources.get(record.requestId)?.kind === 'onepassword') pending.add(record.requestId)
    }
    for (const requestId of pending) {
      try { await this.resolveRequest(requestId) } catch {}
    }
    for (const record of this.#handles.values()) if (!record.revoked && !this.#announced.has(record.handle)) {
      this.#events.emit('change', this.#event(record, 'availability'))
      this.#announced.add(record.handle)
    }
    return this.#publishRecovery()
  }
  close() { this.#closed = true; clearTimeout(this.#retry); this.onePassword.close() }
}
