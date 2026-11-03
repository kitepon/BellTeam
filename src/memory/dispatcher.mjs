import { isAbsolute } from 'node:path'
import { BellTeamMemory } from '../memory-service.mjs'

export const MEMORY_METHODS = Object.freeze(['initialize', 'ensureScope', 'remember', 'reviseMemory', 'pinMemory',
  'consolidateGrowth', 'recallMemory', 'recordKnowledge', 'searchKnowledge', 'rebuildKnowledgeIndex'])
const methods = new Set(MEMORY_METHODS)
const failure = code => Object.assign(new Error(code), { code, outcome: 'not_accepted', status: 503 })
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function validate(method, params) {
  if (!methods.has(method) || !object(params, ['args', 'profiles']) || !Array.isArray(params.args)
    || params.args.length > (method === 'initialize' ? 0 : method === 'ensureScope' ? 2 : 1)
    || !Array.isArray(params.profiles) || params.profiles.some(bot => !object(bot, ['id', 'project'])
      || typeof bot.id !== 'string' || !bot.id || typeof bot.project !== 'string'
      || !isAbsolute(bot.project) || bot.project.includes('\0'))) throw failure('MEMORY_INPUT_INVALID')
}

export function createMemoryDispatcher({ root }) {
  let initialized = false, accepting = false, quiesced = false, exiting = false, epoch = 0
  const active = new Set()
  const drain = async () => { do { await Promise.allSettled([...active]) } while (active.size) }
  const validateRequest = (method, params) => {
    validate(method, params)
    if (!initialized || !accepting || exiting) throw failure('MEMORY_UNAVAILABLE')
  }
  const dispatch = (method, params) => {
    // The channel already accepted this operation; quiesce must keep its continuation alive.
    validate(method, params)
    if (!initialized || exiting) throw failure('MEMORY_UNAVAILABLE')
    quiesced = false
    const task = Promise.resolve().then(() => {
      const registry = new Map(params.profiles.map(bot => [bot.id, bot]))
      const memory = new BellTeamMemory({ root, registry })
      return memory[method](...params.args)
    })
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const control = async (method, params) => {
    if (!['initialize', 'resume', 'quiesce', 'exit'].includes(method) || !object(params, []) || exiting)
      throw failure('MEMORY_CONTROL_INVALID')
    if (method === 'initialize') {
      if (initialized) throw failure('MEMORY_CONTROL_INVALID')
      initialized = true
      return { restored: true }
    }
    if (!initialized) throw failure('MEMORY_CONTROL_INVALID')
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
    if (!quiesced || active.size) throw failure('MEMORY_NOT_QUIESCED')
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
