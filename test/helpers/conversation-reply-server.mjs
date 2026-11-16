// 返信（reply_to）の試験用HTTP fixture。引用つきの履歴を返し、POSTされた本文を記録して引用つきの新しい行を足す。実際のBotや資格情報には接続しない。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])

const at = index => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
const history = Array.from({ length: 60 }, (_, index) => {
  const id = `m${String(index + 1).padStart(3, '0')}`
  return {
    id, kind: 'message', direction: index % 2 ? 'outgoing' : 'incoming',
    sender: { id: index % 2 ? 'user' : 'bot-one', name: index % 2 ? '利用者' : 'ユキ' },
    at: at(index), message: `${id} 短い返事です。`, delivery: 'delivered',
  }
})
history[56].message = 'm057 今日は晴れです。明日は雨になりそうです。週末は未定です。'
// m056は、元が無い部分引用。
history[55].reply_to = { id: 'gone-2', available: false, part: true, text: '選んだ文章' }
// m055は、ハルの発言をコメント付きで転送した行（content_startはコメント「これお願い\n\n」の7字）。
history[54].message = 'これお願い\n\n午前は打ち合わせ。'
history[54].origin = { kind: 'forward', from: { id: 'bot-two', name: 'ハル' }, at: at(1), content_start: 7 }
// m060は古いm003への返信、m059は元が読めない返信。
history[59].reply_to = { id: 'm003', available: true, sender: { id: 'bot-one', name: 'ユキ' }, at: at(2), text: 'm003 短い返事です。' }
history[58].reply_to = { id: 'gone-1', available: false }

let messages = history.slice()
let posts = []
const pageItems = url => {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 10))
  const before = url.searchParams.get('before')
  const after = url.searchParams.get('after')
  if (after) {
    const index = messages.findIndex(item => item.id === after)
    return { items: index < 0 ? messages.slice(-limit) : messages.slice(index + 1), has_more: false }
  }
  let end = messages.length
  if (before) { const index = messages.findIndex(item => item.id === before); if (index >= 0) end = index }
  const start = Math.max(0, end - limit)
  return { items: messages.slice(start, end), has_more: start > 0 }
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const json = (value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') { messages = history.slice(); posts = []; return json({ ok: true }) }
  if (path === '/test/proof') return json({ posts })
  if (path === '/api/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': open\n\n'); return }
  if (path === '/api/subscription') return json({ subscription: { productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer', setupComplete: true, entitled: false, canUseAI: true, state: 'none', autoRenewing: false } })
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/harness-auth') return json({ harnesses: [] })
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path.includes('/queue')) return json({ items: [] })
  if (path === '/api/bots/bot-one/messages' && request.method === 'GET') return json(pageItems(url))
  const postTo = path.match(/^\/api\/(bots|rooms)\/([^/]+)\/messages$/u)
  if (postTo && postTo[2] !== 'bot-one' && request.method === 'POST') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { posts.push({ ...JSON.parse(body), _to: `${postTo[1]}/${postTo[2]}` }); json({ id: 'fwd-1', delivery_id: 'fwd-1', message_id: 'fwd-1', status: 'accepted' }) })
    return
  }
  if (path === '/api/bots/bot-one/messages' && request.method === 'POST') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const post = JSON.parse(body)
      posts.push(post)
      const id = `m${String(messages.length + 1).padStart(3, '0')}`
      const original = messages.find(item => item.id === post.reply_to)
      const row = { id, kind: 'message', direction: 'outgoing', sender: { id: 'user', name: '利用者' }, at: new Date().toISOString(), message: post.message, delivery: 'delivered' }
      const part = post.reply_quote?.text
      if (post.reply_to && part !== undefined) {
        const index = original ? original.message.indexOf(part) : -1
        row.reply_to = original
          ? { id: original.id, available: true, sender: original.sender, at: original.at, text: part, part: true, ...(index >= 0 ? { range: { start: index, end: index + [...part].length } } : {}) }
          : { id: post.reply_to, available: false, part: true, text: part }
      } else if (post.reply_to) row.reply_to = original
        ? { id: original.id, available: true, sender: original.sender, at: original.at, text: original.message }
        : { id: post.reply_to, available: false }
      messages.push(row)
      json({ id, delivery_id: id, message_id: id, status: 'accepted' })
    })
    return
  }
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return json({ items: [], has_more: false })
  json({ error: 'NOT_FOUND' }, 404)
})
const host = process.env.REPLY_FIXTURE_HOST || '127.0.0.1'
server.listen(Number(process.env.REPLY_FIXTURE_PORT ?? 0), host, () => console.log(JSON.stringify({ url: `http://${host}:${server.address().port}` })))
