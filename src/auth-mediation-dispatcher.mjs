import { AUTH_MEDIATION_STATE_COMPATIBILITY, validAuthMediationGeneration, validateAuthMediationRequest, validateAuthMediationResult,
  authMediationError, authMediationObject } from './auth-mediation-protocol.mjs'

export function createAuthMediationDispatcher({ core }) {
  let generation = null, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set()
  const track = task => {
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const validate = (method, params, context) => {
    validateAuthMediationRequest(method, params, context)
    if (!generation || context.generation !== generation || exiting) throw authMediationError('AUTH_MEDIATION_UNAVAILABLE', 503)
  }
  const validateRequest = (method, params, context) => {
    validate(method, params, context)
    if (!accepting) throw authMediationError('AUTH_MEDIATION_NOT_ACCEPTED', 503)
  }
  const dispatch = (method, params, context, effect) => {
    validate(method, params, context)
    quiesced = false
    return track(Promise.resolve().then(async () => {
      const value = await core[method](params, effect)
      validateAuthMediationResult(method, value)
      return value
    }))
  }
  const control = async (method, params) => {
    if (!['initialize', 'resume', 'quiesce', 'exit'].includes(method) || exiting) throw authMediationError('AUTH_MEDIATION_CONTROL_INVALID')
    if (method === 'initialize') {
      if (generation || !authMediationObject(params, ['generation', 'mode']) || !validAuthMediationGeneration(params.generation)
        || !['bootstrap', 'restore'].includes(params.mode)) throw authMediationError('AUTH_MEDIATION_CONTROL_INVALID')
      generation = params.generation
      return { stateCompatibility: AUTH_MEDIATION_STATE_COMPATIBILITY }
    }
    if (!generation || !authMediationObject(params, [])) throw authMediationError('AUTH_MEDIATION_CONTROL_INVALID')
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
    if (!quiesced || active.size) throw authMediationError('AUTH_MEDIATION_NOT_QUIESCED', 503)
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