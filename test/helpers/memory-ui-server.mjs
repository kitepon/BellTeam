// Apple member memory / knowledge / character-sheet screens (docs/architecture/modules/apple/memory-and-sheets.md): in-memory stores, no real memory service.
// Same routes and shapes as src/http-bot-api.mjs and src/members/profiles-http.mjs:
//   POST|GET /api/bots/:id/memory[?query=&scope=], POST|GET /api/bots/:id/knowledge[?query=&scope=] -> {items}, GET /api/bots/:id/character-sheet -> {sheets:[{file,size,updatedAt,url}]} and the image at url.
// Prints {"url"} on start. /test/reset, /test/proof (every write and read the app made),
// /test/mode?memory=ok|error|old|slow &sheets=two|empty|error|old|imagefail
//   (error is a 503, old is an older body's 404 NOT_FOUND, slow holds each memory answer for 700 ms, imagefail lists two sheets and fails the image).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])
const KINDS = new Set(['fact', 'preference', 'policy', 'task', 'config', 'incident', 'relationship', 'episode', 'growth'])
const SCOPES = new Set(['personal', 'shared'])

let state
function reset() {
  state = {
    mode: { memory: 'ok', sheets: 'two' },
    memories: [
      { botId: 'bot-one', scope: 'personal', kind: 'preference', content: '朝は紅茶を好む。会議の前には砂糖を入れない。' },
      { botId: 'bot-one', scope: 'personal', kind: 'task', content: '毎週金曜に週報の下書きを用意する。' },
      { botId: 'bot-one', scope: 'personal', kind: 'growth', content: '長い返事より、先に結論を書くと喜ばれると分かった。' },
      { botId: 'bot-one', scope: 'personal', kind: 'relationship', content: 'ハルとは設計の相談をよくする。' },
      { botId: '', scope: 'shared', kind: 'policy', content: '本番を止める操作は、必ず先にオーナーへ聞く。' },
    ],
    knowledge: [
      { botId: 'bot-one', scope: 'personal', title: '週報の書き方', content: '先週やったこと、今週やること、困っていることの三つに分ける。数字は先に書く。' },
      { botId: '', scope: 'shared', title: 'BellTeamの用語集', content: '席は、メンバーのAIが動く場所。端末は、席を動かすMac。' },
    ],
    proof: { memoryPosts: [], knowledgePosts: [], recalls: [], searches: [], sheetLists: 0, sheetImages: [] },
  }
}
reset()

// A small PNG without dependencies: a pastel gradient with a character drawn from circles and rounded boxes.
function png(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const pixel = (x, y, [r, g, b]) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = y * (width * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y, [Math.round(236 - 40 * y / height), Math.round(228 - 30 * x / width), Math.round(255 - 30 * y / height)])
  const circle = (cx, cy, r, color) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) pixel(x, y, color) }
  const box = (x0, y0, w, h, round, color) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const dx = Math.max(x0 + round - x, 0, x - (x0 + w - 1 - round)), dy = Math.max(y0 + round - y, 0, y - (y0 + h - 1 - round))
    if (dx * dx + dy * dy <= round * round) pixel(x, y, color) } }
  paint({ circle, box, width, height })
  const crc = (buffer) => { let c, table = crc.table ??= Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
    let value = 0xffffffff; for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const SKIN = [255, 226, 205], HAIR = [96, 72, 168], DRESS = [120, 100, 220], EYE = [48, 40, 80], CHEEK = [255, 170, 170]
const IMAGES = {
  'front.png': png(480, 640, ({ circle, box }) => {
    box(150, 330, 180, 250, 60, DRESS); circle(240, 210, 110, HAIR); circle(240, 235, 92, SKIN)
    circle(205, 235, 10, EYE); circle(275, 235, 10, EYE); circle(185, 262, 14, CHEEK); circle(295, 262, 14, CHEEK); box(222, 275, 36, 8, 4, EYE)
  }),
  'expressions.png': png(640, 480, ({ circle, box }) => {
    for (let i = 0; i < 6; i++) {
      const cx = 110 + (i % 3) * 210, cy = 130 + Math.floor(i / 3) * 220
      circle(cx, cy, 80, HAIR); circle(cx, cy + 12, 66, SKIN); circle(cx - 24, cy + 6, 8, EYE); circle(cx + 24, cy + 6, 8, EYE)
      circle(cx - 42, cy + 28, 10, CHEEK); circle(cx + 42, cy + 28, 10, CHEEK); box(cx - 18, cy + 36 - (i % 3) * 3, 36, 6 + (i % 3) * 6, 3, EYE)
    }
  }),
}
const SHEETS = [
  { file: 'front.png', size: IMAGES['front.png'].length, updatedAt: '2026-11-08T03:12:45.000Z' },
  { file: 'expressions.png', size: IMAGES['expressions.png'].length, updatedAt: '2026-11-09T21:40:02.000Z' },
]

async function body(request) {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : {}
}

const excerpt = (text, query) => {
  const at = Math.max(text.indexOf(query), 0)
  return `${at > 0 ? '…' : ''}${text.slice(at, at + 60)}${text.length > at + 60 ? '…' : ''}`
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const send = (status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  const fail = (status, code) => send(status, { error: code, message: code })
  if (path === '/test/reset') { reset(); return send(200, { ok: true }) }
  if (path === '/test/proof') return send(200, state.proof)
  if (path === '/test/mode') {
    for (const key of ['memory', 'sheets']) if (url.searchParams.has(key)) state.mode[key] = url.searchParams.get(key)
    return send(200, state.mode)
  }
  if (path === '/api/bots' && request.method === 'GET') return send(200, { bots: fixture.bots })
  if (path === '/api/rooms') return send(200, { rooms: fixture.rooms })
  if (path === '/api/owner') return send(200, { owner: fixture.owner })
  if (path === '/api/models') return send(200, { models: { claude: { efforts: ['high'], models: [{ id: 'opus', efforts: ['high'], fast: true }] }, codex: { efforts: [], models: [] }, grok: { efforts: [], models: [] } } })
  if (path === '/api/queue' || path.endsWith('/queue')) return send(200, { items: [] })
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return send(200, { messages: [], items: [], hasMore: false })
  if (path === '/api/settings') return send(200, { settings: [] })
  if (path === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write('event: ready\ndata: {}\n\n')
    return
  }

  const route = /^\/api\/bots\/([a-z0-9-]+)\/(memory|knowledge|character-sheet)(?:\/([^/]+))?$/u.exec(path)
  if (route) {
    const [, botId, resource, file] = route
    if (!fixture.bots.some(bot => bot.id === botId)) return fail(404, 'BOT_NOT_FOUND')
    if (resource === 'character-sheet') {
      if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED')
      if (state.mode.sheets === 'old') return fail(404, 'NOT_FOUND')
      if (state.mode.sheets === 'error' && !file) return fail(503, 'CHARACTER_SHEETS_UNAVAILABLE')
      if (!file) {
        state.proof.sheetLists++
        const sheets = state.mode.sheets === 'empty' ? [] : SHEETS
        return send(200, { sheets: sheets.map(sheet => ({ ...sheet, url: `/api/bots/${botId}/character-sheet/${encodeURIComponent(sheet.file)}` })) })
      }
      const name = decodeURIComponent(file)
      state.proof.sheetImages.push(name)
      if (state.mode.sheets === 'imagefail') return fail(500, 'SHEET_READ_FAILED')
      if (!IMAGES[name]) return fail(404, 'SHEET_NOT_FOUND')
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': IMAGES[name].length })
      return response.end(IMAGES[name])
    }
    if (state.mode.memory === 'old') return fail(404, 'NOT_FOUND')
    if (state.mode.memory === 'slow') await new Promise(resolve => setTimeout(resolve, 700))
    if (state.mode.memory === 'error') return fail(503, 'MEMORY_UNAVAILABLE')
    const here = (scope) => item => item.scope === scope && (scope === 'shared' || item.botId === botId)
    if (request.method === 'POST') {
      const input = await body(request)
      if (!SCOPES.has(input.scope ?? 'personal')) return fail(400, 'MEMORY_SCOPE_INVALID')
      const scope = input.scope ?? 'personal'
      if (resource === 'memory') {
        state.proof.memoryPosts.push({ botId, body: input })
        if (!KINDS.has(input.kind)) return fail(400, 'MEMORY_KIND_INVALID')
        if (typeof input.content !== 'string' || !input.content.trim()) return fail(400, 'MEMORY_CONTENT_INVALID')
        state.memories.push({ botId: scope === 'shared' ? '' : botId, scope, kind: input.kind, content: input.content.trim() })
        return send(201, { id: `memory-${state.memories.length}`, status: 'active' })
      }
      state.proof.knowledgePosts.push({ botId, body: input })
      if (typeof input.title !== 'string' || !input.title.trim()) return fail(400, 'KNOWLEDGE_TITLE_INVALID')
      if (typeof input.content !== 'string' || !input.content.trim()) return fail(400, 'KNOWLEDGE_CONTENT_INVALID')
      state.knowledge.push({ botId: scope === 'shared' ? '' : botId, scope, title: input.title.trim(), content: input.content.trim() })
      return send(201, { id: `knowledge-${state.knowledge.length}` })
    }
    if (request.method === 'GET') {
      const query = url.searchParams.get('query') ?? '', scope = url.searchParams.get('scope') ?? 'personal'
      if (!SCOPES.has(scope)) return fail(400, 'MEMORY_SCOPE_INVALID')
      if (resource === 'memory') {
        state.proof.recalls.push({ botId, query, scope })
        const items = state.memories.filter(here(scope)).filter(item => query && item.content.includes(query))
        return send(200, { scope, items: items.map((item, index) => ({ id: `m-${index}`, kind: item.kind, content: item.content, importance: 3, observedAt: '2026-11-01T00:00:00Z', metadata: {} })) })
      }
      state.proof.searches.push({ botId, query, scope })
      const items = state.knowledge.filter(here(scope)).filter(item => query && (item.title.includes(query) || item.content.includes(query)))
      return send(200, { scope, items: items.map((item, index) => ({ id: `k-${index}`, title: item.title, excerpt: excerpt(item.content, query), path: `notes/k-${index}.md`, source: '', tags: [], confidence: 'medium', createdAt: '2026-11-01T00:00:00Z' })) })
    }
    return fail(405, 'METHOD_NOT_ALLOWED')
  }
  return fail(404, 'NOT_FOUND')
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
