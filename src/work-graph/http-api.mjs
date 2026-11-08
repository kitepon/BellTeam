import { json } from '../http-response.mjs'

// The body keeps only this thin handler; the facade owns the child, the subscribers and the refresh timer.
export function createWorkGraphApi({ facade, internal, heartbeatMs = 15000 }) {
  const unavailable = error => error?.code === 'WORK_GRAPH_UNAVAILABLE'
  return async (request, response, url) => {
    if (url.pathname !== '/api/work-graph' && url.pathname !== '/api/work-graph/events') return false
    if (internal) return json(response, 403, { error: 'WORK_GRAPH_OWNER_REQUIRED' })
    if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    if (url.pathname === '/api/work-graph') {
      try { return json(response, 200, await facade.snapshot()) }
      catch (error) { if (unavailable(error)) return json(response, 503, { error: 'WORK_GRAPH_UNAVAILABLE' }); throw error }
    }
    const frame = (event, data, id) => response.write(`event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    const batch = data => frame('change', data, `${data.epoch}:${data.version}`)
    // Batches arriving while the snapshot is read are held, then sent if newer than it.
    let held = [], heartbeat, closed = false
    const unsubscribe = facade.subscribe(data => held ? held.push(data) : batch(data))
    const cleanup = () => { closed = true; clearInterval(heartbeat); unsubscribe() }
    request.on('close', cleanup)
    let snapshot
    try { snapshot = await facade.snapshot() }
    catch (error) {
      cleanup()
      if (unavailable(error)) return json(response, 503, { error: 'WORK_GRAPH_UNAVAILABLE' })
      throw error
    }
    if (closed) return
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
    frame('snapshot', snapshot)
    for (const data of held) if (data.version > snapshot.version) batch(data)
    held = null
    heartbeat = setInterval(() => response.write(': hb\n\n'), heartbeatMs)
  }
}
