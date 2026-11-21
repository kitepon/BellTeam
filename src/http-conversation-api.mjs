import { pipeline } from 'node:stream'
import { json, readJson } from './http-response.mjs'
import { withWorkingWord } from './working-words.mjs'
import { webMessage, messageImages, MESSAGE_MAX_BYTES } from './http-messages.mjs'
import { validReplyQuote, validReplyTo } from './reply-reference.mjs'
import { originFailure, readOrigin } from './origin-reference.mjs'

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
  const exists = async id => {
    try { return bots.readMember ? Boolean(await bots.readMember(id)) : bots.has(id) }
    catch (error) { if (error.code === 'BOT_NOT_FOUND' && error.status === 404) return false; throw error }
  }
  return async (request, response, url) => {
    const botQueueMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/queue$/u)
    if (request.method === 'GET' && botQueueMatch) {
      if (!await exists(botQueueMatch[1])) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, { items: withWorkingWord(await transport.queueItems({ botId: botQueueMatch[1] })) })
    }

    const match = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/messages$/u)
    if (match) {
      const botId = match[1]
      if (!(request.method === 'GET' ? await exists(botId) : bots.has(botId))) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, await messagePage('bots', botId, url))
      if (request.method === 'POST') {
        const body = await readJson(request, MESSAGE_MAX_BYTES)
        const message = typeof body.message === 'string' ? body.message.trim() : ''
        const images = messageImages(body)
        const origin = readOrigin(body, images)
        if (origin.error) return json(response, origin.status, { error: origin.error, ...(origin.message ? { message: origin.message } : {}) })
        if (!message && !images.length && !Object.keys(origin.fields).length)
          return json(response, 400, { error: 'MESSAGE_REQUIRED' })
        if (body.reply_to != null && !validReplyTo(body.reply_to)) return json(response, 400, { error: 'REPLY_TO_INVALID' })
        if (body.reply_quote != null && (body.reply_to == null || !validReplyQuote(body.reply_quote))) return json(response, 400, { error: 'REPLY_QUOTE_INVALID' })
        let result
        try { result = await messenger.enqueueUserTurn({ target: botId, message, images, ...(body.reply_to != null ? { replyTo: body.reply_to } : {}), ...(body.reply_quote != null ? { replyQuote: body.reply_quote } : {}), ...origin.fields }) }
        catch (error) {
          const refusal = originFailure(error)
          if (!refusal) throw error
          return json(response, refusal.status, { error: refusal.error, ...(refusal.message ? { message: refusal.message } : {}) })
        }
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
      // Node 26 pipeline throws if the response ended while open was pending.
      if (response.destroyed || response.writableEnded) {
        asset.stream.destroy()
        return response
      }
      response.writeHead(200, {
        'content-type': asset.mime,
        'content-length': asset.size,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        // image-original.md: the saved file name for "save as"; ?download=1 asks the browser to save instead of show.
        'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${imageAssetMatch[2]}"`,
      })
      // A disconnected response must also close the source FileHandle.
      return pipeline(asset.stream, response, () => {})
    }
    const fileAssetMatch = url.pathname.match(/^\/api\/message-files\/([a-z0-9-]+)\/([a-z0-9-]+\.dat)$/u)
    if (request.method === 'GET' && fileAssetMatch) {
      if (!assets) return json(response, 404, { error: 'FILE_ASSET_NOT_FOUND' })
      const asset = await assets.open(fileAssetMatch[1], fileAssetMatch[2])
      if (response.destroyed || response.writableEnded) {
        asset.stream.destroy()
        return response
      }
      // A file is never shown inline: always a download of opaque bytes, under the stored (ASCII) name.
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': asset.size,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${fileAssetMatch[2]}"`,
      })
      return pipeline(asset.stream, response, () => {})
    }
    return false
  }
}
