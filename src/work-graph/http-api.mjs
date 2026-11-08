import { json } from '../http-response.mjs'
import { createWorkGraphHub } from './hub.mjs'

export function createWorkGraphApi(options) {
  let hub = null
  return async (request, response, url) => {
    if (url.pathname !== '/api/work-graph' && url.pathname !== '/api/work-graph/events') return false
    if (options.internal) return json(response, 403, { error: 'WORK_GRAPH_OWNER_REQUIRED' })
    if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    hub ??= createWorkGraphHub(options)
    if (url.pathname === '/api/work-graph') return json(response, 200, await hub.snapshot())
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
    const frame = (event, data, id) => response.write(`event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    const batch = data => frame('change', data, `${data.epoch}:${data.version}`)
    // Batches arriving while the snapshot is read are held, then sent if newer than it.
    let held = []
    const unsubscribe = hub.subscribe(data => held ? held.push(data) : batch(data))
    const heartbeat = setInterval(() => response.write(': hb\n\n'), options.heartbeatMs ?? 15000)
    request.on('close', () => { clearInterval(heartbeat); unsubscribe() })
    try {
      const snapshot = await hub.snapshot()
      frame('snapshot', snapshot)
      for (const data of held) if (data.version > snapshot.version) batch(data)
      held = null
    } catch (error) {
      clearInterval(heartbeat); unsubscribe(); response.end(); throw error
    }
  }
}
