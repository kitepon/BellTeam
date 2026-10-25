import { json, readJson } from './http-response.mjs'

export function createScheduleApi({ bots, scheduler }) {
  return async (request, response, url) => {
    const scheduleRunMatch = url.pathname.match(/^\/api\/(bots|rooms)\/([a-z0-9-]+)\/schedules\/([^/]+)\/run$/u)
    if (request.method === 'POST' && scheduleRunMatch) {
      if (!scheduler) return json(response, 503, { error: 'SCHEDULER_UNAVAILABLE' })
      const [, kind, ownerId, scheduleId] = scheduleRunMatch
      const ran = kind === 'rooms'
        ? await scheduler.runRoomSchedule(ownerId, decodeURIComponent(scheduleId))
        : await scheduler.runBotSchedule(ownerId, decodeURIComponent(scheduleId))
      return json(response, 202, { ran: ran.id })
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
