import { randomUUID } from 'node:crypto'
import { roomTurnsFromThroughline } from './room-routing.mjs'
import { validateConversationEffect, validateConversationEffectResult } from './conversation/effects.mjs'

const fail = code => { throw Object.assign(new Error(code), { code, status: 503, outcome: 'unknown' }) }
const unavailable = () => fail('CONVERSATION_EFFECT_UNAVAILABLE')
const wireContext = context => Object.hasOwn(context ?? {}, 'callbackKind')
  ? Object.fromEntries(['generation', 'operationId', 'deliveryId', 'target', 'callbackKind'].map(key => [key, context[key]]))
  : Object.fromEntries(['generation', 'operationId', 'actor', 'continuation'].map(key => [key, context?.[key]]))

// Parent channel validates authority and keeps this context; no lease or completion is reconstructed here.
export function createConversationParentEffects({ getServices, observerEffects, onExecution }) {
  const saves = new Map()
  const end = entry => {
    if (!entry.ending) {
      entry.ending = entry.gate.endSave(entry.lease)
      void entry.ending.then(() => saves.delete(entry.id), () => {})
    }
    return entry.ending
  }
  const saved = (leaseId, context) => {
    const entry = saves.get(leaseId)
    if (!entry || entry.context !== context) fail('IMAGE_SAVE_LEASE_INVALID')
    entry.gate.assertSave(entry.lease, entry.owner, context.operationContext)
    return entry
  }
  return async (method, params, context) => {
    validateConversationEffect(method, params, wireContext(context))
    const services = getServices()
    if (!services) unavailable()
    let result
    switch (method) {
      case 'direct.log.append':
        if (typeof services.directReceipts?.appendFromChild !== 'function') unavailable()
        await services.directReceipts.appendFromChild(params.record)
        result = { applied: true }
        break
      case 'members.profiles.read': {
        if (typeof services.bots?.refresh !== 'function') unavailable()
        // fork-inquiry.md "Live relay members lease": a callback (fork delivery.answer) reuses the root's members lease,
        // which the root result already returned; without it profiles.read takes the members read pin.
        const { membersLease, ...readContext } = context.operationContext ?? {}
        await services.bots.refresh(Object.hasOwn(context, 'callbackKind') ? readContext : context.operationContext)
        result = { bots: [...services.bots.values()].map(({ id, name, displayName, position, role }) => ({ id, name,
          ...(displayName === undefined ? {} : { displayName }), ...(position === undefined ? {} : { position }),
          ...(role === undefined ? {} : { role }) })) }
        break
      }
      case 'usage.routing.read': case 'usage.notify.direct': case 'usage.notify.room':
        if (typeof services.conversationUsage?.dispatch !== 'function') unavailable()
        result = await services.conversationUsage.dispatch(method, params, context)
        break
      case 'assets.beginSave': {
        const gate = services.conversationAssetGate
        const actual = services.conversationCompletion?.(context)
        if (!(actual instanceof Promise) || !context.operationContext || !gate) unavailable()
        const lease = await gate.beginSave(params.owner, context.operationContext)
        gate.trackCompletion(lease, actual)
        const entry = { id: randomUUID(), context, owner: params.owner, lease, gate, seatRuntime: services.seatRuntime }
        saves.set(entry.id, entry)
        // The real RPC completion also requests cleanup if the child exits before sending endSave.
        void actual.then(() => end(entry), () => end(entry)).catch(() => {})
        result = { leaseId: entry.id }
        break
      }
      case 'assets.endSave':
        end(saved(params.leaseId, context))
        result = { requested: true }
        break
      case 'runtime.image.read': {
        const entry = saved(params.leaseId, context)
        if (entry.ending) fail('IMAGE_SAVE_LEASE_INVALID')
        if (typeof entry.seatRuntime?.readImage !== 'function') unavailable()
        const read = Promise.resolve().then(() => entry.seatRuntime.readImage(params.image, 25 * 1024 * 1024))
        entry.gate.trackCompletion(entry.lease, read)
        result = { data: (await read).toString('base64') }
        break
      }
      case 'runtime.room.context':
        if (typeof services.roomsRoot !== 'string' || !services.roomsRoot) unavailable()
        result = { turns: await roomTurnsFromThroughline({ projectPath: services.roomsRoot, ...params }) }
        break
      case 'runtime.observer.snapshot': case 'runtime.observer.check': case 'runtime.observer.read':
        if (typeof observerEffects !== 'function') unavailable()
        result = await observerEffects(method, params, context)
        break
      case 'execution.notify': case 'execution.turn': case 'execution.fork': case 'execution.report':
      case 'execution.background.begin': case 'execution.background.end': case 'execution.observation.source':
      case 'execution.assertAccess': case 'execution.reconcile': case 'execution.closeLaunch':
      case 'execution.shown.read': case 'execution.shown.consume':
        if (typeof onExecution !== 'function') unavailable()
        result = await onExecution(method, params, context)
        break
      default: fail('CONVERSATION_EFFECT_INVALID')
    }
    validateConversationEffectResult(method, result, params)
    return result
  }
}
