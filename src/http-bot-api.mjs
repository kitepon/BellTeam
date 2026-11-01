import { json, readJson } from './http-response.mjs'
import { recentTimeline } from './timeline-index.mjs'
import { avatarVersion, listAvatar, sendAvatar } from './http-assets.mjs'
import { messageImages, MESSAGE_MAX_BYTES } from './http-messages.mjs'

export function createBotApi({ bots, transport, administration, memory, characterSheets, aiControl, notify, sources, store, messagePage, messenger }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/bots') {
      const all = bots.listForClient ? await bots.listForClient() : [...bots.values()]
      const listingState = id => bots.clientListingState?.(id)
        ?? (bots.isDeleting?.(id) ? 'pending' : bots.has(id) ? 'active' : 'absent')
      const deleting = bot => bot.deleting || listingState(bot.id) === 'pending'
      const [running, views] = await Promise.all([
        transport.runningBots(all.filter(bot => !deleting(bot) && listingState(bot.id) === 'active')),
        store.timelineViews?.(all.map(bot => bot.id)),
      ])
      const list = await Promise.all(all.map(async bot => {
        const last = recentTimeline(await sources('bots', bot.id, views?.get(bot.id)))
        const application = administration.view?.(bot)?.configurationApplication
        const avatars = {}
        for (const field of ['avatarLarge', 'avatarSource', 'avatarLargeSource']) {
          avatars[field] = url.searchParams.get('avatar') === 'omit' ? '' : bot[field] ?? ''
          avatars[`${field}Version`] = avatarVersion(field === 'avatarLarge' ? bot[field] || bot.avatar : bot[field])
        }
        return {
          id: bot.id,
          name: bot.name ?? bot.displayName ?? bot.id,
          displayName: bot.displayName ?? bot.id,
          harness: bot.harness,
          model: bot.model ?? '',
          reasoningEffort: bot.reasoningEffort ?? '',
          fastMode: bot.fastMode === true,
          color: bot.color ?? 'violet',
          profileText: bot.profileText ?? '',
          personality: bot.personality ?? '',
          speechStyle: bot.speechStyle ?? '',
          position: bot.position ?? '',
          role: bot.role ?? '',
          ...listAvatar(bot.avatar, url),
          ...avatars,
          avatarCrop: bot.avatarCrop ?? null,
          avatarLargeCrop: bot.avatarLargeCrop ?? null,
          online: !deleting(bot) && running.has(bot.id),
          ...(deleting(bot) ? { deleting: true } : {}),
          recent: last && { id: last.id, kind: last.kind, direction: last.direction, message: last.message, image: last.image, at: last.at },
          ...(application ? { configurationApplication: application } : {}),
        }
      }))
      // Serialize only the current listing state after all asynchronous timeline reads.
      const current = []
      for (const item of list) {
        const state = listingState(item.id)
        if (state === 'absent') continue
        if (state === 'pending') { item.deleting = true; item.online = false }
        current.push(item)
      }
      return json(response, 200, { bots: current })
    }
    if (request.method === 'POST' && url.pathname === '/api/bots') {
      const bot = await bots.create(await readJson(request))
      await memory?.ensureScope(bot.id, 'personal')
      return json(response, 201, { bot })
    }
    const sheetListMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/character-sheet$/u)
    if (request.method === 'GET' && sheetListMatch) {
      const botId = sheetListMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      const sheets = await characterSheets.list(botId)
      return json(response, 200, { sheets: sheets.map(sheet => ({ ...sheet, url: `/api/bots/${botId}/character-sheet/${encodeURIComponent(sheet.file)}` })) })
    }
    const sheetFileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/character-sheet\/([^/]+)$/u)
    if (request.method === 'GET' && sheetFileMatch) {
      const botId = sheetFileMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      const controller = new AbortController()
      const cancel = () => controller.abort()
      response.once('close', cancel)
      if (response.destroyed) cancel()
      let sheet
      try { sheet = await characterSheets.open(botId, decodeURIComponent(sheetFileMatch[2]), { signal: controller.signal }) }
      catch (error) {
        response.off('close', cancel)
        if (controller.signal.aborted) return
        throw error
      }
      if (controller.signal.aborted) { sheet.stream.destroy(); return }
      response.writeHead(200, {
        'content-type': sheet.mime,
        'content-length': sheet.size,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      })
      // The seat reader must stop when its HTTP consumer disconnects; a read
      // failure after headers aborts this response instead of crashing HTTP.
      sheet.stream.once('error', error => response.destroy(error))
      response.once('close', () => sheet.stream.destroy())
      return sheet.stream.pipe(response)
    }

    const stopMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/stop$/u)
    if (stopMatch) {
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const bot = bots.get(stopMatch[1])
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      try {
        const result = await administration.stop(bot)
        notify({ type: 'bots' })
        return json(response, result.status === 'stop_sent' ? 202 : 200, result)
      } catch {
        return json(response, 502, { error: 'BOT_STOP_UNCONFIRMED', message: '処理の中断を確認できませんでした。会話を確認してください。' })
      }
    }

    const restartMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/restart$/u)
    if (request.method === 'POST' && restartMatch) {
      aiControl?.assertEnabled()
      const botId = restartMatch[1]
      const bot = bots.get(botId)
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      administration.restart(bot)
      return json(response, 202, { restarting: botId })
    }

    const screenMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/screen$/u)
    if (request.method === 'GET' && screenMatch) {
      const bot = bots.get(screenMatch[1])
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, await transport.screen(bot, { history: url.searchParams.get('history') === '1' }))
    }

    const botAvatarMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/(avatar(?:-large)?(?:-source)?)$/u)
    if (request.method === 'GET' && botAvatarMatch) {
      if (!bots.has(botAvatarMatch[1])) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      const bot = bots.get(botAvatarMatch[1])
      const field = { avatar: 'avatar', 'avatar-large': 'avatarLarge', 'avatar-source': 'avatarSource', 'avatar-large-source': 'avatarLargeSource' }[botAvatarMatch[2]]
      return sendAvatar(request, response, field === 'avatarLarge' ? bot[field] || bot.avatar : bot[field], url)
    }
    const profileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/u)
    if (profileMatch) {
      const botId = profileMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, { bot: administration.view?.(bots.get(botId)) ?? bots.get(botId) })
      if (request.method === 'PATCH') return json(response, 200, await administration.update(botId, await readJson(request)))
      if (request.method === 'DELETE') {
        administration.remove(botId)
        return json(response, 202, { deleting: botId })
      }
    }

    const memoryPinMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/([^/]+)\/pin$/u)
    if (request.method === 'POST' && memoryPinMatch) {
      const [, botId, id] = memoryPinMatch
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, await memory.pinMemory({ botId, id, ...await readJson(request) }))
    }

    const memoryItemMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/([^/]+)$/u)
    if (request.method === 'PATCH' && memoryItemMatch) {
      const [, botId, id] = memoryItemMatch
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, await memory.reviseMemory({ botId, id, ...await readJson(request) }))
    }

    const memoryConsolidateMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory\/consolidate-growth$/u)
    if (request.method === 'POST' && memoryConsolidateMatch) {
      const botId = memoryConsolidateMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, await memory.consolidateGrowth({ botId, ...await readJson(request) }))
    }

    const memoryMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/memory$/u)
    if (memoryMatch) {
      const botId = memoryMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, await memory.recallMemory({
        botId, query: url.searchParams.get('query') ?? '', scope: url.searchParams.get('scope') ?? 'personal',
      }))
      if (request.method === 'POST') return json(response, 201, await memory.remember({
        botId, ...await readJson(request), sourceRef: 'ui',
      }))
    }

    const knowledgeMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/knowledge$/u)
    if (knowledgeMatch) {
      const botId = knowledgeMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, await memory.searchKnowledge({
        botId, query: url.searchParams.get('query') ?? '', scope: url.searchParams.get('scope') ?? 'personal',
      }))
      if (request.method === 'POST') return json(response, 201, await memory.recordKnowledge({
        botId, ...await readJson(request),
      }))
    }

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
