import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APNsProvider } from '../../src/push-notifications.mjs'
import { createNotificationRelay } from './relay.mjs'

const directory = process.env.BELLTEAM_APNS_DIRECTORY
if (!directory) throw new Error('APNS_DIRECTORY_REQUIRED')
const provider = await APNsProvider.create(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')), directory)
const relay = createNotificationRelay({ provider, subscriptionEnvironment: process.env })
const server = createServer(async (request, response) => {
  try {
    const input = new Request(new URL(request.url, 'http://notifications.bellteam.local'), {
      method: request.method, headers: request.headers,
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Readable.toWeb(request), duplex: 'half' }),
    })
    const result = await relay.fetch(input)
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    const code = /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'PUSH_RELAY_FAILED'
    process.stderr.write(`BellTeam: 通知中継の処理に失敗しました (${code})\n`)
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code, message: '通知中継の処理に失敗しました。' } }))
  }
})
server.listen(Number(process.env.PORT ?? 18920), process.env.HOST ?? '0.0.0.0', () => {
  process.stdout.write(`BellTeam: 通知中継の待受を開始しました (${server.address().port})\n`)
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => provider.close()))
