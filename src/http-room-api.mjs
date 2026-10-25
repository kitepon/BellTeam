import { json, readJson } from './http-response.mjs'
import { recentTimeline } from './timeline-index.mjs'
import { listAvatar, sendAvatar } from './http-assets.mjs'
import { messageImages, MESSAGE_MAX_BYTES } from './http-messages.mjs'

export function createRoomApi({ rooms, transport, sources, messagePage, roomMessenger }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      await rooms.refresh()
      const list = await Promise.all([...rooms.values()].map(async room => ({
        ...room, ...listAvatar(room.avatar, url), recent: recentTimeline(await sources('rooms', room.id)),
      })))
      return json(response, 200, { rooms: list })
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      return json(response, 201, { room: await rooms.create(await readJson(request)) })
    }
    const roomAvatarMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/avatar$/u)
    if (request.method === 'GET' && roomAvatarMatch) {
      await rooms.refresh()
      if (!rooms.has(roomAvatarMatch[1])) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
      return sendAvatar(request, response, rooms.get(roomAvatarMatch[1]).avatar, url)
    }
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)$/u)
    if (roomMatch) {
      await rooms.refresh()
      const roomId = roomMatch[1]
      if (!rooms.has(roomId)) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, { room: rooms.get(roomId) })
      if (request.method === 'PATCH') return json(response, 200, { room: await rooms.update(roomId, await readJson(request)) })
      if (request.method === 'DELETE') {
        await rooms.remove(roomId)
        response.writeHead(204)
        return response.end()
      }
    }

    const roomScheduleMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/schedules(?:\/([^/]+))?$/u)
    if (roomScheduleMatch) {
      await rooms.refresh()
      const roomId = roomScheduleMatch[1]
      const scheduleId = roomScheduleMatch[2]
      if (!rooms.has(roomId)) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
      if (request.method === 'GET' && !scheduleId) return json(response, 200, { schedules: await rooms.listSchedules(roomId) })
      if (request.method === 'POST' && !scheduleId)
        return json(response, 201, { schedule: await rooms.setSchedule(roomId, await readJson(request)) })
      if (request.method === 'PUT' && scheduleId)
        return json(response, 200, { schedule: await rooms.setSchedule(roomId, { ...await readJson(request), id: decodeURIComponent(scheduleId) }) })
      if (request.method === 'DELETE' && scheduleId) {
        await rooms.removeSchedule(roomId, decodeURIComponent(scheduleId))
        response.writeHead(204)
        return response.end()
      }
    }

    const roomMessagesMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/messages$/u)
    if (roomMessagesMatch) {
      await rooms.refresh()
      const roomId = roomMessagesMatch[1]
      if (!rooms.has(roomId)) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, await messagePage('rooms', roomId, url))
      if (request.method === 'POST') {
        const body = await readJson(request, MESSAGE_MAX_BYTES)
        const message = typeof body.message === 'string' ? body.message.trim() : ''
        const images = messageImages(body)
        if (!message && !images.length) return json(response, 400, { error: 'MESSAGE_REQUIRED' })
        return json(response, 200, await roomMessenger.sendroommessage({
          from: 'user', room: roomId, message, images, targets: body.targets ?? null,
        }))
      }
    }

    const roomQueueMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/queue$/u)
    if (request.method === 'GET' && roomQueueMatch) {
      await rooms.refresh()
      if (!rooms.has(roomQueueMatch[1])) return json(response, 404, { error: 'ROOM_NOT_FOUND' })
      return json(response, 200, { items: transport.queueItems({ roomId: roomQueueMatch[1] }) })
    }

    return false
  }
}
