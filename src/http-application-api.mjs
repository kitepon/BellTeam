import { createConversationAssetsApi } from './http-conversation-api.mjs'
import { json, readJson } from './http-response.mjs'
import { createOwnerApi } from './members/owner-http.mjs'
import { createUsageApi } from './usage/http-api.mjs'

export function createControlApi(options) {
  const { aiControl, diagnostics, models, internal, webGatewayControl, notificationsReleaseControl } = options
  const usageApi = createUsageApi(options)
  return async (request, response, url) => {
    if (url.pathname === '/api/notifications-release') {
      if (internal) return json(response, 403, { error: 'NOTIFICATIONS_OWNER_REQUIRED' })
      if (!notificationsReleaseControl) return json(response, 503, { error: 'NOTIFICATIONS_UNAVAILABLE' })
      if (request.method === 'GET') return json(response, 200, { notificationsRelease: notificationsReleaseControl.snapshot() })
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, 1024)
      if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'versionId'
        || typeof body.versionId !== 'string' || body.versionId !== 'builtin' && !/^[a-f0-9]{64}$/.test(body.versionId))
        return json(response, 400, { error: 'NOTIFICATIONS_VERSION_INVALID' })
      const pending = notificationsReleaseControl.reserve(body.versionId)
      response.once('finish', pending.start)
      response.once('close', () => { if (!response.writableFinished) pending.cancel() })
      return json(response, 202, { notificationsRelease: notificationsReleaseControl.snapshot() })
    }
    if (url.pathname === '/api/web-gateway-release') {
      if (internal) return json(response, 403, { error: 'WEB_GATEWAY_OWNER_REQUIRED' })
      if (!webGatewayControl) return json(response, 503, { error: 'WEB_GATEWAY_UNAVAILABLE' })
      if (request.method === 'GET') return json(response, 200, { webGatewayRelease: webGatewayControl.snapshot() })
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, 1024)
      if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'versionId')
        return json(response, 400, { error: 'WEB_GATEWAY_VERSION_INVALID' })
      const pending = webGatewayControl.reserve(body.versionId)
      response.once('finish', pending.start)
      response.once('close', () => { if (!response.writableFinished) pending.cancel() })
      return json(response, 202, { webGatewayRelease: webGatewayControl.snapshot() })
    }
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
  const owner = createOwnerApi({ ownerProfile, refreshGlobalInstructions, userRules })
  return async (request, response, url) => {
    const handled = await owner(request, response, url)
    if (handled !== false) return handled
    return conversation(request, response, url)
  }
}
