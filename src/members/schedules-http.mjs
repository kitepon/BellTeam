import { json, readJson } from '../http-response.mjs'

export function createScheduleApi({ bots, rooms, scheduler }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/schedules') {
      await rooms.refresh?.()
      const owners = [
        ...[...bots.values()].map(profile => ({ kind: 'bot', profile, registry: bots })),
        ...[...rooms.values()].map(profile => ({ kind: 'room', profile, registry: rooms })),
      ]
      const sources = await Promise.all(owners.map(async ({ kind, profile, registry }) => ({
        kind, id: profile.id, name: profile.displayName ?? profile.name ?? profile.id,
        schedules: await registry.listSchedules(profile.id),
      })))
      return json(response, 200, { sources })
    }
    const scheduleRunMatch = url.pathname.match(/^\/api\/(bots|rooms)\/([a-z0-9-]+)\/schedules\/([^/]+)\/run$/u)
    if (request.method === 'POST' && scheduleRunMatch) {
      if (!scheduler) return json(response, 503, { error: 'SCHEDULER_UNAVAILABLE' })
      const [, kind, ownerId, scheduleId] = scheduleRunMatch
      const ran = kind === 'rooms'
        ? await scheduler.runRoomSchedule(ownerId, decodeURIComponent(scheduleId))
        : await scheduler.runBotSchedule(ownerId, decodeURIComponent(scheduleId))
      return json(response, 202, { ran: ran.id })
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

    const scheduleMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/schedules(?:\/([^/]+))?$/u)
    if (scheduleMatch) {
      const botId = scheduleMatch[1]
      const scheduleId = scheduleMatch[2]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET' && !scheduleId)
        return json(response, 200, { schedules: await bots.listSchedules(botId) })
      if (request.method === 'POST' && !scheduleId) {
        const schedule = await bots.setSchedule(botId, await readJson(request))
        return json(response, 201, { schedule })
      }
      if (request.method === 'PUT' && scheduleId) {
        const schedule = await bots.setSchedule(botId, { ...await readJson(request), id: decodeURIComponent(scheduleId) })
        return json(response, 200, { schedule })
      }
      if (request.method === 'DELETE' && scheduleId) {
        await bots.removeSchedule(botId, decodeURIComponent(scheduleId))
        response.writeHead(204)
        return response.end()
      }
    }

    return false
  }
}
