// Macの編集確認用。既存のpreviewデータを使い、モデル応答を明示的に止める。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
const proof = { modelRequests: 0, releasedModels: false, saves: [] }
let releaseModels
const modelsReady = new Promise(resolve => { releaseModels = resolve })
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/proof') return json(proof)
  if (path === '/test/release-models') { proof.releasedModels = true; releaseModels(); return json({ ok: true }) }
  if (path === '/api/models') {
    proof.modelRequests++
    await modelsReady
    return json({ models: { claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'] }] } } })
  }
  if (request.method === 'PATCH' && path === '/api/bots/bot-one') {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    proof.saves.push({ body, modelsPending: !proof.releasedModels })
    Object.assign(fixture.bots[0], body)
    return json({ ok: true })
  }
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path === '/api/queue' || path.endsWith('/queue')) return json({ items: [] })
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return json({ messages: [], items: [], hasMore: false })
  response.statusCode = 404
  return json({ error: 'NOT_FOUND' })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
