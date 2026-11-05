import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { deliveryExecutionRef } from './execution-bridge.mjs'
const invalid = () => { throw Object.assign(new Error('CONVERSATION_EXECUTION_INVALID'), { code: 'CONVERSATION_EXECUTION_INVALID', status: 503, effect: 'not_started' }) }

// The parent channel owns registration, callback ACKs and background begin/end.
export function createConversationExecutionEffects({ getServices, getController, admission }) {
  const handles = new Map(), observed = new WeakSet()
  const bind = (context, value) => {
    const id = randomUUID()
    handles.set(id, { ...value, lease: context.conversationLease, operationContext: context.operationContext,
      generation: context.generation, operationId: context.operationId })
    if (!observed.has(context.conversationLease)) {
      observed.add(context.conversationLease)
      const clear = () => { for (const [id, entry] of handles) if (entry.lease === context.conversationLease) handles.delete(id) }
      admission.operationCompletion(context.conversationLease).then(clear, clear)
    }
    return id
  }
  const take = (id, context, kind) => {
    const entry = handles.get(id)
    if (!entry || entry.kind !== kind || entry.lease !== context.conversationLease
      || entry.operationContext !== context.operationContext || entry.generation !== context.generation || entry.operationId !== context.operationId) invalid()
    return entry
  }
  const effect = async (method, params, context) => {
    admission.assertCurrentLease(context?.conversationLease, { generation: context?.generation, correlation: context?.operationId })
    if (!(context.actualCompletion instanceof Promise) || !context.operationContext || !getController()?.callback
      || typeof context.admissionCheck !== 'function' && context.rootMethod !== 'observation.poll') invalid()
    const services = getServices(), transport = services?.transport
    const check = () => {
      admission.assertCurrentLease(context.conversationLease, { generation: context.generation, correlation: context.operationId })
      context.admissionCheck?.()
      services.aiControl.assertEnabled()
    }
    const member = async (id, membersContext = context.operationContext) => {
      if (typeof services.bots.readMember === 'function') await services.bots.readMember(id, membersContext)
      else await services.bots.refresh(membersContext)
      check()
      const bot = services.bots.get(id)
      if (!bot) invalid()
      return bot
    }
    switch (method) {
      case 'execution.assertAccess': check(); return { allowed: true }
      case 'execution.observation.source':
        if (context.rootMethod !== 'observation.poll') invalid()
        return { deliveryId: randomUUID(), target: params.target }
      case 'execution.shown.read': {
        if (context.rootMethod !== 'observation.poll') invalid()
        const shown = transport.shownInSelfTurn(params.botId)
        if (!shown) return null
        const prefix = [...shown.words]
        return { shownId: bind(context, { kind: 'shown', botId: params.botId, shown, prefix }), words: prefix, endedAt: shown.endedAt }
      }
      case 'execution.shown.consume': {
        if (context.rootMethod !== 'observation.poll') invalid()
        const entry = take(params.shownId, context, 'shown')
        if (entry.botId !== params.botId) invalid()
        handles.delete(params.shownId)
        return { applied: transport.consumeShownWords(params.botId, entry.shown, entry.prefix) }
      }
      case 'execution.reconcile': case 'execution.closeLaunch': {
        check(); const bot = await member(params.botId)
        const request = deliveryExecutionRef(params.deliveryId, params.target.session_id)
        const value = await transport[method === 'execution.reconcile' ? 'reconcileLaunch' : 'closeLaunch'](bot, request, params.target)
        check()
        const id = bind(context, { kind: method === 'execution.reconcile' ? 'recovery' : 'closure', botId: params.botId,
          deliveryId: params.deliveryId, target: structuredClone(params.target), value })
        return method === 'execution.reconcile' ? { recoveryId: id } : { closureId: id }
      }
      case 'execution.notify': case 'execution.turn': case 'execution.report': {
        check()
        admission.assertDelivery(context.conversationDelivery, { deliveryId: params.deliveryId, target: params.target })
        admission.assertCurrentLease(context.conversationDelivery, { generation: context.generation, correlation: context.operationId })
        const deliver = async membersContext => {
          const bot = await member(params.target, membersContext)
          let recoveredExecution
          if (params.recoveryId !== undefined) {
            const entry = take(params.recoveryId, context, 'recovery')
            if (method !== 'execution.notify' || entry.botId !== params.target || entry.deliveryId !== params.deliveryId
              || !isDeepStrictEqual(entry.target, entry.value.binding?.target?.launch)) invalid()
            recoveredExecution = entry.value; handles.delete(params.recoveryId)
          }
          const summaryAuthority = ['owner', 'bot', 'scheduler'].includes(context.actor?.kind)
            && ['user.post', 'user.turn', 'direct.post', 'room.post', 'room.reply'].includes(context.rootMethod)
            ? { context, assertCurrent: check } : null
          const options = { summaryAuthority, images: params.images ?? [], queue: params.queue, conversationDelivery: context.conversationDelivery,
            membersLease: membersContext.membersLease, admissionCheck: context.admissionCheck,
            conversationLease: context.conversationLease, operationContext: context.operationContext, actualCompletion: context.actualCompletion,
            ...(context.capturedAuthority ? { capturedAuthority: context.capturedAuthority } : {}),
            ...(context.executionSource ? { executionSource: context.executionSource } : {}),
            ...(recoveredExecution ? { recoveredExecution } : {}) }
          const result = method === 'execution.turn' ? transport.turn(bot, params.message, options)
            : method === 'execution.report' ? transport.notifyReport(bot, params.message, options) : transport.notify(bot, params.message, options)
          if (method !== 'execution.turn') return result
          result.catch(() => {})
          return result.accepted
        }
        // Reports keep the original conversation lifetime, but re-enter members only for fresh preparation/acceptance.
        return method === 'execution.report'
          ? transport.membersAdmission.withLease(membersLease => deliver({ membersLease }))
          : deliver(context.operationContext)
      }
      // These effects are consumed by conversation-ipc before onExecution.
      default: invalid()
    }
  }
  effect.consumeClosure = (id, operationContext) => {
    const entry = handles.get(id)
    if (!entry || entry.kind !== 'closure' || entry.operationContext !== operationContext) invalid()
    admission.assertCurrentLease(entry.lease, { generation: entry.generation, correlation: entry.operationId })
    handles.delete(id)
    return entry.value
  }
  return effect
}
