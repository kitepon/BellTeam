import { join } from 'node:path'
import { Diagnostics } from './diagnostics.mjs'
import { DIAGNOSTICS_STATE_COMPATIBILITY, diagnosticsError, diagnosticsObject, validDiagnosticsGeneration,
  validateDiagnosticsRequest } from './diagnostics-protocol.mjs'

export { DIAGNOSTICS_STATE_COMPATIBILITY } from './diagnostics-protocol.mjs'

export function createDiagnosticsDispatcher({ root, investigationsFile = null }) {
  const diagnostics = new Diagnostics(join(root, 'logs/diagnostics.json'), { investigationsFile })
  let generation = null, initializing = false, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set(), streams = new Set()
  const track = task => {
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const drain = async () => {
    do { await Promise.allSettled([...active, diagnostics.pending]) } while (active.size)
  }
  const validate = (method, params, context) => {
    validateDiagnosticsRequest(method, params, context)
    if (!generation || context.generation !== generation || exiting) throw diagnosticsError('DIAGNOSTICS_UNAVAILABLE', 503)
  }
  const validateRequest = (method, params, context) => {
    validate(method, params, context)
    if (!accepting) throw diagnosticsError('DIAGNOSTICS_NOT_ACCEPTED', 503)
  }
  const dispatch = (method, params, context) => {
    // The runner holds requests admitted before quiesce until dispatch and real completion.
    validate(method, params, context)
    quiesced = false
    if (method === 'list') {
      const snapshot = diagnostics.listSnapshot(params.status, params.limit)
      let finish
      track(new Promise(resolve => { finish = resolve }))
      const close = () => { streams.delete(stream); finish() }
      const stream = {
        [Symbol.asyncIterator]() { return this },
        async next() {
          try { const item = snapshot.next(); if (item.done) close(); return item }
          catch (error) { close(); throw error }
        },
        async return() { try { return snapshot.return() } finally { close() } },
      }
      streams.add(stream)
      return stream
    }
    return track(Promise.resolve().then(async () => {
      if (method === 'record') return diagnostics.record(params.report)
      if (method === 'setStatus') return diagnostics.setStatus(params.fingerprint, params.status, { note: params.note })
      if (method === 'setNote') return diagnostics.setNote(params.fingerprint, params.note)
      return diagnostics.updateInvestigation(params.fingerprint, { status: params.status, note: params.note })
    }))
  }
  const control = async (method, params) => {
    if (!['initialize', 'resume', 'quiesce', 'exit'].includes(method) || exiting || initializing)
      throw diagnosticsError('DIAGNOSTICS_CONTROL_INVALID')
    if (method === 'initialize') {
      if (generation || !diagnosticsObject(params, ['generation', 'mode']) || !validDiagnosticsGeneration(params.generation)
        || !['bootstrap', 'restore'].includes(params.mode)) throw diagnosticsError('DIAGNOSTICS_CONTROL_INVALID')
      initializing = true
      try {
        await track(diagnostics.initialize({ mode: params.mode }))
        if (exiting) throw diagnosticsError('DIAGNOSTICS_UNAVAILABLE', 503)
        generation = params.generation
        return { stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY }
      } finally { initializing = false }
    }
    if (!generation || !diagnosticsObject(params, [])) throw diagnosticsError('DIAGNOSTICS_CONTROL_INVALID')
    if (method === 'resume') {
      epoch++
      accepting = true
      quiesced = false
      return { resumed: true }
    }
    if (method === 'quiesce') {
      accepting = false
      const current = ++epoch
      await drain()
      quiesced = current === epoch && !accepting && !exiting
      return { quiesced }
    }
    if (!quiesced || active.size) throw diagnosticsError('DIAGNOSTICS_NOT_QUIESCED', 503)
    exiting = true
    return { closed: true }
  }
  const disconnect = async () => {
    accepting = false
    exiting = true
    epoch++
    await Promise.all([...streams].map(stream => stream.return()))
    await drain()
  }
  return { validateRequest, dispatch, control, disconnect }
}
