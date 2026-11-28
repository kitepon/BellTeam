import { AsyncLocalStorage } from 'node:async_hooks'
import { MessageAssets } from './message-assets.mjs'
import { validateConversationInput } from './conversation/requests.mjs'
import { join } from 'node:path'
import { createConversationProcess } from './conversation-process.mjs'
import { ConversationLifetimes } from './conversation-lifetimes.mjs'
import { createConversationAuthority } from './conversation-authority.mjs'
import { createModuleOperationContext } from './module-operation-context.mjs'
import { createConversationAssetGate, createConversationAssetReader } from './conversation-assets.mjs'
import { createConversationParentEffects } from './conversation-parent-effects.mjs'
import { seatImageReader } from './bot-image-path.mjs'
import { createConversationObserverParentEffects } from './conversation/observer-parent.mjs'
import { checkObserverProjects } from './observer-check.mjs'
import { readObserverTurns } from './self-turns.mjs'
import { createConversationExecutionEffects } from './conversation-execution-effects.mjs'
import { createConversationFacade } from './conversation-facade.mjs'
import { MEMBERS_EXCHANGE_HOLD_MS } from './members-admission.mjs'
import { readMemberSummary } from './members-facade.mjs'

const notAccepted = () => Object.assign(new Error('CONVERSATION_NOT_ACCEPTED'), { code: 'CONVERSATION_NOT_ACCEPTED', status: 503, outcome: 'not_accepted', effect: 'not_started' })
const denied = () => Object.assign(new Error('CONVERSATION_CONTEXT_REQUIRED'), { code: 'CONVERSATION_CONTEXT_REQUIRED', status: 403, outcome: 'not_accepted', effect: 'not_started' })

// One parent graph owns admission/authority; direct writes share its durable writer.
export function createConversationAssembly({ root, membersAdmission, exchangeMutex, getServices, createFacade = createConversationFacade,
  onExecution, onDiagnostic, onState, onModuleChildExit, onModuleRestartLimit, createProcess = createConversationProcess, prepareRelease, spawnProcess }) {
  let controller
  const admission = new ConversationLifetimes(), authority = createConversationAuthority()
  const moduleOperations = createModuleOperationContext({ membersAdmission, conversationAdmission: admission })
  const scope = new AsyncLocalStorage(), owned = new WeakMap(), listeners = new Set(), memberParents = new WeakMap()
  // a296: the module's own replace (quiesce to the new child's resume) is "exchanging"; every exit of it reports through onState.
  let exchanging = false
  const exchangeWaiters = new Set()
  const trackState = state => {
    exchanging = state?.exchanging === true
    if (!exchanging) { for (const wake of exchangeWaiters) wake(); exchangeWaiters.clear() }
  }
  const whenConversationOpen = () => !exchanging ? Promise.resolve() : new Promise((resolve, reject) => {
    const wake = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { exchangeWaiters.delete(wake); reject(notAccepted()) }, MEMBERS_EXCHANGE_HOLD_MS); timer.unref?.()
    exchangeWaiters.add(wake)
  })
  const executionEffects = onExecution ?? createConversationExecutionEffects({ getServices, getController: () => controller, admission })
  const getBots = () => getServices().bots
  const receiptAssetContexts = new WeakSet()
  const gate = createConversationAssetGate({ readRemovalStates: () => getBots().readRemovalStates(),
    assertContext: context => receiptAssetContexts.has(context) ? membersAdmission.assertLease(context.membersLease) : moduleOperations.assert(context) })
  const receiptAssets = new MessageAssets({ root, botsAssetsRoot: join(root, 'state/bots'),
    ...(getServices().seatRuntime ? { readImage: (...args) => seatImageReader({ bots: getBots(), transport: getServices().transport,
      local: (image, maxBytes) => getServices().seatRuntime.readImage(image, maxBytes) })(...args) } : {}) })
  // Every direct-path write (images, files, forwarded images) takes the same members lease and deletion-gate save lease.
  const leased = write => input => membersAdmission.withLease(async membersLease => {
    const context = { membersLease }; receiptAssetContexts.add(context)
    const lease = await gate.beginSave(input.owner, context)
    try { return await write(input) }
    finally { await gate.endSave(lease); receiptAssetContexts.delete(context) }
  })
  const directAssets = { directory: owner => receiptAssets.directory(owner),
    saveAll: leased(input => receiptAssets.saveAll(input)), saveFiles: leased(input => receiptAssets.saveFiles(input)),
    copyAll: leased(input => receiptAssets.copyAll(input)) }

  const observerEffects = createConversationObserverParentEffects({
    snapshot: async context => { await getBots().refresh(context.operationContext); return [...getBots().values()] },
    current: async (botId, context) => { await readMemberSummary(getBots(), botId, context.operationContext); return getBots().get(botId) },
    check: (request, context) => checkObserverProjects(request, { root, seatCommands: Boolean(getServices().seatRuntime), signal: context.signal }),
    read: (request, context) => readObserverTurns(request, { seatCommands: Boolean(getServices().seatRuntime), signal: context.signal }),
  })
  const openAsset = createConversationAssetReader({ root })
  const effects = createConversationParentEffects({ getServices: () => ({ ...getServices(), conversationAssetGate: gate, conversationAssetOpen: openAsset,
    conversationCompletion: context => {
      admission.assertLease(context.conversationLease)
      if (!(context.actualCompletion instanceof Promise)) throw denied()
      return context.actualCompletion
    }, roomsRoot: join(root, 'rooms') }), observerEffects, onExecution: executionEffects })
  controller = createProcess({ root, admission, exchangeMutex, onModuleChildExit, onModuleRestartLimit, authorizeActor: authority.authorizeActor,
    probeCandidate: channel => {
      const token = authority.capture('rooms.list', { kind: 'owner' })
      let operation
      try {
        operation = moduleOperations.reserve()
        const result = channel.request('rooms.list', {}, { capturedAuthority: token,
          conversationLease: operation.conversationLease, operationContext: operation })
        const completion = result.completion ?? result
        membersAdmission.trackCompletion(operation.membersLease, completion)
        admission.trackCompletion(operation.conversationLease, completion)
        completion.then(() => authority.release(token), () => authority.release(token))
        return result
      } catch (error) { authority.release(token); throw error }
      finally { if (operation) moduleOperations.finish(operation) }
    },
    readBots: async () => { await getBots().refresh(); return [...getBots().values()].map(({ id, name, displayName, position, role }) => ({ id, name,
      ...(displayName === undefined ? {} : { displayName }), ...(position === undefined ? {} : { position }), ...(role === undefined ? {} : { role }) })) },
    onEffect: (method, params, context) => scope.run({ actor: context.actor, parent: context }, () => effects(method, params, context)),
    onEvent: async change => { await Promise.all([...listeners].map(listener => listener(change))) },
    onDiagnostic, onState: state => { trackState(state); onState?.(state) }, ...(prepareRelease ? { prepareRelease } : {}), ...(spawnProcess ? { spawnProcess } : {}),
  })
  const inheritedContext = (input, current) => input.operationContext ?? (input.membersLease && input.conversationLease ? input : current?.parent?.operationContext)
  const context = (method, input = {}) => {
    const current = scope.getStore()
    if (!current?.actor) throw denied()
    const inherited = inheritedContext(input, current)
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
      // a149: members serves the root's start only (its reply, or a turn's acceptance); a running turn must not hold a members
      // exchange (Owner 11/08: an update never waits for work). Later members needs re-enter as fresh roots (reports, deliveries).
      membersAdmission.trackCompletion(state.operationContext.membersLease, result.accepted ?? result)
      admission.trackCompletion(state.operationContext.conversationLease, completion)
      // Callback authority lives through delivery and background ACKs, beyond the root result.
      admission.operationCompletion(state.operationContext.conversationLease).then(() => authority.release(state.capturedAuthority), () => authority.release(state.capturedAuthority))
      return result
    } catch (error) { authority.release(state.capturedAuthority); throw error }
    finally { if (state.own) moduleOperations.finish(state.operationContext); owned.delete(options) }
  }
  // members-admission.md (a127): a fresh call reserves (synchronous members enter) right after a members exchange,
  // in the caller's scope, instead of being refused during it; same whenOpen and 60 s exit as the AT7 scheduler.
  // a296: it also waits out this module's own exchange (conversation/process.md), re-checked at the instant it starts.
  const admit = (method, input = {}, start) => {
    const current = scope.getStore()
    if (inheritedContext(input, current) || !membersAdmission.exchanging && !exchanging) return start()
    let started
    const begin = async () => {
      for (;;) {
        await whenConversationOpen()
        if (await membersAdmission.whenOpen(() => exchanging ? false : (started = scope.run(current, start), true))) return
      }
    }
    const opened = begin()
    const result = opened.then(() => started)
    result.completion = opened.then(() => started?.completion ?? started)
    if (method === 'user.turn') result.accepted = opened.then(() => started?.accepted ?? started)
    for (const promise of [result, result.completion, result.accepted]) promise?.catch(() => {})
    return result
  }
  const facade = createFacade({ getController: () => ({ ...controller, request: invoke, callback: (method, params, options) => invoke(method, params, options, true) }), context, admit,
    memberScoped: () => scope.getStore()?.actor?.kind === 'bot' })
  return { controller, admission, moduleOperations, facade, directAssets,
    captureReceipt(method, input) {
      const current = scope.getStore()
      if (!current?.actor) throw denied()
      const params = method === 'call.receive' ? input : { ...input, images: input.images ?? (input.image ? [input.image] : []) }
      if (method !== 'call.receive') { delete params.image; delete params.executionSource; if (method === 'user.post') delete params.from }
      validateConversationInput(method, params, current.actor)
      if (current.actor.kind === 'bot' && method === 'direct.post' && input.from !== current.actor.botId)
        throw Object.assign(new Error('CONVERSATION_SENDER_FORBIDDEN'), { code: 'CONVERSATION_SENDER_FORBIDDEN', status: 403 })
      if (['onboarding', 'usage'].includes(current.actor.kind) && input.target !== current.actor.botId)
        throw Object.assign(new Error('CONVERSATION_TARGET_FORBIDDEN'), { code: 'CONVERSATION_TARGET_FORBIDDEN', status: 403 })
      return current.parent?.executionSource
    },
    assets: { ...facade.assets, open: openAsset, initialize: () => gate.initialize(),
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
