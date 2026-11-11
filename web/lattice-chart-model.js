// 工程表の画面の計算（DOM なし）。データは docs/architecture/modules/lattice/README.md の公開契約、見た目と動きは screen-spec.md。
export const ACCENTS = { violet: '#6147D4', rose: '#E86B94', indigo: '#4559C2', sky: '#47A1E3', mint: '#2EB29E', amber: '#E89E47' }
export const accent = color => ACCENTS[color] ?? ACCENTS.violet
export const RED = '#E0533D'
export const SCHEMA = 'bellteam.lattice-chart.v1'
export const UNKNOWN_MEMBER = '名簿にないメンバー'
export const UNASSIGNED = '担当なし'

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
    const member = roster.get(botId)
    return member ? { botId, name: member.name, color: member.color, avatarVersion: member.avatarVersion ?? '', known: true } : { botId, name: UNKNOWN_MEMBER, color: 'unknown', avatarVersion: '', known: false }
  }
}
export const nameOf = member => member ? member.name : UNASSIGNED

// 担当ごとのレーン、depth ごとの列。同じ担当・同じ depth の札は縦に積む。
export const CARD_W = 136, CARD_H = 92, CARD_DONE_H = 48
const COL_W = 232, LABEL_W = 116, TOP = 14, LANE_MIN = 108, LANE_GAP = 8, LANE_PAD = 8, STACK_GAP = 8
export const cardHeight = card => finished(card.state) ? CARD_DONE_H : CARD_H

export function layoutChart(snapshot) {
  const lookup = memberLookup(snapshot), cards = snapshot.cards ?? []
  const keys = new Map()
  for (const card of cards) {
    const key = card.producer ?? null
    if (!keys.has(key)) keys.set(key, [])
    keys.get(key).push(card)
  }
  const rank = key => key === null ? 2 : lookup(key).known ? 0 : 1
  const laneOrder = [...keys.keys()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? lookup(a).name.localeCompare(lookup(b).name, 'ja') : 0) || String(a).localeCompare(String(b)))
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
    lanes.push({ key: key ?? '', botId: key, member: lookup(key), y, h: height })
    y += height + LANE_GAP
  }
  // 読む順（レーンごとに左から）。キーボードの順もこれに合わせる。
  const order = [...placed.keys()].sort((a, b) => placed.get(a).lane - placed.get(b).lane || placed.get(a).depth - placed.get(b).depth || placed.get(a).y - placed.get(b).y)
  return { lanes, cards: placed, order, width: LABEL_W + 16 + (maxDepth + 1) * COL_W + 24, height: y + 56 }
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
  const cards = snapshot.cards ?? [], waiting = new Set((snapshot.edges ?? []).filter(edge => edge.waiting).map(edge => edge.to))
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

export function waitRows(snapshot, now) {
  const lookup = memberLookup(snapshot), titles = new Map((snapshot.cards ?? []).map(card => [card.id, card]))
  return (snapshot.waits ?? []).map(wait => {
    const waiter = lookup(wait.waiter), producer = lookup(wait.producer), awaited = titles.get(wait.forCard), waiting = titles.get(wait.waitingCard)
    const title = awaited?.title ?? '', state = producerStateText({ ...awaited, state: wait.producerState ?? awaited?.state }, producer, now)
    return {
      key: `${wait.waitingCard}>${wait.forCard}`, waiter, producer, title, state, forCard: wait.forCard, waitingCard: wait.waitingCard,
      headline: `${waiter ? waiter.name : '担当未定'}が待っている`,
      length: sinceText(wait.since, now),
      emphasized: wait.producerState === 'blocked', info: stateInfo(wait.producerState ?? awaited?.state),
      canChat: Boolean(producer?.known),
      label: `${waiter ? waiter.name : '担当未定'}が${title}を待っています。つくっているのは${nameOf(producer)}、${state}`,
      waitingTitle: waiting?.title ?? '',
    }
  })
}

// 待っている辺ごとの札「◯◯が待っています」。待つ側 = 後ろの札の担当。
export function edgeChipText(snapshot, edge) {
  const to = (snapshot.cards ?? []).find(card => card.id === edge.to)
  return `${to?.producer ? memberLookup(snapshot)(to.producer).name : '担当未定'}が待っています`
}

// 左のレール：担当ごとの顔と、作業中・止まり・待ちの数。
export function railItems(snapshot, layout) {
  const cards = snapshot.cards ?? [], waits = snapshot.waits ?? []
  return layout.lanes.filter(lane => lane.botId).map(lane => ({
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
  const lookup = memberLookup(snapshot), link = id => { const other = cards.get(id); return other && { id, title: other.title, state: other.state, producer: lookup(other.producer), stateText: producerStateText(other, lookup(other.producer), now) } }
  const edges = snapshot.edges ?? []
  return {
    id: cardId, card, producer: lookup(card.producer), info: stateInfo(card.state),
    stateText: producerStateText(card, lookup(card.producer), now),
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
