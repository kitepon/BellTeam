import { createServer, request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { json } from './http-response.mjs'
import { KEEP_ALIVE_TIMEOUT_MS } from './http-server.mjs'
import { respondHttpError } from './http-errors.mjs'

function endToEndHeaders(headers) {
  const omitted = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !omitted.has(name)))
}

// SEC-049: name the TCP peer to the business process, which decides the Owner. A socket of this container (listed in this
// network namespace's /proc/net/tcp; the listener is IPv4 only) also names its user. Client-sent copies of both headers are dropped.
const PEER_HEADERS = ['x-bellteam-peer', 'x-bellteam-peer-uid']
const procEntry = (address, port) => `${address.split('.').reverse().map(part => Number(part).toString(16).padStart(2, '0')).join('')}:${port.toString(16).padStart(4, '0')}`.toUpperCase()
export async function socketPeer(socket, readTable = () => readFile('/proc/net/tcp', 'utf8')) {
  const peer = { 'x-bellteam-peer': socket.remoteAddress ?? '' }
  let table
  try { table = await readTable() } catch { return { ...peer, 'x-bellteam-peer-uid': 'unknown' } }
  const local = procEntry(socket.remoteAddress ?? '', socket.remotePort ?? 0), remote = procEntry(socket.localAddress ?? '', socket.localPort ?? 0)
  const uids = new Set(table.split('\n').map(line => line.trim().split(/\s+/u)).filter(field => field[1] === local && field[2] === remote).map(field => field[7]))
  return uids.size === 0 ? peer : { ...peer, 'x-bellteam-peer-uid': uids.size === 1 ? [...uids][0] : 'unknown' }
}

// a487: the browser UI has ended. Every page that is not /api/* or /healthz answers this one plain notice (no session read, no file);
// everything the native apps call (/api/*, /healthz) is forwarded as before. The version header lets the exchange tests and the train check see which gateway answers.
const ENDED_NOTICE = Buffer.from('BellTeamのブラウザ版は終了しました。\nBellTeamはアプリ（iPhone・Mac・Windows・Linux・Android）でお使いください。無料で使うには、公開されているソースコード（https://github.com/kitepon/BellTeam 、MITライセンス）から自分でビルドしてください。\n')
function endedNotice(request, response, assetVersion) {
  response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'content-length': ENDED_NOTICE.length, 'cache-control': 'no-store', 'x-bellteam-gateway-version': assetVersion })
  response.end(request.method === 'HEAD' ? undefined : ENDED_NOTICE)
}

// Only the business process authenticates requests and owns accepted work.
export function createHttpGateway({ socketPath, assetVersion = Date.now().toString(36) }) {
  const streams = new Set(), peers = new WeakMap()
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
    if (pathname !== '/healthz' && !pathname.startsWith('/api/')) return endedNotice(request, response, assetVersion)
    let peer = peers.get(request.socket)
    if (!peer) peers.set(request.socket, peer = socketPeer(request.socket))
    const peerHeaders = await peer
    if (response.destroyed) return
    const upstream = httpRequest({ socketPath, method: request.method, path: request.url,
      headers: { ...endToEndHeaders(Object.fromEntries(Object.entries(request.headers).filter(([name]) => !PEER_HEADERS.includes(name)))), ...peerHeaders },
    }, incoming => {
      incoming.on('error', unavailable)
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
    request.pipe(upstream)
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
