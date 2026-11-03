import { TimelineIndex } from './timeline-index.mjs'
import { readConversationJson } from './conversation-streams.mjs'

const images = input => input.images ?? (input.image ? [input.image] : [])
const inherit = (promise, original) => {
  for (const key of ['accepted', 'completion']) if (Object.hasOwn(original, key)) promise[key] = original[key]
  return promise
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))

// Synchronous Room reads are display projections; refresh/read perform the authenticated fresh RPC.
export function createConversationFacade({ getController, context }) {
  let projection = new Map()
  const invoke = (method, params, options, map, callback = false, chunks = null) => {
    let attempt
    try {
      const captured = context(method, options)
      if (chunks) captured.onChunk = async chunk => { chunks.push(chunk) }
      attempt = getController()[callback ? 'callback' : 'request'](method, params, captured)
    } catch (error) {
      attempt = Promise.reject(error); attempt.catch(() => {}); attempt.completion = attempt
      if (method === 'user.turn') attempt.accepted = attempt
    }
    return map ? inherit(attempt.then(map), attempt) : attempt
  }
  const remember = room => {
    const copy = Object.freeze({ ...room, memberIds: Object.freeze([...room.memberIds]) })
    projection.set(copy.id, copy)
    return copy
  }
  const readRoom = (method, params, options) => invoke(method, params, options, value => remember(value.room))
  const history = (method, params, options) => {
    const chunks = []
    return invoke(method, params, options, async value => {
      if (value?.[Symbol.asyncIterator]) { const rows = []; for await (const row of value) rows.push(row); return rows }
      return readConversationJson(chunks, Infinity)
    }, false, chunks)
  }
  const rooms = {
    get: id => projection.get(id), has: id => projection.has(id), values: () => projection.values(),
    keys: () => projection.keys(), entries: () => projection.entries(), [Symbol.iterator]: () => projection.entries(),
    refresh: options => invoke('rooms.list', {}, options, value => {
      projection = new Map(value.rooms.map(room => [room.id, Object.freeze({ ...room, memberIds: Object.freeze([...room.memberIds]) })]))
      return rooms
    }),
    read: (roomId, options) => readRoom('room.read', { roomId }, options),
    require: id => { const room = projection.get(id); if (!room) throw new Error(`ROOM_NOT_FOUND: ${id}`); return room },
    create: (input, options) => readRoom('room.create', pick(input, ['name', 'purpose', 'memberIds', 'representativeId', 'avatar']), options),
    update: (roomId, changes, options) => readRoom('room.update', { roomId, changes }, options),
    remove: (roomId, options) => invoke('room.remove', { roomId }, options, () => { projection.delete(roomId) }),
    removeBot: (botId, options) => invoke('member.removeFromRooms', { botId }, options, () => { projection.clear() }),
    listSchedules: (roomId, options) => invoke('room.schedules.list', { roomId }, options, value => value.schedules),
    setSchedule: (roomId, schedule, options) => invoke('room.schedules.set', { roomId, schedule }, options, value => value.schedule),
    removeSchedule: (roomId, scheduleId, options) => invoke('room.schedules.remove', { roomId, scheduleId }, options, () => {}),
    claimDue: (input, options) => invoke('room.schedules.claimDue', input, options),
    skipDue: (input, options) => invoke('room.schedules.skipDue', input, options),
    messages: (roomId, options) => history('history.listRoomMessages', { roomId }, options),
    messageView: (roomId, options) => { const attempt = rooms.messages(roomId, options); return inherit(attempt.then(rows => new TimelineIndex(rows)), attempt) },
  }
  Object.defineProperty(rooms, 'size', { get: () => projection.size })
  const store = {
    timeline: (botId, options) => history('history.listMessages', { botId }, options),
    timelineView: (botId, options) => { const attempt = store.timeline(botId, options); return inherit(attempt.then(rows => new TimelineIndex(rows)), attempt) },
    timelineViews: async (botIds, options) => {
      const entries = []
      for (const id of botIds) {
        const attempt = store.timelineView(id, options)
        entries.push([id, await attempt])
        await attempt.completion
      }
      return new Map(entries)
    },
  }
  const user = (method, input, options) => invoke(method, { target: input.target, message: input.message, images: images(input),
    ...pick(input, ['recordUser']) }, options)
  const messenger = {
    enqueueUserTurn: (input, options) => user('user.post', input, options),
    userTurn: (input, options) => user('user.turn', input, options),
    sendmessage: (input, options) => input.from === 'user' ? user('user.post', input, options)
      : invoke('direct.post', { from: input.from, target: input.target, message: input.message, images: images(input) }, options),
    receiveCallBridge: (input, options) => invoke('call.receive', input, options),
    resumeDelivery: (deliveryId, target, options) => invoke('delivery.resume', { deliveryId, target }, options),
    closeDeliveryLaunch: (deliveryId, target, options) => invoke('delivery.closeLaunch', { deliveryId, target }, options,
      ({ closureId, ...result }) => ({ ...result, closed: { closureId } })),
    appendInterimWords: (botId, groupId, words, options) => invoke('display.words', { botId, groupId, words }, options, undefined, true),
  }
  return { rooms, store, messenger,
    roomMessenger: { sendroommessage: (input, options) => input.responseTo
      ? invoke('room.reply', { roomId: input.room, messageId: input.responseTo, message: input.message, images: images(input), ...pick(input, ['targets']) }, options)
      : invoke('room.post', { from: input.from, room: input.room, message: input.message, images: images(input), ...pick(input, ['targets', 'kind', 'schedule']) }, options) },
    assets: { save: (input, options) => invoke('assets.save', input, options), saveAll: (input, options) => invoke('assets.saveAll', input, options) },
    selfTurns: { poll: options => invoke('observation.poll', {}, options) },
  }
}
