import { json } from './http-response.mjs'
import { webMessage } from './http-messages.mjs'

export function createConversationApi({ bots, rooms, timeline }) {
  return async (request, response, url) => {
    const exportMatch = url.pathname.match(/^\/api\/(bots|rooms)\/([a-z0-9-]+)\/export$/u)
    if (request.method === 'GET' && exportMatch) {
      const [, kind, id] = exportMatch
      if (kind === 'rooms') await rooms.refresh()
      const target = (kind === 'rooms' ? rooms : bots).get(id)
      if (!target) return json(response, 404, { error: kind === 'rooms' ? 'ROOM_NOT_FOUND' : 'BOT_NOT_FOUND' })
      return json(response, 200, {
        format: 'bellteam.conversation.v1',
        exportedAt: new Date().toISOString(),
        target: { kind, id, name: target.displayName ?? target.name ?? id },
        messages: (await timeline(kind, id)).map(webMessage),
      })
    }

    return false
  }
}
