// ローカルHTTPSで秘密入力を実測する試験専用サーバー。本番のデータは使わない。
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createTLS } from 'node:https'
import { request as proxyRequest } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretRequests, secretCompletionMessage } from '../src/secret-requests.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const root = await mkdtemp(join(tmpdir(), 'bellteam-secret-smoke-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
  '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
const bots = new Map([['bot-one', { id: 'bot-one', name: 'ユキ' }]])
const rooms = new Map()
rooms.refresh = async () => {}
const delivered = []
const service = new SecretRequests({ root, bots, rooms, notify: item => { delivered.push(secretCompletionMessage(item)) } })
await service.initialize()
const item = await service.create({ botId: 'bot-one', toolId: 'example', label: '接続トークン', message: '接続を確認するためのトークンを入力してください。' })
const server = createBellTeamServer({ bots, rooms, secretRequests: service,
  authorize: () => true, store: { timeline: async () => [], watch: async () => () => {} },
  transport: { queueItems: () => [], isRunning: async () => false },
  ownerProfile: { get: async () => ({ name: '試験利用者', links: [] }) }, staticRoot: new URL('../web/', import.meta.url).pathname })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
await server.startMessageWatch()
let redirected = false
const tls = createTLS({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, (request, response) => {
  if (request.url === '/api/secret-requests/redirect/submit') {
    response.writeHead(307, { location: 'https://localhost:18443/redirect-received' })
    return response.end()
  }
  if (request.url === '/redirect-received') {
    redirected = true
    response.writeHead(400)
    return response.end()
  }
  const upstream = proxyRequest({ hostname: '127.0.0.1', port: server.address().port, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-proto': 'https' } }, reply => {
    response.writeHead(reply.statusCode, reply.headers)
    reply.pipe(response)
  })
  request.pipe(upstream)
})
tls.listen(18443, '127.0.0.1')
await once(tls, 'listening')
console.log(JSON.stringify({ url: 'https://localhost:18443', certificate: join(root, 'cert.pem'), root, requestId: item.id }))
process.on('SIGINT', async () => {
  if (redirected) throw new Error('秘密情報のPOSTがリダイレクトされました')
  const result = service.get(item.id)
  if (result.status === 'submitted') {
    const value = await readFile(result.path, 'utf8')
    if (value !== 'dummy-ui-secret') throw new Error('試験値が一致しません')
    if (JSON.stringify(delivered).includes(value)) throw new Error('通知へ試験値が混入しました')
    console.log('保存ファイルの値が一致し、通知への混入はありません。')
  }
  tls.closeAllConnections(); tls.close()
  server.closeAllConnections(); server.close()
  await rm(root, { recursive: true, force: true })
})
