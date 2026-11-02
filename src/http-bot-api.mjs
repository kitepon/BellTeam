import { json, readJson } from './http-response.mjs'
import { createMemberProfileApi } from './members/profiles-http.mjs'
import { createBotConversationApi } from './http-conversation-api.mjs'

export function createBotApi(options) {
  const { bots, transport, administration, memory, aiControl, notify, messagePage, messenger } = options
  const profiles = createMemberProfileApi(options)
  const conversation = createBotConversationApi({ bots, transport, messagePage, messenger })
  return async (request, response, url) => {
    const handled = await profiles(request, response, url)
    if (handled !== false) return handled
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

    return conversation(request, response, url)
  }
}
