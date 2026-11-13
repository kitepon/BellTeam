// Owner HTTP for the running exclusion list (execution current-work.md "Owner read and remove", a62).
import { json } from './http-response.mjs'

export function createRunningExclusionsApi({ runningExclusions, internal }) {
  return async (request, response, url) => {
    const match = /^\/api\/running-exclusions(?:\/([0-9a-f-]{1,64}))?$/u.exec(url.pathname)
    if (!match) return false
    if (internal) return json(response, 403, { error: 'RUNNING_EXCLUSIONS_OWNER_REQUIRED' })
    const store = runningExclusions()
    if (!store) return json(response, 503, { error: 'RUNNING_EXCLUSIONS_UNAVAILABLE' })
    const [, id] = match
    if (!id && request.method === 'GET') return json(response, 200, await store.list())
    if (id && request.method === 'DELETE') return json(response, 200, await store.remove(id))
    return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
  }
}
