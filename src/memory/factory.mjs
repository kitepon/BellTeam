import { MEMORY_METHODS } from './dispatcher.mjs'

export function createMemoryService({ registry, dispatch }) {
  return Object.fromEntries(MEMORY_METHODS.map(method => [method, (...args) => {
    let profiles
    if (method === 'initialize') profiles = [...registry.values()]
    else {
      const { botId, scope } = method === 'ensureScope' ? { botId: args[0], scope: args[1] } : args[0] ?? {}
      const bot = scope === 'shared' ? null : registry.get(botId)
      profiles = bot ? [bot] : []
    }
    return dispatch(method, {
      args: method === 'initialize' ? [] : method === 'ensureScope' ? args.slice(0, 2) : [args[0]],
      profiles: profiles.map(({ id, project }) => ({ id, project })),
    })
  }]))
}
