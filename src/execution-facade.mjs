import { EXECUTION_METHODS } from './execution-dispatcher.mjs'

const failure = code => Object.assign(new Error(code), { code, status: 503, effect: 'not_started' })

// Only these fixed parent callers cross into the current host engine.
export function createExecutionFacade({ getController, client, membersAdmission, requestStop, watchQueue }) {
  if (typeof getController !== 'function' || !client || !membersAdmission
    || typeof requestStop !== 'function' || typeof watchQueue !== 'function') throw failure('EXECUTION_FACADE_OPTIONS_INVALID')
  const current = () => {
    const controller = getController()
    if (!controller || !['dispatch', 'project', 'close'].every(method => typeof controller[method] === 'function'))
      throw failure('EXECUTION_NOT_ACCEPTING')
    return controller
  }
  const result = { transport: { client, membersAdmission, requestStop, watchQueue }, administration: {}, goals: {} }
  for (const method of EXECUTION_METHODS.project) {
    const [owner, name] = method.split('.')
    result[owner][name] = (...args) => current().project({ method, args })
  }
  for (const method of EXECUTION_METHODS.dispatch) {
    const [owner, name] = method.split('.')
    result[owner][name] = (...args) => {
      try { return current().dispatch({ method, args }) } catch (error) { return Promise.reject(error) }
    }
  }
  result.transport.close = () => {
    try { return current().close() } catch (error) { return Promise.reject(error) }
  }
  for (const part of Object.values(result)) Object.freeze(part)
  return Object.freeze(result)
}
