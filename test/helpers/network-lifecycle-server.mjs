// 背景移行の切り分け用HTTP fixture。実際のBotや資格情報には接続しない。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
let mode = 'post'
let records = []
let reads = []
let active = 0
let peak = 0
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') { mode = new URL(request.url, 'http://localhost').searchParams.get('mode') ?? 'post'; records = []; reads = []; active = 0; peak = 0; return json({ ok: true }) }
  if (path === '/test/proof') return json({ mode, active, peak, records, reads })
  if (request.method === 'GET') reads.push({ path, receivedAt: Date.now() })
  if (path === '/api/subscription') return json({ subscription: { productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer', setupComplete: true, entitled: false, state: 'none', autoRenewing: false } })
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/harness-auth') return json({ harnesses: [] })
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path.includes('/queue')) return json({ items: [] })
  if (path.endsWith('/schedules') || (path.endsWith('/messages') && request.method === 'POST')) {
    let text = ''
    for await (const chunk of request) text += chunk
    const record = { path, method: request.method, receivedAt: Date.now(), completedAt: null, closedAt: null }
    records.push(record)
    active++; peak = Math.max(active, peak)
    response.on('close', () => { record.closedAt = Date.now() })
    await new Promise(resolve => setTimeout(resolve, mode === 'post' ? 20000 : mode === 'schedules-fast' ? 1000 : 8000))
    record.completedAt = Date.now()
    active--
    return json(path.endsWith('/schedules') ? { schedules: [] } : { delivery: 'running' })
  }
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return json({ items: [], hasMore: false })
  response.statusCode = 404
  json({ error: 'NOT_FOUND' })
})
server.listen(Number(process.env.NETWORK_PROBE_PORT ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
