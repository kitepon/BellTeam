import { createConversationAssetsApi } from './http-conversation-api.mjs'
import { json, readJson } from './http-response.mjs'
import { createOwnerApi } from './members/owner-http.mjs'
import { createUsageApi } from './usage/http-api.mjs'

function reserveRelease(updateCenter, controller, versionId) {
  const release = updateCenter?.reserveExchange?.()
  try {
    const pending = controller.reserve(versionId)
    if (release) {
      if (!pending.completion) { pending.cancel(); throw Object.assign(new Error('UPDATE_COMPLETION_UNAVAILABLE'), { code: 'UPDATE_COMPLETION_UNAVAILABLE', status: 503 }) }
      pending.completion.then(release, release)
    }
    return pending
  } catch (error) { release?.(); throw error }
}

export function createControlApi(options) {
  const { aiControl, diagnostics, models, internal, webGatewayControl, notificationsReleaseControl, updateCenter, captureInstallInspectionOwner } = options
  const usageApi = createUsageApi(options)
  return async (request, response, url) => {
    if (url.pathname === '/api/updates' || url.pathname.startsWith('/api/updates/')) {
      if (internal) return json(response, 403, { error: 'UPDATE_OWNER_REQUIRED' })
      if (!updateCenter) return json(response, 503, { error: 'UPDATE_EXECUTOR_UNAVAILABLE' })
      const reconciliation = url.pathname.match(/^\/api\/updates\/operations\/([^/]+)\/reconciliation\/([^/]+)$/u)
      if (reconciliation) {
        if (url.search || request.method === 'GET' && (request.headers['transfer-encoding']
          || Number(request.headers['content-length'] ?? 0) !== 0)) return json(response, 400, { error: 'UPDATE_RECONCILIATION_INPUT_INVALID' })
        if (request.method === 'GET') return json(response, 200, {
          reconciliation: await updateCenter.installReconciliation(reconciliation[1], reconciliation[2]),
        })
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        if (!captureInstallInspectionOwner) return json(response, 503, { error: 'UPDATE_RECONCILIATION_UNAVAILABLE' })
        return json(response, 200, { reconciliation: await updateCenter.inspectModuleInstall(
          reconciliation[1], reconciliation[2], await readJson(request, 4096), captureInstallInspectionOwner(request),
        ) })
      }
      if (url.pathname === '/api/updates') {
        if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return json(response, 200, await updateCenter.snapshot())
      }
      if (url.pathname === '/api/updates/plans') {
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return json(response, 200, { plan: await updateCenter.plan(await readJson(request, 4096)) })
      }
      if (url.pathname === '/api/updates/operations') {
        if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return json(response, 202, { operation: await updateCenter.start(await readJson(request, 4096)) })
      }
      const operationMatch = url.pathname.match(/^\/api\/updates\/operations\/([^/]+)$/u)
      if (operationMatch) {
        if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return json(response, 200, { operation: await updateCenter.operation(operationMatch[1]) })
      }
      return json(response, 404, { error: 'NOT_FOUND' })
    }
    if (url.pathname === '/api/notifications-release') {
      if (internal) return json(response, 403, { error: 'NOTIFICATIONS_OWNER_REQUIRED' })
      if (!notificationsReleaseControl) return json(response, 503, { error: 'NOTIFICATIONS_UNAVAILABLE' })
      if (request.method === 'GET') return json(response, 200, { notificationsRelease: notificationsReleaseControl.snapshot() })
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      const body = await readJson(request, 1024)
      if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'versionId'
        || typeof body.versionId !== 'string' || body.versionId !== 'builtin' && !/^[a-f0-9]{64}$/.test(body.versionId))
        return json(response, 400, { error: 'NOTIFICATIONS_VERSION_INVALID' })
      const pending = reserveRelease(updateCenter, notificationsReleaseControl, body.versionId)
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
      const pending = reserveRelease(updateCenter, webGatewayControl, body.versionId)
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
  return async (request, response, url, context) => {
    const handled = await owner(request, response, url, context)
    if (handled !== false) return handled
    return conversation(request, response, url)
  }
}
