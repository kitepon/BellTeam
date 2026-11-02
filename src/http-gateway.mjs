import { createServer, request as httpRequest } from 'node:http'
import { staticFile } from './http-assets.mjs'
import { json, readJson } from './http-response.mjs'
import { KEEP_ALIVE_TIMEOUT_MS } from './http-server.mjs'
import { respondHttpError } from './http-errors.mjs'

function endToEndHeaders(headers) {
  const omitted = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !omitted.has(name)))
}

// Only the business process authenticates requests and owns accepted work.
export function createHttpGateway({ socketPath, staticRoot, assetVersion = Date.now().toString(36), assetVersions = new Map() }) {
  const streams = new Set()
  let closing = null, stopping = false
  const server = createServer(async (request, response) => {
    let connected = false
    const unavailable = () => {
      if (response.destroyed) return
      if (response.headersSent) return response.destroy()
      json(response, connected ? 502 : 503, { error: connected ? 'GATEWAY_RESPONSE_UNKNOWN' : 'GATEWAY_UPSTREAM_UNAVAILABLE' })
    }
    let url
    try { url = new URL(request.url, 'http://bellteam.local') }
    catch (error) { return respondHttpError(request, response, error) }
    const { pathname } = url
    const staticRequest = pathname !== '/healthz' && !pathname.startsWith('/api/')
    const upstream = httpRequest({ socketPath, method: staticRequest ? 'GET' : request.method,
      path: staticRequest ? '/api/session' : request.url,
      headers: endToEndHeaders(staticRequest
        ? Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['content-length', 'content-type'].includes(name)))
        : request.headers),
    }, async incoming => {
      incoming.on('error', unavailable)
      if (staticRequest) {
        try {
          const session = await readJson(incoming, 4096)
          if (incoming.statusCode !== 200 || typeof session.authenticated !== 'boolean') return unavailable()
          if (!session.authenticated) return json(response, 401, { error: 'UNAUTHORIZED' })
          if (request.method !== 'GET') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
          const requestedVersion = url.searchParams.get('v') ?? assetVersion
          const previous = assetVersions.get(requestedVersion)
          if (requestedVersion !== assetVersion && !previous) return json(response, 404, { error: 'NOT_FOUND' })
          await staticFile(response, previous?.root ?? staticRoot, pathname, requestedVersion, previous)
        } catch { unavailable() }
        return
      }
      response.writeHead(incoming.statusCode, endToEndHeaders(incoming.headers))
      if (incoming.headers['content-type']?.startsWith('text/event-stream')) {
        if (stopping) return response.destroy()
        streams.add(response)
        response.once('close', () => streams.delete(response))
      }
      incoming.pipe(response)
    })
    upstream.once('socket', socket => {
      if (socket.connecting) socket.once('connect', () => { connected = true })
      else connected = true
    })
    upstream.once('error', unavailable)
    response.once('close', () => upstream.destroy())
    request.once('aborted', () => upstream.destroy())
    if (staticRequest) { request.resume(); upstream.end() }
    else request.pipe(upstream)
  })
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  const close = () => {
    closing ??= new Promise((resolve, reject) => {
      stopping = true
      // A broken SSE stream invokes the existing client reconnect path; EOF does not.
      for (const response of streams) response.destroy()
      const reap = setInterval(() => server.closeIdleConnections(), 50)
      server.once('close', () => clearInterval(reap))
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
      server.closeIdleConnections()
    })
    return closing
  }
  return { server, close }
}
