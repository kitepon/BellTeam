import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { credentialContextValid, credentialScopeValid, readPrivateSecret } from './secret-credentials.mjs'

const error = (code, status = 400) => Object.assign(new Error(code), { code, status })
const unavailable = () => error('SECRET_SOURCE_UNAVAILABLE', 503)
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\u0000-\u0020\u007f]/u.test(value)
const targetValid = value => value && Object.keys(value).sort().join(',') === 'host,port,user'
  && text(value.host) && text(value.user) && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
const nativeRevision = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
const bindingValid = value => value && Object.keys(value).sort().join(',') === 'ref,target' && uuid(value.ref) && targetValid(value.target)
const scopeValid = value => credentialScopeValid(value) && value.purpose === 'terminal.ssh'
const sameTarget = (a, b) => targetValid(a) && a.host === b.host && a.user === b.user && a.port === b.port

export class NativeSecretCredentials {
  #handles = new Map()
  #availability = new Map()
  #provider
  #events = new EventEmitter()
  #tail = Promise.resolve()
  #ready
  #closed = false
  constructor({ root }) { this.directory = join(resolve(root), 'state/secret-native-credentials') }
  ready() {
    if (!this.#ready) this.#ready = this.#initialize()
    return this.#ready
  }
  async #initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue
      const row = JSON.parse(await readPrivateSecret(join(this.directory, name), 8192))
      if (!uuid(row.handle) || name !== row.handle + '.json' || !bindingValid({ ref: row.ref, target: row.target })
        || !scopeValid({ terminalId: row.terminalId, purpose: row.purpose }) || !Number.isSafeInteger(row.revision)
        || row.revision < 1 || !nativeRevision(row.nativeRevision)) throw error('SECRET_STORAGE_INVALID', 503)
      this.#handles.set(row.handle, row)
    }
  }
  setProvider(provider) {
    if (this.#provider || !provider || typeof provider.status !== 'function') throw error('SECRET_CREDENTIAL_INVALID')
    this.#provider = provider
  }
  owns(handle) { return this.#handles.has(handle) }
  has(handle) { return this.owns(handle) }
  watch(listener) { this.#events.on('change', listener); return () => this.#events.off('change', listener) }
  #serialize(operation) {
    const run = this.#tail.then(async () => { await this.ready(); if (this.#closed) throw unavailable(); return operation() })
    this.#tail = run.catch(() => {})
    return run
  }
  #dto(row) { return { handle: row.handle, revision: row.revision, available: this.#availability.get(row.handle) === true } }
  #emit(row, reason) { if (!this.#closed) this.#events.emit('change', { ...this.#dto(row), reason }) }
  async #save(row, fresh = false) {
    const path = join(this.directory, row.handle + '.json')
    if (fresh) await writeFile(path, JSON.stringify(row), { mode: 0o600, flag: 'wx' })
    else {
      const temporary = path + '.' + randomUUID() + '.tmp'
      try { await writeFile(temporary, JSON.stringify(row), { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
      finally { await unlink(temporary).catch(() => {}) }
    }
    this.#handles.set(row.handle, row)
  }
  #record(handle, context) {
    const row = this.#handles.get(handle)
    if (!credentialContextValid(context) || !row || row.terminalId !== context.terminalId || row.purpose !== context.purpose) throw error('SECRET_CREDENTIAL_FORBIDDEN', 403)
    return row
  }
  async #status(binding) {
    try {
      if (!this.#provider || this.#closed) throw unavailable()
      const response = await this.#provider.status(binding.ref)
      const result = response?.structuredContent ?? response
      const credential = result?.credential
      if (result?.ref !== binding.ref || !sameTarget(result?.target, binding.target)
        || credential?.provider !== 'aiterm.native-ssh-key.v1' || !nativeRevision(credential.revision)
        || typeof credential.available !== 'boolean') throw unavailable()
      return credential
    } catch { throw unavailable() }
  }
  async #update(row) {
    let status
    try { status = await this.#status(row) } catch {
      const before = this.#availability.get(row.handle)
      this.#availability.set(row.handle, false)
      if (before !== false) this.#emit(row, 'availability')
      throw unavailable()
    }
    if (this.#closed) throw unavailable()
    const before = this.#availability.get(row.handle)
    if (status.revision !== row.nativeRevision) {
      row = { ...row, revision: row.revision + 1, nativeRevision: status.revision }
      await this.#save(row)
      this.#availability.set(row.handle, status.available)
      this.#emit(row, 'revision')
    } else {
      this.#availability.set(row.handle, status.available)
      if (before !== status.available) this.#emit(row, 'availability')
    }
    return { row, status }
  }
  register(binding, scope) {
    return this.#serialize(async () => {
      if (!bindingValid(binding) || !scopeValid(scope)) throw error('SECRET_CREDENTIAL_INVALID')
      const status = await this.#status(binding)
      if (this.#closed) throw unavailable()
      const row = { handle: randomUUID(), ref: binding.ref, target: { ...binding.target }, ...scope, revision: 1, nativeRevision: status.revision }
      await this.#save(row, true)
      this.#availability.set(row.handle, status.available)
      this.#emit(row, 'revision')
      return this.#dto(row)
    })
  }
  credential(handle, context) {
    return this.#serialize(async () => { const row = this.#record(handle, context); await this.#update(row); return this.#dto(this.#handles.get(handle)) })
  }
  async withResolved(handle, context, consume) {
    if (typeof consume !== 'function') throw error('SECRET_CREDENTIAL_INVALID')
    const capability = await this.#serialize(async () => {
      const { row, status } = await this.#update(this.#record(handle, context))
      if (!status.available || this.#closed) throw unavailable()
      return { nativeKeyRef: row.ref, revision: status.revision }
    })
    if (this.#closed) throw unavailable()
    return consume(capability)
  }
  replace(handle, binding, context) {
    return this.#serialize(async () => {
      const row = this.#record(handle, context)
      if (!bindingValid(binding)) throw error('SECRET_CREDENTIAL_INVALID')
      const status = await this.#status(binding)
      if (this.#closed) throw unavailable()
      const next = { ...row, ref: binding.ref, target: { ...binding.target }, revision: row.revision + 1, nativeRevision: status.revision }
      await this.#save(next)
      this.#availability.set(handle, status.available)
      this.#emit(next, 'revision')
      return this.#dto(next)
    })
  }
  refresh() { return this.#serialize(async () => { for (const row of this.#handles.values()) { try { await this.#update(row) } catch {} } }) }
  close() { this.#closed = true; this.#events.removeAllListeners() }
}
