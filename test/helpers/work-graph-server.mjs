// 相関図の試験用HTTP fixture。docs/architecture/modules/work-graph/README.md の契約どおりの snapshot と change を流す。実際のBotには接続しない。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../ios/BellBot/BellBot/Core/PreviewFixtures.swift', import.meta.url), 'utf8')
const fixture = JSON.parse(source.match(/let source = """\n([\s\S]*?)\n\s*"""/u)[1])

const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
const node = (botId, name, color, state, minutes) => ({ botId, name, color, avatarVersion: '', state, activeSince: minutesAgo(minutes) })
const edge = (from, to, label, state = 'running') => ({ id: `req-${from}-${to}:${to}`, requestId: `req-${from}-${to}`, from, to, context: 'direct', roomId: null, label, state, startedAt: minutesAgo(1) })

const base = {
  nodes: [
    node('bot-one', 'ユキ', 'indigo', 'working', 3),
    node('bot-two', 'ハル', 'violet', 'working', 1),
    node('bot-three', 'ナギ', 'rose', 'linked', 0),
    node('bot-four', 'キロ', 'mint', 'working', 7),
    node('bot-five', 'エピネル', 'amber', 'working', 2),
  ],
  edges: [
    edge('bot-one', 'bot-three', '資料の公開範囲を決めてほしい。社外に出す章と社内だけの章を分けて、明日までに返事をください'),
    edge('bot-two', 'bot-one', 'iPhoneとMacの画面写真を撮って送って。相関図の札が切れずに折り返し、ほかの札やアイコンに重ならないことも見てください'),
    edge('bot-one', 'bot-two', '比較表を更新', 'steered'),
    edge('bot-four', 'bot-five', 'PR #646 の取り込み判定をお願いします。会話一覧の土台をChatLayoutへ替えたので、上へ読み進めた時に位置が飛ばないことも実機で確かめてください'),
    // 要約がまだ無い依頼（label null）は札を出さない。
    edge('bot-five', 'bot-two', null),
  ],
}
const colors = ['violet', 'rose', 'indigo', 'sky', 'mint', 'amber']
const names = ['トロニー', 'エピネル', 'センチ', 'キロ', 'モリー', 'アドミ', 'ドリリー', 'レオナ', 'マスト', 'アンカー', 'ヘルム', 'ナユタ', 'ブラック', 'ケイ', 'ルナ', 'ソラ', 'カイ', 'ミオ', 'リク', 'ユナ', 'ハナ', 'トワ', 'セナ', 'ノア']
// 24人・依頼10本の混雑時（人数が増えたら小さくする確認用）。
const crowd = {
  nodes: names.map((name, index) => node(`crowd-${index}`, name, colors[index % colors.length], index % 5 === 4 ? 'linked' : 'working', index)),
  edges: Array.from({ length: 10 }, (_, index) => edge(`crowd-${index}`, `crowd-${(index * 7 + 3) % 24}`, `依頼${index + 1}の確認`)),
}
const extra = node('bot-six', 'センチ', 'sky', 'working', 0)
const extraEdge = edge('bot-five', 'bot-six', '版114のコンテナを作って配布して')

let mode = 'full'
let epoch = `e${Date.now()}`
let version = 1
let graph = structuredClone(base)
let streams = []
let ticker = null

const snapshot = () => ({ schema: 'bellteam.work-graph.v1', epoch, version, at: new Date().toISOString(),
  degraded: mode === 'degraded' ? ['responders'] : [], ...(mode === 'empty' ? { nodes: [], edges: [] } : mode === 'crowd' ? crowd : graph) })

function publish(changes) {
  version += 1
  const body = { epoch, version, at: new Date().toISOString(), degraded: mode === 'degraded' ? ['responders'] : [], changes }
  for (const stream of streams) stream.write(`event: change\nid: ${epoch}:${version}\ndata: ${JSON.stringify(body)}\n\n`)
}

// 6秒ごとに1人が入り依頼が流れ、次の6秒で依頼が終わり出ていく。入退場と線の伸び縮みを撮るため。
function startTicker() {
  if (ticker || mode !== 'full') return
  let present = false
  ticker = setInterval(() => {
    if (!present) { graph.nodes.push(extra); graph.edges.push(extraEdge); publish([{ type: 'member-enter', node: extra }, { type: 'edge-start', edge: extraEdge }]) }
    else {
      graph.nodes = graph.nodes.filter(item => item.botId !== extra.botId); graph.edges = graph.edges.filter(item => item.id !== extraEdge.id)
      publish([{ type: 'edge-end', edgeId: extraEdge.id }, { type: 'member-leave', botId: extra.botId }])
    }
    present = !present
  }, 6000)
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const json = (value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (path === '/test/reset') {
    mode = url.searchParams.get('mode') ?? 'full'; epoch = `e${Date.now()}`; version = 1; graph = structuredClone(base)
    clearInterval(ticker); ticker = null
    for (const stream of streams) stream.end()
    streams = []
    return json({ ok: true, mode })
  }
  if (path === '/test/drop') { for (const stream of streams) stream.destroy(); streams = []; return json({ ok: true }) }
  if (path === '/api/work-graph/events') {
    if (mode === 'unsupported') return json({ error: 'NOT_FOUND' }, 404)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`)
    streams.push(response)
    const heartbeat = setInterval(() => response.write(': hb\n\n'), 15000)
    request.on('close', () => { clearInterval(heartbeat); streams = streams.filter(item => item !== response) })
    startTicker()
    return
  }
  if (path === '/api/work-graph') return mode === 'unsupported' ? json({ error: 'NOT_FOUND' }, 404) : json(snapshot())
  if (path === '/api/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': open\n\n'); return }
  if (path === '/api/subscription') return json({ subscription: { productId: 'dev.kitepon.bellbot.monthly', environment: 'Production', accessMode: 'developer', setupComplete: true, entitled: false, state: 'none', autoRenewing: false } })
  if (path === '/api/settings') return json({ settings: [] })
  if (path === '/api/harness-auth') return json({ harnesses: [] })
  if (path === '/api/bots') return json({ bots: fixture.bots })
  if (path === '/api/rooms') return json({ rooms: fixture.rooms })
  if (path === '/api/owner') return json({ owner: fixture.owner })
  if (path.endsWith('/messages') || path.endsWith('/timeline') || path.includes('/queue')) return json({ items: [], has_more: false })
  json({ error: 'NOT_FOUND' }, 404)
})
const host = process.env.WORK_GRAPH_FIXTURE_HOST || '127.0.0.1'
server.listen(Number(process.env.WORK_GRAPH_FIXTURE_PORT ?? 0), host, () => console.log(JSON.stringify({ url: `http://${host}:${server.address().port}` })))
