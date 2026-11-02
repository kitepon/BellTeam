import { createConversationAssetsApi } from './http-conversation-api.mjs'
import { json, readJson } from './http-response.mjs'
import { listAvatar, sendAvatar } from './http-assets.mjs'
import { createUsageApi } from './usage/http-api.mjs'

export function createControlApi(options) {
  const { aiControl, diagnostics, models } = options
  const usageApi = createUsageApi(options)
  return async (request, response, url) => {
    if (url.pathname === '/api/ai-control') {
      if (!aiControl) return json(response, 404, { error: 'NOT_FOUND' })
      if (request.method === 'GET') return json(response, 200, { control: aiControl.snapshot() })
      if (request.method !== 'PATCH') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, 8192)
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.paused !== 'boolean')
        return json(response, 400, { error: 'AI_CONTROL_INVALID' })
      const result = await aiControl.update(body.paused)
      return json(response, result.status, { control: result.control, ...(result.error ? { error: result.error } : {}) })
    }
    if (await usageApi(request, response, url) !== false) return
    if (request.method === 'POST' && url.pathname === '/api/diagnostics') {
      if (!diagnostics) return json(response, 404, { error: 'NOT_FOUND' })
      const report = await readJson(request, 65536)
      if (typeof report?.code !== 'string' || !report.code.startsWith('IOS_')) return json(response, 400, { error: 'DIAGNOSTIC_INVALID' })
      await diagnostics.record(report)
      return json(response, 202, { accepted: true })
    }
    if (request.method === 'GET' && url.pathname === '/api/models')
      return json(response, 200, { models: await models.list(url.searchParams.get('harness') || undefined) })
    return false
  }
}

export function createApplicationApi({ ownerProfile, refreshGlobalInstructions, userRules, events, assets }) {
  const conversation = createConversationAssetsApi({ events, assets })
  return async (request, response, url) => {
    if (request.method === 'GET' && url.pathname === '/api/owner') {
      const owner = await ownerProfile.get()
      return json(response, 200, { owner: { ...owner, ...listAvatar(owner.avatar, url) } })
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/avatar') return sendAvatar(request, response, (await ownerProfile.get()).avatar, url)
    if (request.method === 'PATCH' && url.pathname === '/api/owner') {
      const owner = await ownerProfile.update(await readJson(request))
      await refreshGlobalInstructions()
      return json(response, 200, { owner })
    }
    if (request.method === 'GET' && url.pathname === '/api/user-rules') return json(response, 200, { text: await userRules.get() })
    if (request.method === 'PUT' && url.pathname === '/api/user-rules') {
      const text = await userRules.update((await readJson(request)).text)
      await refreshGlobalInstructions()
      return json(response, 200, { text })
    }
    return conversation(request, response, url)
  }
}
