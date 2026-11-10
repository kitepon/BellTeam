import { automaticConfigurationApplication, validConfigurationOperationId } from './automatic-configuration-application.mjs'
import { configurationUUID } from './configuration-request.mjs'
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
    const operationMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/configuration-operations\/([^/]+)$/u)
    if (operationMatch) {
      if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const [, botId, requestId] = operationMatch
      const bot = bots.readMember ? await bots.readMember(botId) : bots.get(botId)
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      if (!validConfigurationOperationId(requestId) || url.search || Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])
        return json(response, 400, { error: 'CONFIGURATION_OPERATION_ID_INVALID' })
      try {
        const result = await administration.readConfigurationOperation(botId, requestId)
        return json(response, 200, automaticConfigurationApplication(result, requestId))
      } catch (error) {
        const statuses = { BOT_NOT_FOUND: 404, CONFIGURATION_OPERATION_ID_INVALID: 400, CONFIGURATION_OPERATION_NOT_RECORDED: 404, CONFIGURATION_OPERATION_READ_UNAVAILABLE: 503 }
        const returnedCode = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value
        const code = Object.hasOwn(statuses, returnedCode) ? returnedCode : 'CONFIGURATION_OPERATION_READ_UNAVAILABLE'
        return json(response, statuses[code], { error: code })
      }
    }

    const reconcileMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/configuration\/reconcile$/u)
    if (reconcileMatch) {
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request)
      if (!body || Object.keys(body).join(',') !== 'request_id' || !configurationUUID(body.request_id))
        return json(response, 400, { error: 'CONFIGURATION_REQUEST_INVALID' })
      const result = await administration.reconcile(reconcileMatch[1], body.request_id)
      notify({ type: 'bots' })
      return json(response, 200, result)
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
      } catch (error) {
        let automatic = null
        try { automatic = automaticConfigurationApplication(Object.getOwnPropertyDescriptor(error, 'automaticConfigurationApplication')?.value) } catch {}
        return json(response, 502, { error: 'BOT_STOP_UNCONFIRMED', message: '処理の中断を確認できませんでした。会話を確認してください。',
          ...(automatic ? { automaticConfigurationApplication: automatic } : {}) })
      }
    }

    const restartMatch = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/restart$/u)
    if (request.method === 'POST' && restartMatch) {
      aiControl?.assertEnabled()
      const botId = restartMatch[1]
      const bot = bots.get(botId)
      if (!bot) return json(response, 404, { error: 'BOT_NOT_FOUND' })
      try {
        const result = await administration.restart(bot)
        return json(response, 200, { restarted: botId, ...(typeof result?.session === 'string' ? { session: result.session } : {}) })
      } catch (error) {
        return json(response, error.status ?? 502, { error: 'BOT_RESTART_FAILED', message: error.publicMessage ?? '会話を再起動できませんでした。' })
      }
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
