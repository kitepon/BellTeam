import { LATTICE_STATE_COMPATIBILITY, validLatticeGeneration, validateLatticeRequest, validateLatticeResult,
  latticeError, latticeObject } from './lattice-protocol.mjs'

export function createLatticeDispatcher({ core }) {
  let generation = null, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set()
  const track = task => {
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const validate = (method, params, context) => {
    validateLatticeRequest(method, params, context)
    if (!generation || context.generation !== generation || exiting) throw latticeError('LATTICE_UNAVAILABLE', 503)
  }
  const validateRequest = (method, params, context) => {
    validate(method, params, context)
    if (!accepting) throw latticeError('LATTICE_NOT_ACCEPTED', 503)
  }
  const dispatch = (method, params, context, effect) => {
    validate(method, params, context)
    quiesced = false
    return track(Promise.resolve().then(async () => {
      const value = await core[method](params, effect)
      validateLatticeResult(method, value)
      return value
    }))
  }
  const control = async (method, params) => {
    if (!['initialize', 'resume', 'quiesce', 'exit'].includes(method) || exiting) throw latticeError('LATTICE_CONTROL_INVALID')
    if (method === 'initialize') {
      if (generation || !latticeObject(params, ['generation', 'mode']) || !validLatticeGeneration(params.generation)
        || !['bootstrap', 'restore'].includes(params.mode)) throw latticeError('LATTICE_CONTROL_INVALID')
      generation = params.generation
      return { stateCompatibility: LATTICE_STATE_COMPATIBILITY }
    }
    if (!generation || !latticeObject(params, [])) throw latticeError('LATTICE_CONTROL_INVALID')
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
    if (!quiesced || active.size) throw latticeError('LATTICE_NOT_QUIESCED', 503)
    exiting = true
    return { closed: true }
  }
  const disconnect = async () => {
    accepting = false
    exiting = true
    epoch++
    await drain()
  }
  return { validateRequest, dispatch, control, disconnect }
}
