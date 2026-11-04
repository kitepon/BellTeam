import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { createConversationProcess } from './conversation-process.mjs'
import { ConversationLifetimes } from './conversation-lifetimes.mjs'
import { createConversationAuthority } from './conversation-authority.mjs'
import { createModuleOperationContext } from './module-operation-context.mjs'
import { createConversationAssetGate, createConversationAssetReader } from './conversation-assets.mjs'
import { createConversationParentEffects } from './conversation-parent-effects.mjs'
import { createConversationObserverParentEffects } from './conversation/observer-parent.mjs'
import { checkObserverProjects } from './observer-check.mjs'
import { readObserverTurns } from './self-turns.mjs'
import { createConversationExecutionEffects } from './conversation-execution-effects.mjs'
import { createConversationFacade } from './conversation-facade.mjs'

const denied = () => Object.assign(new Error('CONVERSATION_CONTEXT_REQUIRED'), { code: 'CONVERSATION_CONTEXT_REQUIRED', status: 403, outcome: 'not_accepted', effect: 'not_started' })

// One parent graph owns admission and captured authority; the child alone owns conversation writes.
export function createConversationAssembly({ root, membersAdmission, exchangeMutex, getServices, createFacade = createConversationFacade,
  onExecution, onDiagnostic, onState, onModuleChildExit, createProcess = createConversationProcess, prepareRelease, spawnProcess }) {
  const admission = new ConversationLifetimes(), authority = createConversationAuthority()
  const moduleOperations = createModuleOperationContext({ membersAdmission, conversationAdmission: admission })
  const scope = new AsyncLocalStorage(), owned = new WeakMap(), listeners = new Set(), memberParents = new WeakMap()
  let controller
  const executionEffects = onExecution ?? createConversationExecutionEffects({ getServices, getController: () => controller, admission })
  const getBots = () => getServices().bots
  const gate = createConversationAssetGate({ readRemovalStates: () => getBots().readRemovalStates(), assertContext: moduleOperations.assert })
  const observerEffects = createConversationObserverParentEffects({
    snapshot: async context => { await getBots().refresh(context.operationContext); return [...getBots().values()] },
    current: async (botId, context) => { await getBots().readMember(botId, context.operationContext); return getBots().get(botId) },
    check: (request, context) => checkObserverProjects(request, { root, seatCommands: Boolean(getServices().seatRuntime), signal: context.signal }),
    read: (request, context) => readObserverTurns(request, { seatCommands: Boolean(getServices().seatRuntime), signal: context.signal }),
  })
  const effects = createConversationParentEffects({ getServices: () => ({ ...getServices(), conversationAssetGate: gate,
    conversationCompletion: context => {
      admission.assertLease(context.conversationLease)
      if (!(context.actualCompletion instanceof Promise)) throw denied()
      return context.actualCompletion
    }, roomsRoot: join(root, 'rooms') }), observerEffects, onExecution: executionEffects })
  controller = createProcess({ root, admission, exchangeMutex, onModuleChildExit, authorizeActor: authority.authorizeActor,
    readBots: async () => { await getBots().refresh(); return [...getBots().values()].map(({ id, name, displayName, position, role }) => ({ id, name,
      ...(displayName === undefined ? {} : { displayName }), ...(position === undefined ? {} : { position }), ...(role === undefined ? {} : { role }) })) },
    onEffect: (method, params, context) => scope.run({ actor: context.actor, parent: context }, () => effects(method, params, context)),
    onEvent: async change => { await Promise.all([...listeners].map(listener => listener(change))) },
    onDiagnostic, onState, ...(prepareRelease ? { prepareRelease } : {}), ...(spawnProcess ? { spawnProcess } : {}),
  })
  const context = (method, input = {}) => {
    const current = scope.getStore()
    if (!current?.actor) throw denied()
    const inherited = input.operationContext ?? (input.membersLease && input.conversationLease ? input : current.parent?.operationContext)
    const operationContext = inherited ? moduleOperations.assert(inherited) : moduleOperations.reserve()
    let capturedAuthority
    try { capturedAuthority = authority.capture(method, current.actor) }
    catch (error) { if (!inherited) moduleOperations.finish(operationContext); throw error }
    const options = { conversationLease: operationContext.conversationLease, capturedAuthority, operationContext, ...(current.parent?.executionSource ? { executionSource: current.parent.executionSource } : {}),
      admissionCheck: input.admissionCheck ?? current.parent?.admissionCheck ?? (() => getServices().aiControl.assertEnabled()) }
    owned.set(options, { own: !inherited, operationContext, capturedAuthority })
    return options
  }
  const invoke = (method, params, options, callback = false) => {
    const state = owned.get(options)
    if (!state) throw denied()
    let result
    try {
      result = controller[callback ? 'callback' : 'request'](method, params, options)
      const completion = result.completion ?? result
      membersAdmission.trackCompletion(state.operationContext.membersLease, completion)
      admission.trackCompletion(state.operationContext.conversationLease, completion)
      // Callback authority lives through delivery and background ACKs, beyond the root result.
      admission.operationCompletion(state.operationContext.conversationLease).then(() => authority.release(state.capturedAuthority), () => authority.release(state.capturedAuthority))
      return result
    } catch (error) { authority.release(state.capturedAuthority); throw error }
    finally { if (state.own) moduleOperations.finish(state.operationContext); owned.delete(options) }
  }
  const facade = createFacade({ getController: () => ({ ...controller, request: invoke, callback: (method, params, options) => invoke(method, params, options, true) }), context })
  return { controller, admission, moduleOperations, facade,
    assets: { ...facade.assets, open: createConversationAssetReader({ root }), initialize: () => gate.initialize(),
      prepareBotAssetRemoval: (...args) => gate.prepareBotAssetRemoval(...args), cancelBotAssetRemoval: (...args) => gate.cancelBotAssetRemoval(...args) },
    run: (actor, operation, parent) => scope.run({ actor, parent }, operation),
    memberRequest(method, params, options, request) {
      if (!['profile.remove', 'schedules.list', 'schedules.set', 'schedules.remove', 'schedules.claimDue', 'schedules.skipDue'].includes(method)
        || options.membersReadPin) return request(method, params, options)
      const captured = scope.getStore()
      if (!captured?.actor) throw denied()
      const existing = moduleOperations.forMembers(options.membersLease)
      const operationContext = existing ?? moduleOperations.reserve({ membersLease: options.membersLease })
      memberParents.set(options.membersLease, { actor: captured.actor, parent: { operationContext } })
      let result
      try {
        result = request(method, params, options)
        admission.trackCompletion(operationContext.conversationLease, result.completion ?? result)
        return result
      } finally { if (!existing) moduleOperations.finish(operationContext) }
    },
    memberEffect(context, operation) {
      const captured = memberParents.get(context.membersLease)
      if (!captured) throw denied()
      return scope.run(captured, () => operation(captured.parent.operationContext))
    },
    currentOperation: () => scope.getStore()?.parent?.operationContext,
    consumeClosure: (...args) => executionEffects.consumeClosure(...args),
    watch(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async initialize() { await gate.initialize(); await controller.start() },
    close: () => controller.close(),
  }
}
