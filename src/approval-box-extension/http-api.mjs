// Approval Box extension: the body-resident thin handler for /api/approvals/* (contract/approvals-contract.md). Shape of lattice/http-api.mjs:
// Owner only (internal server 403), JSON writes only, SSE framing and heartbeat. The facade (Molly) owns the child, the engine loop and the subscribers.
import { json, readJson } from '../http-response.mjs'
import { APPROVALS_DECISION_ID } from '../approval-box-extension-protocol.mjs'

const MESSAGES = {
  not_entitled: '決裁箱の拡張は、まだ使えません。', not_connected: '決裁箱につながっていません。', subscription_expired: '決裁箱の契約が切れています。',
  not_found: '見つかりません。', rate_limited: 'しばらく待って、もう一度お試しください。', validation_failed: '内容を確かめてください。', unavailable: 'いまは決裁箱を読めません。',
  conflict: '答える前に、内容が直されました。', answer_on_device: 'この決裁は、決裁箱のアプリで答えてください。',
}
const FAILS = { APPROVALS_NOT_ENTITLED: [403, 'not_entitled'], APPROVALS_NOT_CONNECTED: [409, 'not_connected'], APPROVALS_SUBSCRIPTION_EXPIRED: [402, 'subscription_expired'],
  APPROVALS_NOT_FOUND: [404, 'not_found'], APPROVALS_RATE_LIMITED: [429, 'rate_limited'], APPROVALS_VALIDATION_FAILED: [400, 'validation_failed'], APPROVALS_ANSWER_ON_DEVICE: [409, 'answer_on_device'] }
const IDEMPOTENCY = /^[A-Za-z0-9-]{8,64}$/u

export function createApprovalsApi({ facade, internal, heartbeatMs = 15000 }) {
  const error = (response, status, code, extra = {}) => json(response, status, { error: { code, message: MESSAGES[code] ?? code, ...extra } })
  // not_entitled carries the plan state so an app picks view 1 (none) or view 2 (expired / revoked).
  const failed = async (response, caught) => {
    const known = FAILS[caught?.code]
    if (!known) return error(response, 503, 'unavailable')
    const extra = known[1] === 'not_entitled' ? await facade.connection().then(value => ({ state: value.entitlement.state, ...(value.entitlement.validUntil ? { validUntil: value.entitlement.validUntil } : {}) }), () => ({})) : {}
    return error(response, known[0], known[1], extra)
  }
  return async (request, response, url) => {
    const match = /^\/api\/approvals(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/u.exec(url.pathname)
    if (!match) return false
    if (internal) return json(response, 403, { error: { code: 'owner_required', message: 'Ownerだけが使えます。' } })
    const [, first, second, third] = match
    const method = request.method
    const wrongMethod = () => json(response, 405, { error: { code: 'method_not_allowed', message: 'この操作はできません。' } })
    const run = async action => { try { return json(response, 200, await action()) } catch (caught) { return failed(response, caught) } }
    const jsonBody = async max => {
      if (!/^application\/json\s*(;|$)/iu.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: { code: 'json_required', message: 'JSONで送ってください。' } }) && null
      const body = await readJson(request, max).catch(() => null)
      return body && typeof body === 'object' && !Array.isArray(body) ? body : (json(response, 400, { error: { code: 'validation_failed', message: MESSAGES.validation_failed } }), null)
    }

    if (first === undefined) { // list
      if (method !== 'GET') return wrongMethod()
      const status = (url.searchParams.get('status') ?? 'pending,held').split(',').filter(Boolean), origin = url.searchParams.get('origin')
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined, cursor = url.searchParams.get('cursor') ?? undefined
      if (!status.every(item => ['pending', 'held', 'answered', 'cancelled'].includes(item)) || origin && !['bellteam', 'external'].includes(origin)
        || limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) return error(response, 400, 'validation_failed')
      return run(() => facade.list({ status, ...(origin ? { origin } : {}), ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) }))
    }
    if (first === 'summary' && !second) return method === 'GET' ? run(() => facade.summary()) : wrongMethod()
    if (first === 'connection' && !second) {
      if (method === 'GET') return run(() => facade.connection())
      return method === 'DELETE' ? run(() => facade.disconnect()) : wrongMethod()
    }
    if (first === 'connect' && !second) {
      if (method === 'POST') return run(() => facade.connect())
      return method === 'DELETE' ? run(() => facade.cancelConnect()) : wrongMethod()
    }
    if (first === 'by-task' && !second) {
      if (method !== 'GET') return wrongMethod()
      const project = url.searchParams.get('project'), plan = url.searchParams.get('plan'), task = url.searchParams.get('task')
      if (!project || !plan || !task) return error(response, 400, 'validation_failed')
      const found = await facade.byTask({ project, plan, task }).catch(() => null)
      return found ? json(response, 200, found) : error(response, 404, 'not_found')
    }
    if (first === 'by-decision' && !second) { // ids and state only (peer-channel-feed.md section 5)
      if (method !== 'GET') return wrongMethod()
      const id = url.searchParams.get('id')
      if (!id || !APPROVALS_DECISION_ID.test(id)) return error(response, 400, 'validation_failed')
      const found = await facade.byDecision({ id }).catch(() => null)
      return found ? json(response, 200, found) : error(response, 404, 'not_found')
    }
    if (first === 'events' && !second) {
      if (method !== 'GET') return wrongMethod()
      if (request.destroyed || response.destroyed) return
      let closed = false, heartbeat
      const unsubscribe = facade.subscribe(({ event, data }) => { if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) })
      const cleanup = () => { closed = true; clearInterval(heartbeat); unsubscribe() }
      request.on('close', cleanup)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
      response.write(': open\n\n')
      heartbeat = setInterval(() => response.write(': hb\n\n'), heartbeatMs)
      return
    }
    if (!APPROVALS_DECISION_ID.test(first)) return error(response, 404, 'not_found')
    if (!second) return method === 'GET' ? run(() => facade.get({ id: first })) : wrongMethod()
    if (second === 'hold' || second === 'unhold') return method === 'POST' ? run(() => facade[second]({ id: first })) : wrongMethod()
    if (second === 'attachments' && third) {
      if (method !== 'GET') return wrongMethod()
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(third)) return error(response, 404, 'not_found')
      let file
      try { file = await facade.attachment({ id: first, aid: third }) } catch (caught) { return failed(response, caught) }
      response.writeHead(200, { 'content-type': file.contentType, 'content-length': file.size, ...(file.etag ? { etag: file.etag } : {}), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'content-disposition': /^image\/(png|jpeg|gif|webp)$/iu.test(file.contentType) ? 'inline' : 'attachment' }) // the AI that attached it may not be ours: a direct open of html/svg must not run script on this origin
      return response.end(Buffer.from(file.data, 'base64'))
    }
    if (second === 'answer') {
      if (method !== 'POST') return wrongMethod()
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string' || !IDEMPOTENCY.test(key)) return error(response, 400, 'validation_failed')
      const body = await jsonBody(64 * 1024)
      if (!body) return
      const { optionId, text, version, ...rest } = body
      if (Object.keys(rest).length || !Number.isInteger(version) || version < 1 || (optionId === undefined) === (text === undefined)
        || optionId !== undefined && typeof optionId !== 'string' || text !== undefined && (typeof text !== 'string' || !text || text.length > 20000)) return error(response, 400, 'validation_failed')
      let result
      try { result = await facade.answer({ id: first, ...(optionId === undefined ? { text } : { optionId }), version, idempotencyKey: key }) } catch (caught) { return failed(response, caught) }
      return result.outcome === 'conflict' ? error(response, 409, 'conflict', { decision: result.decision }) : json(response, 200, result.decision)
    }
    return error(response, 404, 'not_found')
  }
}
