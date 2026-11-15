import { createModuleEndpoint } from './module-ipc.mjs'
import { APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY, APPROVAL_BOX_EXTENSION_PROTOCOL_VERSION, validApprovalsGeneration, approvalsError, approvalsObject,
  validateApprovalsRequest, validateApprovalsEffect, validateApprovalsEffectResult, validateApprovalsControl,
  validateApprovalsControlResult, validateApprovalsReady, validateApprovalsResult, approvalsWireError, approvalsRootReads } from './approval-box-extension-protocol.mjs'

const failure = (code, outcome = 'unknown', status = 503) => Object.assign(new Error(code), { code, outcome, status })
const check = value => { if (!value) throw failure('APPROVALS_IPC_INVALID') }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => {})
  return { promise, resolve, reject }
}
// A refused Owner-task write (Lattice's LATTICE_OWNER_TASK_REFUSED, mapped by the parent) is told apart from unavailable so the child skips that decision, not the tick.
const passed = new Map([['APPROVALS_EFFECT_REFUSED', 409]])
const acknowledged = value => approvalsObject(value, ['acknowledged']) && value.acknowledged === true

export function createApprovalsParentChannel(child, { generation, onEffect }) {
  check(validApprovalsGeneration(generation) && typeof onEffect === 'function')
  const ready = deferred()
  let readySeen = false, channel
  const fail = () => ready.reject(failure('APPROVALS_IPC_DISCONNECTED'))
  channel = createModuleEndpoint(child, {
    errorPrefix: 'APPROVALS',
    validateResult: (kind, method, value) => {
      if (kind === 'control') { validateApprovalsControlResult(method, value); return true }
      check(kind === 'root')
      validateApprovalsResult(method, value)
    },
    onDisconnect: fail,
    onRequest: message => {
      if (message.kind === 'control') {
        check(message.method === 'ready' && !readySeen)
        validateApprovalsReady(message.params)
        readySeen = true
        return () => { ready.resolve(message.params); return { acknowledged: true } }
      }
      // An effect is valid only inside a root call that is still pending on this channel.
      check(message.kind === 'effect' && approvalsObject(message.context, ['operation']) && channel.pending.get(message.context.operation)?.kind === 'root')
      validateApprovalsEffect(message.method, message.params)
      return async () => {
        try {
          const value = await onEffect(message.method, message.params)
          validateApprovalsEffectResult(message.method, value)
          return value
        } catch (error) {
          // Nothing else leaks to the child.
          throw passed.has(error?.code) ? approvalsError(error.code, passed.get(error.code)) : approvalsError('APPROVALS_EFFECT_FAILED', 503)
        }
      }
    },
  })
  return { ready: ready.promise,
    request: (method, params) => {
      try {
        validateApprovalsRequest(method, params, { generation })
        // refresh runs the link engine: a few Lattice writes can each wait up to 50 s in the facade queue, so it outlives the default root timeout.
        return channel.call('root', method, params, { generation }, { timeout: method === 'refresh' ? 120000 : 60000 })
      } catch (error) {
        const rejected = Promise.reject(error); rejected.catch(() => {})
        Object.defineProperty(rejected, 'completion', { value: rejected })
        return rejected
      }
    },
    control: (method, params = {}, timeout = 5000) => {
      validateApprovalsControl(method, params)
      if (method === 'initialize') check(params.generation === generation)
      return channel.call('control', method, params, null, { timeout })
    },
    reaped: () => { channel.reaped(); fail() },
    dispose: () => { channel.fail(); fail() },
    snapshot: () => channel.snapshot(),
  }
}

export function createApprovalsChildChannel({ dispatcher, event = process, versionId = process.argv[2] === 'builtin' ? null : process.argv[2] }) {
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
    errorPrefix: 'APPROVALS',
    validateResult: (kind, method, value) => kind === 'effect' ? (validateApprovalsEffectResult(method, value), true)
      : kind === 'control' && method === 'ready' && acknowledged(value),
    onDisconnect: orphan,
    afterResponse: async message => {
      if (message.kind !== 'control') return
      if (message.method === 'initialize') await ready()
      if (message.method === 'exit') close()
    },
    onRequest: message => {
      if (message.kind === 'control') {
        validateApprovalsControl(message.method, message.params)
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
      if (!accepting || active.size >= 8) throw failure('APPROVALS_NOT_ACCEPTED', 'not_accepted')
      dispatcher.validateRequest(message.method, message.params, message.context)
      quiesced = false
      // Writes (answer, hold, connect, refresh) run one at a time in arrival order; reads never wait behind a write (the lattice child's rule).
      const write = !approvalsRootReads(message.method), done = deferred(), before = write ? chain : null
      if (write) chain = done.promise
      active.add(done.promise)
      const effect = async (method, params) => {
        const value = await channel.call('effect', method, params, { operation: message.id }, { timeout: 60000 })
        validateApprovalsEffectResult(method, value)
        return value
      }
      const run = async () => {
        try {
          if (before) await before
          return await dispatcher.dispatch(message.method, message.params, message.context, effect)
        } catch (error) { throw Object.assign(new Error('APPROVALS_OPERATION_FAILED'), approvalsWireError(error, 'unknown')) }
      }
      run.finish = () => { active.delete(done.promise); done.resolve() }
      return run
    },
  })
  const ready = () => {
    check(!readySent && generation !== null); readySent = true
    return channel.call('control', 'ready', { versionId, protocolVersion: APPROVAL_BOX_EXTENSION_PROTOCOL_VERSION,
      stateCompatibility: APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY }, null, { timeout: 5000 })
  }
  return { ready, close, snapshot: () => channel.snapshot() }
}
