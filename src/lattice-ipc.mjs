import { createModuleEndpoint } from './module-ipc.mjs'
import { LATTICE_STATE_COMPATIBILITY, LATTICE_PROTOCOL_VERSION, validLatticeGeneration, latticeError, latticeObject,
  validateLatticeRequest, validateLatticeEffect, validateLatticeEffectResult, validateLatticeControl,
  validateLatticeControlResult, validateLatticeReady, validateLatticeResult, latticeWireError } from './lattice-protocol.mjs'

const failure = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })
const check = value => { if (!value) throw failure('LATTICE_IPC_INVALID') }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => {})
  return { promise, resolve, reject }
}
const acknowledged = value => latticeObject(value, ['acknowledged']) && value.acknowledged === true

export function createLatticeParentChannel(child, { generation, onEffect }) {
  check(validLatticeGeneration(generation) && typeof onEffect === 'function')
  const ready = deferred()
  let readySeen = false, channel
  const fail = () => ready.reject(failure('LATTICE_IPC_DISCONNECTED'))
  channel = createModuleEndpoint(child, {
    errorPrefix: 'LATTICE',
    validateResult: (kind, method, value) => {
      if (kind === 'control') { validateLatticeControlResult(method, value); return true }
      check(kind === 'root')
      validateLatticeResult(method, value)
    },
    onDisconnect: fail,
    onRequest: message => {
      if (message.kind === 'control') {
        check(message.method === 'ready' && !readySeen)
        validateLatticeReady(message.params)
        readySeen = true
        return () => { ready.resolve(message.params); return { acknowledged: true } }
      }
      // An effect is valid only inside a root call that is still pending on this channel.
      check(message.kind === 'effect' && latticeObject(message.context, ['operation']) && channel.pending.get(message.context.operation)?.kind === 'root')
      validateLatticeEffect(message.method, message.params)
      return async () => {
        try {
          const value = await onEffect(message.method, message.params)
          validateLatticeEffectResult(message.method, value)
          return value
        } catch { throw latticeError('LATTICE_EFFECT_FAILED', 503) }
      }
    },
  })
  return { ready: ready.promise,
    request: (method, params) => {
      try {
        validateLatticeRequest(method, params, { generation })
        // run may spend a 60 s CLI budget plus setup, so it outlives the default root timeout.
        return channel.call('root', method, params, { generation }, { timeout: method === 'run' ? 70000 : 60000 })
      } catch (error) {
        const rejected = Promise.reject(error); rejected.catch(() => {})
        Object.defineProperty(rejected, 'completion', { value: rejected })
        return rejected
      }
    },
    control: (method, params = {}, timeout = 5000) => {
      validateLatticeControl(method, params)
      if (method === 'initialize') check(params.generation === generation)
      return channel.call('control', method, params, null, { timeout })
    },
    reaped: () => { channel.reaped(); fail() },
    dispose: () => { channel.fail(); fail() },
    snapshot: () => channel.snapshot(),
  }
}

export function createLatticeChildChannel({ dispatcher, event = process, versionId = process.argv[2] === 'builtin' ? null : process.argv[2] }) {
  let generation = null, accepting = false, quiesced = false, epoch = 0, orphaned = false, readySent = false, chain = Promise.resolve(), channel
  const active = new Set()
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const close = () => channel.close()
  const orphan = () => {
    if (orphaned) return
    orphaned = true; accepting = false; epoch++
    const timer = setTimeout(() => { if (event === process) process.exit(1) }, 60000)
    void dispatcher.disconnect().then(drain).catch(() => { if (event === process) process.exitCode = 1 })
      .finally(() => { clearTimeout(timer); channel.close() })
  }
  channel = createModuleEndpoint(event, {
    errorPrefix: 'LATTICE',
    validateResult: (kind, method, value) => kind === 'effect' ? (validateLatticeEffectResult(method, value), true)
      : kind === 'control' && method === 'ready' && acknowledged(value),
    onDisconnect: orphan,
    afterResponse: async message => {
      if (message.kind !== 'control') return
      if (message.method === 'initialize') await ready()
      if (message.method === 'exit') close()
    },
    onRequest: message => {
      if (message.kind === 'control') {
        validateLatticeControl(message.method, message.params)
        if (message.method === 'initialize') {
          check(generation === null); generation = message.params.generation
        }
        const current = message.method === 'resume' ? ++epoch : epoch
        if (message.method === 'quiesce') accepting = false
        return async () => {
          if (message.method === 'quiesce') {
            await drain()
            if (current !== epoch) return { quiesced: false }
          }
          if (message.method === 'exit') check(quiesced && active.size === 0)
          const value = await dispatcher.control(message.method, message.params)
          if (message.method === 'resume') { accepting = true; quiesced = false }
          if (message.method === 'quiesce' && current === epoch) quiesced = value.quiesced === true
          return value
        }
      }
      check(message.kind === 'root' && message.context?.generation === generation)
      if (!accepting || active.size >= 8) throw failure('LATTICE_NOT_ACCEPTED', 'not_accepted')
      dispatcher.validateRequest(message.method, message.params, message.context)
      quiesced = false
      const done = deferred(), before = chain; chain = done.promise; active.add(done.promise)
      // Root calls run one at a time; each may call the parent's providers only through this bound effect.
      const effect = async (method, params) => {
        const value = await channel.call('effect', method, params, { operation: message.id }, { timeout: 30000 })
        validateLatticeEffectResult(method, value)
        return value
      }
      const run = async () => {
        try {
          await before
          return await dispatcher.dispatch(message.method, message.params, message.context, effect)
        } catch (error) { throw Object.assign(new Error('LATTICE_OPERATION_FAILED'), latticeWireError(error, 'unknown')) }
      }
      run.finish = () => { active.delete(done.promise); done.resolve() }
      return run
    },
  })
  const ready = () => {
    check(!readySent && generation !== null); readySent = true
    return channel.call('control', 'ready', { versionId, protocolVersion: LATTICE_PROTOCOL_VERSION,
      stateCompatibility: LATTICE_STATE_COMPATIBILITY }, null, { timeout: 5000 })
  }
  return { ready, close, snapshot: () => channel.snapshot() }
}
