import { createManagedTransport } from './aiterm-transport.mjs'
import { BotAdministration } from './bot-administration.mjs'
import { ConfigurationIntents } from './configuration-intents.mjs'
import { ConfigurationRequests } from './configuration-requests.mjs'
import { BotGoals } from './bot-goals.mjs'
import { SeatTurns } from './seat-turns.mjs'
import { IdleSessions } from './idle-sessions.mjs'
import { CapacityContinuation } from './capacity-continuation.mjs'

export const EXECUTION_STATE_COMPATIBILITY = 'bellteam.execution-state.v1'
const COMPATIBILITY = EXECUTION_STATE_COMPATIBILITY
const failure = code => Object.assign(new Error(code), { code, effect: 'not_started', status: 503 })
const asyncMethods = {
  transport: ['isRunning', 'runningBots', 'screen', 'ensure', 'wake', 'restart', 'reconfigure',
    'reconcileConfiguration', 'stop', 'interrupt', 'interruptMany', 'reconcileLaunch', 'closeLaunch',
    'observe', 'goalTargets', 'closeIdle', 'stopForConfiguration', 'turn', 'setupTest', 'notify', 'notifyReport',
    'idle', 'restartIfIdle', 'updateWorkSummary', 'seatTurns', 'watchSeatTurns'],
  administration: ['update', 'reconcile', 'readConfigurationOperation', 'stop', 'restart', 'remove'],
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
export function createExecutionDispatcher({ generation, ports, handoff = null }) {
  if (typeof generation !== 'string' || !generation || !ports || Object.keys(ports).some(key => !portNames.includes(key))
    || !ports.native || !ports.membersAdmission || !ports.bots || !ports.rooms || !ports.configurationStorage
    || typeof ports.access?.assertWorkAllowed !== 'function') throw failure('EXECUTION_PORTS_INVALID')
  if (handoff && (handoff.stateCompatibility !== COMPATIBILITY || handoff.generation === generation
    || typeof handoff.generation !== 'string')) throw failure('EXECUTION_STATE_INCOMPATIBLE')
  const groups = {
    configurationStorage: ['root', 'trustedAnchor', 'ownerUid'],
    access: ['assertWorkAllowed', 'admitWork', 'requireMember', 'requireAccess'],
    storage: ['prepareStartup', 'updateSession', 'updateFastMode'],
    seat: ['waitProcess', 'handoffContext', 'writeTemporaryImage', 'removeTemporaryImage', 'tempRoot'],
    observer: ['appendInterimWords', 'emitQueue', 'report'], diagnostics: ['record', 'goalError'],
    continuation: ['models', 'harnessAuth', 'messenger'],
  }
  for (const [name, allowed] of Object.entries(groups))
    if (ports[name] && Object.keys(ports[name]).some(key => !allowed.includes(key))) throw failure('EXECUTION_PORTS_INVALID')
  let phase = 'created', initialized = false, initialization = null, draining = null, observerStarted = false, idleStarted = false
  const pending = new Set()
  const alive = () => { if (['discarding', 'retired'].includes(phase)) throw failure('EXECUTION_GENERATION_RETIRED') }
  const enter = () => { if (phase !== 'running') throw failure('EXECUTION_NOT_ACCEPTING') }
  const track = value => {
    if (!value || typeof value.then !== 'function') return value
    pending.add(value)
    value.then(() => pending.delete(value), () => pending.delete(value))
    return value
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
  native.close = async () => {} // The host owns the shared SDK and native PTYs.
  const { root, ...storageOptions } = ports.configurationStorage
  const requests = new ConfigurationRequests({ client: native, intents: new ConfigurationIntents(root, storageOptions) })
  const transport = createManagedTransport({
    ...ports.seat, ...ports.storage,
    trackCompletion: track, client: native, membersAdmission: ports.membersAdmission, conversationAdmission: ports.conversationAdmission,
    configurationRequests: requests, requireMember: ports.access.requireMember,
    requireAccess: ports.access.requireAccess,
    assertWorkAllowed: () => { alive(); ports.access.assertWorkAllowed() },
    reportError: report => { alive(); return track(ports.diagnostics?.record?.(report)) },
  })
  const administration = new BotAdministration({ bots: ports.bots, rooms: ports.rooms, transport, moduleOperations: ports.moduleOperations,
    reportError: report => { alive(); return track(ports.diagnostics?.record?.(report)) }, trackCompletion: track })
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
  observer.poll = () => { alive(); return track(poll()) }
  const checkIdle = idle.check.bind(idle)
  idle.check = () => { alive(); return track(checkIdle()) }
  const unsubscribe = transport.watchQueue(change => {
    alive(); track(ports.observer?.emitQueue?.(change))
  })
  const engines = { transport, administration, goals }
  const invoke = (request, type) => {
    enter(); validateRequest(request, type)
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
    return track(engines[owner][method](...args))
  }
  function validateRequest(request, type = 'dispatch') {
    if (!request || Object.keys(request).some(key => !['method', 'args'].includes(key))
      || !Array.isArray(request.args) || !Object.hasOwn(EXECUTION_METHODS, type)
      || !EXECUTION_METHODS[type].includes(request.method)) throw failure('EXECUTION_REQUEST_INVALID')
    return true
  }
  const idleNow = () => !initialization && !pending.size && !transport.jobs.size && !transport.active.size && !transport.watches.size
    && !transport.sessionChanges.size && !transport.configurationChanges.size && !transport.dispatches.size
    && !transport.waking.size && !transport.executionStopping && !requests.active.size
    && !transport.workState.pending.size && !transport.runningSnapshot
    && !deferredRecovery.length && !continuation?.pending.size
  const assertQuiescent = () => {
    if (phase !== 'quiesced' || !idleNow()) throw failure('EXECUTION_BUSY')
    return true
  }
  const startProducers = () => {
    if (!observerStarted) { observer.start(); observerStarted = true }
    if (!idleStarted) { idle.start(); idleStarted = true }
  }
  async function quiesce(timeoutMs = 60_000) {
    if (phase === 'quiesced') return { quiesced: true }
    if (phase !== 'running' && phase !== 'quiescing') throw failure('EXECUTION_NOT_ACCEPTING')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw failure('EXECUTION_REQUEST_INVALID')
    phase = 'quiescing'
    if (draining) return draining
    draining = (async () => {
      // Keep completion observation, but stop the producer that can close a seat.
      if (idleStarted) { idleStarted = false; track(idle.stop()) }
      const deadline = performance.now() + timeoutMs
      while (!idleNow()) {
        if (performance.now() >= deadline) throw failure('EXECUTION_BUSY')
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))))
      }
      // No existing watch requires the observer after actual zero.
      if (observerStarted) { observerStarted = false; await observer.stop() }
      if (!idleNow()) throw failure('EXECUTION_BUSY')
      clearTimeout(transport.workState.timer); transport.workState.timer = null
      phase = 'quiesced'
      return { quiesced: true }
    })().finally(() => { draining = null })
    return draining
  }
  function exportState() {
    if (phase !== 'quiesced' || !idleNow()) throw failure('EXECUTION_BUSY')
    const state = transport.sessionState
    // Clone the entire evidence graph once: rejected.original must remain pending's object.
    const metadata = structuredClone({
      sessions: state.sessions, stopVersions: state.stopVersions, stopSessions: state.stopSessions,
      uncertainty: new Map(state.uncertainChanges), uncertaintyVersions: state.uncertainChanges.versions,
      requests: { pending: requests.pending, latest: requests.latest, rejectedPreparations: requests.rejectedPreparations },
      applications: administration.applications, automaticConfigurationOperations: administration.automaticConfigurationOperations,
      work: { records: transport.workState.records, seq: transport.workState.seq },
      followedTurns: transport.followedTurns, retainedImages: transport.retainedImages,
      idleSeen: idle.seen, continuationStates: continuation?.states ?? new Map(),
    })
    return { stateCompatibility: COMPATIBILITY, generation, metadata,
      // Parent observer opaque handles refer to these exact objects; never serialize them.
      shownWords: new Map(transport.activity.shownWords) }
  }
  if (handoff) {
    const m = handoff.metadata
    for (const key of ['sessions', 'stopVersions', 'stopSessions']) for (const entry of m[key]) transport.sessionState[key].set(...entry)
    for (const [id, cause] of m.uncertainty) Map.prototype.set.call(transport.uncertainChanges, id, cause)
    transport.uncertainChanges.versions = m.uncertaintyVersions
    Object.assign(requests, m.requests, { restoring: Promise.resolve() })
    administration.applications = m.applications
    administration.automaticConfigurationOperations = m.automaticConfigurationOperations ?? new Map()
    transport.workState.records = m.work.records; transport.workState.seq = m.work.seq
    for (const entry of m.followedTurns) transport.followedTurns.set(...entry)
    transport.retainedImages = m.retainedImages
    transport.activity.shownWords = handoff.shownWords
    idle.seen = m.idleSeen
    if (continuation) continuation.states = m.continuationStates
  }
  async function retire() {
    if (phase === 'retired') return { closed: true }
    if (!['created', 'failed', 'quiesced'].includes(phase) || !idleNow()) throw failure('EXECUTION_BUSY')
    phase = 'discarding'
    try {
      await Promise.all([...(observerStarted ? [observer.stop()] : []), ...(idleStarted ? [idle.stop()] : [])])
      observerStarted = false; idleStarted = false
      if (!idleNow()) throw failure('EXECUTION_BUSY')
      unsubscribe(); transport.activity.listeners.clear()
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
        if (!handoff) await transport.restoreConfigurationRequests()
        initialized = true; phase = 'running'; transport.workState.schedule(); startProducers()
        return { stateCompatibility: COMPATIBILITY }
      })()
      try { return await initialization }
      catch (error) { phase = 'failed'; throw error }
      finally { initialization = null }
    }
    if (action === 'resume') {
      if (draining || !initialized || !['quiescing', 'quiesced'].includes(phase)) throw failure('EXECUTION_BUSY')
      phase = 'running'; transport.workState.schedule(); startProducers()
      for (const context of deferredRecovery.splice(0)) recover(context)
      return { resumed: true }
    }
    if (action === 'quiesce') return quiesce(options.timeoutMs)
    if (action === 'exit') return retire()
    throw failure('EXECUTION_REQUEST_INVALID')
  }
  return Object.freeze({ validateRequest, dispatch: request => invoke(request, 'dispatch'),
    project: request => invoke(request, 'project'), control, exportState, disconnect: retire, assertQuiescent })
}
