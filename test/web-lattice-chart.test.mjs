import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UNKNOWN_MEMBER, backoffMs, bannerFor, chartCounts, coordinatorBotId, degradedPills, detailOf, diffSnapshots, edgeChipText, edgeGeometry, flowPositions, formatJst, highlightSets,
  layoutChart, layoutTree, historyRows, listItems, memberLookup, ownerLookup, pointOnEdge, railItems, sinceText, waitRows, cardLabel,
} from '../web/lattice-chart-model.js'
import { createChartStream, createLatticeChart } from '../web/lattice-chart.js'

const BASE = Date.parse('2026-11-11T12:00:00Z'), minutesAgo = n => new Date(BASE - n * 60000).toISOString()
const TRONY = 'bot-7b140b27', MOLLY = 'bot-39be7047', FLORA = 'bot-7e777fe5', GHOST = 'bot-ghost0001'
const card = (id, state, producer, depth, extra = {}) => ({ id: `p1/${id}`, plan: 'p1', taskId: id, title: `工程${id}`, doneCondition: '', designMemo: '', state, lane: null, producer, startedAt: null, changedAt: minutesAgo(1), blockedReason: null, depth, ...extra })
const fixture = (extra = {}) => ({
  schema: 'bellteam.lattice-chart.v1', epoch: 'e1', version: 1, at: minutesAgo(0), projectId: 'bellteam', name: 'BellTeam開発', createdBy: TRONY, coordinator: true, state: 'verified', verifiedAt: minutesAgo(0), degraded: [],
  members: [{ botId: TRONY, name: 'トロニー', color: 'indigo', avatarVersion: 'v1' }, { botId: MOLLY, name: 'モリー', color: 'mint', avatarVersion: '' }, { botId: FLORA, name: 'フローラ', color: 'violet', avatarVersion: '' }],
  cards: [
    card('t01', 'done', TRONY, 0, { title: '公開契約の裁定' }),
    card('t02', 'in-progress', MOLLY, 0, { title: '部品の配置と保存場所', startedAt: minutesAgo(12) }),
    card('t03', 'pending', FLORA, 1, { title: '部品の実装', designMemo: '本体をつくる。\n入口は裁定済みの契約だけ。', doneCondition: '席から工程表を読める' }),
    card('t04', 'blocked', GHOST, 1, { title: 'Web画面の組込口', blockedReason: '組込の登録点が未定' }),
    card('t05', 'ready', null, 2, { title: 'iPhone/Mac画面' }),
    card('t06', 'retired', MOLLY, 2, { title: '古い案' }),
  ],
  edges: [{ from: 'p1/t01', to: 'p1/t03', waiting: false }, { from: 'p1/t02', to: 'p1/t03', waiting: true }, { from: 'p1/t04', to: 'p1/t05', waiting: true }],
  waits: [
    { waiter: FLORA, waitingCard: 'p1/t03', forCard: 'p1/t02', producer: MOLLY, producerState: 'in-progress', since: minutesAgo(12) },
    { waiter: null, waitingCard: 'p1/t05', forCard: 'p1/t04', producer: GHOST, producerState: 'blocked', since: minutesAgo(130) },
  ],
  ...extra,
})
const NAMES = { bellteam: 'BellTeam開発', gone: '消えた工程表', a: '設計' }
const chartsList = (...ids) => ({ schema: 'bellteam.lattice-charts.v1', at: '', charts: ids.map((projectId, i) => ({ projectId, name: NAMES[projectId] ?? null, coordinator: i === 0, createdBy: TRONY, counts: { total: 6, done: 2, working: 1, waiting: 2, blocked: 1 }, activeMembers: [MOLLY, GHOST], updatedAt: minutesAgo(3), state: 'verified' })) })

// ---- model ----
test('担当：着手前でも工程表に書かれた担当（lane）の文字を出す。担当なしは lane が空の時だけ', () => {
  const snap = fixture({
    cards: [card('a', 'pending', null, 0, { lane: 'kiro', title: '上限明けの続き' }), card('b', 'pending', null, 1, { lane: 'kiro' }), card('c', 'pending', null, 0)],
    edges: [{ from: 'p1/a', to: 'p1/b', waiting: true }, { from: 'p1/c', to: 'p1/b', waiting: true }],
    waits: [{ waiter: null, waitingCard: 'p1/b', forCard: 'p1/a', producer: null, producerState: 'pending', since: minutesAgo(5) }],
  })
  const owner = ownerLookup(snap)(snap.cards[0])
  assert.deepEqual([owner.name, owner.botId, owner.authored, owner.known], ['kiro', null, true, false])
  assert.equal(ownerLookup(snap)(snap.cards[2]), null)
  const layout = layoutChart(snap)
  assert.deepEqual(layout.lanes.map(lane => lane.member?.name ?? null), ['kiro', null], '書かれた担当のレーン、担当なしは最後')
  assert.equal(railItems(snap, layout).length, 0, 'レールは名簿のメンバーだけ')
  const [row] = waitRows(snap, BASE)
  assert.equal(row.headline, '工程b'); assert.equal(row.ownerText, '担当 kiro'); assert.equal(row.producer.name, 'kiro'); assert.equal(row.canChat, false)
  assert.match(row.state, /担当 kiro/)
  assert.equal(edgeChipText(snap, snap.edges[0]), 'kiroが待っています')
  assert.match(detailOf(snap, 'p1/a', BASE).stateText, /担当 kiro/)
  assert.match(cardLabel(snap.cards[0], owner), /つくっている kiro/)
})

test('ツリー：工程表 -> まとまり -> 工程（親の下）、葉は一行ずつ、親は子の真ん中、依存は右の弧', () => {
  const snap = fixture({ phases: [{ id: 'p1/a', title: '設計' }, { id: 'p1/b', title: null }],
    cards: fixture().cards.map(c => ({ ...c, phase: ['p1/t01', 'p1/t02', 'p1/t03'].includes(c.id) ? 'p1/a' : c.id === 'p1/t04' ? 'p1/b' : null, parent: c.id === 'p1/t03' ? 'p1/t02' : null })) })
  const tree = layoutTree(snap, 'BellTeam開発'), node = key => tree.nodes.find(n => n.key === key)
  assert.deepEqual([node('root').label, node('phase:p1/a').label, node('phase:p1/b').label], ['BellTeam開発', '設計', '名前のないまとまり'])
  assert.ok(node('phase:p1/a').x > node('root').x && node('p1/t01').x > node('phase:p1/a').x && node('p1/t03').x > node('p1/t02').x, '子は親の右')
  assert.equal(node('p1/t05').x, node('phase:p1/a').x, 'まとまりの無い工程は工程表の直下')
  const leaves = ['p1/t01', 'p1/t03', 'p1/t04', 'p1/t05', 'p1/t06'].map(id => node(id).y)
  assert.deepEqual(leaves, [...leaves].sort((a, b) => a - b)); assert.equal(new Set(leaves).size, 5, '葉は一行ずつ')
  assert.equal(node('p1/t02').y, node('p1/t03').y, '子が一つなら同じ高さ')
  assert.equal(node('phase:p1/a').y, (node('p1/t01').y + node('p1/t02').y) / 2, '親は子の真ん中')
  assert.deepEqual([node('phase:p1/a').done, node('phase:p1/a').total, node('phase:p1/a').tone, node('phase:p1/b').tone], [1, 3, 'in-progress', 'blocked'])
  assert.deepEqual(tree.arcs.map(a => [a.key, a.waiting]), [['p1/t01>p1/t03', false], ['p1/t02>p1/t03', true], ['p1/t04>p1/t05', true]])
  assert.equal(tree.links.length, tree.nodes.length - 1, '根以外はどれも一本の線で親につながる')
  assert.ok(tree.width > node('p1/t03').x + node('p1/t03').w)
  const old = layoutTree(fixture(), 'x')
  assert.equal(old.nodes.filter(n => n.kind === 'card').every(n => n.x === old.nodes[0].x + old.nodes[0].w + 36), true, 'phases の無い古い一枚は工程表の直下に並ぶ')
})

test('消えた工程（archived）はツリーにも担当にも描かず、過去ログに新しい順・日ごとに並ぶ', () => {
  const snap = fixture({ phases: [{ id: 'p1/a', title: '下調べ' }, { id: 'p1/b', title: '部品' }],
    cards: fixture().cards.map(c => ({ ...c, phase: c.id === 'p1/t01' ? 'p1/a' : 'p1/b', parent: c.id === 'p1/t03' ? 'p1/t01' : null,
      archived: c.id === 'p1/t01', doneAt: c.id === 'p1/t01' ? minutesAgo(30) : c.id === 'p1/t06' ? minutesAgo(60 * 30) : null })) })
  const tree = layoutTree(snap, 'x'), keys = tree.nodes.map(n => n.key)
  assert.equal(keys.includes('p1/t01'), false); assert.equal(keys.includes('phase:p1/a'), false, '中身が全部消えたまとまりは描かない')
  assert.equal(tree.links.find(l => l.to === 'p1/t03').from, 'phase:p1/b', '消えた親の子は自分のまとまりへ')
  assert.equal(layoutChart(snap).cards.has('p1/t01'), false)
  assert.deepEqual([chartCounts(snap).total, chartCounts(snap).done], [5, 1], '分数は消えた工程を数えない（a96）')
  assert.deepEqual([tree.nodes[0].done, tree.nodes[0].total, tree.nodes.find(n => n.key === 'phase:p1/b').total], [1, 5, 5], 'ツリーの根も上の分数と同じ数')
  const past = historyRows(snap, BASE)
  assert.equal(past.count, 2)
  assert.deepEqual(past.groups.map(g => [g.heading, g.rows.map(r => r.title)]), [['今日', ['公開契約の裁定']], ['昨日', ['古い案']]])
  assert.match(past.groups[0].rows[0].label, /公開契約の裁定、完了、今日 \d\d:\d\d、トロニー/u)
})

test('指揮官（owner）は名前と顔で出し、会話もレールも無し', () => {
  const snap = fixture({ owner: { name: 'クオ', avatar: 'data:x' },
    cards: [card('a', 'pending', 'owner', 0, { title: '端末を更新' }), card('b', 'pending', MOLLY, 1)],
    edges: [{ from: 'p1/a', to: 'p1/b', waiting: true }],
    waits: [{ waiter: MOLLY, waitingCard: 'p1/b', forCard: 'p1/a', producer: 'owner', producerState: 'pending', since: minutesAgo(3) }] })
  const owner = memberLookup(snap)('owner')
  assert.deepEqual([owner.name, owner.owner, owner.avatar], ['クオ', true, '/api/owner/avatar'])
  assert.equal(memberLookup(fixture())('owner').name, '指揮官', 'プロフィール未取得なら指揮官')
  const [row] = waitRows(snap, BASE)
  assert.deepEqual([row.producer.name, row.canChat], ['クオ', false]); assert.match(row.state, /担当 クオ/)
  assert.deepEqual(railItems(snap, layoutChart(snap)).map(item => item.botId), [MOLLY], 'レールはメンバーだけ')
  assert.deepEqual(layoutChart(snap).lanes.map(lane => lane.member?.name), ['クオ', 'モリー'])
})

test('配置：担当ごとのレーン（担当なしは最後）、depth ごとの列、同じ担当・同じ列は縦に積む', () => {
  const layout = layoutChart(fixture())
  assert.deepEqual(layout.lanes.map(lane => lane.botId), [TRONY, FLORA, MOLLY, GHOST, null], '名簿の名前順、名簿にいない担当、担当なし')
  assert.equal(layout.lanes[3].member.known, false)
  const t02 = layout.cards.get('p1/t02'), t03 = layout.cards.get('p1/t03'), t05 = layout.cards.get('p1/t05')
  assert.ok(t02.x < t03.x && t03.x < t05.x, '列は depth の順')
  assert.equal(t02.x, layout.cards.get('p1/t01').x)
  assert.equal(t02.w, 136); assert.equal(t02.h, 104); assert.equal(layout.cards.get('p1/t01').h, 48, '完了は小さい札')
  const stacked = layoutChart({ ...fixture(), cards: [card('a', 'pending', MOLLY, 0), card('b', 'pending', MOLLY, 0)], edges: [], waits: [] })
  const [a, b] = ['p1/a', 'p1/b'].map(id => stacked.cards.get(id))
  assert.equal(a.x, b.x); assert.ok(b.y >= a.y + 104)
  const lane = stacked.lanes[0]; assert.ok(a.y >= lane.y && b.y + b.h <= lane.y + lane.h)
  assert.equal(new Set(layout.order).size, 6)
  const moved = layoutChart({ ...fixture(), cards: fixture().cards.map(c => c.id === 'p1/t05' ? { ...c, producer: MOLLY } : c) })
  assert.equal(moved.cards.get('p1/t01').x, layout.cards.get('p1/t01').x, '深さと担当が同じ札の列は動かない')
})

test('辺の曲線：右中央から左中央、粒は600msごと・1.4秒で進む', () => {
  const g = edgeGeometry({ x: 0, y: 0, w: 136, h: 92 }, { x: 300, y: 200, w: 136, h: 92 })
  assert.deepEqual(pointOnEdge(g, 0), { x: 136, y: 46 }); assert.deepEqual(pointOnEdge(g, 1), { x: 300, y: 246 })
  assert.deepEqual(flowPositions(1400).map(t => +t.toFixed(3)), [0.143, 0.571])
  assert.equal(flowPositions(1000).length, 2)
  assert.ok(flowPositions(5000).every(t => t >= 0 && t < 1) && flowPositions(5000).length <= 3)
})

test('待ちの流れの文：作業中 N分 / 止まり: 理由 / 未着手: 担当 / 担当なし、待った長さ、名簿にないメンバー', () => {
  const rows = waitRows(fixture(), BASE)
  assert.equal(rows[0].headline, '部品の実装'); assert.equal(rows[0].ownerText, '担当 フローラ'); assert.equal(rows[0].title, '部品の配置と保存場所')
  assert.equal(rows[0].state, '作業中 12分'); assert.equal(rows[0].length, '12分'); assert.equal(rows[0].canChat, true); assert.equal(rows[0].emphasized, false)
  assert.equal(rows[0].label, '「部品の実装」（担当 フローラ）は、「部品の配置と保存場所」が終わるのを待っています。つくっているのはモリー、作業中 12分')
  assert.equal(rows[1].headline, 'iPhone/Mac画面'); assert.equal(rows[1].ownerText, '担当なし'); assert.equal(edgeChipText(fixture(), fixture().edges[2]), '次の工程が待っています'); assert.equal(rows[1].state, '止まり: 組込の登録点が未定'); assert.equal(rows[1].length, '2時間10分')
  assert.equal(rows[1].emphasized, true); assert.equal(rows[1].canChat, false); assert.equal(rows[1].producer.name, UNKNOWN_MEMBER)
  const pending = waitRows({ ...fixture(), waits: [{ waiter: TRONY, waitingCard: 'p1/t05', forCard: 'p1/t03', producer: FLORA, producerState: 'pending', since: minutesAgo(1) }] }, BASE)
  assert.equal(pending[0].state, '未着手: 担当 フローラ')
  const none = waitRows({ ...fixture(), waits: [{ waiter: TRONY, waitingCard: 'p1/t03', forCard: 'p1/t05', producer: null, producerState: 'ready', since: minutesAgo(0) }] }, BASE)
  assert.equal(none[0].state, '担当なし'); assert.equal(none[0].length, '1分未満')
  assert.equal(sinceText(minutesAgo(60 * 25), BASE), '1日')
  assert.equal(edgeChipText(fixture(), fixture().edges[1]), 'フローラが待っています')
})

test('件数・強調・レール・詳細・一覧の項目', () => {
  assert.deepEqual(chartCounts(fixture()), { total: 6, done: 2, working: 1, blocked: 1, waiting: 2 })
  const layout = layoutChart(fixture())
  const rail = railItems(fixture(), layout)
  assert.deepEqual(rail.find(item => item.botId === MOLLY), { botId: MOLLY, member: memberLookup(fixture())(MOLLY), working: true, blocked: false, waiting: 0 })
  assert.equal(rail.find(item => item.botId === FLORA).waiting, 1); assert.equal(rail.find(item => item.botId === GHOST).blocked, true)
  assert.equal(highlightSets(fixture(), null), null)
  const sets = highlightSets(fixture(), MOLLY); assert.ok(sets.cards.has('p1/t02') && !sets.cards.has('p1/t03')); assert.ok(sets.waits.has('p1/t03>p1/t02') && !sets.waits.has('p1/t05>p1/t04'))
  const detail = detailOf(fixture(), 'p1/t03', BASE)
  assert.deepEqual(detail.previous.map(item => item.id), ['p1/t01', 'p1/t02']); assert.deepEqual(detail.next, [])
  assert.equal(detail.startedText, 'まだ着手されていません'); assert.equal(detailOf(fixture(), 'p1/t02', BASE).startedText, '着手 11月11日 20:48 JST')
  assert.equal(detailOf(fixture(), 'nope', BASE), null)
  const items = listItems(chartsList('a', 'b'), id => id === MOLLY ? { botId: id, name: 'モリー', color: 'mint', avatar: '', known: true } : id === TRONY ? { botId: id, name: 'トロニー', known: true } : null)
  assert.deepEqual(items.map(item => item.name), ['設計', 'トロニーの工程表'], '名前が無ければ作った人の工程表')
  assert.equal(items[0].coordinator, true); assert.equal(items[0].waitingText, '待ち 2'); assert.equal(items[0].members[1].name, UNKNOWN_MEMBER)
  assert.equal(coordinatorBotId(chartsList('a', 'b')), TRONY); assert.equal(coordinatorBotId({ charts: [] }), null)
  assert.equal(cardLabel(fixture().cards[1], memberLookup(fixture())(MOLLY)), '部品の配置と保存場所、作業中、つくっている モリー')
  assert.equal(cardLabel(fixture().cards[4], null), 'iPhone/Mac画面、着手可、つくっている 担当なし')
})

test('帯と読み直しの文は状態から決まり、コードも理由も出さない', () => {
  assert.equal(bannerFor(fixture()), null)
  assert.deepEqual(bannerFor(fixture({ state: 'unverified' })), { tone: 'amber', glyph: 'tri', text: '工程表の記録に食い違いがあります。読める分だけ表示しています。', talk: true, dim: false })
  const last = bannerFor(fixture({ state: 'last_verified', verifiedAt: '2026-11-11T12:05:00Z' }))
  assert.equal(last.text, 'いまの記録が読めないため、最後に確認できた状態（11月11日 21:05 JST）を表示しています。'); assert.equal(last.dim, true)
  assert.equal(bannerFor(fixture({ state: 'unavailable' })), null)
  assert.deepEqual(degradedPills(fixture({ degraded: ['lattice-read', 'members', 'other'] })), ['最新の記録を読み直しています…', 'メンバー情報を読み直しています…'])
  assert.equal(formatJst('2026-11-11T15:30:00Z'), '11月12日 00:30')
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(i => backoffMs(i, () => 0.5)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('差分：増えた・消えた・状態が変わった・完了になった札と辺', () => {
  const next = fixture({ cards: [...fixture().cards.filter(c => c.id !== 'p1/t06').map(c => c.id === 'p1/t02' ? { ...c, state: 'done' } : c), card('t07', 'pending', null, 3)], edges: [fixture().edges[0], { from: 'p1/t03', to: 'p1/t07', waiting: true }] })
  assert.deepEqual(diffSnapshots(null, next), { first: true, addedCards: [], removedCards: [], changedCards: [], completedCards: [], addedEdges: [], removedEdges: [] })
  assert.deepEqual(diffSnapshots(fixture(), next), { first: false, addedCards: ['p1/t07'], removedCards: ['p1/t06'], changedCards: ['p1/t02'], completedCards: ['p1/t02'], addedEdges: ['p1/t03>p1/t07'], removedEdges: ['p1/t02>p1/t03', 'p1/t04>p1/t05'] })
})

test('別の工程表の前の工程：待ちの流れと詳細に題名・工程表の名前・開き先が出る。読めていない状態、題名なし、辺があっても配置と差分は壊れない', () => {
  const ext = { id: 'lattice:l1/release', projectId: 'lattice', cardId: 'l1/release', chartName: 'Lattice', title: '0.99.0 を出す', state: 'in-progress', finished: false, producer: MOLLY }
  const snap = fixture({
    externals: [ext, { id: 'lattice:l1/none', projectId: 'lattice', cardId: 'l1/none', chartName: null, title: null, state: null, finished: false, producer: null }],
    edges: [...fixture().edges, { from: ext.id, to: 'p1/t05', waiting: true, external: true }, { from: 'lattice:l1/none', to: 'p1/t05', waiting: true, external: true }],
    waits: [
      { waiter: null, waitingCard: 'p1/t05', forCard: ext.id, producer: MOLLY, producerState: 'in-progress', since: minutesAgo(5) },
      { waiter: FLORA, waitingCard: 'p1/t05', forCard: 'lattice:l1/none', producer: null, producerState: null, since: minutesAgo(3) },
      ...fixture().waits,
    ],
  })
  const [a, b, c] = waitRows(snap, BASE)
  assert.equal(a.title, '0.99.0 を出す'); assert.equal(a.chart, 'Latticeの工程表'); assert.deepEqual(a.external, { projectId: 'lattice', cardId: 'l1/release' })
  assert.equal(a.state, '作業中'); assert.equal(a.producer.name, 'モリー'); assert.equal(a.canChat, true)
  assert.equal(a.label, '「iPhone/Mac画面」（担当なし）は、「0.99.0 を出す」（Latticeの工程表）が終わるのを待っています。つくっているのはモリー、作業中')
  assert.equal(b.title, 'ほかの工程表の工程'); assert.equal(b.chart, 'ほかの工程表の工程表'); assert.equal(b.state, '読めていません'); assert.equal(b.producer, null); assert.equal(b.canChat, false)
  assert.equal(c.chart, null); assert.equal(c.external, null)
  const previous = detailOf(snap, 'p1/t05', BASE).previous
  assert.deepEqual(previous.map(item => item.id), ['p1/t04', ext.id, 'lattice:l1/none'])
  assert.equal(previous[1].title, '0.99.0 を出す'); assert.equal(previous[1].chart, 'Latticeの工程表'); assert.equal(previous[1].producer.name, 'モリー'); assert.equal(previous[1].stateText, '作業中')
  assert.deepEqual(previous[1].external, { projectId: 'lattice', cardId: 'l1/release' }); assert.equal(previous[0].external, undefined)
  assert.equal(previous[2].title, 'ほかの工程表の工程'); assert.equal(previous[2].stateText, '読めていません'); assert.equal(previous[2].state, null)
  assert.equal(detailOf(snap, ext.id, BASE), null)
  assert.doesNotThrow(() => { layoutChart(snap); layoutTree(snap); highlightSets(snap, MOLLY) })
  assert.equal(layoutTree(snap).arcs.some(arc => arc.from === ext.id), false)
  assert.equal(chartCounts(snap).waiting, chartCounts(fixture()).waiting)
  assert.deepEqual(diffSnapshots(fixture(), snap).addedEdges, [`${ext.id}>p1/t05`, 'lattice:l1/none>p1/t05'])
})

// ---- view ----
class Text { constructor(text) { this.nodeType = 3; this.textContent = text } }
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = new Map(); this.dataset = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.style = { setProperty: (k, v) => { this.style[k] = v } }; this.open = false; this.parent = null }
  get textContent() { return this.children.map(c => c.nodeType === 3 ? c.textContent : c.textContent).join('') }
  set textContent(v) { this.children = [new Text(String(v))] }
  get classList() { const el = this; return { add: n => { if (!el.className.split(' ').includes(n)) el.className = `${el.className} ${n}`.trim() }, remove: n => { el.className = el.className.split(' ').filter(c => c && c !== n).join(' ') }, contains: n => el.className.split(' ').includes(n), toggle(n, force) { const on = force ?? !this.contains(n); on ? this.add(n) : this.remove(n); return on } } }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else this.attrs.set(k, String(v)) }
  getAttribute(k) { return k === 'class' ? this.className : this.attrs.get(k) ?? null }
  append(...nodes) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n) } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes) }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener() {}
  fire(type, event = {}) { const e = { target: this, preventDefault() { this.prevented = true }, ...event }; for (const fn of this.listeners[type] ?? []) fn(e); return e }
  click() { return this.fire('click') }
  focus() { document.activeElement = this }
  closest() { return null }
  scrollTo(options) { this.scrolled = options }
  showModal() { this.open = true }
  close() { this.open = false; this.fire('close') }
  find(pred) { return all(this).filter(pred) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
  querySelectorAll(sel) { const key = sel.slice(1, -1).replace(/^data-/u, '').replace(/-./gu, m => m[1].toUpperCase()); return all(this).filter(el => el.dataset && key in el.dataset) }
}
const all = root => root.children.flatMap(c => c.nodeType === 3 ? [] : [c, ...all(c)])
const textOf = el => el.textContent
const byClass = (root, name) => all(root).filter(el => el.className.split(' ').includes(name))
const buttonByText = (root, text) => all(root).find(el => el.tagName === 'button' && textOf(el).includes(text))

function setup(t, { api, fetchImage, reduce = false, getMember = () => null, mode = 'lanes' } = {}) {
  const saved = Object.fromEntries(['document', 'matchMedia'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  globalThis.document = { createElement: tag => new El(tag), createElementNS: (ns, tag) => new El(tag), createTextNode: s => new Text(s), addEventListener() {}, removeEventListener() {}, activeElement: null, hidden: false }
  globalThis.matchMedia = () => ({ matches: reduce })
  t.after(() => { for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k] })
  const dialog = new El('dialog'), body = new El('div'), pill = new El('p'); pill.hidden = true
  dialog.querySelector = sel => sel === '[data-lattice-body]' ? body : sel === '[data-lattice-pill]' ? pill : null
  dialog.querySelectorAll = () => []
  dialog.addEventListener('close', () => view.close())
  const clock = { now: BASE, next: 1, timers: new Map() }
  const frames = [], opened = []
  const view = createLatticeChart(dialog, {
    api, fetchImage, getMember, mode, openChat: botId => opened.push(botId), now: () => clock.now,
    setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.set(id, { fn, at: clock.now + ms }); return id }, clearTimeout: id => clock.timers.delete(id), random: () => 0.5,
    requestFrame: fn => { frames.push(fn); return frames.length }, cancelFrame() {},
  })
  const advance = async ms => {
    const end = clock.now + ms
    for (;;) {
      const due = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      clock.timers.delete(due[0]); clock.now = Math.max(clock.now, due[1].at); due[1].fn(); await flush()
    }
    clock.now = end; await flush()
  }
  return { dialog, body, pill, view, frames, opened, advance, clock }
}
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)) }
const sse = () => {
  const queue = [], waiters = [], encoder = new TextEncoder()
  const push = chunk => { const item = chunk === null ? { done: true } : { done: false, value: encoder.encode(chunk) }; if (waiters.length) waiters.shift()(item); else queue.push(item) }
  return { response: { ok: true, status: 200, body: { getReader: () => ({ read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)) }) } }, snapshot: data => push(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`), end: () => push(null) }
}
const router = ({ streams = [], avatars = true } = {}) => {
  const calls = []
  return { calls, fetchImage: async (url, options) => {
    calls.push(url)
    if (url.includes('/avatar')) return avatars ? { ok: true, status: 200, blob: async () => new Blob(['x']) } : { ok: false, status: 404 }
    const next = streams.shift()
    if (!next) return new Promise(() => {})
    return typeof next === 'function' ? next(options) : next.response ?? next
  } }
}

test('開く：一覧（統括が先頭）→ 工程表。札は状態の記号と文字、待ちの流れは誰が何を待ち誰がつくっているか', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async path => { assert.equal(path, '/api/lattice/charts'); return chartsList('bellteam', 'other') }, fetchImage: net.fetchImage, getMember: id => id === MOLLY ? { botId: id, name: 'モリー', color: 'mint', avatar: '/api/bots/bot-39be7047/avatar?v=3', known: true } : null })
  ui.view.open(); await flush()
  assert.equal(ui.dialog.open, true)
  const cards = byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button')
  assert.equal(cards.length, 2); assert.match(textOf(cards[0]), /BellTeam開発.*統括/u); assert.match(textOf(cards[0]), /待ち 2/u)
  assert.match(textOf(ui.body), /工程表はメンバーがLatticeでつくります。権限も参加登録もなく、誰でも開けます。/u)
  assert.equal(net.calls.some(u => u.includes(MOLLY)), true, '一覧の顔は fetchImage で取る')
  cards[0].click(); await flush()
  assert.deepEqual(net.calls.filter(u => u.includes('/events')), ['/api/lattice/charts/bellteam/events'])
  feed.snapshot(fixture()); await flush()
  const cardEls = byClass(ui.body, 'lattice-card')
  assert.equal(cardEls.length, 6)
  const t02 = cardEls.find(el => el.dataset.cardId === 'p1/t02')
  assert.equal(t02.getAttribute('aria-label'), '部品の配置と保存場所、作業中、つくっている モリー')
  assert.match(textOf(t02), /作業中/u); assert.match(textOf(t02), /12分/u)
  assert.ok(t02.className.includes('is-working')); assert.ok(cardEls.find(el => el.dataset.cardId === 'p1/t04').className.includes('is-blocked'))
  assert.match(textOf(cardEls.find(el => el.dataset.cardId === 'p1/t04')), /止まり.*組込の登録点が未定/su)
  assert.match(textOf(cardEls.find(el => el.dataset.cardId === 'p1/t05')), /着手可.*担当なし/su)
  assert.ok(cardEls.find(el => el.dataset.cardId === 'p1/t01').className.includes('is-done'))
  const rows = byClass(ui.body, 'wr')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].getAttribute('aria-label'), '「部品の実装」（担当 フローラ）は、「部品の配置と保存場所」が終わるのを待っています。つくっているのはモリー、作業中 12分')
  assert.match(textOf(rows[0]), /部品の実装.*待ち 12分.*担当 フローラ.*この工程が終わるのを待っています.*部品の配置と保存場所.*つくっている.*モリー.*作業中 12分/su)
  assert.match(textOf(rows[1]), /iPhone\/Mac画面.*担当なし.*Web画面の組込口.*名簿にないメンバー.*止まり: 組込の登録点が未定/su)
  assert.ok(rows[1].className.includes('em'), '止まりの担当を待つ行は強調')
  assert.equal(buttonByText(rows[1], '会話を開く'), undefined, '名簿にない担当には会話を開かない')
  assert.match(textOf(ui.body), /2\/6/u); assert.match(textOf(ui.body), /作業中 1/u); assert.match(textOf(ui.body), /待ち 2/u); assert.match(textOf(ui.body), /止まり 1/u)
  assert.equal(byClass(ui.body, 'lattice-chip').length, 2); assert.match(textOf(byClass(ui.body, 'lattice-chip')[0]), /フローラが待っています/u)
  assert.equal(byClass(ui.body, 'lattice-live')[0].hidden, false)
  ui.view.close()
})

test('工程表が一つだけなら、そのまま工程表へ。会話を開くは担当の席へ、閉じて開き直すと同じ工程表に戻る', async t => {
  const feed = sse(), feed2 = sse(), net = router({ streams: [feed, feed2] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage })
  ui.view.open(); await flush()
  assert.deepEqual(net.calls.filter(u => u.includes('/events')), ['/api/lattice/charts/bellteam/events'])
  assert.equal(byClass(ui.body, 'lattice-cc').length, 0)
  feed.snapshot(fixture()); await flush()
  buttonByText(byClass(ui.body, 'wr')[0], '会話を開く').click()
  assert.deepEqual(ui.opened, [MOLLY])
  ui.dialog.close(); assert.equal(ui.dialog.open, false)
  ui.view.open(); await flush(); feed2.snapshot(fixture()); await flush()
  assert.equal(byClass(ui.body, 'lattice-card').length, 6)
  buttonByText(ui.body, 'BellTeam開発').click(); await flush()
  assert.equal(byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button').length, 1, '切替は一覧へ')
  const back = byClass(ui.body, 'lattice-back')[0]
  assert.equal(back.getAttribute('aria-label'), 'BellTeam開発へ戻る', '一覧から来た工程表へ戻れる')
  back.click(); await flush()
  assert.equal(byClass(ui.body, 'lattice-cc').length, 0); assert.equal(byClass(ui.body, 'lattice-back').length, 0)
  ui.view.close()
})

test('メンバーの工程表ボタン：open(projectId) は一覧を飛ばしてその工程表へ。左上の「すべての工程表」で一覧、戻ると同じ工程表（a90 a94）', async t => {
  const feed = sse(), feed2 = sse(), net = router({ streams: [feed, feed2] })
  const ui = setup(t, { api: async () => chartsList('bellteam', 'other'), fetchImage: net.fetchImage })
  ui.view.open('other'); await flush()
  assert.deepEqual(net.calls.filter(u => u.includes('/events')), ['/api/lattice/charts/other/events'], '工程表が二つでも指定の工程表を直接開く')
  feed.snapshot(fixture()); await flush()
  const toolbar = byClass(ui.body, 'lattice-toolbar')[0], all = toolbar.children[0]
  assert.ok(all.className.includes('lattice-all')); assert.equal(textOf(all), 'すべての工程表', '帯の一番左')
  all.click(); await flush()
  assert.equal(byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2)
  byClass(ui.body, 'lattice-back')[0].click(); await flush()
  assert.deepEqual(net.calls.filter(u => u.includes('/events')), ['/api/lattice/charts/other/events', '/api/lattice/charts/other/events'])
  ui.dialog.close()
  ui.view.open('gone'); await flush()
  assert.equal(byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2, '一覧に無い工程表なら一覧')
  ui.view.close()
})

test('待ちの流れ（広い画面）：畳んだ取っ手（数、止まりがあれば赤）から始まり、取っ手で開き×で畳む。開き直しても覚えている', async t => {
  const feed = sse(), feed2 = sse(), net = router({ streams: [feed, feed2] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage })
  ui.view.open(); await flush(); feed.snapshot(fixture()); await flush()
  const main = () => byClass(ui.body, 'lattice-main')[0], fold = () => byClass(ui.body, 'lattice-wfold')[0]
  assert.equal(main().classList.contains('is-folded'), true)
  assert.equal(textOf(fold()), '2'); assert.equal(fold().classList.contains('is-red'), true); assert.equal(fold().getAttribute('aria-label'), '待ちの流れを開く、待ち 2')
  fold().click()
  assert.equal(main().classList.contains('is-folded'), false); assert.equal(document.activeElement.getAttribute('aria-label'), '待ちの流れを閉じる')
  ui.dialog.close(); ui.view.open(); await flush(); feed2.snapshot(fixture({ waits: fixture().waits.slice(0, 1) })); await flush()
  assert.equal(main().classList.contains('is-folded'), false, 'ページが生きている間は開いたまま')
  assert.equal(fold().classList.contains('is-red'), false)
  byClass(ui.body, 'wp-x')[0].click()
  assert.equal(main().classList.contains('is-folded'), true); assert.equal(document.activeElement, fold())
  ui.view.close()
})

test('古いサーバー（一覧が404）は閉じるだけの案内。一覧が空の案内。どちらも自動で直る', async t => {
  let mode = 'old'
  const ui = setup(t, { api: async () => { if (mode === 'old') throw Object.assign(new Error('x'), { status: 404 }); return mode === 'empty' ? { charts: [] } : chartsList('a', 'b') }, fetchImage: router().fetchImage })
  ui.view.open(); await flush()
  assert.equal(textOf(ui.body).includes('このサーバーではまだ工程表を使えません。'), true); assert.equal(ui.pill.hidden, true)
  assert.ok(buttonByText(ui.body, '閉じる'))
  mode = 'empty'; await ui.advance(10000)
  assert.equal(textOf(ui.body).includes('工程表はまだありません。メンバーがLatticeで工程をつくると、ここに並びます。'), true)
  mode = 'ok'; await ui.advance(10000)
  assert.equal(byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2)
  ui.view.close()
})

test('503・切断：上に「工程表に再接続しています…」、1,2,4…秒で戻り続け、新しい一枚で消える', async t => {
  const feed = sse(), net = router({ streams: [{ ok: false, status: 503 }, { ok: false, status: 503 }, feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage })
  ui.view.open(); await flush()
  assert.equal(ui.pill.hidden, false); assert.match(textOf(ui.pill), /工程表に再接続しています…/u)
  await ui.advance(1000); assert.equal(net.calls.filter(u => u.includes('/events')).length, 2); assert.equal(ui.pill.hidden, false)
  await ui.advance(1999); assert.equal(net.calls.filter(u => u.includes('/events')).length, 2)
  await ui.advance(1); assert.equal(net.calls.filter(u => u.includes('/events')).length, 3)
  feed.snapshot(fixture()); await flush()
  assert.equal(ui.pill.hidden, true); assert.equal(byClass(ui.body, 'lattice-chart')[0].className.includes('is-stale'), false)
  feed.end(); await flush()
  assert.equal(ui.pill.hidden, false); assert.ok(byClass(ui.body, 'lattice-chart')[0].className.includes('is-stale'), '切れたら描画は薄く')
  assert.equal(byClass(ui.body, 'lattice-card').length, 6, '最後の描画は残る')
  ui.view.close()
  assert.equal(ui.pill.hidden, true)
})

test('一覧の取得が503でも再接続の帯を出して戻り続ける', async t => {
  let fail = 2
  const ui = setup(t, { api: async () => { if (fail-- > 0) throw Object.assign(new Error('x'), { status: 503 }); return chartsList('a', 'b') }, fetchImage: router().fetchImage })
  ui.view.open(); await flush()
  assert.match(textOf(ui.pill), /工程表に再接続しています…/u)
  await ui.advance(1000); assert.equal(ui.pill.hidden, false)
  await ui.advance(2000); assert.equal(ui.pill.hidden, true); assert.equal(byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2)
  ui.view.close()
})

test('工程表が見つからない（404 LATTICE_CHART_NOT_FOUND）は案内し、一覧へ戻れる。再接続はしない', async t => {
  const net = router({ streams: [{ ok: false, status: 404, json: async () => ({ error: 'LATTICE_CHART_NOT_FOUND' }) }] })
  const ui = setup(t, { api: async () => chartsList('gone', 'other'), fetchImage: net.fetchImage })
  ui.view.open(); await flush()
  buttonByText(ui.body, '消えた工程表').click(); await flush()
  assert.equal(textOf(ui.body).includes('この工程表は見つかりません。'), true); assert.equal(textOf(ui.body).includes('LATTICE'), false)
  await ui.advance(60000); assert.equal(net.calls.filter(u => u.includes('/events')).length, 1)
  buttonByText(ui.body, '一覧へ戻る').click(); await flush()
  assert.equal(byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2)
  ui.view.close()
  // 本文のない404（古いサーバー）は「使えません」。
  const older = router({ streams: [{ ok: false, status: 404, json: async () => { throw new Error('html') } }] }), old = setup(t, { api: async () => chartsList('a', 'b'), fetchImage: older.fetchImage })
  old.view.open(); await flush(); buttonByText(old.body, '設計').click(); await flush()
  assert.equal(textOf(old.body).includes('このサーバーではまだ工程表を使えません。'), true)
  old.view.close()
})

test('ツリーが最初の表示：小さな箱をタップで詳細、ツリー / 担当 で切り替え', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage, mode: 'tree' })
  ui.view.open(); await flush()
  feed.snapshot(fixture({ phases: [{ id: 'p1/a', title: '設計' }], cards: fixture().cards.map(c => ({ ...c, phase: 'p1/a', parent: null })) })); await flush()
  const boxes = byClass(ui.body, 'lattice-tbox')
  assert.equal(boxes.length, 6); assert.equal(byClass(ui.body, 'lattice-card').length, 0)
  assert.match(textOf(ui.body), /設計/u)
  const t02 = boxes.find(el => el.dataset.cardId === 'p1/t02')
  assert.equal(t02.getAttribute('aria-label'), '部品の配置と保存場所、作業中、つくっている モリー')
  t02.click(); await flush()
  assert.match(textOf(byClass(ui.body, 'lattice-sheet')[0]), /部品の配置と保存場所/u)
  buttonByText(ui.body, '担当').click(); await flush()
  assert.equal(byClass(ui.body, 'lattice-card').length, 6)
  assert.equal(byClass(ui.body, 'lattice-tree')[0].hidden, true)
  assert.match(textOf(byClass(ui.body, 'lattice-sheet')[0]), /部品の配置と保存場所/u, '詳細は切り替えても開いたまま')
})

test('過去ログ：切り替えで終わった工程を新しい順に出し、行のタップで詳細', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage, mode: 'tree' })
  ui.view.open(); await flush()
  feed.snapshot(fixture({ cards: fixture().cards.map(c => ({ ...c, archived: c.id === 'p1/t01', doneAt: c.id === 'p1/t01' ? minutesAgo(5) : null })) })); await flush()
  assert.equal(byClass(ui.body, 'lattice-tbox').some(el => el.dataset.cardId === 'p1/t01'), false, '消えた工程はツリーに出ない')
  const tab = buttonByText(ui.body, '過去ログ'); assert.equal(textOf(tab), '過去ログ 2')
  tab.click(); await flush()
  const rows = byClass(ui.body, 'lattice-hrow')
  assert.deepEqual(rows.map(el => el.dataset.cardId), ['p1/t01', 'p1/t06'])
  rows[0].click(); await flush()
  assert.match(textOf(byClass(ui.body, 'lattice-sheet')[0]), /公開契約の裁定/u)
})

test('詳細：札で開く（設計メモ・終了条件・前の工程/次の工程）、前後をたどる、閉じる・Esc で戻る', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage })
  ui.view.open(); await flush(); feed.snapshot(fixture()); await flush()
  const sheet = byClass(ui.body, 'lattice-sheet')[0]
  assert.equal(sheet.hidden, true)
  byClass(ui.body, 'lattice-card').find(el => el.dataset.cardId === 'p1/t03').click()
  assert.equal(sheet.hidden, false)
  const text = textOf(sheet)
  assert.match(text, /部品の実装/u); assert.match(text, /フローラ · 未着手: 担当 フローラ/u); assert.match(text, /設計メモ/u); assert.match(text, /本体をつくる。\n入口は裁定済みの契約だけ。/u)
  assert.match(text, /終了条件/u); assert.match(text, /席から工程表を読める/u); assert.match(text, /前の工程 · 2/u); assert.match(text, /まだ着手されていません/u)
  assert.ok(byClass(ui.body, 'lattice-card').find(el => el.dataset.cardId === 'p1/t03').className.includes('sel'))
  buttonByText(sheet, '部品の配置と保存場所').click()
  assert.match(textOf(sheet), /^部品の配置と保存場所/u); assert.match(textOf(sheet), /着手 11月11日 20:48 JST/u); assert.match(textOf(sheet), /次の工程 · 1/u)
  assert.ok(ui.body.find(el => el.className.includes('lattice-canvas'))[0].scrolled, '前後の工程へはキャンバスが追う')
  const esc = ui.dialog.fire('cancel'); assert.equal(esc.prevented, true); assert.equal(sheet.hidden, true)
  byClass(ui.body, 'lattice-card').find(el => el.dataset.cardId === 'p1/t04').click()
  assert.equal(sheet.hidden, false)
  all(sheet).find(el => el.getAttribute('aria-label') === '詳細を閉じる').click()
  assert.equal(sheet.hidden, true); assert.equal(ui.dialog.fire('cancel').prevented, undefined, '詳細が無い時の Esc はダイアログを閉じる')
  // 待ちの流れ「工程へ移動」：その札の詳細が開く
  buttonByText(byClass(ui.body, 'wr')[0], '工程へ移動').click()
  assert.equal(sheet.hidden, false); assert.match(textOf(sheet), /部品の配置と保存場所/u)
  ui.view.close()
})

test('帯：食い違い・最後に確認した状態（統括と話す）、読めない、読み直し。担当の強調はタップで切り替わる', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage })
  ui.view.open(); await flush()
  feed.snapshot(fixture({ version: 2, state: 'unverified' })); await flush()
  const banner = byClass(ui.body, 'lattice-banner')[0]
  assert.equal(textOf(banner), '工程表の記録に食い違いがあります。読める分だけ表示しています。統括と話す')
  buttonByText(banner, '統括と話す').click(); assert.deepEqual(ui.opened, [TRONY])
  feed.snapshot(fixture({ version: 3, state: 'last_verified', verifiedAt: '2026-11-11T12:05:00Z' })); await flush()
  assert.match(textOf(byClass(ui.body, 'lattice-banner')[0]), /最後に確認できた状態（11月11日 21:05 JST）/u)
  assert.ok(byClass(ui.body, 'lattice-chart')[0].className.includes('is-dim'))
  feed.snapshot(fixture({ version: 4, degraded: ['lattice-read', 'members'] })); await flush()
  assert.equal(byClass(ui.body, 'lattice-banner').length, 0); assert.match(textOf(ui.pill), /最新の記録を読み直しています….*メンバー情報を読み直しています…/su)
  // 強調
  const rail = byClass(ui.body, 'lattice-ri'), molly = rail.find(el => el.getAttribute('aria-label').startsWith('モリー'))
  assert.equal(molly.getAttribute('aria-label'), 'モリー、作業中')
  molly.click()
  const dimmed = () => byClass(ui.body, 'lattice-card').filter(el => el.className.split(' ').includes('dim')).map(el => el.dataset.cardId).sort()
  assert.deepEqual(dimmed(), ['p1/t01', 'p1/t03', 'p1/t04', 'p1/t05'])
  assert.equal(byClass(ui.body, 'lattice-ri').find(el => el.getAttribute('aria-label').startsWith('モリー')).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(byClass(ui.body, 'wr').map(el => el.className.includes('dim')), [false, true])
  byClass(ui.body, 'lattice-ri').find(el => el.getAttribute('aria-label').startsWith('モリー')).click(); assert.deepEqual(dimmed(), [])
  feed.snapshot(fixture({ version: 5, state: 'unavailable', cards: [], edges: [], waits: [], members: [] })); await flush()
  assert.equal(textOf(ui.body).includes('この工程表はまだ読めません。'), true)
  feed.snapshot(fixture({ version: 6 })); await flush()
  assert.equal(byClass(ui.body, 'lattice-card').length, 6, '記録が整えば自動で戻る')
  ui.view.close()
})

test('画面に出る文字と読み上げに、id・コード・パスは出ない。名簿にいない担当は「名簿にないメンバー」', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam', 'other'), fetchImage: net.fetchImage })
  ui.view.open(); await flush()
  const forbidden = /bot-[0-9a-z]{6,}|p1\/t\d|LATTICE_|\/api\/|unverified|degraded|lattice-read|blob:/u
  const seen = () => [textOf(ui.body), textOf(ui.pill), ...all(ui.body).flatMap(el => ['aria-label', 'title'].map(k => el.attrs.get(k)).filter(Boolean))].join('\n')
  assert.doesNotMatch(seen(), forbidden); assert.match(seen(), /名簿にないメンバー/u, '一覧の顔：名簿に引けない子')
  const projectIds = /bellteam|(?<![a-z])other(?![a-z])/u
  const listCards = byClass(ui.body, 'lattice-cc').filter(el => el.tagName === 'button')
  assert.deepEqual(listCards.map(el => el.dataset.focusKey), ['bellteam', 'other'])
  assert.doesNotMatch(seen(), projectIds, '一覧の札：プロジェクトIDではなく名前')
  assert.match(textOf(listCards[0]), /BellTeam開発/u); assert.match(textOf(listCards[1]), /名前のない工程表/u, '名前が無く作った人も引けない')
  buttonByText(ui.body, 'BellTeam開発').click(); await flush(); feed.snapshot(fixture({ state: 'unverified', degraded: ['members'] })); await flush()
  const shown = seen()
  assert.doesNotMatch(shown, projectIds, '工程表の上端：プロジェクトIDではなく名前')
  assert.equal(all(ui.body).some(el => el.attrs.get('aria-label') === 'BellTeam開発、工程表の一覧へ'), true)
  assert.doesNotMatch(shown, forbidden); assert.match(shown, /名簿にないメンバー/u)
  byClass(ui.body, 'lattice-card').find(el => el.dataset.cardId === 'p1/t04').click()
  assert.doesNotMatch(seen(), forbidden)
  ui.view.close()
})

test('動き：待ちの辺に粒が流れる（動きを減らす設定では出さない）、30秒ごとに分の表示を更新する', async t => {
  const feed = sse(), net = router({ streams: [feed] })
  const ui = setup(t, { api: async () => chartsList('bellteam'), fetchImage: net.fetchImage })
  ui.view.open(); await flush(); feed.snapshot(fixture()); await flush()
  assert.equal(ui.frames.length, 1)
  ui.frames.shift()()
  const dots = all(ui.body).filter(el => el.tagName === 'circle' && el.getAttribute('r') === '3.5')
  assert.equal(dots.length, 6); assert.ok(dots.some(dot => dot.getAttribute('cx') !== null && Number(dot.getAttribute('opacity')) > 0))
  assert.equal(ui.frames.length, 1, '次のコマ')
  await ui.advance(12 * 60000)
  assert.match(textOf(byClass(ui.body, 'wr')[0]), /待ち 24分/u); assert.match(textOf(byClass(ui.body, 'wr')[0]), /作業中 24分/u)
  ui.view.close()
  const feed2 = sse()
  const reduced = setup(t, { api: async () => chartsList('bellteam'), fetchImage: router({ streams: [feed2] }).fetchImage, reduce: true })
  reduced.view.open(); await flush(); feed2.snapshot(fixture()); await flush()
  assert.equal(reduced.frames.length, 0, '動きを減らす設定では粒を動かさない')
  reduced.view.close()
})

test('SSE：snapshot だけ読み、35秒の無音・空の終わり・壊れたJSON・別のschemaは再接続、404は止まる', async () => {
  const statuses = [], snapshots = [], timers = []
  const body = text => ({ ok: true, status: 200, body: { getReader() { let sent = false; return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new TextEncoder().encode(text) } } } } } })
  const responses = [{ ok: false, status: 503 }, body(': hb\n\nevent: snapshot\ndata: {"v":1}\n\n'), body('event: snapshot\ndata: not-json\n\n'), { ok: false, status: 404, json: async () => ({ error: 'LATTICE_CHART_NOT_FOUND' }) }]
  const stream = createChartStream({
    fetch: async () => responses.shift() ?? new Promise(() => {}), url: '/x',
    setTimeout: (fn, ms) => { if (ms === 35000) return 0; timers.push(ms); queueMicrotask(fn); return timers.length }, clearTimeout() {}, random: () => 0.5,
    onSnapshot: data => snapshots.push(data), onStatus: status => statuses.push(status),
  })
  stream.start()
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve))
  stream.stop()
  assert.deepEqual(statuses, ['unreadable', 'live', 'drop', 'unreadable', 'notfound'])
  assert.deepEqual(snapshots, [{ v: 1 }])
  assert.deepEqual(timers, [1000, 1000, 2000], '成功したら間隔は1秒から数え直す')
})
