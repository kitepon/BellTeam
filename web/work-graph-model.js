// 相関図の描画状態（DOMなし）。数値は docs/architecture/modules/work-graph/behavior-spec.md のとおり。
export const SCHEMA = 'bellteam.work-graph.v1'
export const ACCENTS = { violet: '#6147D4', rose: '#E86B94', indigo: '#4559C2', sky: '#47A1E3', mint: '#2EB29E', amber: '#E89E47' }
export const accent = color => ACCENTS[color] ?? ACCENTS.violet
const NAME_HEIGHT = 18, ENTER_MS = 700, LEAVE_MS = 600, GROW_MS = 350, END_MS = 300, REDUCED_MS = 200

export function cubicBezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return x => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0, hi = 1, t = x
    for (let i = 0; i < 30; i++) { t = (lo + hi) / 2; if (at(x1, x2, t) < x) lo = t; else hi = t }
    return at(y1, y2, t)
  }
}
export const enterCurve = cubicBezier(0.2, 0.8, 0.2, 1)
export const leaveCurve = cubicBezier(0.4, 0, 1, 1)
const easeOut = t => 1 - (1 - t) ** 2

export function fnv1a(text) {
  let hash = 0x811c9dc5
  for (const char of new TextEncoder().encode(text)) { hash ^= char; hash = Math.imul(hash, 0x01000193) >>> 0 }
  return hash >>> 0
}

export function avatarSide(rect, n, wide) {
  const s0 = wide ? 64 : 56, count = Math.max(1, n)
  const s12 = count > 12 ? s0 * Math.sqrt(12 / count) : s0
  return Math.max(36, Math.min(s12, Math.sqrt(rect.w * rect.h / count) * 0.3))
}

export function blinkOpacity(now, activeSince) {
  const t = now - (Date.parse(activeSince) || now)
  return 0.25 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * t / 1600))
}

export function nodeText(node, now) {
  if (node.state !== 'working') return `${node.name}、依頼の相手`
  const minutes = Math.max(0, Math.floor((now - (Date.parse(node.activeSince) || now)) / 60000))
  return `${node.name}、作業中、${minutes}分前から`
}
// 依頼ラベルは省略せず、幅に収まるまで折り返す（空白があればそこで、なければ文字単位）。
export function wrapLabel(text, width, measure) {
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (!line || measure(line + char) <= width) { line += char; continue }
      const space = char === ' ' ? -1 : line.lastIndexOf(' ')
      if (space > 0 && measure(line.slice(space + 1) + char) <= width) { lines.push(line.slice(0, space)); line = line.slice(space + 1) + char }
      else { lines.push(line.trimEnd()); line = char === ' ' ? '' : char }
    }
    lines.push(line)
  }
  return lines
}
// 分身（読み取り専用の fork）への依頼は seat.kind === 'fork'。seat の無い線は本体。
export const isFork = edge => edge.seat?.kind === 'fork'
export const chipText = edge => isFork(edge) ? (edge.label ? `分身: ${edge.label}` : '分身') : edge.label
export const edgeText = (edge, names) => `${names.get(edge.from) ?? edge.from}から${names.get(edge.to) ?? edge.to}${isFork(edge) ? '（分身）' : ''}へ依頼${edge.label ? `: ${edge.label}` : ''}`

const validNode = node => node && typeof node.botId === 'string' && typeof node.name === 'string' && ['working', 'linked'].includes(node.state)
const validEdge = edge => edge && typeof edge.id === 'string' && typeof edge.from === 'string' && typeof edge.to === 'string'
export function readSnapshot(data) {
  if (data?.schema !== SCHEMA || typeof data.epoch !== 'string' || !Number.isInteger(data.version) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
    || !data.nodes.every(validNode) || !data.edges.every(validEdge)) throw new Error('WORK_GRAPH_UNREADABLE')
  return data
}

// 矩形の中心から方向(ux,uy)へ出た線が、一辺sの正方形の縁に当たるまでの距離。
const border = (s, ux, uy) => (s / 2) / Math.max(Math.abs(ux), Math.abs(uy), 1e-6)
// 札の置き場所（behavior-spec "Chip placement"、layout-sim.mjs chipSpots と同じ並び）：t = 0.5, 0.45, 0.55, … 0.1, 0.9 の各点で、
// 中央 → 上（札の下端が点）→ 下 → 左（札の右端が点）→ 右。side は札の大きさの半分を単位にしたずれ（画面の上下左右）。
export const CHIP_SIDES = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]
export const CHIP_SPOTS = [0.5, ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(k => [0.5 - k * 0.05, 0.5 + k * 0.05])]
  .map(t => Math.round(t * 100) / 100).flatMap(t => CHIP_SIDES.map(side => ({ t, side })))
const CENTER = { t: 0.5, side: [0, 0] }
// 札の箱 {x, y, w, h}：線上の点 t から side の向きへ札の半分ずつずらす（layout-sim.mjs chipBox を広げる前と同じ）。
export const chipBoxAt = (line, { t, side }, w, h) => { const p = pointAt(line, t); return { x: p.x + (side[0] - 1) * w / 2, y: p.y + (side[1] - 1) * h / 2, w, h } }
// 顔の箱：一辺 S の円板の正方形と、前のコマで描いた名前の箱（顔からの差 nameRel）を合わせ、g 広げる。
const nodeBox = (node, p, S, g) => {
  const r = node.nameRel, half = S / 2
  return { x0: Math.min(p.x - half, r ? p.x + r.x0 : Infinity) - g, x1: Math.max(p.x + half, r ? p.x + r.x1 : -Infinity) + g,
    y0: Math.min(p.y - half, r ? p.y + r.y0 : Infinity) - g, y1: Math.max(p.y + half, r ? p.y + r.y1 : -Infinity) + g }
}
// behavior-spec "Chip placement > On screen"（layout-sim.mjs intoArea / onScreen と同じ）：4 広げた札の箱を、D の内側へ入るだけ寄せる。
// D より大きい軸（Oversize chip の高さ）は、始めの縁を D の始めに合わせる。その箱は D に入らないので空き場所にならない。
const slide = (lo, hi, size) => hi - lo > size ? -lo : Math.max(0, -lo) - Math.max(0, hi - size)
export const intoRect = (box, rect) => ({ ...box, x: box.x + slide(box.x - 4 - rect.x, box.x + box.w + 4 - rect.x, rect.w), y: box.y + slide(box.y - 4 - rect.y, box.y + box.h + 4 - rect.y, rect.h) })
const onScreen = (box, rect) => box.x - 4 >= rect.x - 1e-6 && box.y - 4 >= rect.y - 1e-6 && box.x + box.w + 4 <= rect.x + rect.w + 1e-6 && box.y + box.h + 4 <= rect.y + rect.h + 1e-6
const grown = box => ({ x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 })
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

// 線の交差（behavior-spec "Uncrossing swaps"、layout-sim.mjs と同じ数え方）。端を共有する線は交差に数えない。
const side = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
const cross = (a, b, c, d) => side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
const pairsOf = edges => [...new Set(edges.map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`))].map(k => k.split(',').map(Number))
const crossCount = (P, list, all) => {
  let c = 0
  for (const [a, b] of list) for (const [e, f] of all) if (a !== e && a !== f && b !== e && b !== f && cross(P[a], P[b], P[e], P[f])) c++
  return c
}
// 線分abが箱rに入るか（Liang-Barsky、layout-sim.mjs と同じ）。箱は {x0, x1, y0, y1}。
export function segmentHitsBox(a, b, r) {
  let t0 = 0, t1 = 1
  const dx = b.x - a.x, dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
  }
  return true
}
const boxesMeet = (r, q) => r.x0 < q.x1 && q.x0 < r.x1 && r.y0 < q.y1 && q.y0 < r.y1
const CLEARANCE = 0.003, CLEAR_GAP = 6, CHIP_GAP = 4

// behavior-spec "Clearance"（layout-sim.mjs simulate() の clear 部分と同じ式）。P は点、返す力は正規化座標。
// box(k, g): k 番の顔の箱を g だけ広げたもの。pairs: 線（A→B と B→A は一本）。
// chips: blocked の札ごとに {a, b, box}（4 広げた箱）。同じ二人の間の逆向きの依頼も、札はそれぞれ押す。
export function clearanceForces(P, pairs, { box, chips = [], kc = CLEARANCE }) {
  const F = P.map(() => ({ u: 0, v: 0 }))
  const push = (c, a, b, ta, nx, ny) => {
    const d = Math.hypot(nx, ny) || 1, fu = kc * nx / d, fv = kc * ny / d
    F[c].u += fu; F[c].v += fv; F[a].u -= fu * (1 - ta); F[a].v -= fv * (1 - ta); F[b].u -= fu * ta; F[b].v -= fv * ta
  }
  const center = (c, gap) => { const r = box(c, gap); return { r, x: P[c].x, y: (r.y0 + r.y1) / 2 } }
  for (const [a, b] of pairs) {
    const ex = P[b].x - P[a].x, ey = P[b].y - P[a].y, el = ex * ex + ey * ey || 1
    for (let c = 0; c < P.length; c++) {
      if (c === a || c === b) continue
      const { r, x: cx, y: cy } = center(c, CLEAR_GAP)
      if (!segmentHitsBox(P[a], P[b], r)) continue
      const t = Math.min(1, Math.max(0, ((cx - P[a].x) * ex + (cy - P[a].y) * ey) / el))
      let nx = cx - (P[a].x + t * ex), ny = cy - (P[a].y + t * ey)
      if (Math.hypot(nx, ny) < 1e-6) { nx = -ey; ny = ex }
      push(c, a, b, t, nx, ny)
    }
  }
  for (const { a, b, box: chip } of chips) {
    if ([a, b].some(e => boxesMeet(chip, box(e, 0)))) {
      // 札が自分の両端の間に収まらない：線を伸ばす
      const ex = P[b].x - P[a].x, ey = P[b].y - P[a].y, d = Math.hypot(ex, ey) || 1, fu = kc * ex / d, fv = kc * ey / d
      F[a].u -= fu; F[a].v -= fv; F[b].u += fu; F[b].v += fv
    }
    for (let c = 0; c < P.length; c++) {
      if (c === a || c === b || !boxesMeet(chip, box(c, 0))) continue
      const { x: cx, y: cy } = center(c, 0)
      push(c, a, b, 0.5, cx - (chip.x0 + chip.x1) / 2, cy - (chip.y0 + chip.y1) / 2)
    }
  }
  return F
}

// 入れ替えると交差が一番多く減る2人（同数なら先の組）。減らないなら null。
// clear = { box(k, p) } の時、関係のない顔の箱を通る線も交差1つと数える（behavior-spec "Clearance"）。
export function bestSwap(P, edges, clear = null) {
  const pairs = pairsOf(edges), touching = P.map((_, i) => pairs.filter(([a, b]) => a === i || b === i))
  const passes = (Q, i, j) => {
    if (!clear) return 0
    let c = 0
    const hit = (a, b, k) => k !== a && k !== b && segmentHitsBox(Q[a], Q[b], clear.box(k, Q[k]))
    for (const [a, b] of pairs) {
      if (a === i || a === j || b === i || b === j) { for (let k = 0; k < Q.length; k++) if (hit(a, b, k)) c++ }
      else { if (hit(a, b, i)) c++; if (hit(a, b, j)) c++ }
    }
    return c
  }
  const local = (Q, i, j) => { const mine = [...new Set([...touching[i], ...touching[j]])]; return crossCount(Q, mine, pairs) - crossCount(Q, mine, mine) / 2 + passes(Q, i, j) }
  let best = null
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    if (!touching[i].length && !touching[j].length) continue
    const Q = P.slice(); Q[i] = P[j]; Q[j] = P[i]
    const gain = local(P, i, j) - local(Q, i, j)
    if (gain > 0 && (!best || gain > best.gain)) best = { pair: [i, j], gain }
  }
  return best
}

export function createGraphModel({ reduceMotion = false } = {}) {
  const nodes = new Map(), edges = new Map()
  let epoch = null, version = -1, degraded = [], alpha = 1, firstSeen = false, steps = 0
  const GLIDE_MS = reduceMotion ? REDUCED_MS : ENTER_MS
  // 入れ替えた顔の描く位置：from から今の位置へ enter の曲線で700ms。Reduce Motion は前半 from で消え、後半新しい場所で現れる。
  function drawnAt(node, now) {
    const g = node.glide, t = g ? (now - g.at) / GLIDE_MS : 1
    if (t >= 1) return { x: node.x, y: node.y, opacity: 1 }
    if (reduceMotion) return t < 0.5 ? { ...g.from, opacity: 1 - 2 * t } : { x: node.x, y: node.y, opacity: 2 * t - 1 }
    const k = enterCurve(t)
    return { x: g.from.x + (node.x - g.from.x) * k, y: g.from.y + (node.y - g.from.y) * k, opacity: 1 }
  }
  // 30コマごとに一組だけ入れ替える。位置と速度を交換し、α は変えない（behavior-spec "Uncrossing swaps"）。
  function uncross(live, now, S) {
    const order = [...live].sort((a, b) => a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0), index = new Map(order.map((node, i) => [node.botId, i]))
    const list = [...edges.values()].filter(edge => !edge.endAt && index.has(edge.from) && index.has(edge.to)).map(edge => [index.get(edge.from), index.get(edge.to)])
    const swap = bestSwap(order, list, { box: (k, p) => nodeBox(order[k], p, S, 0) })
    if (!swap) return
    const [a, b] = swap.pair.map(i => order[i])
    for (const node of [a, b]) if (reduceMotion || now - node.enterAt >= ENTER_MS) { const p = drawnAt(node, now); node.glide = { from: { x: p.x, y: p.y }, at: now } }
    for (const key of ['x', 'y', 'vu', 'vv']) [a[key], b[key]] = [b[key], a[key]]
  }

  function enter(node, now, rect) {
    const current = nodes.get(node.botId)
    if (current && !current.leaveAt) { Object.assign(current, node); return }
    const theta = (fnv1a(node.botId) % 360) * Math.PI / 180
    const c = rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : { x: 0, y: 0 }
    const near = reduceMotion ? 0.12 : 0.25, m = rect ? Math.min(rect.w, rect.h) : 100
    nodes.set(node.botId, { ...node, x: c.x + Math.cos(theta) * m * near, y: c.y + Math.sin(theta) * m * near, vu: 0, vv: 0, theta, enterAt: now, leaveAt: null })
    firstSeen = true
  }
  function leave(botId, now) { const node = nodes.get(botId); if (node && !node.leaveAt) node.leaveAt = now }
  function start(edge, now) {
    const current = edges.get(edge.id)
    if (current && !current.endAt) { Object.assign(current, edge); return }
    edges.set(edge.id, { ...edge, startAt: now, endAt: null })
  }
  function end(id, now) { const edge = edges.get(id); if (edge && !edge.endAt) edge.endAt = now }

  return {
    get epoch() { return epoch },
    get version() { return version },
    get degraded() { return degraded },
    get nodes() { return nodes },
    get edges() { return edges },
    // 新しい接続の最初の一枚。描いている図との差を、普通の変化と同じ動きで見せる。
    snapshot(data, now, rect) {
      readSnapshot(data)
      const nodeIds = new Set(data.nodes.map(node => node.botId)), edgeIds = new Set(data.edges.map(edge => edge.id))
      for (const id of edges.keys()) if (!edgeIds.has(id)) end(id, now)
      for (const id of nodes.keys()) if (!nodeIds.has(id)) leave(id, now)
      for (const node of data.nodes) enter(node, now, rect)
      for (const edge of data.edges) start(edge, now)
      epoch = data.epoch; version = data.version; degraded = Array.isArray(data.degraded) ? data.degraded : []; alpha = 1
    },
    // 同じepochで version が1つ進んだ時だけ適用する。それ以外は false（再接続）。
    change(batch, now, rect) {
      if (batch?.epoch !== epoch || batch.version !== version + 1 || !Array.isArray(batch.changes)) return false
      for (const item of batch.changes) {
        if (item?.type === 'member-enter' || item?.type === 'member-update') { if (!validNode(item.node)) return false; enter(item.node, now, rect) }
        else if (item?.type === 'edge-start' || item?.type === 'edge-update') { if (!validEdge(item.edge)) return false; start(item.edge, now) }
        else if (item?.type === 'edge-end') end(item.edgeId, now)
        else if (item?.type === 'member-leave') leave(item.botId, now)
        else return false
      }
      version = batch.version; degraded = Array.isArray(batch.degraded) ? batch.degraded : []; alpha = 1
      return true
    },
    heat() { alpha = 1 },
    get alpha() { return alpha },
    // 1コマ分の力学。dtは秒。
    step(dt, rect, now, wide) {
      dt = Math.min(Math.max(dt, 0), 1 / 30)
      for (const [id, edge] of edges) if (edge.endAt && now - edge.endAt >= END_MS) edges.delete(id)
      for (const [id, node] of nodes) if (node.leaveAt && now - node.leaveAt >= (reduceMotion ? REDUCED_MS : LEAVE_MS)) nodes.delete(id)
      const live = [...nodes.values()].filter(node => !node.leaveAt), n = live.length
      if (!n) return
      // 力は D に正規化した座標 (u, v) で計算する。衝突と境界だけ点で測る（behavior-spec "Layout ... normalized"）。
      const { w: W, h: H } = rect, S = avatarSide(rect, n, wide), cx = rect.x + W / 2, cy = rect.y + H / 2
      const kr = 0.005 / n, ks = 0.02, L = Math.min(0.7, 1.4 / Math.sqrt(n))
      const uv = new Map(live.map(node => [node, { u: (node.x - rect.x) / W, v: (node.y - rect.y) / H }]))
      const span = (key, size) => Math.max(...live.map(node => uv.get(node)[key])) - Math.min(...live.map(node => uv.get(node)[key])) + size
      const gravity = fill => 0.02 * Math.min(50, Math.max(0.001, (fill / 0.88) ** 16))
      const gu = gravity(span('u', S / W)), gv = gravity(span('v', (S + NAME_HEIGHT) / H))
      const force = new Map(live.map(node => [node, { u: gu * (0.5 - uv.get(node).u), v: gv * (0.5 - uv.get(node).v) }]))
      const pull = (a, b, q) => {
        const du = uv.get(b).u - uv.get(a).u, dv = uv.get(b).v - uv.get(a).v, d = Math.max(0.01, Math.hypot(du, dv)), f = q(d)
        force.get(a).u += f * du / d; force.get(a).v += f * dv / d; force.get(b).u -= f * du / d; force.get(b).v -= f * dv / d
      }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pull(live[i], live[j], d => -kr / (d * d))
      const springs = new Set()
      for (const edge of edges.values()) {
        if (edge.endAt) continue
        const a = nodes.get(edge.from), b = nodes.get(edge.to)
        if (!a || !b || a.leaveAt || b.leaveAt) continue
        const key = [edge.from, edge.to].sort().join('\n')
        if (springs.has(key)) continue
        springs.add(key)
        pull(a, b, d => ks * (d - L))
      }
      // Clearance: 線と blocked の札を、関係のない顔（円板＋描いた名前）からどける。
      // 線は二人ごとに一本、札は依頼ごとに一枚（同じ二人の逆向きの依頼も別の札）。
      const index = new Map(live.map((node, i) => [node.botId, i])), P = live.map(node => ({ x: node.x, y: node.y })), pairs = new Map(), chips = []
      for (const edge of edges.values()) {
        if (edge.endAt || !index.has(edge.from) || !index.has(edge.to)) continue
        const a = index.get(edge.from), b = index.get(edge.to)
        pairs.set(a < b ? `${a},${b}` : `${b},${a}`, [Math.min(a, b), Math.max(a, b)])
        if (!edge.chip?.blocked) continue
        const mx = (P[a].x + P[b].x) / 2, my = (P[a].y + P[b].y) / 2, { w, h } = edge.chip
        chips.push({ a, b, box: { x0: mx - w / 2 - CHIP_GAP, x1: mx + w / 2 + CHIP_GAP, y0: my - h / 2 - CHIP_GAP, y1: my + h / 2 + CHIP_GAP } })
      }
      const clear = clearanceForces(P, [...pairs.values()], { box: (k, g) => nodeBox(live[k], P[k], S, g), chips })
      live.forEach((node, i) => { force.get(node).u += clear[i].u; force.get(node).v += clear[i].v })
      for (const node of live) {
        const f = force.get(node), p = uv.get(node)
        node.vu = ((node.vu ?? 0) + f.u * alpha) * 0.82; node.vv = ((node.vv ?? 0) + f.v * alpha) * 0.82
        const speed = Math.hypot(node.vu * W, node.vv * H)
        if (speed > 14) { node.vu *= 14 / speed; node.vv *= 14 / speed }
        node.x = rect.x + (p.u + node.vu * dt * 60) * W; node.y = rect.y + (p.v + node.vv * dt * 60) * H
      }
      const gap = S * 2.2
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = live[i], b = live[j]; let dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy)
        if (d >= gap) continue
        if (d < 1e-6) { dx = Math.cos(a.theta); dy = Math.sin(a.theta); d = 1 } else { dx /= d; dy /= d }
        const push = (gap - Math.max(d, 1e-6)) / 2
        a.x += dx * push; a.y += dy * push; b.x -= dx * push; b.y -= dy * push
      }
      // 円板と名前が D の中に収まるように。名前は幅 S×2.2、点滅の輪（S/2+6.5）の外に高さ18px。
      const halfX = Math.max(S / 2, S * 1.1), top = S / 2, bottom = S / 2 + 28
      for (const node of live) {
        node.x = W < halfX * 2 ? cx : Math.min(rect.x + W - halfX, Math.max(rect.x + halfX, node.x))
        node.y = H < top + bottom ? cy : Math.min(rect.y + H - bottom, Math.max(rect.y + top, node.y))
      }
      if (++steps % 30 === 0) uncross(live, now, S)
      alpha = Math.max(0.04, alpha * 0.985 ** (dt * 60))
    },
    // 描く物の一覧。edges → nodes → labels の順に描く。
    frame(now, rect, { wide = false, hover = null, measure = text => text.length * 7 } = {}) {
      const live = [...nodes.values()].filter(node => !node.leaveAt)
      const S = avatarSide(rect, live.length, wide), cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
      const far = Math.hypot(rect.w, rect.h) / 2 + S
      const drawn = new Map()
      for (const node of nodes.values()) {
        let x = node.x, y = node.y, scale = 1, opacity = 1
        if (node.leaveAt) {
          const t = Math.min(1, (now - node.leaveAt) / (reduceMotion ? REDUCED_MS : LEAVE_MS))
          if (reduceMotion) opacity = 1 - t
          else {
            if (!node.leaveFrom) { const p = drawnAt(node, now); node.leaveFrom = { x: p.x, y: p.y } }
            const dx = node.leaveFrom.x - cx, dy = node.leaveFrom.y - cy, d = Math.hypot(dx, dy) || 1, k = leaveCurve(t)
            x = node.leaveFrom.x + (cx + dx / d * far - node.leaveFrom.x) * k; y = node.leaveFrom.y + (cy + dy / d * far - node.leaveFrom.y) * k
            opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4
          }
        } else {
          const t = Math.min(1, (now - node.enterAt) / (reduceMotion ? REDUCED_MS : ENTER_MS)), p = drawnAt(node, now)
          if (reduceMotion) { opacity = t * p.opacity; x = p.x; y = p.y }
          else if (t < 1) {
            const k = enterCurve(t), sx = cx + Math.cos(node.theta) * far, sy = cy + Math.sin(node.theta) * far
            x = sx + (node.x - sx) * k; y = sy + (node.y - sy) * k; scale = 0.6 + 0.4 * k; opacity = k
          } else { x = p.x; y = p.y }
        }
        drawn.set(node.botId, { node, x, y, scale, opacity, side: S * scale })
      }
      const discs = [...drawn.values()].filter(item => !item.node.leaveAt).map(item => ({ id: item.node.botId, x: item.x - item.side / 2 - 4, y: item.y - item.side / 2 - 4, w: item.side + 8, h: item.side + 8 }))
      const live2 = [...edges.values()].filter(edge => !edge.endAt)
      const lines = []
      for (const edge of edges.values()) {
        const a = drawn.get(edge.from), b = drawn.get(edge.to)
        if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d
        const p0 = { x: a.x + ux * border(a.side, ux, uy), y: a.y + uy * border(a.side, ux, uy) }
        const p2 = { x: b.x - ux * border(b.side, ux, uy), y: b.y - uy * border(b.side, ux, uy) }
        const length = Math.hypot(p2.x - p0.x, p2.y - p0.y)
        const reverse = live2.some(other => other !== edge && other.from === edge.to && other.to === edge.from)
        const control = reverse ? { x: (p0.x + p2.x) / 2 + uy * length * 0.18, y: (p0.y + p2.y) / 2 - ux * length * 0.18 } : null
        const grow = edge.endAt ? 1 : Math.min(1, (now - edge.startAt) / (reduceMotion ? 1 : GROW_MS))
        const opacity = edge.endAt ? Math.max(0, 1 - (now - edge.endAt) / END_MS) : 1
        lines.push({ edge, p0, p2, control, length, grow: easeOut(grow), opacity, dotsSince: edge.startAt + GROW_MS, color: accent(a.node.color) })
      }
      const names = []
      for (const item of drawn.values()) {
        if (item.node.leaveAt && item.opacity <= 0) continue
        const width = Math.min(item.side * 2.2, measure(item.node.name)), others = discs.filter(disc => disc.id !== item.node.botId)
        const below = { x: item.x - width / 2, y: item.y + item.side / 2 + 9, w: width, h: 18 }
        const over = { x: item.x - width / 2, y: item.y - item.side / 2 - 27, w: width, h: 18 }
        const box = !others.some(disc => intersects(below, disc)) ? below : !others.some(disc => intersects(over, disc)) ? over : hover?.botId === item.node.botId ? below : null
        if (box) names.push({ item, box, maxWidth: item.side * 2.2 })
      }
      // 顔の箱（Clearance）に使う名前の位置を、顔からの差で覚える。隠れた名前は数えない。
      const named = new Map(names.map(({ item, box }) => [item.node, box]))
      for (const item of drawn.values()) {
        const box = named.get(item.node)
        item.node.nameRel = box ? { x0: box.x - item.x, x1: box.x + box.w - item.x, y0: box.y - item.y, y1: box.y + box.h - item.y } : null
      }
      // 描いている名前も札の障害物（隠れた名前は除く）。去る顔は円板と同じく数えない。
      const nameBoxes = names.filter(({ item }) => !item.node.leaveAt).map(({ box }) => grown(box))
      // 札は出始めを依頼ごとに一度だけ決め、線が終わるまで出し続ける（behavior-spec "Chip start"）。毎コマ決め直すと点いたり消えたりする。
      // 置き場所は古い依頼から。今の場所が空いていれば動かさず、ふさがれば最初の空き場所へ。どこも空かなければ今の場所のまま blocked。
      const labels = [], blocked = [], above = [], placed = [], started = edge => Date.parse(edge.startedAt) || edge.startAt
      const order = [...lines].sort((a, b) => started(a.edge) - started(b.edge) || a.edge.startAt - b.edge.startAt || (a.edge.id < b.edge.id ? -1 : 1))
      const free = box => onScreen(box, rect) && !discs.some(disc => intersects(box, disc)) && !nameBoxes.some(name => intersects(box, name)) && !placed.some(other => intersects(box, grown(other)))
      for (const line of order) {
        const edge = line.edge
        const settled = [edge.from, edge.to].every(id => { const item = nodes.get(id); return !item || item.leaveAt || now - item.enterAt >= (reduceMotion ? REDUCED_MS : ENTER_MS) })
        if (chipText(edge) && !edge.chip && settled) edge.chip = { since: now, spot: null, appearAt: null, nullAt: null, lines: null }
        const chip = edge.chip
        if (!chip) continue
        const max = Math.min(180, rect.w - 8)
        if (chipText(edge)) { chip.nullAt = null; chip.lines = wrapLabel(chipText(edge), max - 12, measure) }
        else chip.nullAt ??= now
        const text = chip.lines, w = Math.min(max, Math.max(...text.map(measure)) + 12), h = text.length * 16 + 6
        const at = spot => intoRect(chipBoxAt(line, spot, w, h), rect), oversize = h + 8 > rect.h
        // 線を指した・タップした間の札（t = 0.5）。D より高い札は D の高さの箱で、文字を scroll（hover.scroll、最初の行から）で送る。
        const peek = () => oversize ? { box: { ...at(CENTER), h: rect.h - 8 }, scroll: Math.min(Math.max(0, hover?.scroll ?? 0), h + 8 - rect.h) } : { box: at(CENTER) }
        // Clearance が読む：札の大きさと、空きがない（置いた場所がふさがれた・まだ空きを待つ）か。
        chip.w = w; chip.h = h; chip.blocked = false
        let alpha = line.opacity
        if (chip.nullAt !== null) alpha *= Math.max(0, 1 - (now - chip.nullAt) / END_MS)
        // 消えた札だけが場所を返す。
        if (alpha <= 0 && (chip.nullAt !== null || edge.endAt)) chip.spot = null
        else if (!edge.endAt && chip.nullAt === null) {
          const first = CHIP_SPOTS.find(spot => free(at(spot)))
          if (chip.spot === null) { if (first !== undefined) { chip.spot = first; chip.appearAt = now } }
          else if (!free(at(chip.spot))) chip.spot = first ?? chip.spot
        }
        const hovered = hover?.edgeId === edge.id && chipText(edge) && !edge.endAt
        // 空きを待つ札も、線を指している・タップした間は t = 0.5 で一番上に出す（behavior-spec #800）。
        if (chip.spot === null) {
          chip.blocked = !edge.endAt && chip.nullAt === null
          if (hovered) above.push({ edge, ...peek(), alpha: 1, lines: text, blocked: false })
          continue
        }
        const box = at(chip.spot), isBlocked = !free(box)
        chip.blocked = isBlocked && !edge.endAt && chip.nullAt === null
        placed.push(box)
        // 最初に出る時いつも200msで現れる。
        alpha *= Math.min(1, (now - chip.appearAt) / 200)
        const item = { edge, box, alpha: hovered ? 1 : alpha, lines: text, blocked: isBlocked }
        if (hovered) above.push(oversize ? { ...item, ...peek() } : item)
        else (isBlocked ? blocked : labels).push(item)
      }
      labels.push(...above)
      return { side: S, nodes: [...drawn.values()], lines, blocked, labels, names, empty: !live.length }
    },
    get firstSeen() { return firstSeen },
  }
}

// 押せる相手：描いている名前、または顔（44×44未満なら44×44へ広げる）。名前も顔も後に描いた方が上。線・札・余白はnull。
export function nodeAt(frame, x, y) {
  const name = frame.names.findLast(({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h)
  if (name) return name.item.node.botId
  const item = frame.nodes.findLast(item => { const r = Math.max(item.side, 44) / 2; return Math.abs(item.x - x) <= r && Math.abs(item.y - y) <= r })
  return item?.node.botId ?? null
}

// タップ：主ボタンの押下を覚え、10px未満・500ms未満で離したらタップ（true を返す）。顔の上で押していたらその相手を開く。押している間に一度でも10px以上動いたら取り消し。
export function createTap(onTap) {
  let press = null
  return {
    down(id, x, y, at, primary, botId = null) { press = primary ? { id, x, y, at, botId } : null },
    move(id, x, y) { if (press?.id === id && Math.hypot(x - press.x, y - press.y) >= 10) press = null },
    up(id, x, y, at) {
      const item = press; press = null
      const tapped = item?.id === id && Math.hypot(x - item.x, y - item.y) < 10 && at - item.at < 500
      if (tapped && item.botId) onTap(item.botId)
      return tapped
    },
    cancel() { press = null },
  }
}

// 線（直線か二次曲線）上の位置。tは0〜1。
export function pointAt(line, t) {
  const { p0, p2, control } = line
  if (!control) return { x: p0.x + (p2.x - p0.x) * t, y: p0.y + (p2.y - p0.y) * t }
  const u = 1 - t
  return { x: u * u * p0.x + 2 * u * t * control.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * control.y + t * t * p2.y }
}

// 流れる点：28px間隔、90px/秒で依頼元から相手へ。最初と最後の10%で薄くなる。
export function flowDots(line, now) {
  if (line.edge.endAt || now < line.dotsSince || line.length <= 0) return []
  const offset = ((now - line.dotsSince) / 1000 * 90) % 28, dots = []
  for (let s = offset; s < line.length; s += 28) {
    const t = s / line.length, fade = Math.min(1, t / 0.1, (1 - t) / 0.1)
    dots.push({ ...pointAt(line, t), alpha: Math.max(0, fade) })
  }
  return dots
}

// 再接続の待ち時間：すぐ、1, 2, 4, 8, 15, 15…秒（±20%）。
export function backoffMs(attempt, random = Math.random) {
  if (attempt <= 0) return 0
  const base = [1000, 2000, 4000, 8000][attempt - 1] ?? 15000
  return Math.round(base * (0.8 + 0.4 * random()))
}
