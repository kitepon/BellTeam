import { dirname, join } from 'node:path'
import { ModelHandoff } from './model-handoff.mjs'
import { createManagedTransport } from './aiterm-transport.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { ConfigurationIntents } from './configuration-intents.mjs'
import { ConfigurationRequests } from './configuration-requests.mjs'
import { BotGoals } from './bot-goals.mjs'
import { SeatTurns } from './seat-turns.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { CapacityContinuation } from './capacity-continuation.mjs'

export const EXECUTION_STATE_COMPATIBILITY = 'bellteam.execution-state.v1'
// This engine accepts ports.access.assertInput (Z-c update hold); a parent passes it only when this is true.
export const EXECUTION_UPDATE_HOLD_GATE = true
const COMPATIBILITY = EXECUTION_STATE_COMPATIBILITY
const failure = code => Object.assign(new Error(code), { code, effect: 'not_started', status: 503 })
const asyncMethods = {
  transport: ['isRunning', 'runningBots', 'screen', 'ensure', 'wake', 'restart', 'reconfigure',
    'reconcileConfiguration', 'stop', 'interrupt', 'interruptMany', 'reconcileLaunch', 'closeLaunch',
    'observe', 'goalTargets', 'closeIdle', 'stopForConfiguration', 'turn', 'setupTest', 'notify', 'notifyReport',
    'idle', 'restartIfIdle', 'updateWorkSummary', 'seatTurns', 'watchSeatTurns'],
  administration: ['configureFromMcp', 'update', 'reconcile', 'readConfigurationOperation', 'stop', 'restart', 'remove'],
  goals: ['list', 'inspect', 'mutate'],
}
const syncMethods = {
  transport: ['session', 'currentWork', 'currentWorkBinding', 'shownInSelfTurn', 'consumeShownWords',
    'isIdle', 'deliveryBots', 'queueItems'],
  administration: ['view'],
}
export const EXECUTION_METHODS = Object.freeze({
  dispatch: Object.freeze(Object.entries(asyncMethods).flatMap(([owner, names]) => names.map(name => `${owner}.${name}`))),
  project: Object.freeze(Object.entries(syncMethods).flatMap(([owner, names]) => names.map(name => `${owner}.${name}`))),
})
const portNames = ['native', 'membersAdmission', 'conversationAdmission', 'moduleOperations', 'bots', 'rooms', 'configurationStorage',
  'access', 'storage', 'seat', 'observer', 'diagnostics', 'continuation']

// This module and every relative engine import belong to the same fixed bundle.
export function createExecutionDispatcher({ generation, ports, handoff = null, backgroundSummary = null, requestRestartSummary = null }) {
  if (typeof generation !== 'string' || !generation || !ports || Object.keys(ports).some(key => !portNames.includes(key))
    || !ports.native || !ports.membersAdmission || !ports.bots || !ports.rooms || !ports.configurationStorage
    || typeof ports.access?.assertWorkAllowed !== 'function') throw failure('EXECUTION_PORTS_INVALID')
  if (handoff && (handoff.stateCompatibility !== COMPATIBILITY || handoff.generation === generation
    || typeof handoff.generation !== 'string')) throw failure('EXECUTION_STATE_INCOMPATIBLE')
  const groups = {
    configurationStorage: ['root', 'trustedAnchor', 'ownerUid'],
    access: ['assertWorkAllowed', 'admitWork', 'requireMember', 'requireAccess', 'assertInput'],
    storage: ['prepareStartup', 'updateSession', 'updateFastMode', 'deliveryAnchor'],
    seat: ['waitProcess', 'handoffContext', 'writeTemporaryImage', 'removeTemporaryImage', 'tempRoot'],
    observer: ['appendInterimWords', 'emitQueue', 'report'], diagnostics: ['record', 'goalError'],
    continuation: ['models', 'harnessAuth', 'messenger'],
  }
  for (const [name, allowed] of Object.entries(groups))
    if (ports[name] && Object.keys(ports[name]).some(key => !allowed.includes(key))) throw failure('EXECUTION_PORTS_INVALID')
  let phase = 'created', initialized = false, initialization = null, draining = null, observerStarted = false, idleStarted = false
  let handedOver = null
  const pending = new Set()
  // Operations whose results land in cloned metadata; they must finish before a handover export.
  const administrative = new Set()
  // Turns and watches the previous engine still follows in a shared registry belong to that engine's drain.
  const inherited = new Set(handoff?.activity ? [...handoff.activity.jobs, ...handoff.activity.watches.values()] : [])
  const own = items => [...items].filter(item => !inherited.has(item))
  const alive = () => { if (['discarding', 'retired'].includes(phase)) throw failure('EXECUTION_GENERATION_RETIRED') }
  const enter = () => { if (phase !== 'running') throw failure('EXECUTION_NOT_ACCEPTING') }
  // Reads stay available while an exchange drains; the old state is a valid (possibly stale) view.
  const readable = request => request.type === 'project' || request.method === 'transport.runningBots'
  const enterFor = request => { if (!(readable(request) ? ['running', 'quiescing', 'quiesced'].includes(phase) : phase === 'running')) throw failure('EXECUTION_NOT_ACCEPTING') }
  const track = value => {
    if (!value || typeof value.then !== 'function') return value
    pending.add(value)
    value.then(() => pending.delete(value), () => pending.delete(value))
    return value
  }
  const trackAdministrative = value => {
    if (!value || typeof value.then !== 'function') return value
    administrative.add(value)
    value.then(() => administrative.delete(value), () => administrative.delete(value))
    return track(value)
  }
  const native = Object.create(ports.native)
  const nativeMethods = new Set(['pty_list', 'pty_read', 'pty_observe', 'pty_send', 'pty_close',
    'agent_launch', 'agent_configure', 'agent_stop', 'agent_goal'])
  native.call = (name, ...args) => {
    alive()
    if (!nativeMethods.has(name)) throw failure('EXECUTION_REQUEST_INVALID')
    return track(ports.native.call(name, ...args))
  }
  native.connect = (...args) => { alive(); return track(ports.native.connect(...args)) }
  // An operation lease keeps the same restrictions on every pinned call (aiterm-generation-pin.md).
  if (typeof ports.native.pin === 'function') native.pin = () => {
    alive()
    const pinned = ports.native.pin()
    // The facade lease is frozen with live getters; define over it instead of assigning or copying.
    return Object.create(pinned, {
      call: { value: (name, ...args) => {
        alive()
        if (!nativeMethods.has(name)) throw failure('EXECUTION_REQUEST_INVALID')
        return track(pinned.call(name, ...args))
      } },
      connect: { value: (...args) => { alive(); return track(pinned.connect(...args)) } },
    })
  }
  native.close = async () => {} // The host owns the shared SDK and native PTYs.
  const { root, ...storageOptions } = ports.configurationStorage
  const requests = new ConfigurationRequests({ client: native, intents: new ConfigurationIntents(root,
    { ...storageOptions, runtimeCapture: () => ports.native.runtime() }) })
  const transport = createManagedTransport({
    ...ports.seat, ...Object.fromEntries(Object.entries(ports.storage ?? {}).filter(([key]) => key !== 'deliveryAnchor')), backgroundSummary,
    activityPath: join(dirname(root), 'execution-activity.json'),
    runtimeLaunchesPath: join(dirname(root), 'execution-runtime-launches.json'),
    trackCompletion: track, client: native, membersAdmission: ports.membersAdmission, conversationAdmission: ports.conversationAdmission,
    resolveBot: id => ports.bots.get(id), configurationRequests: requests, requireMember: ports.access.requireMember,
    requireAccess: ports.access.requireAccess,
    assertWorkAllowed: () => { alive(); ports.access.assertWorkAllowed() },
    assertInputAllowed: () => ports.access.assertInput?.(),
    reportError: report => { alive(); return track(ports.diagnostics?.record?.(report)) },
  })
  const administration = new BotAdministration({ bots: ports.bots, rooms: ports.rooms, transport, moduleOperations: ports.moduleOperations,
    reportError: report => { alive(); return track(ports.diagnostics?.record?.(report)) }, trackCompletion: trackAdministrative })
  const modelHandoff = new ModelHandoff({ transport, requests, readAnchor: ports.storage?.deliveryAnchor,
    trackCompletion: trackAdministrative, records: administration.automaticConfigurationOperations })
  administration.handoff = modelHandoff; transport.modelHandoff = modelHandoff
  const goals = new BotGoals({ transport, admitWork: ports.access.admitWork,
    reportError: error => { alive(); return track(ports.diagnostics?.goalError?.(error)) } })
  const continuation = ports.continuation ? new CapacityContinuation({ ...ports.continuation,
    bots: ports.bots, administration,
    assertEnabled: () => { alive(); ports.access.assertWorkAllowed() },
  }) : null
  const deferredRecovery = []
  const recover = continuation?.failed.bind(continuation)
  if (continuation) continuation.failed = context => {
    alive()
    // After a handover the successor owns capacity recovery for turns that finish here.
    if (handedOver) { handedOver.activity.recoverCapacity?.(context); return }
    if (phase !== 'running') { deferredRecovery.push(context); return }
    recover(context)
  }
  transport.continuation = continuation
  const originalWatch = transport.watchSeatTurns.bind(transport)
  transport.watchSeatTurns = (bots, options) => originalWatch(bots, { ...options, allowNew: () => phase === 'running' })
  const observer = new SeatTurns({ bots: ports.bots, transport,
    appendInterimWords: (...args) => { alive(); return track(ports.observer?.appendInterimWords?.(...args)) },
    report: message => { alive(); ports.observer?.report?.(message) },
  })
  const idle = new IdleSessions({ bots: ports.bots, transport, allowClose: () => phase === 'running',
    report: message => { alive(); ports.observer?.report?.(message) },
  })
  const poll = observer.poll.bind(observer)
  observer.poll = () => { alive(); const observing = Promise.all([poll(), modelHandoff.poll()]); return track(observing) }
  const checkIdle = idle.check.bind(idle)
  idle.check = () => { alive(); return track(checkIdle()) }
  if (handoff?.activity) {
    // Same live registry: stop/queue/steer/isIdle keep seeing turns the previous engine still follows.
    const activity = handoff.activity
    transport.activity = activity
    for (const key of ['active', 'jobs', 'watches', 'followedTurns', 'configurationChanges', 'dispatches', 'waking']) transport[key] = activity[key]
  }
  transport.activity.recoverCapacity = continuation ? context => continuation.failed(context) : null
  const unsubscribe = transport.watchQueue(change => {
    alive(); track(ports.observer?.emitQueue?.(change))
  })
  const engines = { transport, administration, goals }
  const deliveryMethods = new Set(['transport.turn', 'transport.notify', 'transport.notifyReport', 'transport.setupTest'])
  const invoke = (request, type) => {
    enterFor({ type, method: request?.method }); validateRequest(request, type)
    const [owner, method] = request.method.split('.')
    const callbackKeys = ['onStatus', 'onAnswer', 'onInterim', 'onTurnEnd', 'admissionCheck']
    const args = request.args.map(arg => {
      if (!arg || typeof arg !== 'object' || !callbackKeys.some(key => typeof arg[key] === 'function')) return arg
      const copy = { ...arg }
      for (const key of callbackKeys) if (typeof arg[key] === 'function')
        copy[key] = (...values) => { alive(); return track(arg[key](...values)) }
      return copy
    })
    if (typeof engines[owner][method] !== 'function') throw failure('EXECUTION_METHOD_UNAVAILABLE')
    const result = engines[owner][method](...args)
    return type === 'dispatch' && !deliveryMethods.has(request.method) && !readable({ type, method: request.method })
      ? trackAdministrative(result) : track(result)
  }
  function validateRequest(request, type = 'dispatch') {
    if (!request || Object.keys(request).some(key => !['method', 'args'].includes(key))
      || !Array.isArray(request.args) || !Object.hasOwn(EXECUTION_METHODS, type)
      || !EXECUTION_METHODS[type].includes(request.method)) throw failure('EXECUTION_REQUEST_INVALID')
    return true
  }
  const idleNow = () => !initialization && !pending.size && !own(transport.jobs).length
    && !own(transport.active.values()).length && !own(transport.watches.values()).length
    && !transport.sessionChanges.size && !transport.configurationChanges.size && !transport.dispatches.size
    && !transport.waking.size && !transport.executionStopping && !requests.active.size
    && !transport.workState.activityPending && !transport.workState.pending.size && !transport.runningSnapshot
    && !deferredRecovery.length && !continuation?.pending.size
  // Accepted, followed turns and self-turn watches may keep running on this engine after a handover.
  const handoverReady = () => !initialization && !administrative.size
    && own(transport.jobs).every(job => job.handoverReady)
    && !transport.sessionChanges.size && !transport.configurationChanges.size && !transport.dispatches.size
    && !transport.waking.size && !transport.executionStopping && !requests.active.size
    && !transport.workState.activityPending && !transport.workState.pending.size && !transport.runningSnapshot
    && !deferredRecovery.length && !continuation?.pending.size
  const assertQuiescent = () => {
    if (phase !== 'quiesced' || !idleNow()) throw failure('EXECUTION_BUSY')
    return true
  }
  const startProducers = () => {
    if (!observerStarted) { observer.start(); observerStarted = true }
    if (!idleStarted) { idle.start(); idleStarted = true }
  }
  async function quiesce(timeoutMs = 60_000, { handover = false } = {}) {
    if (phase === 'quiesced') return { quiesced: true }
    const ready = handover ? handoverReady : idleNow
    if (phase !== 'running' && phase !== 'quiescing') throw failure('EXECUTION_NOT_ACCEPTING')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw failure('EXECUTION_REQUEST_INVALID')
    phase = 'quiescing'
    if (draining) return draining
    draining = (async () => {
      // Keep completion observation, but stop the producer that can close a seat.
      if (idleStarted) { idleStarted = false; track(idle.stop()) }
      const deadline = performance.now() + timeoutMs
      while (!ready()) {
        // Deferred continuation can only run after resume; preserve it and end this drain.
        if (deferredRecovery.length) throw failure('EXECUTION_BUSY')
        if (performance.now() >= deadline) throw failure('EXECUTION_BUSY')
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))))
      }
      // No existing watch requires the observer after actual zero.
      if (observerStarted) { observerStarted = false; await observer.stop() }
      if (!ready()) throw failure('EXECUTION_BUSY')
      clearTimeout(transport.workState.timer); transport.workState.timer = null
      phase = 'quiesced'
      return { quiesced: true }
    })().finally(() => { draining = null })
    return draining
  }
  function exportState({ handover = false } = {}) {
    if (phase !== 'quiesced' || !(handover ? handoverReady() : idleNow())) throw failure('EXECUTION_BUSY')
    const state = transport.sessionState
    // Clone the entire evidence graph once: rejected.original must remain pending's object.
    const metadata = structuredClone({
      sessions: state.sessions, stopVersions: state.stopVersions, stopSessions: state.stopSessions,
      // Empty legacy fields keep older handoff readers compatible; they are never admission state.
      uncertainty: new Map(), uncertaintyVersions: new Map(),
      requests: { pending: requests.pending, latest: requests.latest },
      applications: administration.applications, automaticConfigurationOperations: administration.automaticConfigurationOperations,
      work: { records: transport.workState.records, seq: transport.workState.seq, restartActivity: transport.workState.restartActivity },
      followedTurns: transport.followedTurns, retainedImages: transport.retainedImages, failedDeliveries: transport.activity.failed,
      idleSeen: idle.seen, continuationStates: continuation?.states ?? new Map(),
    })
    const result = { stateCompatibility: COMPATIBILITY, generation, metadata,
      // Parent observer opaque handles refer to these exact objects; never serialize them.
      shownWords: new Map(transport.activity.shownWords) }
    if (!handover) return result
    // Own turns finish here; the successor shares the registry and becomes the only activity-file writer.
    const completions = own([...transport.jobs, ...transport.watches.values()]).map(item => item.completion)
    handedOver = { activity: transport.activity }
    unsubscribe(); transport.workState.activityPath = null
    const released = (async () => {
      await Promise.allSettled(completions)
      while (pending.size) await Promise.allSettled([...pending])
    })()
    return Object.assign(result, { activity: transport.activity, released })
  }
  if (handoff) {
    const m = handoff.metadata
    for (const key of ['sessions', 'stopVersions', 'stopSessions']) for (const entry of m[key]) transport.sessionState[key].set(...entry)
    Object.assign(requests, m.requests, { restoring: Promise.resolve() })
    administration.applications = m.applications
    administration.automaticConfigurationOperations = m.automaticConfigurationOperations ?? new Map()
    modelHandoff.records = administration.automaticConfigurationOperations
    transport.workState.records = m.work.records; transport.workState.seq = m.work.seq
    transport.workState.restartActivity = m.work.restartActivity ?? new Map()
    transport.retainedImages = m.retainedImages
    if (!handoff.activity) {
      for (const entry of m.followedTurns) transport.followedTurns.set(...entry)
      transport.activity.failed = m.failedDeliveries ?? new Map()
      transport.activity.shownWords = handoff.shownWords
    }
    idle.seen = m.idleSeen
    if (continuation) continuation.states = m.continuationStates
  }
  async function retire() {
    if (phase === 'retired') return { closed: true }
    const settled = () => handedOver ? !pending.size : idleNow()
    if (!['created', 'failed', 'quiesced'].includes(phase) || !settled()) throw failure('EXECUTION_BUSY')
    phase = 'discarding'
    try {
      await Promise.all([...(observerStarted ? [observer.stop()] : []), ...(idleStarted ? [idle.stop()] : [])])
      observerStarted = false; idleStarted = false
      if (!settled()) throw failure('EXECUTION_BUSY')
      // A shared registry keeps the successor's listeners.
      if (handedOver) unsubscribe(); else { unsubscribe(); transport.activity.listeners.clear() }
      clearTimeout(transport.workState.timer); transport.workState.timer = null
      // Never call Transport.close(): it closes the shared native client and aborts watches.
      phase = 'retired'
      if (continuation) await continuation.close()
      return { closed: true }
    } catch (error) {
      if (phase !== 'retired') phase = 'failed'
      throw error
    }
  }
  async function control(action, options = {}) {
    alive()
    if (action === 'initialize') {
      if (initialized || phase !== 'created') throw failure('EXECUTION_NOT_ACCEPTING')
      phase = 'initializing'
      initialization = (async () => {
        if (!handoff) {
          for (const reference of await transport.workState.takeRestartActivity()) {
            const bot = ports.bots.get(reference.botId)
            if (!bot) continue
            const reconnect = transport.configurationChanges.track(bot.id, (async () => {
              const resumed = await transport.resumePreviouslyActive(bot, reference)
              if (resumed && requestRestartSummary && Date.parse(resumed.resumedAt) > Date.parse(reference.observedAt))
                await requestRestartSummary({ botId: bot.id, from: reference.observedAt, to: resumed.resumedAt })
            })())
            track(reconnect).catch(error => { try { Promise.resolve(ports.diagnostics?.record?.({
              code: 'SERVER_TURN_TRACKING_FAILED', module: 'conversation', diagnostic_log: JSON.stringify({
                stage: 'restart_resume', code: 'RESTART_RESUME_UNAVAILABLE', botId: bot.id, sessionId: reference.sessionId,
                cause_code: ['AGENT_RESUME_UNAVAILABLE', 'RESUME_CAPABILITY_UNAVAILABLE', 'RESTART_RESUME_UNCONFIRMED'].includes(error?.code) ? error.code : null,
              }),
            })).catch(() => {}) } catch {} })
          }
        }
        initialized = true; phase = 'running'; transport.workState.schedule(); startProducers()
        return { stateCompatibility: COMPATIBILITY }
      })()
      try { return await initialization }
      catch (error) { phase = 'failed'; throw error }
      finally { initialization = null }
    }
    if (action === 'resume') {
      if (!draining && initialized && phase === 'running') return { resumed: true }
      if (draining || !initialized || !['quiescing', 'quiesced'].includes(phase)) throw failure('EXECUTION_BUSY')
      phase = 'running'; transport.workState.schedule(); startProducers()
      for (const context of deferredRecovery.splice(0)) recover(context)
      return { resumed: true }
    }
    if (action === 'quiesce') return quiesce(options.timeoutMs, { handover: options.handover === true })
    if (action === 'exit') return retire()
    throw failure('EXECUTION_REQUEST_INVALID')
  }
  return Object.freeze({ validateRequest, dispatch: request => invoke(request, 'dispatch'),
    project: request => invoke(request, 'project'), control, exportState, disconnect: retire, assertQuiescent })
}
