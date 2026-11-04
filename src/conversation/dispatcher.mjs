import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { BellTeamMessenger } from '../messenger.mjs'
import { ConversationStore } from '../conversation-store.mjs'
import { MessageAssets } from '../message-assets.mjs'
import { RoomRegistry } from '../room-registry.mjs'
import { RoomMessenger } from '../room-messenger.mjs'
import { requireRoomMember, requireRepresentative } from '../room-access.mjs'
import { SelfTurns } from '../self-turns.mjs'
import { TurnReports, judgeOwnerReport } from '../turn-reports.mjs'
import { chooseRoomResponder } from '../room-routing.mjs'
import { ConversationNative } from './native.mjs'
import { ConversationBackground } from './background.mjs'
import { ConversationRouting } from './routing.mjs'
import { conversationHistoryPage } from '../timeline-index.mjs'
import { readSelfTurnsState } from './restore.mjs'
import { CONVERSATION_STATE_COMPATIBILITY } from './state-compatibility.mjs'
import { validateConversationRequest, validateConversationControl } from './requests.mjs'
import { validateConversationResult, validateConversationControlResult } from './results.mjs'
import { validateConversationCallback, conversationCallbackFailureFields } from './callbacks.mjs'
import { validateConversationCallbackContext } from './requests.mjs'
import { validateConversationEffect, validateConversationEffectResult } from './effects.mjs'

const failure = code => Object.assign(new Error(code), { code, status: 503, outcome: 'not_accepted' })

export function createConversationDispatcher({ root, effect, event, trackBackground, diagnostic = async () => {}, fetcher = fetch }) {
  if ([effect, event, trackBackground].some(value => typeof value !== 'function')) throw failure('CONVERSATION_ADAPTER_REQUIRED')
  const contexts = new AsyncLocalStorage(), active = new Set(), bots = new Map()
  let generation, initializationStarted = false, initialized = false, accepting = false, exiting = false, quiesced = false, epoch = 0
  const current = () => {
    const value = contexts.getStore()
    if (!value) throw failure('CONVERSATION_CONTEXT_REQUIRED')
    return value
  }
  const track = task => {
    active.add(task)
    task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const invoke = async (method, params, context = current().context) => {
    validateConversationEffect(method, params, context)
    const result = await effect(method, params, context)
    validateConversationEffectResult(method, result, params)
    return result
  }
  const replaceBots = snapshot => {
    bots.clear()
    for (const bot of snapshot) bots.set(bot.id, Object.freeze({ ...bot }))
  }
  bots.refresh = async () => replaceBots((await invoke('members.profiles.read', {})).bots)
  const background = new ConversationBackground({ effect: invoke, trackBackground })
  const routing = new ConversationRouting({ read: context => invoke('usage.routing.read', {}, context), fetcher })
  const native = new ConversationNative({ invoke, current, run: (state, operation) => contexts.run(state, operation),
    awaitStarted: context => background.awaitStarted(context) })
  const logPath = join(root, 'logs/direct-messages.jsonl'), store = new ConversationStore({ logPath, onCorruption: report => diagnostic(report) })
  const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots })
  const assets = new MessageAssets({ root, botsAssetsRoot: join(root, 'state/bots'),
    readImage: async (image, _maxBytes, leaseId) => Buffer.from((await invoke('runtime.image.read', { image, leaseId })).data, 'base64'),
    saveAdmission: {
      beginSave: async owner => (await invoke('assets.beginSave', { owner })).leaseId,
      endSave: leaseId => invoke('assets.endSave', { leaseId }),
    } })
  const reportFailure = () => diagnostic({ code: 'CONVERSATION_BACKGROUND_FAILED' })
  const emit = async (record, room = false) => {
    const context = current().context
    if (!room) await event({ type: 'changed', topics: ['timeline'], all: record.schema === 'bellteam.delivery-status.v1',
      botIds: [...new Set([record.bot, record.from, record.target].filter(id => bots.has(id)))], roomIds: [] }, context)
    if (record.schema === 'bellteam.direct-message.v1' || room) {
      try {
        await invoke(room ? 'usage.notify.room' : 'usage.notify.direct', room
          ? { id: record.id, sender: { id: record.sender.id, name: record.sender.name }, room: { id: record.room.id, name: record.room.name } }
          : { deliveryId: record.delivery_id, from: record.from, target: record.target })
      } catch { await diagnostic({ code: 'CONVERSATION_NOTIFICATION_FAILED' }) }
    }
  }
  const access = () => invoke('execution.assertAccess', {})
  const appendRoomMessage = rooms.appendMessage.bind(rooms)
  rooms.appendMessage = async (roomId, record) => {
    await appendRoomMessage(roomId, record)
    await event({ type: 'changed', topics: ['timeline'], all: false, botIds: [], roomIds: [roomId] }, current().context)
  }
  const afterTurn = turn => {
    const state = current()
    if (state.inlineReport) return reports.check(turn)
    const child = { ...state }
    const task = background.start(async () => {
      child.source = state.source ?? await invoke('execution.observation.source', { target: turn.botId })
      return child.source
    }, state.context, () => contexts.run(child, () => reports.check(turn)))
    task.catch(reportFailure).catch(() => {})
    return task
  }
  const messenger = new BellTeamMessenger({ bots, transport: native, logPath, store, assets,
    failureFields: conversationCallbackFailureFields,
    admitWork: () => () => {}, requireAccess: access, onMessage: record => emit(record), onTurnEnd: afterTurn })
  const reports = new TurnReports({ bots, store, transport: native,
    appendInterimWords: (...args) => messenger.appendInterimWords(...args),
    notifyReport: (...args) => native.report(...args),
    enabled: async () => {
      try { await access() }
      catch (error) { if (current().context.actor?.kind === 'observer' && error.code === 'AI_GLOBAL_PAUSED') return false; throw error }
      return routing.withRouting(current().context, value => value.enabled)
    },
    judge: value => routing.withRouting(current().context, config => judgeOwnerReport({ ...value, apiKey: config.apiKey, fetcher: config.fetcher })),
  })
  const roomMessenger = new RoomMessenger({ rooms, bots, transport: native, assets,
    failureFields: conversationCallbackFailureFields, admitWork: () => () => {}, requireAccess: access,
    automaticRouting: () => routing.withRouting(current().context, value => value.enabled),
    chooseResponder: value => routing.withRouting(current().context, config => chooseRoomResponder({ ...value, apiKey: config.apiKey, fetcher: config.fetcher })),
    roomTurns: async ({ projectPath: _root, ...params }) => (await invoke('runtime.room.context', params)).turns,
    onMessage: record => emit(record, true),
    onInterimWords: (...args) => messenger.appendInterimWords(...args), onTurnEnd: afterTurn })
  const selfTurns = new SelfTurns({ bots, statePath: join(root, 'logs/self-turns.json'),
    observer: {
      snapshot: async () => (await invoke('runtime.observer.snapshot', {})).projects.map(({ botId, scope, projectBytes }) => ({ id: botId, project: scope, projectBytes })),
      check: request => invoke('runtime.observer.check', request),
      read: request => invoke('runtime.observer.read', request),
    },
    shown: botId => invoke('execution.shown.read', { botId }),
    consumeShown: (botId, shown) => invoke('execution.shown.consume', { botId, shownId: shown.shownId }),
    appendAnswer: (botId, groupId, text) => messenger.appendInterimWords(botId, groupId, [{ text, kind: 'answer' }]),
    afterTurn, report: () => { void Promise.resolve(diagnostic({ code: 'CONVERSATION_OBSERVATION_FAILED' })).catch(() => {}) } })

  function assertContext(context) {
    if (!initialized || exiting || context.generation !== generation) throw failure('CONVERSATION_UNAVAILABLE')
  }
  function validateRequest(method, params, context) {
    validateConversationRequest(method, params, context)
    assertContext(context)
    if (!accepting && !context.continuation) throw failure('CONVERSATION_UNAVAILABLE')
  }
  function validateCallback(method, params, context) {
    if (method === 'display.words') { validateConversationRequest(method, params, context); assertContext(context); return }
    validateConversationCallback(method, params)
    validateConversationCallbackContext(method, context)
    assertContext(context)
  }
  const authorizeRoom = (roomId, representative = false) => {
    const actor = current().context.actor
    if (actor.kind !== 'bot') return rooms.require(roomId)
    return (representative ? requireRepresentative : requireRoomMember)(rooms, roomId, actor.botId)
  }
  const changedRooms = async value => {
    await event({ type: 'changed', topics: ['rooms', 'schedules', 'timeline'], botIds: [], roomIds: [], all: true }, current().context)
    return value
  }
  function history(items) {
    let offset = 0, finished = false
    const done = Promise.withResolvers()
    track(done.promise)
    const finish = () => { if (!finished) { finished = true; done.resolve() } }
    return {
      [Symbol.asyncIterator]() { return this },
      async next() { if (finished || offset === items.length) { finish(); return { done: true } }; return { done: false, value: items[offset++] } },
      async return() { finish(); return { done: true } },
      async throw(error) { finish(); throw error },
    }
  }
  async function roomResponse(params, silent) {
    const actor = current().context.actor
    if (actor.kind !== 'bot') throw new Error('ROOM_MEMBER_REQUIRED')
    authorizeRoom(params.roomId)
    const received = (await rooms.messages(params.roomId)).find(row => row.id === params.messageId
      && row.deliveries?.some(delivery => delivery.target === actor.botId))
    if (!received) throw new Error('ROOM_RESPONSE_CONTEXT_MISSING')
    if (received.routing?.status !== 'ready') throw new Error('ROOM_ROUTING_NOT_READY')
    const assigned = received.routing.responders.includes(actor.botId)
    if (silent) { if (assigned) throw new Error('ROOM_REPLY_EXPECTED'); return { delivery: 'suppressed' } }
    if (!assigned) throw new Error('ROOM_REPLY_NOT_ASSIGNED')
    const result = await roomMessenger.sendroommessage({ from: actor.botId, room: params.roomId,
      responseTo: params.messageId, message: params.message, images: params.images, targets: params.targets })
    return { id: result.id, delivery: result.delivery, ...(result.failedTargets ? { failedTargets: result.failedTargets } : {}) }
  }
  function execute(method, params) {
    const actor = current().context.actor
    if (actor.kind === 'bot' && ['direct.post', 'room.post'].includes(method) && params.from !== actor.botId)
      throw Object.assign(new Error('CONVERSATION_SENDER_FORBIDDEN'), { status: 403 })
    if (actor.kind === 'bot' && ['assets.save', 'assets.saveAll'].includes(method) && params.owner !== actor.botId)
      throw Object.assign(new Error('CONVERSATION_ASSET_OWNER_FORBIDDEN'), { status: 403 })
    if (['onboarding', 'usage'].includes(actor.kind) && params.target !== actor.botId)
      throw Object.assign(new Error('CONVERSATION_TARGET_FORBIDDEN'), { status: 403 })
    switch (method) {
      case 'rooms.list': return { rooms: [...rooms.values()].filter(room => actor.kind !== 'bot' || room.memberIds.includes(actor.botId)) }
      case 'room.read': return { room: authorizeRoom(params.roomId) }
      case 'room.authorize': return { room: authorizeRoom(params.roomId, params.requirement === 'representative') }
      case 'room.create':
        if (actor.kind === 'bot' && (!params.memberIds.includes(actor.botId) || params.representativeId !== actor.botId)) throw new Error('ROOM_REPRESENTATIVE_REQUIRED')
        return rooms.create(params).then(room => changedRooms({ room }))
      case 'room.update': authorizeRoom(params.roomId, true); return rooms.update(params.roomId, params.changes).then(room => changedRooms({ room }))
      case 'room.remove': authorizeRoom(params.roomId, true); return rooms.remove(params.roomId).then(() => changedRooms({ removed: params.roomId }))
      case 'room.invite': case 'room.leave': {
        if (!bots.has(params.botId)) throw new Error(`BOT_NOT_FOUND: ${params.botId}`)
        const room = rooms.require(params.roomId), leaving = method === 'room.leave'
        return rooms.update(room.id, { memberIds: leaving ? room.memberIds.filter(id => id !== params.botId) : [...new Set([...room.memberIds, params.botId])],
          ...(leaving && room.representativeId === params.botId ? { representativeId: null } : {}) }).then(room => changedRooms({ room }))
      }
      case 'room.schedules.list': authorizeRoom(params.roomId); return rooms.listSchedules(params.roomId).then(schedules => ({ schedules }))
      case 'room.schedules.set': authorizeRoom(params.roomId, true); return rooms.setSchedule(params.roomId, params.schedule).then(schedule => changedRooms({ schedule }))
      case 'room.schedules.remove': authorizeRoom(params.roomId, true); return rooms.removeSchedule(params.roomId, params.scheduleId).then(() => changedRooms({ removed: params.scheduleId }))
      case 'room.schedules.claimDue': case 'room.schedules.skipDue': return rooms[method.endsWith('claimDue') ? 'claimDue' : 'skipDue'](params)
        .then(value => value === null ? null : changedRooms(value))
      case 'member.removeFromRooms': return rooms.removeBot(params.botId).then(() => changedRooms({ removed: params.botId }))
      case 'history.listMessages':
        if (!bots.has(params.botId)) throw new Error(`BOT_NOT_FOUND: ${params.botId}`)
        return store.timeline(params.botId).then(history)
      case 'history.listRoomMessages': authorizeRoom(params.roomId); return rooms.messages(params.roomId).then(history)
      case 'history.deliveryAnchor': {
        if (current().context.actor.botId !== params.target) throw Object.assign(failure('CONVERSATION_ACTOR_INVALID'), { status: 403 })
        if (!bots.has(params.target)) throw new Error(`BOT_NOT_FOUND: ${params.target}`)
        if (params.context === 'room') { authorizeRoom(params.contextId); return rooms.deliveryAnchor(params) }
        return store.deliveryAnchor(params)
      }
      case 'history.page': {
        let base
        if (params.kind === 'rooms') { authorizeRoom(params.id); base = rooms.messageView(params.id) }
        else {
          if (!bots.has(params.id)) throw new Error(`BOT_NOT_FOUND: ${params.id}`)
          base = store.timelineView(params.id)
        }
        return base.then(index => history([conversationHistoryPage(index, params)]))
      }
      case 'history.recentBatch': {
        for (const botId of params.botIds) if (!bots.has(botId)) throw new Error(`BOT_NOT_FOUND: ${botId}`)
        return store.timelineViews(params.botIds).then(views => history(params.botIds.map(botId => ({ botId, message: views.get(botId).at(-1) ?? null }))))
      }
      // 一覧の直近表示は最後の1件だけを使う。全履歴を親へ送ると、メンバー数に比例して一覧が遅くなる。
      case 'history.recent': {
        if (!bots.has(params.botId)) throw new Error(`BOT_NOT_FOUND: ${params.botId}`)
        return store.timelineView(params.botId).then(index => ({ message: index.length ? index.at(-1) : null }))
      }
      case 'direct.post': return messenger.sendmessage(params)
      case 'user.post': case 'user.turn': {
        const state = current(), completion = messenger.userTurn(params)
        state.userSaved = track(completion.then(async result => { await background.awaitStarted(state.context); return result }))
        state.userSaved.catch(() => {})
        return method === 'user.turn' ? completion : completion.accepted
      }
      case 'room.post': return roomMessenger.sendroommessage(params)
      case 'room.reply': return roomResponse(params, false)
      case 'room.silent': return roomResponse(params, true)
      case 'assets.save': return assets.save(params)
      case 'assets.saveAll': return assets.saveAll(params)
      case 'delivery.resume': return messenger.resumeDelivery(params.deliveryId, params.target)
      case 'delivery.closeLaunch': return messenger.closeDeliveryLaunch(params.deliveryId, params.target).then(({ closed, ...result }) => ({ ...result, closureId: closed.closureId }))
      case 'call.receive': return messenger.receiveCallBridge(params)
      case 'observation.poll': return selfTurns.poll().then(() => ({ applied: true }))
      case 'display.words':
        if (!bots.has(params.botId)) throw new Error(`BOT_NOT_FOUND: ${params.botId}`)
        return messenger.appendInterimWords(params.botId, params.groupId, params.words).then(() => ({ applied: true }))
      default: throw failure('CONVERSATION_INPUT_INVALID')
    }
  }
  function dispatch(method, params, context) {
    validateConversationRequest(method, params, context)
    assertContext(context)
    const accepted = method === 'user.turn' ? Promise.withResolvers() : null
    accepted?.promise.catch(() => {})
    const task = track(contexts.run({ context }, async () => {
      await bots.refresh()
      if (method.startsWith('room') || ['history.listRoomMessages', 'member.removeFromRooms'].includes(method)
        || method === 'history.page' && params.kind === 'rooms'
        || method === 'history.deliveryAnchor' && params.context === 'room') await rooms.refresh()
      const result = execute(method, params)
      if (accepted) Promise.resolve(result.accepted).then(value => { validateConversationResult('user.post', value); accepted.resolve(value) }, accepted.reject).catch(accepted.reject)
      const value = await result
      await background.awaitStarted(context)
      validateConversationResult(method, value)
      return value
    }))
    if (accepted) { task.catch(accepted.reject); task.accepted = accepted.promise }
    return task
  }
  const drain = async () => {
    do {
      await Promise.allSettled([...active])
      await background.drain()
      await native.drain()
    } while (active.size || background.snapshot().pending || native.snapshot().deliveries)
  }
  async function control(method, params, context) {
    validateConversationControl(method, params, context)
    let value
    if (method === 'initialize') {
      if (initializationStarted || exiting) throw failure('CONVERSATION_ALREADY_INITIALIZED')
      initializationStarted = true; generation = params.generation
      replaceBots(params.bots)
      if (params.mode === 'restore') { await rooms.restore(); selfTurns.state = await readSelfTurnsState(selfTurns.statePath) }
      else { await rooms.initialize(); await selfTurns.initialize() }
      await assets.initialize()
      initialized = true
      value = { stateCompatibility: CONVERSATION_STATE_COMPATIBILITY }
    } else {
      assertContext(context)
      if (method === 'routing.changed') value = routing.changed(params)
      else if (method === 'resume') { epoch++; accepting = true; quiesced = false; value = { resumed: true } }
      else if (method === 'quiesce') {
        accepting = false
        const currentEpoch = ++epoch
        await drain()
        if (currentEpoch !== epoch || accepting) throw failure('CONVERSATION_QUIESCE_SUPERSEDED')
        quiesced = true; value = { quiesced: true }
      } else {
        if (!quiesced || active.size || background.snapshot().pending || native.snapshot().deliveries) throw failure('CONVERSATION_NOT_QUIESCED')
        exiting = true; value = { closed: true }
      }
    }
    validateConversationControlResult(method, value)
    return value
  }
  return { validateRequest, dispatch, validateCallback,
    dispatchCallback: (method, params, context) => { validateCallback(method, params, context); return method === 'display.words'
      ? dispatch(method, params, context) : track(native.dispatchCallback(method, params, context)) },
    releaseDelivery: binding => native.releaseDelivery(binding), control,
    disconnect: async () => { accepting = false; exiting = true; epoch++; native.disconnect(failure('CONVERSATION_DISCONNECTED')); await drain() },
  }
}
