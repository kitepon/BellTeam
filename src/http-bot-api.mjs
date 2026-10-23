import { json, readJson } from './http-response.mjs'
import { recentTimeline } from './timeline-index.mjs'
import { listAvatar, sendAvatar } from './http-assets.mjs'
import { stopFailureReport } from './stop-failure-report.mjs'
import { messageImages, MESSAGE_MAX_BYTES } from './http-messages.mjs'

export function createBotApi({ bots, rooms, transport, memory, characterSheets, aiControl, notify, writeLog, sources, store, messagePage, messenger }) {
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/bots') {
      const all = [...bots.values()]
      const [running, views] = await Promise.all([
        transport.runningBots(all), store.timelineViews?.(all.map(bot => bot.id)),
      ])
      const list = await Promise.all(all.map(async bot => {
        const last = recentTimeline(await sources('bots', bot.id, views?.get(bot.id)))
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
          online: running.has(bot.id),
          recent: last && { id: last.id, kind: last.kind, direction: last.direction, message: last.message, image: last.image, at: last.at },
        }
      }))
      return json(response, 200, { bots: list })
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
      const sheet = await characterSheets.open(botId, decodeURIComponent(sheetFileMatch[2]))
      response.writeHead(200, {
        'content-type': sheet.mime,
        'content-length': sheet.size,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      })
      return sheet.stream.pipe(response)
    }

    const stopMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/stop$/u)
    if (stopMatch) {
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const bot = bots.get(stopMatch[1])
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      try {
        const result = await transport.interrupt(bot)
        if (result?.botId !== bot.id || !(result.status === 'stop_sent' || result.status === 'interrupted' && result.sessionPreserved === true))
          throw new Error('BOT_STOP_UNCONFIRMED')
        notify({ type: 'bots' })
        return json(response, result.status === 'stop_sent' ? 202 : 200, result)
      } catch (error) {
        try { writeLog(`BellTeam stop failure: ${JSON.stringify(stopFailureReport(bot.id, error))}\n`) }
        catch { /* Reporting must not change the stop response or retry it. */ }
        return json(response, 502, { error: 'BOT_STOP_UNCONFIRMED', message: '処理の中断を確認できませんでした。会話を確認してください。' })
      }
    }

    const restartMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/restart$/u)
    if (request.method === 'POST' && restartMatch) {
      aiControl?.assertEnabled()
      const botId = restartMatch[1]
      const bot = bots.get(botId)
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      transport.restart(bot).catch(error => process.stderr.write(`BellTeam restart error: ${error.stack ?? error.message}\n`))
      return json(response, 202, { restarting: botId })
    }

    const screenMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/screen$/u)
    if (request.method === 'GET' && screenMatch) {
      const bot = bots.get(screenMatch[1])
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return json(response, 200, await transport.screen(bot))
    }

    const botAvatarMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/avatar$/u)
    if (request.method === 'GET' && botAvatarMatch) {
      if (!bots.has(botAvatarMatch[1])) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      return sendAvatar(request, response, bots.get(botAvatarMatch[1]).avatar, url)
    }
    const profileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/u)
    if (profileMatch) {
      const botId = profileMatch[1]
      if (!bots.has(botId)) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, { bot: bots.get(botId) })
      if (request.method === 'PATCH') {
        const current = bots.get(botId)
        const changes = await readJson(request)
        const candidate = await bots.previewUpdate(botId, changes)
        const harnessChanged = candidate.harness !== current.harness
        const fastModeChanged = candidate.fastMode !== current.fastMode
        const configurationChanged = harnessChanged || candidate.model !== current.model
          || candidate.reasoningEffort !== current.reasoningEffort || fastModeChanged
        const wasRunning = configurationChanged ? await transport.isRunning(current) : false
        // 稼働中Botへの適用は現在の作業の後に並ぶ。保存の応答はそれを待たずに返す。
        if (wasRunning) {
          transport.reconfigure(current, candidate)
            .catch(async error => {
              process.stderr.write(`BellTeam reconfigure error: ${error.stack ?? error.message}\n`)
              // ファストモードを当てられなかった時は、保存した値を元へ戻す。記録が「有効」のまま、実際は通常の速度、という食い違いを残さない。
              if (fastModeChanged && bots.get(botId)?.fastMode === candidate.fastMode) await bots.update(botId, { fastMode: current.fastMode })
            })
            .catch(error => process.stderr.write(`BellTeam fast mode restore error: ${error.stack ?? error.message}\n`))
        }
        const bot = await bots.update(botId, changes)
        return json(response, 200, { bot, harnessChanged, configurationChanged, applying: wasRunning })
      }
      if (request.method === 'DELETE') {
        const bot = bots.get(botId)
        void (async () => {
          await transport.stop(bot)
          await rooms.removeBot(botId)
          await bots.remove(botId)
        })().catch(error => process.stderr.write(`BellTeam delete error: ${error.stack ?? error.message}\n`))
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
