// 工程表の画面の計算（DOM なし）。データは docs/architecture/modules/lattice/README.md の公開契約、見た目と動きは screen-spec.md。
export const ACCENTS = { violet: '#6147D4', rose: '#E86B94', indigo: '#4559C2', sky: '#47A1E3', mint: '#2EB29E', amber: '#E89E47' }
export const accent = color => ACCENTS[color] ?? ACCENTS.violet
export const RED = '#E0533D'
export const SCHEMA = 'bellteam.lattice-chart.v1'
export const UNKNOWN_MEMBER = '名簿にないメンバー'
export const UNASSIGNED = '担当なし'
export const OWNER_ID = 'owner', OWNER_FALLBACK = '指揮官'

export const MESSAGES = {
  reconnect: '工程表に再接続しています…',
  listEmpty: '工程表はまだありません。メンバーがLatticeで工程をつくると、ここに並びます。',
  newChart: '工程表はメンバーがLatticeでつくります。権限も参加登録もなく、誰でも開けます。',
  oldServer: 'このサーバーではまだ工程表を使えません。',
  notFound: 'この工程表は見つかりません。',
  unavailable: 'この工程表はまだ読めません。',
  noCards: 'この工程表にはまだ工程がありません。',
  unverified: '工程表の記録に食い違いがあります。読める分だけ表示しています。',
  degraded: { 'lattice-read': '最新の記録を読み直しています…', members: 'メンバー情報を読み直しています…' },
}

// 状態 -> バッジの文字・記号・色の系統。色だけで状態を伝えない（記号と文字が必ず付く）。
export const STATES = {
  pending: { badge: '未着手', glyph: 'dashed', tone: 'pending' },
  ready: { badge: '着手可', glyph: 'play', tone: 'ready' },
  'in-progress': { badge: '作業中', glyph: 'progress', tone: 'working' },
  blocked: { badge: '止まり', glyph: 'octagon', tone: 'blocked' },
  done: { badge: '完了', glyph: 'seal', tone: 'done' },
  retired: { badge: '取り下げ', glyph: 'archive', tone: 'retired' },
}
export const stateInfo = state => STATES[state] ?? STATES.pending
const finished = state => state === 'done' || state === 'retired'

export function backoffMs(attempt, random = Math.random) {
  return Math.min(30000, Math.round(Math.min(30000, 1000 * 2 ** Math.max(0, attempt)) * (0.8 + 0.4 * random())))
}

const JST = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
export function formatJst(value) {
  if (!value || Number.isNaN(Date.parse(value))) return ''
  const part = Object.fromEntries(JST.formatToParts(new Date(value)).map(item => [item.type, item.value]))
  return `${part.month}月${part.day}日 ${part.hour}:${part.minute}`
}
export function minutesSince(value, now) {
  const at = Date.parse(value)
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 60000))
}
export function sinceText(value, now) {
  const n = minutesSince(value, now)
  if (n < 1) return '1分未満'
  if (n < 60) return `${n}分`
  if (n < 1440) return n % 60 ? `${Math.floor(n / 60)}時間${n % 60}分` : `${n / 60}時間`
  return `${Math.floor(n / 1440)}日`
}

// 名簿にいない担当は「名簿にないメンバー」。担当が空なら null のまま呼び出し側が「担当なし」を使う。
export function memberLookup(snapshot) {
  const roster = new Map((snapshot?.members ?? []).map(member => [member.botId, member]))
  return botId => {
    if (!botId) return null
    // The Owner (指揮官) has no Bot id; the view puts the Owner profile on the snapshot as `owner`.
    if (botId === OWNER_ID) return { botId, name: snapshot?.owner?.name || OWNER_FALLBACK, color: 'amber', avatarVersion: '', known: true, owner: true, avatar: snapshot?.owner?.avatar ? '/api/owner/avatar' : '' }
    const member = roster.get(botId)
    return member ? { botId, name: member.name, color: member.color, avatarVersion: member.avatarVersion ?? '', known: true } : { botId, name: UNKNOWN_MEMBER, color: 'unknown', avatarVersion: '', known: false }
  }
}
export const nameOf = member => member ? member.name : UNASSIGNED
// 札の担当：つくっている人（着手した人か、名簿にいる担当）。いなければ工程表に書かれた担当の文字（顔は頭文字、会話なし）。それも無ければ null（担当なし）。
export function ownerLookup(snapshot) {
  const lookup = memberLookup(snapshot)
  return card => card?.producer ? lookup(card.producer) : card?.lane ? { botId: null, name: card.lane, color: 'unknown', avatarVersion: '', known: false, authored: true } : null
}

// 担当ごとのレーン、depth ごとの列。同じ担当・同じ depth の札は縦に積む。
export const CARD_W = 136, CARD_H = 104, CARD_DONE_H = 48
const COL_W = 232, LABEL_W = 116, TOP = 14, LANE_MIN = 108, LANE_GAP = 8, LANE_PAD = 8, STACK_GAP = 8
export const cardHeight = card => finished(card.state) ? CARD_DONE_H : CARD_H

export function layoutChart(snapshot) {
  const ownerOf = ownerLookup(snapshot), cards = (snapshot.cards ?? []).filter(card => !card.archived)
  const keys = new Map(), owners = new Map([[null, null]])
  for (const card of cards) {
    const owner = ownerOf(card), key = owner ? owner.botId ?? `lane:${owner.name}` : null
    owners.set(key, owner)
    if (!keys.has(key)) keys.set(key, [])
    keys.get(key).push(card)
  }
  const rank = key => key === null ? 3 : owners.get(key).known ? 0 : owners.get(key).authored ? 1 : 2
  const laneOrder = [...keys.keys()].sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? owners.get(a).name.localeCompare(owners.get(b).name, 'ja') : 0) || String(a).localeCompare(String(b)))
  const lanes = [], placed = new Map()
  let y = TOP, maxDepth = 0
  for (const key of laneOrder) {
    const cells = new Map()
    for (const card of keys.get(key).toSorted((a, b) => a.id.localeCompare(b.id))) {
      const depth = Math.max(0, card.depth ?? 0)
      maxDepth = Math.max(maxDepth, depth)
      if (!cells.has(depth)) cells.set(depth, [])
      cells.get(depth).push(card)
    }
    const stack = list => list.reduce((sum, card) => sum + cardHeight(card), 0) + STACK_GAP * (list.length - 1)
    const height = Math.max(LANE_MIN, ...[...cells.values()].map(list => stack(list) + LANE_PAD * 2))
    for (const [depth, list] of cells) {
      let top = y + (height - stack(list)) / 2
      for (const card of list) {
        placed.set(card.id, { x: LABEL_W + 16 + depth * COL_W, y: top, w: CARD_W, h: cardHeight(card), depth, lane: lanes.length })
        top += cardHeight(card) + STACK_GAP
      }
    }
    lanes.push({ key: key ?? '', botId: owners.get(key)?.botId ?? null, member: owners.get(key), y, h: height })
    y += height + LANE_GAP
  }
  // 読む順（レーンごとに左から）。キーボードの順もこれに合わせる。
  const order = [...placed.keys()].sort((a, b) => placed.get(a).lane - placed.get(b).lane || placed.get(a).depth - placed.get(b).depth || placed.get(a).y - placed.get(b).y)
  return { lanes, cards: placed, order, width: LABEL_W + 16 + (maxDepth + 1) * COL_W + 24, height: y + 56 }
}

// ツリー：工程表 -> まとまり（phase）-> 工程（parent があればその下）。葉が一行ずつ、親は子の真ん中。依存は箱の右の弧。
export const TREE = { ROW: 40, BOX_H: 32, GAP: 36, TOP: 16, LEFT: 16, ROOT_W: 168, PHASE_W: 196, CARD_W: 300 }
export const UNNAMED_PHASE = '名前のないまとまり'
export function phaseTone(cards) {
  if (cards.some(card => card.state === 'blocked')) return 'blocked'
  if (cards.some(card => card.state === 'in-progress')) return 'in-progress'
  return cards.length && cards.every(card => finished(card.state)) ? 'done' : 'pending'
}
export function layoutTree(snapshot, name = '') {
  // 消えた工程（archived）は描かない。中身が全部消えたまとまりも描かず、消えた親の子はそのまとまりへ。
  const cards = (snapshot.cards ?? []).filter(card => !card.archived), byId = new Map(cards.map(card => [card.id, card]))
  const phaseIds = new Set((snapshot.phases ?? []).map(phase => phase.id).filter(id => !(snapshot.cards ?? []).some(card => card.phase === id) || cards.some(card => card.phase === id)))
  const nodes = new Map([['root', { key: 'root', kind: 'root', label: name, w: TREE.ROOT_W, children: [] }]])
  for (const phase of (snapshot.phases ?? []).filter(phase => phaseIds.has(phase.id))) nodes.set(`phase:${phase.id}`, { key: `phase:${phase.id}`, kind: 'phase', id: phase.id, label: phase.title ?? UNNAMED_PHASE, w: TREE.PHASE_W, children: [] })
  for (const card of cards) nodes.set(card.id, { key: card.id, kind: 'card', id: card.id, card, w: TREE.CARD_W, children: [] })
  const parentOf = card => card.parent && byId.has(card.parent) ? card.parent : card.phase && phaseIds.has(card.phase) ? `phase:${card.phase}` : 'root'
  for (const node of nodes.values()) if (node.kind === 'phase') nodes.get('root').children.push(node.key)
  for (const card of cards) nodes.get(parentOf(card)).children.push(card.id)
  let row = 0, right = 0
  const place = (key, x, seen = new Set()) => {
    const node = nodes.get(key)
    seen.add(key)
    node.x = x; right = Math.max(right, x + node.w)
    const kids = node.children.filter(child => !seen.has(child))
    for (const child of kids) place(child, x + node.w + TREE.GAP, seen)
    node.y = kids.length ? (nodes.get(kids[0]).y + nodes.get(kids.at(-1)).y) / 2 : TREE.TOP + row++ * TREE.ROW
    node.h = TREE.BOX_H
    return node
  }
  place('root', TREE.LEFT)
  // 完了数もツリーに出す工程（archived でない）だけを数える（Owner 2026-11-14、a96。上の「◯/◯ 完了」と同じ）。
  for (const node of nodes.values()) if (node.kind !== 'card') {
    const inside = node.kind === 'root' ? cards : cards.filter(card => card.phase === node.id)
    Object.assign(node, { done: inside.filter(card => finished(card.state)).length, total: inside.length, tone: phaseTone(inside) })
  }
  const mid = node => node.y + node.h / 2
  const links = [...nodes.values()].flatMap(node => node.children.map(child => {
    const to = nodes.get(child), x0 = node.x + node.w, x1 = to.x, bend = (x1 - x0) / 2
    return { from: node.key, to: child, d: `M${x0} ${mid(node)}C${x0 + bend} ${mid(node)} ${x1 - bend} ${mid(to)} ${x1} ${mid(to)}` }
  }))
  let reach = right
  const arcs = (snapshot.edges ?? []).filter(edge => nodes.has(edge.from) && nodes.has(edge.to) && nodes.get(edge.from).kind === 'card' && nodes.get(edge.to).kind === 'card').map(edge => {
    const a = nodes.get(edge.from), b = nodes.get(edge.to), x0 = a.x + a.w, x1 = b.x + b.w
    const bulge = Math.max(x0, x1) + 24 + Math.min(160, Math.abs(mid(b) - mid(a)) * 0.3)
    reach = Math.max(reach, bulge)
    return { key: `${edge.from}>${edge.to}`, from: edge.from, to: edge.to, waiting: edge.waiting,
      d: `M${x0} ${mid(a)}C${bulge} ${mid(a)} ${bulge} ${mid(b)} ${x1 + 6} ${mid(b)}` }
  })
  const list = [...nodes.values()].map(({ children, ...node }) => node)
  return { nodes: list, links, arcs, cards: new Map(list.filter(node => node.kind === 'card').map(node => [node.id, node])),
    width: reach + 24, height: TREE.TOP + Math.max(1, row) * TREE.ROW + 16 }
}

// 過去ログ：終わった工程を新しい順に、JSTの日ごと（今日 / 昨日 / M月D日）。
const JST_DAY = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
const JST_TIME = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
export function historyRows(snapshot, now) {
  const ownerOf = ownerLookup(snapshot), day = value => JST_DAY.format(new Date(value))
  const today = day(now), yesterday = day(now - 86400000)
  const rows = (snapshot.cards ?? []).filter(card => finished(card.state))
    .toSorted((a, b) => (b.doneAt ? Date.parse(b.doneAt) : -Infinity) - (a.doneAt ? Date.parse(a.doneAt) : -Infinity) || a.id.localeCompare(b.id))
  const groups = []
  for (const card of rows) {
    const at = card.doneAt && !Number.isNaN(Date.parse(card.doneAt)) ? card.doneAt : null, key = at ? day(at) : ''
    const heading = !at ? '日時の分からない工程' : key === today ? '今日' : key === yesterday ? '昨日' : key.replace(/^\d+\/(\d+)\/(\d+)$/u, '$1月$2日')
    if (groups.at(-1)?.heading !== heading) groups.push({ heading, rows: [] })
    const owner = ownerOf(card), info = stateInfo(card.state), time = at ? JST_TIME.format(new Date(at)) : ''
    groups.at(-1).rows.push({ id: card.id, title: card.title, owner, info, time,
      label: `${card.title}、${info.badge}${time ? `、${heading} ${time}` : ''}、${nameOf(owner)}` })
  }
  return { count: rows.length, groups }
}

// 辺は右中央から左中央への滑らかな曲線。
export function edgeGeometry(from, to) {
  const p0 = { x: from.x + from.w, y: from.y + from.h / 2 }, p3 = { x: to.x, y: to.y + to.h / 2 }
  const dx = Math.max(36, (p3.x - p0.x) / 2), p1 = { x: p0.x + dx, y: p0.y }, p2 = { x: p3.x - dx, y: p3.y }
  return { p0, p1, p2, p3, d: `M${p0.x} ${p0.y}C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}` }
}
export function pointOnEdge(geometry, t) {
  const { p0, p1, p2, p3 } = geometry, u = 1 - t
  const at = key => u ** 3 * p0[key] + 3 * u * u * t * p1[key] + 3 * u * t * t * p2[key] + t ** 3 * p3[key]
  return { x: at('x'), y: at('y') }
}
export const FLOW = { spawnMs: 600, travelMs: 1400 }
// 待ちの辺：600ms ごとに一粒、1.4 秒で待つ側へ。いま飛んでいる粒の進み具合（0〜1）。
export function flowPositions(now) {
  const out = []
  for (let n = Math.floor(now / FLOW.spawnMs); n * FLOW.spawnMs > now - FLOW.travelMs; n--) out.push((now - n * FLOW.spawnMs) / FLOW.travelMs)
  return out
}
export const particleOpacity = t => Math.min(1, t / 0.07, (1 - t) / 0.23)

export function chartCounts(snapshot) {
  // 分数はツリーに出す工程だけ（archived を除く、a96）。archived は終わった工程なので、作業中・止まり・待ちは変わらない。
  const cards = (snapshot.cards ?? []).filter(card => !card.archived), waiting = new Set((snapshot.edges ?? []).filter(edge => edge.waiting).map(edge => edge.to))
  return {
    total: cards.length,
    done: cards.filter(card => finished(card.state)).length,
    working: cards.filter(card => card.state === 'in-progress').length,
    blocked: cards.filter(card => card.state === 'blocked').length,
    waiting: cards.filter(card => waiting.has(card.id)).length,
  }
}

// 担当の状態を一文に：作業中 N分 / 止まり: 理由 / 未着手: 担当 ◯◯ / 担当なし。
export function producerStateText(card, member, now) {
  if (!card) return ''
  const info = stateInfo(card.state)
  if (card.state === 'in-progress') return `${info.badge} ${sinceText(card.startedAt, now)}`
  if (card.state === 'blocked') return card.blockedReason ? `${info.badge}: ${card.blockedReason}` : info.badge
  if (card.state === 'pending' || card.state === 'ready') return member ? `${info.badge}: 担当 ${member.name}` : UNASSIGNED
  return info.badge
}

export function cardLabel(card, member) {
  return `${card.title}、${stateInfo(card.state).badge}、つくっている ${nameOf(member)}`
}
// 札の下の一行：止まりは理由、未着手と着手可は担当。
export function cardNote(card, member) {
  if (card.state === 'blocked') return card.blockedReason ?? ''
  if (card.state === 'pending' || card.state === 'ready') return member ? `担当 ${member.name}` : UNASSIGNED
  if (card.state === 'in-progress') return member ? `${member.name}がつくっています` : ''
  return ''
}

// 別の工程表の前の工程（externals[]）：題名と工程表の名前の穴埋め、読めていない状態は「読めていません」。
const NO_READ = '読めていません'
const externalsOf = snapshot => new Map((snapshot.externals ?? []).map(ext => [ext.id, ext]))
const externalTitle = ext => ext.title ?? 'ほかの工程表の工程', externalChart = ext => `${ext.chartName ?? 'ほかの工程表'}の工程表`
// 別の工程表の工程は着手時刻を持たないので、作業中は分を付けない。
const externalState = (ext, producer, now) => ext.state === null ? NO_READ : ext.state === 'in-progress' ? stateInfo(ext.state).badge : producerStateText({ state: ext.state }, producer, now)

export function waitRows(snapshot, now) {
  const lookup = memberLookup(snapshot), ownerOf = ownerLookup(snapshot), titles = new Map((snapshot.cards ?? []).map(card => [card.id, card])), externals = externalsOf(snapshot)
  return (snapshot.waits ?? []).map(wait => {
    const ext = externals.get(wait.forCard), awaited = ext ? { state: ext.state } : titles.get(wait.forCard), waiting = titles.get(wait.waitingCard)
    const waiter = wait.waiter ? lookup(wait.waiter) : ownerOf(waiting), producer = wait.producer ? lookup(wait.producer) : ext ? null : ownerOf(awaited)
    const title = ext ? externalTitle(ext) : awaited?.title ?? '', chart = ext ? externalChart(ext) : null
    const state = ext ? externalState(ext, producer, now) : producerStateText({ ...awaited, state: wait.producerState ?? awaited?.state }, producer, now)
    return {
      key: `${wait.waitingCard}>${wait.forCard}`, waiter, producer, title, chart, external: ext ? { projectId: ext.projectId, cardId: ext.cardId } : null, state, forCard: wait.forCard, waitingCard: wait.waitingCard,
      headline: waiting?.title ?? '', ownerText: waiter ? `担当 ${waiter.name}` : UNASSIGNED,
      length: sinceText(wait.since, now),
      emphasized: wait.producerState === 'blocked', info: stateInfo(wait.producerState ?? awaited?.state),
      canChat: Boolean(producer?.known && !producer.owner),
      label: `「${waiting?.title ?? ''}」（${waiter ? `担当 ${waiter.name}` : UNASSIGNED}）は、「${title}」${chart ? `（${chart}）` : ''}が終わるのを待っています。つくっているのは${nameOf(producer)}、${state}`,
      waitingTitle: waiting?.title ?? '',
    }
  })
}

// 待っている辺ごとの札「◯◯が待っています」。待つ側 = 後ろの札の担当。
export function edgeChipText(snapshot, edge) {
  const to = (snapshot.cards ?? []).find(card => card.id === edge.to)
  const owner = ownerLookup(snapshot)(to)
  return owner ? `${owner.name}が待っています` : '次の工程が待っています'
}

// 左のレール：担当ごとの顔と、作業中・止まり・待ちの数。
export function railItems(snapshot, layout) {
  const cards = snapshot.cards ?? [], waits = snapshot.waits ?? []
  return layout.lanes.filter(lane => lane.botId && !lane.member?.owner).map(lane => ({
    botId: lane.botId, member: lane.member,
    working: cards.some(card => card.producer === lane.botId && card.state === 'in-progress'),
    blocked: cards.some(card => card.producer === lane.botId && card.state === 'blocked'),
    waiting: waits.filter(wait => wait.waiter === lane.botId).length,
  }))
}

// 強調：その担当の札と待ちだけ。
export function highlightSets(snapshot, botId) {
  if (!botId) return null
  return {
    cards: new Set((snapshot.cards ?? []).filter(card => card.producer === botId).map(card => card.id)),
    waits: new Set((snapshot.waits ?? []).filter(wait => wait.waiter === botId || wait.producer === botId).map(wait => `${wait.waitingCard}>${wait.forCard}`)),
  }
}

export function detailOf(snapshot, cardId, now) {
  const cards = new Map((snapshot.cards ?? []).map(card => [card.id, card])), card = cards.get(cardId)
  if (!card) return null
  const ownerOf = ownerLookup(snapshot), externals = externalsOf(snapshot)
  const link = id => {
    const ext = externals.get(id), producer = ext?.producer ? memberLookup(snapshot)(ext.producer) : null
    if (ext) return { id, title: externalTitle(ext), state: ext.state, producer, stateText: externalState(ext, producer, now), chart: externalChart(ext), external: { projectId: ext.projectId, cardId: ext.cardId } }
    const other = cards.get(id); return other && { id, title: other.title, state: other.state, producer: ownerOf(other), stateText: producerStateText(other, ownerOf(other), now) }
  }
  const edges = snapshot.edges ?? []
  return {
    id: cardId, card, producer: ownerOf(card), info: stateInfo(card.state),
    stateText: producerStateText(card, ownerOf(card), now),
    previous: edges.filter(edge => edge.to === cardId).map(edge => link(edge.from)).filter(Boolean),
    next: edges.filter(edge => edge.from === cardId).map(edge => link(edge.to)).filter(Boolean),
    startedText: card.startedAt ? `着手 ${formatJst(card.startedAt)} JST` : 'まだ着手されていません',
  }
}

// 画面上の帯。state と degraded から決まる。
export function bannerFor(snapshot) {
  if (snapshot.state === 'unverified') return { tone: 'amber', glyph: 'tri', text: MESSAGES.unverified, talk: true, dim: false }
  if (snapshot.state === 'last_verified') {
    const at = formatJst(snapshot.verifiedAt)
    return { tone: 'grey', glyph: 'info', text: `いまの記録が読めないため、最後に確認できた状態${at ? `（${at} JST）` : ''}を表示しています。`, talk: true, dim: true }
  }
  return null
}
export const degradedPills = snapshot => (snapshot.degraded ?? []).map(key => MESSAGES.degraded[key]).filter(Boolean)

// 前の一枚との差：増えた・消えた・状態が変わった・完了になった札、増減した辺。
export function diffSnapshots(prev, next) {
  const out = { first: !prev, addedCards: [], removedCards: [], changedCards: [], completedCards: [], addedEdges: [], removedEdges: [] }
  if (!prev) return out
  const before = new Map((prev.cards ?? []).map(card => [card.id, card])), after = new Map((next.cards ?? []).map(card => [card.id, card]))
  for (const [id, card] of after) {
    const old = before.get(id)
    if (!old) out.addedCards.push(id)
    else if (old.state !== card.state) { out.changedCards.push(id); if (card.state === 'done' && old.state !== 'retired') out.completedCards.push(id) }
  }
  for (const id of before.keys()) if (!after.has(id)) out.removedCards.push(id)
  const key = edge => `${edge.from}>${edge.to}`, was = new Set((prev.edges ?? []).map(key)), is = new Set((next.edges ?? []).map(key))
  out.addedEdges = [...is].filter(id => !was.has(id)); out.removedEdges = [...was].filter(id => !is.has(id))
  return out
}

// 工程表の名前：付いた名前、無ければ「作った人の工程表」。IDは画面に出さない。
export const chartName = (chart, getMember = () => null) => chart?.name ?? (chart?.createdBy && getMember(chart.createdBy)?.name ? `${getMember(chart.createdBy).name}の工程表` : '名前のない工程表')

// 一覧：統括の工程表が先頭（サーバーの並びのまま）。active は名簿から引けた分だけ顔にし、引けない子は「?」。
export function listItems(list, getMember = () => null) {
  return (list.charts ?? []).map(chart => {
    const members = (chart.activeMembers ?? []).slice(0, 4).map(botId => getMember(botId) ?? { botId, name: UNKNOWN_MEMBER, color: 'unknown', avatar: '', known: false })
    const { done = 0, total = 0, waiting = 0 } = chart.counts ?? {}
    const name = chartName(chart, getMember)
    return {
      projectId: chart.projectId, name, coordinator: Boolean(chart.coordinator), done, total, waiting, members,
      fraction: total ? Math.min(1, done / total) : 0,
      waitingText: `待ち ${waiting}`,
      updated: chart.updatedAt ? `更新 ${formatJst(chart.updatedAt)}` : '',
      label: `${name}${chart.coordinator ? '、統括の工程表' : ''}、完了 ${done}/${total}、待ち ${waiting}${members.length ? `、動いているのは${members.map(member => member.name).join('、')}` : ''}`,
    }
  })
}
export const coordinatorBotId = list => (list?.charts ?? []).find(chart => chart.coordinator && chart.createdBy)?.createdBy ?? null
export const listSignature = list => JSON.stringify((list.charts ?? []).map(chart => [chart.projectId, chart.name, chart.createdBy, chart.coordinator, chart.counts, chart.activeMembers, chart.updatedAt, chart.state]))
