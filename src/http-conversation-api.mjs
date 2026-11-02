import { json, readJson } from './http-response.mjs'
import { webMessage, messageImages, MESSAGE_MAX_BYTES } from './http-messages.mjs'

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

export function createBotConversationApi({ bots, transport, messagePage, messenger }) {
  return async (request, response, url) => {
    const botQueueMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/queue$/u)
    if (request.method === 'GET' && botQueueMatch) {
      if (!bots.has(botQueueMatch[1])) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, { items: transport.queueItems({ botId: botQueueMatch[1] }) })
    }

    const match = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/messages$/u)
    if (match) {
      const botId = match[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, await messagePage('bots', botId, url))
      if (request.method === 'POST') {
        const body = await readJson(request, MESSAGE_MAX_BYTES)
        const message = typeof body.message === 'string' ? body.message.trim() : ''
        const images = messageImages(body)
        if (!message && !images.length)
          return json(response, 400, { error: 'MESSAGE_REQUIRED' })
        const result = await messenger.enqueueUserTurn({ target: botId, message, images })
        return json(response, 200, result)
      }
    }
    return false
  }
}

export function createConversationAssetsApi({ events, assets }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/events') {
      return events.connect(request, response)
    }
    const imageAssetMatch = url.pathname.match(/^\/api\/message-images\/([a-z0-9-]+)\/([a-z0-9-]+\.(?:png|jpg|webp|gif))$/u)
    if (request.method === 'GET' && imageAssetMatch) {
      if (!assets) return json(response, 404, { error: 'IMAGE_ASSET_NOT_FOUND' })
      const asset = await assets.open(imageAssetMatch[1], imageAssetMatch[2])
      response.writeHead(200, {
        'content-type': asset.mime,
        'content-length': asset.size,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      return asset.stream.pipe(response)
    }
    return false
  }
}
