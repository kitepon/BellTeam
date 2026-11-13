import { EXECUTION_METHODS } from './execution-dispatcher.mjs'
import { updateHoldError } from './update-hold.mjs'
import { watchCurrentTurn } from './current-work.mjs'

const failure = code => Object.assign(new Error(code), { code, status: 503, effect: 'not_started' })

// Only these fixed parent callers cross into the current host engine.
// Input methods are refused while a body update hold exists, also for a selected engine without its own gate.
const INPUT_METHODS = new Set(['transport.turn', 'transport.notify', 'transport.notifyReport', 'transport.forkInquiry'])

export function createExecutionFacade({ getController, client, membersAdmission, requestStop, watchQueue, hold = null, commandWait = () => null }) {
  if (typeof getController !== 'function' || !client || !membersAdmission
    || typeof requestStop !== 'function' || typeof watchQueue !== 'function') throw failure('EXECUTION_FACADE_OPTIONS_INVALID')
  const current = () => {
    const controller = getController()
    if (!controller || !['dispatch', 'project', 'close'].every(method => typeof controller[method] === 'function'))
      throw failure('EXECUTION_NOT_ACCEPTING')
    return controller
  }
  const result = { transport: { client, membersAdmission, requestStop, watchQueue }, administration: {}, goals: {}, accounts: {} }
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
  // Script waits (current-work.md 2026-11-12): a Bot waiting on its notify=result command reads working; currentTurn stays native for after_turn.
  // a41: own work (a process its CLI started, a pending subagent result) also reads working. An older engine without
  // transport.ownWork refuses the method: that is "not supplied", never an error for the caller.
  const own = botId => {
    try { const value = current().project({ method: 'transport.ownWork', args: [botId] }); return typeof value?.kind === 'string' ? value : null }
    catch { return null }
  }
  const work = result.transport.currentWork
  result.transport.currentWork = bot => {
    const value = work(bot)
    if (!bot || value?.state === 'working') return value
    const waited = commandWait(bot.id)
    if (waited) return { ...value, state: 'working', observedAt: value.observedAt ?? waited }
    return value?.state === 'idle' && own(bot.id) ? { ...value, state: 'working' } : value
  }
  result.transport.runningState = botId => {
    const state = current().project({ method: 'transport.currentTurn', args: [botId] })?.state
    return state !== 'working' && (commandWait(botId) || state === 'idle' && own(botId)) ? 'working' : state
  }
  // after_turn (current-work.md): every currentTurn change per listener, over the exchange-surviving queue stream.
  result.transport.watchCurrentTurn = listener => watchCurrentTurn(watchQueue,
    botId => current().project({ method: 'transport.currentTurn', args: [botId, { startedAt: true }] }), listener)
  // harness-accounts.md: registry changes arrive on the exchange-surviving queue stream as topic 'accounts'.
  result.accounts.watch = listener => watchQueue(change => {
    if (change?.topics?.includes('accounts')) { try { listener() } catch {} }
  })
  result.transport.close = () => {
    try { return current().close() } catch (error) { return Promise.reject(error) }
  }
  for (const part of Object.values(result)) Object.freeze(part)
  return Object.freeze(result)
}
