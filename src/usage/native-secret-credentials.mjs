import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { credentialContextValid, credentialDtoValid, credentialScopeValid, normalizeCredentialScope, readPrivateSecret } from './secret-credentials.mjs'

const error = (code, status = 400) => Object.assign(new Error(code), { code, status })
const unavailable = () => error('SECRET_SOURCE_UNAVAILABLE', 503)
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\u0000-\u0020\u007f]/u.test(value)
const targetValid = value => value && Object.keys(value).sort().join(',') === 'host,port,user'
  && text(value.host) && text(value.user) && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
const nativeRevision = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
const bindingValid = value => value && Object.keys(value).sort().join(',') === 'ref,target' && uuid(value.ref) && targetValid(value.target)
const scopeValid = value => credentialScopeValid(value) && value.purpose === 'terminal.ssh'
const selectionDtoValid = value => value && Object.keys(value).sort().join(',') === 'available,handle,requestId,revision'
  && credentialDtoValid({ handle: value.handle, revision: value.revision, available: value.available })
  && (value.requestId === null || (typeof value.requestId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value.requestId)))
const sameTarget = (a, b) => targetValid(a) && a.host === b.host && a.user === b.user && a.port === b.port

export class NativeSecretCredentials {
  #handles = new Map()
  #availability = new Map()
  #selections = new Map()
  #selectionEpochs = new Map()
  #selectionCaptures = new WeakMap()
  #provider
  #events = new EventEmitter()
  #tail = Promise.resolve()
  #ready
  #closed = false
  constructor({ root }) { this.directory = join(resolve(root), 'state/secret-native-credentials'); this.selectionDirectory = join(resolve(root), 'state/secret-credential-selections') }
  ready() {
    if (!this.#ready) this.#ready = this.#initialize()
    return this.#ready
  }
  async #initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await mkdir(this.selectionDirectory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.selectionDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const row = JSON.parse(await readPrivateSecret(join(this.selectionDirectory, name), 8192))
      const scope = normalizeCredentialScope({ terminalId: row.terminalId, purpose: row.purpose })
      if (Object.keys(row).sort().join(',') !== 'credential,purpose,terminalId' || row.purpose !== scope.purpose
        || name !== this.#selectionKey(scope) + '.json' || (row.credential !== null && !selectionDtoValid(row.credential))) throw error('SECRET_STORAGE_INVALID', 503)
      this.#selections.set(this.#selectionKey(scope), row.credential)
    }
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue
      const row = JSON.parse(await readPrivateSecret(join(this.directory, name), 8192))
      if (!uuid(row.handle) || name !== row.handle + '.json' || !bindingValid({ ref: row.ref, target: row.target })
        || !scopeValid({ terminalId: row.terminalId, purpose: row.purpose }) || !Number.isSafeInteger(row.revision)
        || row.revision < 1 || !nativeRevision(row.nativeRevision) || (row.revoked !== undefined && typeof row.revoked !== 'boolean')) throw error('SECRET_STORAGE_INVALID', 503)
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
  #selectionKey(scope) { return createHash('sha256').update(JSON.stringify(scope)).digest('hex') }
  async #select(event) {
    const scope = normalizeCredentialScope({ terminalId: event.terminalId, purpose: event.purpose })
    const dto = { handle: event.handle, revision: event.revision, available: event.available, requestId: event.requestId }
    if (!selectionDtoValid(dto) || !['bound', 'unbound', 'availability', 'revision'].includes(event.reason)) throw error('SECRET_CREDENTIAL_INVALID')
    const key = this.#selectionKey(scope), current = this.#selections.get(key)
    if (event.reason !== 'bound' && (!current || current.handle !== dto.handle)) return
    await this.#writeSelection(scope, event.reason === 'unbound' ? null : dto)
  }
  async #writeSelection(scope, credential) {
    const key = this.#selectionKey(scope)
    const path = join(this.selectionDirectory, key + '.json'), temporary = path + '.' + randomUUID() + '.tmp'
    try { await writeFile(temporary, JSON.stringify({ ...scope, credential }), { mode: 0o600, flag: 'wx' }); await rename(temporary, path) }
    finally { await unlink(temporary).catch(() => {}) }
    this.#selections.set(key, credential)
    this.#selectionEpochs.set(key, (this.#selectionEpochs.get(key) ?? 0) + 1)
  }
  #snapshot(key) {
    const credential = this.#selections.get(key)
    return { present: this.#selections.has(key), credential: credential ? { ...credential } : null }
  }
  #captureMatches(key, token) {
    const capture = token && this.#selectionCaptures.get(token)
    return capture?.key === key && capture.epoch === (this.#selectionEpochs.get(key) ?? 0)
  }
  clearSelection(scope, token) { return this.#serialize(async () => {
    scope = normalizeCredentialScope(scope)
    if (token !== undefined && !this.#captureMatches(this.#selectionKey(scope), token)) return
    await this.#writeSelection(scope, null)
  }) }
  selection(scope) { return this.#serialize(() => this.#snapshot(this.#selectionKey(normalizeCredentialScope(scope)))) }
  captureSelection(scope) { return this.#serialize(() => {
    const key = this.#selectionKey(normalizeCredentialScope(scope)), token = Object.freeze({})
    this.#selectionCaptures.set(token, { key, epoch: this.#selectionEpochs.get(key) ?? 0 })
    return { token, selection: this.#snapshot(key) }
  }) }
  restoreSelection(scope, credential, token) { return this.#serialize(async () => {
    scope = normalizeCredentialScope(scope)
    const key = this.#selectionKey(scope)
    if (credential !== null && !this.#selections.has(key) && this.#captureMatches(key, token)) await this.#select({ ...scope, ...credential, reason: 'bound' })
    return this.#snapshot(key)
  }) }
  selectCredential(event) { return this.#serialize(() => this.#select(event)) }
  #assertSelected(handle, scope) {
    const key = this.#selectionKey(normalizeCredentialScope(scope))
    if (this.#selections.has(key) && this.#selections.get(key)?.handle !== handle) throw error('SECRET_CREDENTIAL_REVOKED', 403)
  }
  assertSelected(handle, scope) { return this.#serialize(() => this.#assertSelected(handle, scope)) }
  async withSelected(handle, scope, consume) {
    if (typeof consume !== 'function') throw error('SECRET_CREDENTIAL_INVALID')
    const wrapped = await this.#serialize(() => { this.#assertSelected(handle, scope); return { result: consume() } })
    return wrapped.result
  }
  async #emit(row, reason) {
    const event = { ...this.#dto(row), terminalId: row.terminalId, purpose: row.purpose, requestId: null, reason }
    await this.#select(event)
    if (!this.#closed) this.#events.emit('change', event)
  }
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
    if (row.revoked) throw error('SECRET_CREDENTIAL_REVOKED', 403)
    if (context.expectedRevision !== undefined && context.expectedRevision !== row.revision) throw error('SECRET_CREDENTIAL_STALE', 409)
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
      if (before !== false) await this.#emit(row, 'availability')
      throw unavailable()
    }
    if (this.#closed) throw unavailable()
    const before = this.#availability.get(row.handle)
    if (status.revision !== row.nativeRevision) {
      row = { ...row, revision: row.revision + 1, nativeRevision: status.revision }
      await this.#save(row)
      this.#availability.set(row.handle, status.available)
      await this.#emit(row, 'revision')
    } else {
      this.#availability.set(row.handle, status.available)
      if (before !== status.available) await this.#emit(row, 'availability')
    }
    return { row, status }
  }
  register(binding, scope) {
    return this.#serialize(async () => {
      scope = normalizeCredentialScope(scope)
      if (!bindingValid(binding) || !scopeValid(scope)) throw error('SECRET_CREDENTIAL_INVALID')
      const status = await this.#status(binding)
      if (this.#closed) throw unavailable()
      const row = { handle: randomUUID(), ref: binding.ref, target: { ...binding.target }, ...scope, revision: 1, nativeRevision: status.revision }
      await this.#save(row, true)
      this.#availability.set(row.handle, status.available)
      await this.#emit(row, 'bound')
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
      if (context.expectedRevision !== undefined && context.expectedRevision !== row.revision) throw error('SECRET_CREDENTIAL_STALE', 409)
      if (!status.available || this.#closed) throw unavailable()
      return { nativeKeyRef: row.ref, revision: status.revision }
    })
    await this.#serialize(() => { this.#record(handle, context); const key = this.#selectionKey(normalizeCredentialScope({ terminalId: context.terminalId, purpose: context.purpose })); if (this.#selections.has(key) && this.#selections.get(key)?.handle !== handle) throw error('SECRET_CREDENTIAL_REVOKED', 403) })
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
      await this.#emit(next, 'revision')
      return this.#dto(next)
    })
  }
  unbind(handle, scope, token) {
    return this.#serialize(async () => {
      scope = normalizeCredentialScope(scope)
      const row = this.#handles.get(handle)
      if (!row || row.terminalId !== scope.terminalId || row.purpose !== scope.purpose) throw error('SECRET_CREDENTIAL_FORBIDDEN', 403)
      if (token !== undefined && !this.#captureMatches(this.#selectionKey(scope), token)) return this.#dto(row)
      if (row.revoked) { this.#availability.set(handle, false); return this.#dto(row) }
      const next = { ...row, revoked: true }
      await this.#save(next)
      this.#availability.set(handle, false)
      await this.#emit(next, 'unbound')
      return this.#dto(next)
    })
  }
  refresh() { return this.#serialize(async () => { for (const row of this.#handles.values()) { if (row.revoked) continue; try { await this.#update(row) } catch {} } }) }
  close() { this.#closed = true; this.#events.removeAllListeners() }
}
