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
export const edgeText = (edge, names) => `${names.get(edge.from) ?? edge.from}から${names.get(edge.to) ?? edge.to}へ依頼${edge.label ? `: ${edge.label}` : ''}`

const validNode = node => node && typeof node.botId === 'string' && typeof node.name === 'string' && ['working', 'linked'].includes(node.state)
const validEdge = edge => edge && typeof edge.id === 'string' && typeof edge.from === 'string' && typeof edge.to === 'string'
export function readSnapshot(data) {
  if (data?.schema !== SCHEMA || typeof data.epoch !== 'string' || !Number.isInteger(data.version) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
    || !data.nodes.every(validNode) || !data.edges.every(validEdge)) throw new Error('WORK_GRAPH_UNREADABLE')
  return data
}

// 矩形の中心から方向(ux,uy)へ出た線が、一辺sの正方形の縁に当たるまでの距離。
const border = (s, ux, uy) => (s / 2) / Math.max(Math.abs(ux), Math.abs(uy), 1e-6)
const SLOTS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]
const grown = box => ({ x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 })
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export function createGraphModel({ reduceMotion = false } = {}) {
  const nodes = new Map(), edges = new Map()
  let epoch = null, version = -1, degraded = [], alpha = 1, firstSeen = false

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
            node.leaveFrom ??= { x: node.x, y: node.y }
            const dx = node.leaveFrom.x - cx, dy = node.leaveFrom.y - cy, d = Math.hypot(dx, dy) || 1, k = leaveCurve(t)
            x = node.leaveFrom.x + (cx + dx / d * far - node.leaveFrom.x) * k; y = node.leaveFrom.y + (cy + dy / d * far - node.leaveFrom.y) * k
            opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4
          }
        } else {
          const t = Math.min(1, (now - node.enterAt) / (reduceMotion ? REDUCED_MS : ENTER_MS))
          if (reduceMotion) opacity = t
          else if (t < 1) {
            const k = enterCurve(t), sx = cx + Math.cos(node.theta) * far, sy = cy + Math.sin(node.theta) * far
            x = sx + (node.x - sx) * k; y = sy + (node.y - sy) * k; scale = 0.6 + 0.4 * k; opacity = k
          }
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
      // 描いている名前も札の障害物（隠れた名前は除く）。去る顔は円板と同じく数えない。
      const nameBoxes = names.filter(({ item }) => !item.node.leaveAt).map(({ box }) => grown(box))
      // 札は出始めを依頼ごとに一度だけ決め、線が終わるまで出し続ける（behavior-spec "Chip start"）。毎コマ決め直すと点いたり消えたりする。
      // 置き場所は古い依頼から。今の t が空いていれば動かさず、ふさがれば最初の空き t へ。どこも空かなければ今の t のまま blocked。
      const labels = [], blocked = [], above = [], placed = [], started = edge => Date.parse(edge.startedAt) || edge.startAt
      const order = [...lines].sort((a, b) => started(a.edge) - started(b.edge) || a.edge.startAt - b.edge.startAt || (a.edge.id < b.edge.id ? -1 : 1))
      const boxAt = (line, t, w, h) => { const p = pointAt(line, t); return { x: p.x - w / 2, y: p.y - h / 2, w, h } }
      const free = box => !discs.some(disc => intersects(box, disc)) && !nameBoxes.some(name => intersects(box, name)) && !placed.some(other => intersects(box, grown(other)))
      for (const line of order) {
        const edge = line.edge
        const settled = [edge.from, edge.to].every(id => { const item = nodes.get(id); return !item || item.leaveAt || now - item.enterAt >= (reduceMotion ? REDUCED_MS : ENTER_MS) })
        if (edge.label && !edge.chip && settled) edge.chip = { since: now, t: null, appearAt: null, nullAt: null, lines: null }
        const chip = edge.chip
        if (!chip) continue
        if (edge.label) { chip.nullAt = null; chip.lines = wrapLabel(edge.label, 168, measure) }
        else chip.nullAt ??= now
        const text = chip.lines, w = Math.min(180, Math.max(...text.map(measure)) + 12), h = text.length * 16 + 6
        let alpha = line.opacity
        if (chip.nullAt !== null) alpha *= Math.max(0, 1 - (now - chip.nullAt) / END_MS)
        // 消えた札だけが場所を返す。
        if (alpha <= 0 && (chip.nullAt !== null || edge.endAt)) chip.t = null
        else if (!edge.endAt && chip.nullAt === null) {
          const first = SLOTS.find(t => free(boxAt(line, t, w, h)))
          if (chip.t === null) { if (first !== undefined) { chip.t = first; chip.appearAt = now } }
          else if (!free(boxAt(line, chip.t, w, h))) chip.t = first ?? chip.t
        }
        const hovered = hover?.edgeId === edge.id && edge.label && !edge.endAt
        // 空きを待つ札も、線を指している・タップした間は t = 0.5 で一番上に出す（behavior-spec #800）。
        if (chip.t === null) {
          if (hovered) above.push({ edge, box: boxAt(line, 0.5, w, h), alpha: 1, lines: text, blocked: false })
          continue
        }
        const box = boxAt(line, chip.t, w, h), isBlocked = !free(box)
        placed.push(box)
        // 最初に出る時いつも200msで現れる。
        alpha *= Math.min(1, (now - chip.appearAt) / 200)
        const item = { edge, box, alpha: hovered ? 1 : alpha, lines: text, blocked: isBlocked }
        if (hovered) above.push(item)
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

// タップ：押した時の相手を覚え、10px未満・500ms未満で離したらその相手を開く。押している間に一度でも10px以上動いたら取り消し。
export function createTap(onTap) {
  let press = null
  return {
    down(id, x, y, at, botId) { press = botId ? { id, x, y, at, botId } : null },
    move(id, x, y) { if (press?.id === id && Math.hypot(x - press.x, y - press.y) >= 10) press = null },
    up(id, x, y, at) { const item = press; press = null; if (item?.id === id && Math.hypot(x - item.x, y - item.y) < 10 && at - item.at < 500) onTap(item.botId) },
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
