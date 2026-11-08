import { EXECUTION_METHODS } from './execution-dispatcher.mjs'
import { updateHoldError } from './update-hold.mjs'

const failure = code => Object.assign(new Error(code), { code, status: 503, effect: 'not_started' })

// Only these fixed parent callers cross into the current host engine.
// Input methods are refused while a body update hold exists, also for a selected engine without its own gate.
const INPUT_METHODS = new Set(['transport.turn', 'transport.notify', 'transport.notifyReport'])

export function createExecutionFacade({ getController, client, membersAdmission, requestStop, watchQueue, hold = null }) {
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
      if (hold?.held && INPUT_METHODS.has(method)) return Promise.reject(updateHoldError())
      try { return current().dispatch({ method, args }) } catch (error) { return Promise.reject(error) }
    }
  }
  // after_turn (current-work.md): every currentTurn change per listener, over the exchange-surviving queue stream.
  result.transport.watchCurrentTurn = listener => {
    if (typeof listener !== 'function') throw failure('EXECUTION_FACADE_OPTIONS_INVALID')
    const last = new Map(), retry = new Set()
    return watchQueue(change => {
      for (const botId of [...retry, ...(Array.isArray(change?.botIds) ? change.botIds : [])]) {
        let turn
        try { turn = current().project({ method: 'transport.currentTurn', args: [botId] }) }
        catch { retry.add(botId); continue }
        retry.delete(botId)
        const key = `${turn.state}:${turn.turnId}`
        if (last.get(botId) === key) continue
        last.set(botId, key)
        try { listener({ botId, state: turn.state, turnId: turn.turnId }) } catch {}
      }
    })
  }
  result.transport.close = () => {
    try { return current().close() } catch (error) { return Promise.reject(error) }
  }
  for (const part of Object.values(result)) Object.freeze(part)
  return Object.freeze(result)
}
