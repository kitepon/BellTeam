// Product lifecycle (Aiterm runtime-adoption.ts). argv, never env: spawned seats/hooks must not inherit it.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** AitermClient options for a candidate that starts in standby (no recovery/claims until activate). */
export function standbyAitermOptions(options, { generation, scope }) {
  if (!TOKEN.test(generation ?? '') || !TOKEN.test(scope ?? '') || !options?.args?.includes('--execution-interrupt'))
    throw Object.assign(new Error('AITERM_STANDBY_INVALID'), { code: 'AITERM_STANDBY_INVALID' })
  return { ...options, args: [...options.args, '--runtime-adoption', 'standby', '--runtime-generation', generation, '--runtime-scope', scope] }
}

/** One lifecycle RPC: prepare/activate/status/retire -> structured aiterm.runtime-adoption.v1, or Error.code = product error_code. */
export async function runtimeAdoption(client, input) {
  let result
  try { result = await client.call('runtime_adoption', input) }
  catch (error) {
    let code = null
    try { code = JSON.parse(error.message)?.error_code ?? null } catch { /* transport/unknown */ }
    if (code) error.code = code
    throw error
  }
  if (result?.structuredContent?.schema !== 'aiterm.runtime-adoption.v1')
    throw Object.assign(new Error('RUNTIME_ADOPTION_RESULT_INVALID'), { code: 'RUNTIME_ADOPTION_RESULT_INVALID' })
  return result.structuredContent
}

export class AitermGenerationClient {
  constructor({ client, runtimeCapture }) {
    this.records = new Map()
    this.current = null
    this.closed = false
    this.publishGeneration({ client, runtimeCapture })
  }

  generation() { return this.current?.generation ?? null }

  references() {
    return Object.freeze([...this.records.values()].map(record => Object.freeze({
      generation: record.generation, current: record === this.current, references: record.references,
    })))
  }

  publishGeneration({ client, runtimeCapture }) {
    if (this.closed) throw new Error('AITERM_GENERATION_CLIENT_CLOSED')
    const generation = runtimeCapture?.generation ?? null
    let record = this.records.get(generation)
    if (record) {
      if (record.client !== client || record.runtimeCapture !== runtimeCapture || record.retirement)
        throw new Error('AITERM_GENERATION_CONFLICT')
    } else {
      record = { generation, client, runtimeCapture, references: 0, zeroWaiters: new Set(), retirement: null }
      this.records.set(generation, record)
    }
    this.current = record
    return generation
  }

  pin() {
    if (this.closed || !this.current) throw new Error('AITERM_GENERATION_CLIENT_CLOSED')
    const record = this.current
    const release = this.retain(record)
    const invoke = (method, args) => record.client[method](...args)
    return Object.freeze({
      generation: record.generation,
      get client() { return record.client.client },
      get sdk() { return record.client.client },
      get transport() { return record.client.transport },
      get connecting() { return record.client.connecting },
      call: (...args) => invoke('call', args),
      connect: (...args) => invoke('connect', args),
      runtime: (...args) => invoke('runtime', args),
      prepareAuthConnection: (...args) => invoke('prepareAuthConnection', args),
      authOptions: (...args) => invoke('authOptions', args),
      launchOptions: (...args) => invoke('launchOptions', args),
      release,
    })
  }

  retireGeneration(generation, retireCallback) {
    const record = this.records.get(generation)
    if (!record || record === this.current || typeof retireCallback !== 'function')
      return Promise.reject(new Error('AITERM_GENERATION_RETIRE_INVALID'))
    if (record.retirement) return record.retirement
    record.retirement = (async () => {
      if (record.references) await new Promise(resolve => record.zeroWaiters.add(resolve))
      await retireCallback(record.client, record.runtimeCapture)
      this.records.delete(generation)
    })()
    return record.retirement.catch(error => {
      record.retirement = null
      throw error
    })
  }

  call(...args) { return this.invokeCurrent('call', args) }
  connect(...args) { return this.invokeCurrent('connect', args) }
  runtime(...args) { return this.invokeCurrent('runtime', args) }
  prepareAuthConnection(...args) { return this.invokeCurrent('prepareAuthConnection', args) }
  authOptions(...args) { return this.invokeCurrent('authOptions', args) }
  launchOptions(...args) { return this.invokeCurrent('launchOptions', args) }

  // Body-level settings shared by every generation (dispatcher inherits them via Object.create).
  get seatProject() { return this.current?.client.seatProject ?? null }
  get environmentReady() { return this.current?.client.environmentReady ?? null }
  get client() { return this.current?.client.client ?? null }
  get sdk() { return this.current?.client.client ?? null }
  get transport() { return this.current?.client.transport ?? null }
  get connecting() { return this.current?.client.connecting ?? null }

  invokeCurrent(method, args) {
    if (this.closed || !this.current) throw new Error('AITERM_GENERATION_CLIENT_CLOSED')
    const record = this.current, release = this.retain(record)
    try {
      const result = record.client[method](...args)
      const completion = result?.completion ?? result
      if (completion && typeof completion.then === 'function') Promise.resolve(completion).then(release, release)
      else release()
      return result
    } catch (error) {
      release()
      throw error
    }
  }

  retain(record) {
    record.references++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--record.references === 0) {
        for (const resolve of record.zeroWaiters) resolve()
        record.zeroWaiters.clear()
      }
    }
  }

  close() {
    this.closed = true
    return Promise.all([...this.records.values()].map(record => Promise.resolve().then(() => record.client.close?.())))
  }
}
