// Apple Lattice工程表 screens (docs/architecture/modules/apple/lattice-chart.md) against fixture charts in the
// lattice module's app contract shape (docs/architecture/modules/lattice/README.md "Public contract (apps)"):
//   GET /api/lattice/charts -> bellteam.lattice-charts.v1, GET /api/lattice/charts/:id -> bellteam.lattice-chart.v1,
//   GET /api/lattice/charts/:id/events -> SSE `snapshot` on connect, `: hb` every 15 s.
// Prints {"url"} on start. /test/reset, /test/mode?state=verified|unverified|last_verified|unavailable &list=ok|old|empty
//   &stream=ok|drop (drop answers 503 to every stream) &unknown=1 (a producer that is not in the roster) &degraded=lattice-read,members
// /test/complete?card=p1/t04 pushes a snapshot where that card is done (the completion bloom). Times are relative to now.
import { createServer } from 'node:http'

const MEMBERS = [
  { botId: 'bot-trony', name: 'トロニー', color: 'indigo', avatarVersion: '' },
  { botId: 'bot-molly', name: 'モリー', color: 'mint', avatarVersion: '' },
  { botId: 'bot-kiro', name: 'キロ', color: 'sky', avatarVersion: '' },
  { botId: 'bot-admi', name: 'アドミ', color: 'amber', avatarVersion: '' },
  { botId: 'bot-rapi', name: 'ラピ', color: 'rose', avatarVersion: '' },
  { botId: 'bot-flora', name: 'フローラ', color: 'violet', avatarVersion: '' },
]
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString()

let state, subscribers = new Set()
function reset() {
  state = { mode: { state: 'verified', list: 'ok', stream: 'ok', unknown: false, degraded: [] }, version: 1, done: new Set() }
}
reset()

function cards() {
  const card = (id, title, cardState, producer, depth, extra = {}) => ({ id: `p1/${id}`, plan: 'p1', taskId: id, title, state: state.done.has(`p1/${id}`) ? 'done' : cardState, lane: producer, producer, depth, doneCondition: '', designMemo: '', startedAt: null, changedAt: ago(60), blockedReason: null, ...extra })
  return [
    card('t01', '決定済み仕様の確認', 'done', 'bot-flora', 0, { doneCondition: '仕様の要点を一覧にする' }),
    card('t02', 'Latticeの読取口の確認', 'done', 'bot-flora', 0, { doneCondition: '読取の2つの入口を確かめる' }),
    card('t03', '旧・組込案の比較', 'retired', 'bot-admi', 0),
    card('t04', '部品の配置と保存場所', 'in-progress', 'bot-molly', 1, { doneCondition: '配置先と保存先を決定', startedAt: ago(12), designMemo: '部品の置き場と、工程表の保存先を決める。保存先は夜間の控えに入る場所にする。' }),
    card('t05', '席へのCLI配布', 'in-progress', 'bot-kiro', 1, { doneCondition: '全席でCLIが使える', startedAt: ago(4) }),
    card('t06', 'Web画面の組込口', 'blocked', 'bot-admi', 1, { doneCondition: 'Webから工程表を開ける', blockedReason: '組込の登録点が未定' }),
    card('t07', '公開契約の裁定', 'ready', 'bot-trony', 1, { doneCondition: '公開契約が確定する' }),
    card('t08', '部品の実装', 'pending', 'bot-flora', 2, { doneCondition: '契約どおりに動き、席から工程表を読める', designMemo: 'Lattice部品の本体をつくる。公開の入口は裁定済みの契約だけに限り、保存はモリーの配置先を使う。' }),
    card('t09', 'iPhone/Mac画面', 'pending', state.mode.unknown ? 'bot-ghost' : 'bot-rapi', 3, { doneCondition: '実画面で承認される' }),
    card('t10', 'Web画面', 'pending', 'bot-flora', 3, { doneCondition: 'Webで工程表が開く' }),
    card('t11', '受け取り確認', 'pending', null, 4, { doneCondition: '3画面を実画面で承認' }),
  ]
}
const EDGES = [['t01', 't07'], ['t02', 't04'], ['t04', 't08'], ['t05', 't08'], ['t07', 't08'], ['t08', 't09'], ['t06', 't10'], ['t09', 't11'], ['t10', 't11']]
const SINCE = { t06: 52, t04: 41, t07: 36, t05: 24, t08: 18, t09: 6, t10: 3 }

function snapshot(projectId) {
  const list = cards(), byId = new Map(list.map(card => [card.taskId, card]))
  const finished = card => card.state === 'done' || card.state === 'retired'
  const edges = EDGES.map(([from, to]) => ({ from: `p1/${from}`, to: `p1/${to}`, waiting: !finished(byId.get(from)) && !finished(byId.get(to)) }))
  const waits = EDGES.filter(([from, to]) => !finished(byId.get(from)) && !finished(byId.get(to)))
    .map(([from, to]) => ({ waiter: byId.get(to).producer, waitingCard: `p1/${to}`, forCard: `p1/${from}`, producer: byId.get(from).producer, producerState: byId.get(from).state, since: ago(SINCE[from] ?? 1) }))
    .sort((a, b) => a.since.localeCompare(b.since))
  const referenced = new Set([...list.map(card => card.producer), ...waits.map(wait => wait.waiter)])
  return {
    schema: 'bellteam.lattice-chart.v1', epoch: 'fixture', version: state.version, at: new Date().toISOString(), projectId, coordinator: projectId === 'lattice',
    state: state.mode.state, verifiedAt: ago(state.mode.state === 'last_verified' ? 46 : 0), degraded: state.mode.degraded,
    members: MEMBERS.filter(member => referenced.has(member.botId)), cards: list, edges, waits,
  }
}

function charts() {
  if (state.mode.list === 'empty') return []
  const main = snapshot('lattice'), done = main.cards.filter(card => card.state === 'done' || card.state === 'retired').length
  return [
    { projectId: 'lattice', coordinator: true, createdBy: 'bot-trony', counts: { total: main.cards.length, done, working: 2, waiting: 4, blocked: 1 }, activeMembers: ['bot-trony', 'bot-molly', 'bot-kiro', 'bot-admi', 'bot-rapi', 'bot-flora'], updatedAt: ago(1), state: state.mode.state },
    { projectId: 'nightly-care', coordinator: false, createdBy: 'bot-molly', counts: { total: 12, done: 7, working: 2, waiting: 1, blocked: 0 }, activeMembers: ['bot-molly', 'bot-kiro', 'bot-admi'], updatedAt: ago(12), state: 'verified' },
    { projectId: 'call-bridge', coordinator: false, createdBy: 'bot-kiro', counts: { total: 8, done: 3, working: 1, waiting: 2, blocked: 0 }, activeMembers: ['bot-kiro', 'bot-molly', 'bot-trony', 'bot-rapi'], updatedAt: ago(34), state: 'verified' },
    { projectId: 'web-polish', coordinator: false, createdBy: 'bot-admi', counts: { total: 11, done: 9, working: 1, waiting: 0, blocked: 0 }, activeMembers: ['bot-admi', 'bot-flora'], updatedAt: ago(63), state: 'verified' },
    { projectId: 'guide', coordinator: false, createdBy: 'bot-flora', counts: { total: 9, done: 4, working: 1, waiting: 2, blocked: 0 }, activeMembers: ['bot-flora', 'bot-rapi', 'bot-trony'], updatedAt: ago(14 * 60), state: 'verified' },
  ]
}

const push = () => { state.version++; for (const [response, id] of subscribers) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(id))}\n\n`) }

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost'), path = url.pathname
  const send = (status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') { reset(); return send(200, { ok: true }) }
  if (path === '/test/mode') {
    for (const key of ['state', 'list', 'stream']) if (url.searchParams.has(key)) state.mode[key] = url.searchParams.get(key)
    if (url.searchParams.has('unknown')) state.mode.unknown = url.searchParams.get('unknown') === '1'
    if (url.searchParams.has('degraded')) state.mode.degraded = url.searchParams.get('degraded').split(',').filter(Boolean)
    if (state.mode.stream === 'drop') { for (const [subscriber] of subscribers) subscriber.end(); subscribers.clear() } else push()
    return send(200, state.mode)
  }
  if (path === '/test/complete') { state.done.add(url.searchParams.get('card')); push(); return send(200, { ok: true }) }
  if (path === '/api/events') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.write('event: ready\ndata: {}\n\n'); return }
  if (path === '/api/bots') return send(200, { bots: [] })
  if (path === '/api/rooms') return send(200, { rooms: [] })
  if (path.endsWith('/messages') || path.endsWith('/timeline')) return send(200, { messages: [], items: [], hasMore: false })
  const route = /^\/api\/lattice\/charts(?:\/([^/]+?)(\/events)?)?$/u.exec(path)
  if (!route) return send(404, { error: 'NOT_FOUND' })
  if (state.mode.list === 'old') return send(404, { error: 'NOT_FOUND' })
  const [, id, events] = route
  if (id === undefined) return send(200, { schema: 'bellteam.lattice-charts.v1', at: new Date().toISOString(), charts: charts() })
  if (!charts().some(chart => chart.projectId === id)) return send(404, { error: 'LATTICE_CHART_NOT_FOUND' })
  if (!events) return send(200, snapshot(id))
  if (state.mode.stream === 'drop') return send(503, { error: 'LATTICE_UNAVAILABLE' })
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
  response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(id))}\n\n`)
  const entry = [response, id]
  subscribers.add(entry)
  const heartbeat = setInterval(() => response.write(': hb\n\n'), 15000)
  request.on('close', () => { clearInterval(heartbeat); subscribers.delete(entry) })
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
