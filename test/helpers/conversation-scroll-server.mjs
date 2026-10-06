// 会話スクロールの試験用HTTP fixture。Markdownの表・コードを含む長い履歴を返し、before取得を記録する。実際のBotや資格情報には接続しない。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])

const rich = id => `## ${id} の確認\n\n**強調**と[資料](https://example.org)です。\n\n| 項目 | 状態 |\n| --- | --- |\n| 調査 | 完了 |\n| 表示確認 | 進行中 |\n\n- 見出しと段落の余白\n- 長い項目も字下げを揃えて折り返します。\n\n> 表示確認用のメモです。\n\n\`\`\`swift\nlet status = "working"\n\`\`\``
const plain = id => `${id} 短い返事です。`
const history = Array.from({ length: 60 }, (_, index) => {
  const id = `m${String(index + 1).padStart(3, '0')}`
  return {
    id, kind: 'message', direction: index % 2 ? 'outgoing' : 'incoming',
    sender: { id: index % 2 ? 'user' : 'bot-one', name: index % 2 ? '利用者' : 'ユキ' },
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    message: index % 3 === 2 || index === 59 ? plain(id) : rich(id),
    delivery: 'delivered',
  }
})

// src/http-server.mjs の pageItems と同じ before / limit の意味。依存を入れずに起動できるよう複製する。
function pageItems(items, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 10))
  const before = url.searchParams.get('before')
  const after = url.searchParams.get('after')
  if (after) {
    const index = items.findIndex(item => item.id === after)
    return { items: index < 0 ? items.slice(-limit) : items.slice(index + 1), has_more: false }
  }
  let end = items.length
  if (before) {
    const index = items.findIndex(item => item.id === before)
    if (index >= 0) end = index
  }
  const start = Math.max(0, end - limit)
  return { items: items.slice(start, end), has_more: start > 0 }
}

// 初回10件が画面に収まる短文の履歴（ハル）。過去は残っている。
const shortMessages = Array.from({ length: 35 }, (_, index) => {
  const id = `s${String(index + 1).padStart(2, '0')}`
  return {
    id, kind: 'message', direction: index % 2 ? 'outgoing' : 'incoming',
    sender: { id: index % 2 ? 'user' : 'bot-two', name: index % 2 ? '利用者' : 'ハル' },
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), message: `${id} 短い返事`, delivery: 'delivered',
  }
})

let messages = history.slice()
let subscribers = []
let failBefore = false
let requests = []
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const json = (value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') { failBefore = url.searchParams.get('failBefore') === '1'; requests = []; messages = history.slice(0, Number(url.searchParams.get('total') ?? 60)); return json({ ok: true }) }
  if (path === '/test/append') {
    const id = `m${String(messages.length + 1).padStart(3, '0')}`
    messages.push({ id, kind: 'message', direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' }, at: new Date().toISOString(), message: `${id} 新着です。`, delivery: 'delivered' })
    for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: {"type":"messages"}\n\n`)
    return json({ id })
  }
  if (path === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(': open\n\n')
    subscribers.push(response)
    request.on('close', () => { subscribers = subscribers.filter(item => item !== response) })
    return
  }
  if (path === '/test/proof') return json({ failBefore, requests, subscribers: subscribers.length })
  if (path === '/api/subscription') return json({ subscription: { productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer', setupComplete: true, entitled: false, state: 'none', autoRenewing: false } })
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/harness-auth') return json({ harnesses: [] })
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path.includes('/queue')) return json({ items: [] })
  if (path === '/api/bots/bot-one/messages' && request.method === 'GET') {
    requests.push({ query: url.search })
    if (failBefore && url.searchParams.has('before')) return json({ error: 'FIXTURE_FAILURE', message: '試験用の取得失敗です。' }, 500)
    return json(pageItems(messages, url))
  }
  if (path === '/api/bots/bot-two/messages' && request.method === 'GET') {
    requests.push({ query: url.search, bot: 'bot-two' })
    return json(pageItems(shortMessages, url))
  }
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return json({ items: [], has_more: false })
  json({ error: 'NOT_FOUND' }, 404)
})
server.listen(Number(process.env.SCROLL_FIXTURE_PORT ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
