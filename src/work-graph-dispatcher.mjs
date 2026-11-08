import { WORK_GRAPH_STATE_COMPATIBILITY, validWorkGraphGeneration, validateWorkGraphRequest, validateWorkGraphResult,
  workGraphError, workGraphObject } from './work-graph-protocol.mjs'

export function createWorkGraphDispatcher({ core }) {
  let generation = null, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set()
  const track = task => {
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const validate = (method, params, context) => {
    validateWorkGraphRequest(method, params, context)
    if (!generation || context.generation !== generation || exiting) throw workGraphError('WORK_GRAPH_UNAVAILABLE', 503)
  }
  const validateRequest = (method, params, context) => {
    validate(method, params, context)
    if (!accepting) throw workGraphError('WORK_GRAPH_NOT_ACCEPTED', 503)
  }
  const dispatch = (method, params, context, effect) => {
    validate(method, params, context)
    quiesced = false
    return track(Promise.resolve().then(async () => {
      const value = await core[method](effect)
      validateWorkGraphResult(method, value)
      return value
    }))
  }
  const control = async (method, params) => {
    if (!['initialize', 'resume', 'quiesce', 'exit'].includes(method) || exiting) throw workGraphError('WORK_GRAPH_CONTROL_INVALID')
    if (method === 'initialize') {
      if (generation || !workGraphObject(params, ['generation', 'mode']) || !validWorkGraphGeneration(params.generation)
        || !['bootstrap', 'restore'].includes(params.mode)) throw workGraphError('WORK_GRAPH_CONTROL_INVALID')
      generation = params.generation
      return { stateCompatibility: WORK_GRAPH_STATE_COMPATIBILITY }
    }
    if (!generation || !workGraphObject(params, [])) throw workGraphError('WORK_GRAPH_CONTROL_INVALID')
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
    if (!quiesced || active.size) throw workGraphError('WORK_GRAPH_NOT_QUIESCED', 503)
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
