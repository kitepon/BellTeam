import { json, readJson } from '../http-response.mjs'
import { LATTICE_PROJECT_ID, LATTICE_STOP_ID } from '../lattice-protocol.mjs'

// The body keeps only this thin handler; the facade owns the child, the subscribers and the refresh timer.
export function createLatticeApi({ facade, internal, heartbeatMs = 15000 }) {
  const failed = (response, error) => {
    const known = { LATTICE_UNAVAILABLE: 503, LATTICE_CHART_NOT_FOUND: 404 }[error?.code]
    if (!known) throw error
    return json(response, known, { error: error.code })
  }
  // The stops routes send only valid params, so LATTICE_INVALID from the child means a child older than them (README Stops).
  const stopsFailed = (response, error) => failed(response, error?.code === 'LATTICE_INVALID' ? { code: 'LATTICE_UNAVAILABLE' } : error)
  return async (request, response, url) => {
    if (url.pathname === '/api/lattice/blockers') {
      if (internal) return json(response, 403, { error: 'LATTICE_OWNER_REQUIRED' })
      if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      try { return json(response, 200, await facade.blockers()) } catch (error) { return stopsFailed(response, error) }
    }
    const unblock = /^\/api\/lattice\/charts\/([^/]+)\/unblock$/u.exec(url.pathname)
    if (unblock) {
      if (internal) return json(response, 403, { error: 'LATTICE_OWNER_REQUIRED' })
      if (request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      // A cross-site form cannot send JSON.
      if (!/^application\/json\s*(;|$)/iu.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: 'LATTICE_JSON_REQUIRED' })
      if (!LATTICE_PROJECT_ID.test(unblock[1])) return json(response, 400, { error: 'LATTICE_PROJECT_INVALID' })
      const body = await readJson(request, 1024).catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'stopId' || typeof body.stopId !== 'string' || !LATTICE_STOP_ID.test(body.stopId))
        return json(response, 400, { error: 'LATTICE_INVALID' })
      let value
      try { value = await facade.unblock({ projectId: unblock[1], stopId: body.stopId }) } catch (error) { return stopsFailed(response, error) }
      if (value.outcome !== 'refused') return json(response, 200, value)
      return json(response, 409, { error: 'LATTICE_UNBLOCK_REFUSED', outcome: 'refused', code: value.code, reason: value.reason })
    }
    const match = /^\/api\/lattice\/charts(?:\/([^/]+?)(\/events)?)?$/u.exec(url.pathname)
    if (!match) return false
    if (internal) return json(response, 403, { error: 'LATTICE_OWNER_REQUIRED' })
    if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    const [, id, events] = match
    if (id !== undefined && !LATTICE_PROJECT_ID.test(id)) return json(response, 404, { error: 'LATTICE_CHART_NOT_FOUND' })
    if (!events) {
      try { return json(response, 200, await (id === undefined ? facade.charts() : facade.chart(id))) } catch (error) { return failed(response, error) }
    }
    // Snapshots pushed while the first one is read are held, then sent if newer than it.
    let held = [], last = null, heartbeat, closed = false
    const push = snapshot => {
      if (last && snapshot.epoch === last.epoch && snapshot.version <= last.version) return
      last = snapshot
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    }
    const unsubscribe = facade.subscribe(id, snapshot => held ? held.push(snapshot) : push(snapshot))
    const cleanup = () => { closed = true; clearInterval(heartbeat); unsubscribe() }
    request.on('close', cleanup)
    let first
    try { first = await facade.chart(id) } catch (error) { cleanup(); return failed(response, error) }
    if (closed) return
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
    push(first)
    for (const snapshot of held) push(snapshot)
    held = null
    heartbeat = setInterval(() => response.write(': hb\n\n'), heartbeatMs)
  }
}
