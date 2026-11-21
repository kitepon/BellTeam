// 会話スクロールの試験用HTTP fixture。Markdownの表・コードを含む長い履歴を返し、before取得を記録する。実際のBotや資格情報には接続しない。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])

const rich = id => `## ${id} の確認\n\n**強調**と[資料](https://example.org)です。\n\n| 項目 | 状態 |\n| --- | --- |\n| 調査 | 完了 |\n| 表示確認 | 進行中 |\n\n- 見出しと段落の余白\n- 長い項目も字下げを揃えて折り返します。\n\n> 表示確認用のメモです。\n\n\`\`\`swift\nlet status = "working"\n\`\`\``
const plain = id => `${id} 短い返事です。`
const history = Array.from({ length: 260 }, (_, index) => {
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
  const before = url.searchParams.get('before')
  // 頁の上限（本体は1000）。試験は小さい履歴で頁の境目を作るため、最初の頁と過去の頁の上限を下げられる。
  const cap = (before ? olderCap : firstCap) || 1000
  const limit = Math.min(cap, Math.max(1, Number(url.searchParams.get('limit')) || 10))
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
  return { items: items.slice(start, end), has_more: start > 0, ...(legacyServer ? {} : { remaining_before: start }) }
}

// 初回10件が画面に収まる短文の履歴（ハル）。過去は残っている。
// 長く動いた機械席：古い500件は普通の行、次の597件は畳まれる道具の行（同じfold_group）、最新の3件だけが普通の行（1画面に満たない）。
// 畳んだ行は一つの行に束ねて描くので、頁を読んでも描かれる行がほとんど増えない（a471-fill-drawn）。
const foldHistory = Array.from({ length: 1100 }, (_, index) => {
  const id = `m${String(index + 1).padStart(3, '0')}`
  const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  const base = { id, direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' }, at, delivery: 'delivered' }
  if (index >= 500 && index < 1097) {
    return { ...base, kind: 'machine_event', message: 'Bash ls', machine_event: { seq: index, view: 'tool_use', display: 'fold', fold_group: 'tool_use', fold_count: 1, title: 'tool_use', text: 'Bash ls', tool: { name: 'Bash', summary: 'ls' } } }
  }
  return { ...base, kind: 'message', message: `${id} 短い返事です。` }
})

// 頁の境目が畳んだ行の束の中にある履歴（働いている機械席でよく起きる）：m001〜m100は普通の行、m101〜m220は畳まれる道具の行（一つの束）、m221〜m223は普通の行。
// 最初の頁を100行に絞ると m124〜m223 で、先頭 m124 は束の途中。過去の頁（m001〜m123）が届くと束の先頭が m101 に替わる。
const boundaryHistory = Array.from({ length: 223 }, (_, index) => {
  const id = `m${String(index + 1).padStart(3, '0')}`
  const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
  const base = { id, direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' }, at, delivery: 'delivered' }
  if (index >= 100 && index < 220) {
    return { ...base, kind: 'machine_event', message: 'Bash ls', machine_event: { seq: index, view: 'tool_use', display: 'fold', fold_group: 'tool_use', fold_count: 1, title: 'tool_use', text: 'Bash ls', tool: { name: 'Bash', summary: 'ls' } } }
  }
  return { ...base, kind: 'message', message: index % 3 === 2 ? plain(id) : rich(id) }
})

// 答えの後に出る思考の行（a471-thinking-bubble）。全文は message（先頭120字）より長い。
const thinkingRow = {
  id: 't01', kind: 'machine_event', direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' },
  at: new Date(Date.UTC(2026, 0, 1, 5, 0)).toISOString(), delivery: 'delivered', message: 'thinking 次に調べるのは過去ログの読み込みの規則です',
  machine_event: { seq: 1, view: 'thinking', display: 'show', title: 'thinking', text: '次に調べるのは過去ログの読み込みの規則です。' + '全文の続きです。'.repeat(30) + '終わりの一文。' },
}

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
let shortPage = false
let legacyServer = false
let shortTotal = shortMessages.length
let beforeDelay = 0
let firstDelay = 0
let sendDelay = 0
let replyRows = 0
let firstCap = 0
let olderCap = 0
let requests = []
let diagnosticReports = []
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const json = (value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') { failBefore = url.searchParams.get('failBefore') === '1'; legacyServer = url.searchParams.get('legacyServer') === '1'; shortPage = url.searchParams.get('shortPage') === '1'; shortTotal = Number(url.searchParams.get('shortTotal') ?? shortMessages.length); for (const subscriber of subscribers) subscriber.end(); subscribers = []; firstDelay = 0; sendDelay = 0; replyRows = 0; beforeDelay = Number(url.searchParams.get('beforeDelay') ?? 0); firstCap = Number(url.searchParams.get('firstCap') ?? 0); olderCap = Number(url.searchParams.get('olderCap') ?? 0); requests = []; diagnosticReports = []; messages = url.searchParams.get('boundary') === '1' ? boundaryHistory.slice() : url.searchParams.get('thinking') === '1' ? [...history.slice(0, 12), thinkingRow] : url.searchParams.get('fold') === '1' ? foldHistory.slice() : history.slice(0, Number(url.searchParams.get('total') ?? 60)); return json({ ok: true }) }
  if (path === '/test/append') {
    const id = `m${String(messages.length + 1).padStart(3, '0')}`
    messages.push({ id, kind: 'message', direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' }, at: new Date().toISOString(), message: `${id} 新着です。`, delivery: 'delivered' })
    const targeted = url.searchParams.get('targeted') === '1'
    const payload = targeted
      ? { at: new Date().toISOString(), all: false, topics: ['timeline'], botIds: ['bot-one'], roomIds: [] }
      : { type: 'messages' }
    for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(payload)}\n\n`)
    return json({ id })
  }
  if (path === '/test/config') {
    // 履歴を作り直さずに、応答の遅れだけを変える（会話を開き直す場合の再現）。
    firstDelay = Number(url.searchParams.get('firstDelay') ?? 0)
    if (url.searchParams.has('sendDelay')) sendDelay = Number(url.searchParams.get('sendDelay'))
    if (url.searchParams.has('replyRows')) replyRows = Number(url.searchParams.get('replyRows'))
    if (url.searchParams.has('firstCap')) firstCap = Number(url.searchParams.get('firstCap'))
    return json({ firstDelay, firstCap })
  }
  if (path === '/test/grow') {
    // 既存の行（id）の本文を長くする。上の行の高さが後から変わる場合（畳んだ群の伸び・本文の描き直し）の再現。
    const id = url.searchParams.get('id')
    const row = messages.find(item => item.id === id)
    if (!row) return json({ error: 'NOT_FOUND' }, 404)
    row.message = row.message + '\n\n' + '後から足された長い続きの文です。'.repeat(20)
    const payload = { at: new Date().toISOString(), all: false, topics: ['timeline'], botIds: ['bot-one'], roomIds: [] }
    for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(payload)}\n\n`)
    return json({ id })
  }
  if (path === '/test/burst') {
    // 働いている機械席：道具・フック・思考・言葉の行が続けざまに届く。畳む行は同じfold_groupで束ねられて育つ。
    const n = Number(url.searchParams.get('n') ?? 30), interval = Number(url.searchParams.get('interval') ?? 250)
    // tall=1：背の高い言葉の行だけを詰めて届ける（末尾を追うアニメーションが途切れない）。
    const tall = url.searchParams.get('tall') === '1'
    const prefix = url.searchParams.get('prefix') ?? 'b'
    const kinds = tall ? ['words'] : ['tool_use', 'tool_use', 'hook', 'thinking', 'tool_use', 'words']
    for (let i = 0; i < n; i++) setTimeout(() => {
      const kind = kinds[i % kinds.length]
      const id = `${prefix}${String(i + 1).padStart(3, '0')}`
      const folded = kind === 'tool_use' || kind === 'hook'
      messages.push({
        id, kind: 'machine_event', direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' }, at: new Date().toISOString(), delivery: 'delivered',
        message: folded ? `${kind} ${id}` : `${kind} ${id} 作業の途中経過です`,
        machine_event: { seq: 1000 + i, view: kind, display: folded ? 'fold' : 'show', fold_group: kind, fold_count: 1, title: kind, text: `${kind} ${id} 作業の途中経過です。` + (tall ? '\n続きの行です。'.repeat(8) : ''), ...(kind === 'tool_use' ? { tool: { name: 'Bash', summary: 'ls' } } : {}) },
      })
      const payload = { at: new Date().toISOString(), all: false, topics: ['timeline'], botIds: ['bot-one'], roomIds: [] }
      for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(payload)}\n\n`)
    }, i * interval)
    return json({ n })
  }
  if (path === '/test/notify') {
    const bot = url.searchParams.get('bot')
    if (bot !== 'bot-one' && bot !== 'bot-two') return json({ error: 'UNKNOWN_BOT' }, 400)
    const payload = { at: new Date().toISOString(), all: false, topics: ['timeline'], botIds: [bot], roomIds: [] }
    for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(payload)}\n\n`)
    return json({ ok: true })
  }
  if (path === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(': open\n\n')
    subscribers.push(response)
    request.on('close', () => { subscribers = subscribers.filter(item => item !== response) })
    return
  }
  if (path === '/api/diagnostics' && request.method === 'POST') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { diagnosticReports.push(JSON.parse(body).code); json({ ok: true }) })
    return
  }
  if (path === '/test/proof') return json({ failBefore, requests, diagnosticReports, subscribers: subscribers.length })
  if (path === '/api/subscription') return json({ subscription: { productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer', setupComplete: true, entitled: false, state: 'none', autoRenewing: false } })
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/harness-auth') return json({ harnesses: [] })
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path.includes('/queue')) return json({ items: [] })
  if (path === '/api/bots/bot-one/messages' && request.method === 'POST') {
    // 送信：受け付けて履歴へ足す（Botの会話は delivery_id が履歴の行のid）。
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => setTimeout(() => {
      const id = `sent-${messages.length + 1}`
      messages.push({ id, kind: 'message', direction: 'outgoing', sender: { id: 'user', name: '利用者' }, at: new Date().toISOString(), message: JSON.parse(body).message, delivery: 'queued' })
      json({ delivery_id: id })
      const payload = { at: new Date().toISOString(), all: false, topics: ['timeline'], botIds: ['bot-one'], roomIds: [] }
      for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(payload)}\n\n`)
      // 本物の席と同じく、受け付けた後に道具・フック・思考・言葉の行で答え始める。
      const kinds = ['thinking', 'tool_use', 'tool_use', 'hook', 'tool_use', 'words']
      for (let i = 0; i < replyRows; i++) setTimeout(() => {
        const kind = kinds[i % kinds.length]
        const rid = `r${String(i + 1).padStart(3, '0')}`
        const folded = kind === 'tool_use' || kind === 'hook'
        messages.push({
          id: rid, kind: 'machine_event', direction: 'incoming', sender: { id: 'bot-one', name: 'ユキ' }, at: new Date().toISOString(), delivery: 'delivered',
          message: `${kind} ${rid}`,
          machine_event: { seq: 2000 + i, view: kind, display: folded ? 'fold' : 'show', fold_group: kind, fold_count: 1, title: kind, text: `${kind} ${rid} 答えの途中経過です。` + (kind === 'words' ? '\n続きの行です。'.repeat(6) : ''), ...(kind === 'tool_use' ? { tool: { name: 'Bash', summary: 'ls' } } : {}) },
        })
        for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(payload)}\n\n`)
      }, 600 + i * 350)
    }, sendDelay))
    return
  }
  if (path === '/api/bots/bot-one/messages' && request.method === 'GET') {
    requests.push({ query: url.search })
    if (failBefore && url.searchParams.has('before')) return json({ error: 'FIXTURE_FAILURE', message: '試験用の取得失敗です。' }, 500)
    // 過去の頁だけ遅らせる（末尾を追うスクロールの途中に頁が届く場合の再現）。
    if (beforeDelay && url.searchParams.has('before')) { const page = pageItems(messages, url); return void setTimeout(() => json(page), beforeDelay) }
    // 最初の頁（before も after も無い、limit が頁の大きさ）だけ遅らせる。
    if (firstDelay && !url.searchParams.has('before') && !url.searchParams.has('after') && Number(url.searchParams.get('limit')) >= 100) { const page = pageItems(messages, url); return void setTimeout(() => json(page), firstDelay) }
    return json(pageItems(messages, url))
  }
  if (path === '/api/bots/bot-two/messages' && request.method === 'GET') {
    requests.push({ query: url.search, bot: 'bot-two' })
    if (failBefore && url.searchParams.has('before')) return json({ error: 'FIXTURE_FAILURE', message: '試験用の取得失敗' }, 500)
    // 表示域に収まる初回の頁。本番では短い連絡の行が続く時に起きる。
    if (shortPage && !url.searchParams.has('before')) url.searchParams.set('limit', '3')
    return json(pageItems(shortMessages.slice(-shortTotal), url))
  }
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return json({ items: [], has_more: false })
  json({ error: 'NOT_FOUND' }, 404)
})
// 実機から届くよう、SCROLL_FIXTURE_HOSTにMacのLANアドレスを渡せる。既定はこのMacの中だけ。
const host = process.env.SCROLL_FIXTURE_HOST || '127.0.0.1'
server.listen(Number(process.env.SCROLL_FIXTURE_PORT ?? 0), host, () => console.log(JSON.stringify({ url: `http://${host}:${server.address().port}` })))
