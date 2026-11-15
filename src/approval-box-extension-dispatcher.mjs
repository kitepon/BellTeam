import { APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY, validApprovalsGeneration, validateApprovalsRequest, validateApprovalsResult,
  approvalsError, approvalsObject } from './approval-box-extension-protocol.mjs'

export function createApprovalsDispatcher({ core }) {
  let generation = null, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set()
  const track = task => {
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const drain = async () => { while (active.size) await Promise.allSettled([...active]) }
  const validate = (method, params, context) => {
    validateApprovalsRequest(method, params, context)
    if (!generation || context.generation !== generation || exiting) throw approvalsError('APPROVALS_UNAVAILABLE', 503)
  }
  const validateRequest = (method, params, context) => {
    validate(method, params, context)
    if (!accepting) throw approvalsError('APPROVALS_NOT_ACCEPTED', 503)
  }
  const dispatch = (method, params, context, effect) => {
    validate(method, params, context)
    quiesced = false
    return track(Promise.resolve().then(async () => {
      const value = await core[method](params, effect)
      validateApprovalsResult(method, value)
      return value
    }))
  }
  const control = async (method, params) => {
    if (!['initialize', 'resume', 'quiesce', 'exit'].includes(method) || exiting) throw approvalsError('APPROVALS_CONTROL_INVALID')
    if (method === 'initialize') {
      if (generation || !approvalsObject(params, ['generation', 'mode']) || !validApprovalsGeneration(params.generation)
        || !['bootstrap', 'restore'].includes(params.mode)) throw approvalsError('APPROVALS_CONTROL_INVALID')
      generation = params.generation
      return { stateCompatibility: APPROVAL_BOX_EXTENSION_STATE_COMPATIBILITY }
    }
    if (!generation || !approvalsObject(params, [])) throw approvalsError('APPROVALS_CONTROL_INVALID')
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
    if (!quiesced || active.size) throw approvalsError('APPROVALS_NOT_QUIESCED', 503)
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
