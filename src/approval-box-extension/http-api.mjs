// Approval Box extension: the body-resident thin handler for /api/approvals/* (contract/approvals-contract.md). Shape of lattice/http-api.mjs:
// Owner only (internal server 403). After the /v1 content close (a490h2) it serves only connection, connect, by-task and by-decision; the list, one, answer, hold, attachment, summary and events routes are gone (404).
import { json } from '../http-response.mjs'
import { APPROVALS_DECISION_ID } from '../approval-box-extension-protocol.mjs'

const MESSAGES = {
  not_entitled: '決裁箱の拡張は、まだ使えません。', not_connected: '決裁箱につながっていません。', subscription_expired: '決裁箱の契約が切れています。',
  not_found: '見つかりません。', rate_limited: 'しばらく待って、もう一度お試しください。', validation_failed: '内容を確かめてください。', unavailable: 'いまは決裁箱を読めません。',
  conflict: '答える前に、内容が直されました。',
}
const FAILS = { APPROVALS_NOT_ENTITLED: [403, 'not_entitled'], APPROVALS_NOT_CONNECTED: [409, 'not_connected'], APPROVALS_SUBSCRIPTION_EXPIRED: [402, 'subscription_expired'],
  APPROVALS_NOT_FOUND: [404, 'not_found'], APPROVALS_RATE_LIMITED: [429, 'rate_limited'], APPROVALS_VALIDATION_FAILED: [400, 'validation_failed'] }

export function createApprovalsApi({ facade, internal }) {
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
    const [, first, second] = match
    const method = request.method
    const wrongMethod = () => json(response, 405, { error: { code: 'method_not_allowed', message: 'この操作はできません。' } })
    const run = async action => { try { return json(response, 200, await action()) } catch (caught) { return failed(response, caught) } }

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
    return error(response, 404, 'not_found')
  }
}
