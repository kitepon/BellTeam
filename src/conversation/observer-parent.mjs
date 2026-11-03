import { checkObserverProjects, observerCheckRequests, validateObserverCheckResult } from '../observer-check.mjs'
import { readObserverTurns } from '../self-turns.mjs'
import { normalizeConversationObserverResult, validateConversationEffect, validateConversationEffectResult } from './effects.mjs'
import { observerProjectScope } from './observer.mjs'

const invalid = () => { throw Object.assign(new Error('CONVERSATION_OBSERVER_SOURCE_CHANGED'), { code: 'CONVERSATION_OBSERVER_SOURCE_CHANGED' }) }

// snapshot/current read the parent's same operation; neither raw paths nor CLI options come from the child.
export function createConversationObserverParentEffects({ snapshot, current, check = checkObserverProjects, read = readObserverTurns }) {
  const polls = new WeakMap()
  return async (method, params, context) => {
    const { generation, operationId, actor, continuation } = context
    validateConversationEffect(method, params, { generation, operationId, actor, continuation })
    if (context.rootMethod !== 'observation.poll' || context.actor?.kind !== 'observer') invalid()
    if (method === 'runtime.observer.snapshot') {
      if (polls.has(context)) invalid()
      const bots = await snapshot(context)
      observerCheckRequests(bots.map(bot => ({ id: bot.id, projectPath: bot.project, after: null })))
      const captures = new Map(bots.map(bot => [bot.id, { bot, project: bot.project, scope: observerProjectScope(bot.project) }]))
      polls.set(context, captures)
      const result = { projects: [...captures].map(([botId, entry]) => ({ botId, scope: entry.scope, projectBytes: Buffer.byteLength(JSON.stringify(entry.project), 'utf8') })) }
      validateConversationEffectResult(method, result, params)
      return result
    }
    const captures = polls.get(context)
    if (!captures) invalid()
    const bound = async (id, scope) => {
      const entry = captures.get(id)
      if (!entry || entry.scope !== scope || await current(id, context) !== entry.bot || entry.bot.project !== entry.project) invalid()
      return entry
    }
    if (method === 'runtime.observer.check') {
      const projects = []
      for (const item of params.projects) projects.push({ id: item.id, projectPath: (await bound(item.id, item.scope)).project, after: item.after })
      const requests = observerCheckRequests(projects)
      if (requests.length !== 1 || requests[0].projects.length !== projects.length) invalid()
      const result = await check(requests[0], context)
      for (const item of params.projects) await bound(item.id, item.scope)
      validateObserverCheckResult(result, requests[0])
      return result
    }
    if (method === 'runtime.observer.read') {
      const { botId, scope, ...cursor } = params, entry = await bound(botId, scope)
      const result = normalizeConversationObserverResult(await read({ project: entry.project, ...cursor }, context))
      await bound(botId, scope)
      return result
    }
    invalid()
  }
}
