// AppleのAntigravityメンバー編集試験用。人工モデルと既存previewデータだけを使う。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const initial = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
let fixture = structuredClone(initial)
let saves = []
let modelRequests = 0
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  const json = (value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  if (path === '/test/reset') {
    fixture = structuredClone(initial); saves = []; modelRequests = 0
    return json({ ok: true })
  }
  if (path === '/test/proof') return json({ saves, modelRequests })
  if (path === '/api/models') {
    modelRequests++
    return json({ models: {
      claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'], fast: true }], defaultModel: 'opus' },
      antigravity: { efforts: ['low', 'high'],
        models: [{ id: 'ag-model/phase-one', efforts: ['low', 'high'], fast: false }],
        defaultModel: 'ag-model/phase-one', fastUnavailable: { code: 'FAST_UNSUPPORTED', message: 'このCLIでは使えません。' } },
    } })
  }
  if (request.method === 'PATCH' && path === '/api/bots/bot-one') {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    saves.push(body)
    Object.assign(fixture.bots[0], body)
    return json({ ok: true })
  }
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path === '/api/queue' || path.endsWith('/queue')) return json({ items: [] })
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return json({ messages: [], items: [], hasMore: false })
  return json({ error: 'NOT_FOUND' }, 404)
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
