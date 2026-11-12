// Reference simulation of the 相関図 layout in behavior-spec.md. `node layout-sim.mjs` prints the per-axis fill, then crossings, edges through a member and blocked chips before and after uncrossing swaps and clearance, then chips without a clear spot before and after the chip spots. Each run stops when the layout settles (alpha below alphaMin), as the apps stop their clock.
// Forces act on normalized coordinates (u = x/W, v = y/H), so every aspect ratio fills both axes alike.
export const LAYOUT = Object.freeze({ repulsion: 0.005, spring: 0.02, springLength: 1.4, springMax: 0.7,
  gravity: 0.02, targetFill: 0.88, gravityExponent: 16, gravityMin: 0.001, gravityMax: 50, damping: 0.82, maxSpeed: 14, collision: 2.2,
  alphaDecay: 0.985, alphaMin: 0.001, uncrossEvery: 30, clearance: 0.003, clearGap: 6, chipGap: 4, nameWidth: 1.6, chipWidth: 120, chipHeight: 22 })

export function nodeSize(W, H, n, base = 56) {
  const s12 = n > 12 ? base * Math.sqrt(12 / n) : base
  return Math.max(36, Math.min(s12, Math.sqrt(W * H / n) * 0.3))
}

// Proper intersection of segments ab and cd; edges that share a node never count.
const side = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
const cross = (a, b, c, d) => side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0

const pairsOf = edges => [...new Set(edges.map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`))].map(k => k.split(',').map(Number))
const crossCount = (P, list, all) => {
  let c = 0
  for (const [a, b] of list) for (const [e, f] of all) if (a !== e && a !== f && b !== e && b !== f && cross(P[a], P[b], P[e], P[f])) c++
  return c
}

// Crossings of the straight edges at points P (one per node); A->B and B->A count as one edge.
export function crossings(P, edges) {
  const pairs = pairsOf(edges)
  return crossCount(P, pairs, pairs) / 2
}

// Node box in points: avatar disc plus the name under it, grown by g. nameWidth is a fraction of S (apps use the real text box).
export const nodeBox = (p, S, nameHeight, g, L = LAYOUT) => {
  const hw = Math.max(S, S * L.nameWidth) / 2 + g
  return { x0: p.x - hw, x1: p.x + hw, y0: p.y - S / 2 - g, y1: p.y + S / 2 + 2 + nameHeight + g }
}
// Liang-Barsky: does segment ab enter box r?
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
export const chipSlots = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]
// Chip spots (Chip placement): every path position t = 0.5, 0.45, 0.55, ... 0.1, 0.9, and at each the chip centered on the point,
// then above, below, left and right of it (side = the chip's offset in half sizes; above = its bottom edge on the point).
export const chipSides = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]
export const chipSpots = [0.5, ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(k => [0.5 - k * 0.05, 0.5 + k * 0.05])]
  .map(t => Math.round(t * 100) / 100).flatMap(t => chipSides.map(side => ({ t, side })))
// The spots before 2026-11-10: centered on the path at t = 0.3 ... 0.7 only.
export const centerSpots = chipSlots.map(t => ({ t, side: [0, 0] }))
export const chipBox = (a, b, t = 0.5, L = LAYOUT, side = [0, 0]) => {
  const x = a.x + (b.x - a.x) * t + side[0] * L.chipWidth / 2, y = a.y + (b.y - a.y) * t + side[1] * L.chipHeight / 2
  return { x0: x - L.chipWidth / 2 - L.chipGap, x1: x + L.chipWidth / 2 + L.chipGap, y0: y - L.chipHeight / 2 - L.chipGap, y1: y + L.chipHeight / 2 + L.chipGap }
}
// A chip box (grown by chipGap) inside the drawable rect D = { W, H }; no area = no limit (chips before the on-screen rule).
export const onScreen = (box, area) => !area || (box.x0 >= 0 && box.y0 >= 0 && box.x1 <= area.W && box.y1 <= area.H)
// The box slid inward just enough to lie inside `area` (a box that touches an on-screen point still touches it).
// On an axis where the box is larger than the area (oversize chip), its start edge goes to the area's start edge instead;
// such a box is never inside the area, so it is never a free slot (onScreen is false).
const slide = (lo, hi, size) => hi - lo > size ? -lo : Math.max(0, -lo) - Math.max(0, hi - size)
export const intoArea = (box, area) => {
  if (!area) return box
  const dx = slide(box.x0, box.x1, area.W), dy = slide(box.y0, box.y1, area.H)
  return { x0: box.x0 + dx, x1: box.x1 + dx, y0: box.y0 + dy, y1: box.y1 + dy }
}
// The chip of edge ab at its first spot (slid inside `area`) clear of every node box (own ends included) and of the boxes in `chips`, or blocked at t = 0.5.
export function chipAt(P, a, b, S, nameHeight, L = LAYOUT, spots = chipSpots, chips = [], area = null) {
  for (const { t, side } of spots) {
    const box = intoArea(chipBox(P[a], P[b], t, L, side), area)
    if (onScreen(box, area) && P.every(p => !boxesMeet(box, nodeBox(p, S, nameHeight, 0, L))) && chips.every(c => !boxesMeet(box, c))) return { box, blocked: false }
  }
  return { box: intoArea(chipBox(P[a], P[b], 0.5, L), area), blocked: true }
}
// Every edge's chip placed in edge order (older first), earlier chips being obstacles: how many find no clear spot
// (they wait undrawn or stay blocked over a member or another chip), and how many placed chips leave `screen`.
export function placeChips(P, edges, S, nameHeight, L = LAYOUT, spots = chipSpots, area = null, screen = area) {
  const placed = []
  let blocked = 0
  for (const [a, b] of pairsOf(edges)) {
    const chip = chipAt(P, a, b, S, nameHeight, L, spots, placed.map(c => c.box), area)
    if (chip.blocked) blocked++; else placed.push(chip)
  }
  return { blocked, off: placed.filter(c => !onScreen(c.box, screen)).length }
}
// Edges that run through a node (disc or name) they do not belong to, and chips that find no clear slot (blocked).
export function clearanceFaults(P, edges, S, nameHeight, L = LAYOUT, spots = chipSpots, area = null, screen = area) {
  let passes = 0, chipHits = 0
  for (const [a, b] of pairsOf(edges)) for (let c = 0; c < P.length; c++) {
    if (c === a || c === b) continue
    if (segmentHitsBox(P[a], P[b], nodeBox(P[c], S, nameHeight, 0, L))) passes++
  }
  for (const [a, b] of pairsOf(edges)) if (chipAt(P, a, b, S, nameHeight, L, spots, [], area).blocked) chipHits++
  const chips = placeChips(P, edges, S, nameHeight, L, spots, area, screen)
  return { passes, chipHits, chipFaults: chips.blocked, chipsOff: chips.off }
}

// The node pair whose swapped places remove the most crossings, or null when no swap removes any.
// Only edges touching i or j move, so each pair costs (deg i + deg j) x edges, not edges^2.
export function bestSwap(P, edges, clear = null) {
  const pairs = pairsOf(edges), adjacent = P.map((_, i) => pairs.filter(([a, b]) => a === i || b === i)), touching = i => adjacent[i]
  // An edge through an unrelated node counts like a crossing (clear = { S, nameHeight }).
  const passes = (Q, i, j) => {
    if (!clear) return 0
    let c = 0
    const hit = (a, b, k) => k !== a && k !== b && segmentHitsBox(Q[a], Q[b], nodeBox(Q[k], clear.S, clear.nameHeight, 0))
    for (const [a, b] of pairs) {
      if (a === i || a === j || b === i || b === j) { for (let k = 0; k < Q.length; k++) if (hit(a, b, k)) c++ }
      else { if (hit(a, b, i)) c++; if (hit(a, b, j)) c++ }
    }
    return c
  }
  const local = (Q, i, j) => {
    const mine = [...new Set([...touching(i), ...touching(j)])]
    const inner = crossCount(Q, mine, mine) / 2
    return crossCount(Q, mine, pairs) - inner + passes(Q, i, j)
  }
  let best = null
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    if (!touching(i).length && !touching(j).length) continue
    const Q = P.slice(); Q[i] = P[j]; Q[j] = P[i]
    const gain = local(P, i, j) - local(Q, i, j)
    if (gain > 0 && (!best || gain > best.gain)) best = { pair: [i, j], gain }
  }
  return best
}

export function simulate({ W, H, n, edges, frames = 900, seed = 1, nameHeight = 18, L = LAYOUT, uncross = true, clear = true, spots = chipSpots, keepOnScreen = true, settle = true }) {
  const screen = { W, H }, area = keepOnScreen ? screen : null
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const S = nodeSize(W, H, n), kr = L.repulsion / n, len = Math.min(L.springMax, L.springLength / Math.sqrt(n))
  const nodes = Array.from({ length: n }, () => ({ u: 0.5 + (rnd() - 0.5) * 0.05, v: 0.5 + (rnd() - 0.5) * 0.05, vu: 0, vv: 0 }))
  const span = (key, size) => Math.max(...nodes.map(nd => nd[key])) - Math.min(...nodes.map(nd => nd[key])) + size
  const gravity = fill => L.gravity * Math.min(L.gravityMax, Math.max(L.gravityMin, (fill / L.targetFill) ** L.gravityExponent))
  let alpha = 1, swaps = 0, settled = null
  for (let frame = 0; frame < frames; frame++) {
    const F = nodes.map(() => ({ u: 0, v: 0 }))
    const pull = (i, j, q) => {
      const du = nodes[j].u - nodes[i].u, dv = nodes[j].v - nodes[i].v, d = Math.max(0.01, Math.hypot(du, dv))
      F[i].u += q(d) * du / d; F[i].v += q(d) * dv / d; F[j].u -= q(d) * du / d; F[j].v -= q(d) * dv / d
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pull(i, j, d => -kr / (d * d))
    for (const [a, b] of edges) pull(a, b, d => L.spring * (d - len))
    if (clear) {
      // Clearance: push an unrelated node off an edge's line and off its chip; the edge's ends take the opposite push.
      const P = nodes.map(nd => ({ x: nd.u * W, y: nd.v * H }))
      const push = (c, a, b, ta, nx, ny) => {
        const d = Math.hypot(nx, ny) || 1, fu = L.clearance * nx / d, fv = L.clearance * ny / d
        F[c].u += fu; F[c].v += fv; F[a].u -= fu * (1 - ta); F[a].v -= fv * (1 - ta); F[b].u -= fu * ta; F[b].v -= fv * ta
      }
      for (const [a, b] of pairsOf(edges)) {
        const chip = chipAt(P, a, b, S, nameHeight, L, spots, [], area), ex = P[b].x - P[a].x, ey = P[b].y - P[a].y, el = ex * ex + ey * ey || 1
        if (chip.blocked && [a, b].some(e => boxesMeet(chip.box, nodeBox(P[e], S, nameHeight, 0, L)))) {
          // the chip has no room between its own ends: lengthen the edge
          const d = Math.sqrt(el), fu = L.clearance * ex / d, fv = L.clearance * ey / d
          F[a].u -= fu; F[a].v -= fv; F[b].u += fu; F[b].v += fv
        }
        for (let c = 0; c < n; c++) {
          if (c === a || c === b) continue
          const box = nodeBox(P[c], S, nameHeight, L.clearGap, L), cx = P[c].x, cy = (box.y0 + box.y1) / 2
          if (segmentHitsBox(P[a], P[b], box)) {
            const t = Math.min(1, Math.max(0, ((cx - P[a].x) * ex + (cy - P[a].y) * ey) / el))
            let nx = cx - (P[a].x + t * ex), ny = cy - (P[a].y + t * ey)
            if (Math.hypot(nx, ny) < 1e-6) { nx = -ey; ny = ex }
            push(c, a, b, t, nx, ny)
          }
          if (chip.blocked && boxesMeet(chip.box, nodeBox(P[c], S, nameHeight, 0, L))) push(c, a, b, 0.5, cx - (chip.box.x0 + chip.box.x1) / 2, cy - (chip.box.y0 + chip.box.y1) / 2)
        }
      }
    }
    const gu = gravity(span('u', S / W)), gv = gravity(span('v', (S + nameHeight) / H))
    for (const [i, nd] of nodes.entries()) {
      nd.vu = (nd.vu + (F[i].u + gu * (0.5 - nd.u)) * alpha) * L.damping
      nd.vv = (nd.vv + (F[i].v + gv * (0.5 - nd.v)) * alpha) * L.damping
      const speed = Math.hypot(nd.vu * W, nd.vv * H)
      if (speed > L.maxSpeed) { nd.vu *= L.maxSpeed / speed; nd.vv *= L.maxSpeed / speed }
      nd.u = Math.min(1 - S / 2 / W, Math.max(S / 2 / W, nd.u + nd.vu))
      nd.v = Math.min(1 - (S / 2 + nameHeight) / H, Math.max(S / 2 / H, nd.v + nd.vv))
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = (nodes[j].u - nodes[i].u) * W, dy = (nodes[j].v - nodes[i].v) * H, d = Math.max(0.01, Math.hypot(dx, dy)), min = S * L.collision
      if (d < min) {
        const push = (min - d) / 2
        nodes[i].u -= push * dx / d / W; nodes[i].v -= push * dy / d / H; nodes[j].u += push * dx / d / W; nodes[j].v += push * dy / d / H
      }
    }
    if (uncross && frame % L.uncrossEvery === L.uncrossEvery - 1) {
      const swap = bestSwap(nodes.map(nd => ({ x: nd.u * W, y: nd.v * H })), edges, clear ? { S, nameHeight } : null)
      if (swap) {
        const [i, j] = swap.pair, a = nodes[i]
        nodes[i] = nodes[j]; nodes[j] = a
        swaps++
      }
    }
    // settle: below alphaMin the heat is 0 and the layout stops (the app's clock may stop); !settle = the old 0.04 floor
    alpha = settle ? alpha * L.alphaDecay : Math.max(0.04, alpha * L.alphaDecay)
    if (alpha < L.alphaMin) { settled = frame + 1; break }
  }
  const xs = nodes.map(nd => nd.u * W), ys = nodes.map(nd => nd.v * H)
  const P = nodes.map(nd => ({ x: nd.u * W, y: nd.v * H }))
  return { crossings: crossings(P, edges), ...clearanceFaults(P, edges, S, nameHeight, L, spots, area, screen), swaps, settled, fillX: (Math.max(...xs) - Math.min(...xs) + S) / W, fillY: (Math.max(...ys) - Math.min(...ys) + S + nameHeight) / H, size: S }
}

// n distinct random edges: a denser, cyclic graph than sampleEdges, for the crossing table.
export function denseEdges(n, seed = 11) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, keys = new Set()
  while (keys.size < n) { const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n); if (a !== b) keys.add(a < b ? `${a},${b}` : `${b},${a}`) }
  return [...keys].map(k => k.split(',').map(Number))
}

export function sampleEdges(n, seed = 7) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const edges = []
  for (let i = 1; i < n; i++) if (rnd() < 0.6) edges.push([Math.floor(rnd() * i), i])
  return edges
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const screens = { 'web 1440x900': [1392, 740], 'mac window': [952, 620], 'iphone portrait': [345, 640], 'ipad portrait': [770, 1000], square: [700, 700] }
  for (const [name, [W, H]] of Object.entries(screens)) for (const n of [2, 3, 4, 8, 16, 30]) {
    const runs = [1, 2, 3].map(seed => simulate({ W, H, n, edges: sampleEdges(n, seed + 3), seed }))
    const mean = key => (runs.reduce((sum, run) => sum + run[key], 0) / runs.length).toFixed(2)
    console.log(`${name.padEnd(16)} n=${String(n).padStart(2)} fillX=${mean('fillX')} fillY=${mean('fillY')} S=${runs[0].size.toFixed(0)}`)
  }
  for (const [name, [W, H]] of Object.entries({ 'web 1440x900': screens['web 1440x900'], 'iphone portrait': screens['iphone portrait'] })) for (const n of [6, 10, 16, 24]) {
    const seeds = [1, 2, 3, 4, 5], mean = list => (list.reduce((a, b) => a + b, 0) / seeds.length).toFixed(1)
    const run = opts => seeds.map(seed => simulate({ W, H, n, edges: denseEdges(n, seed + 11), seed, ...opts }))
    const off = run({ uncross: false, clear: false }), on = run({})
    const col = (runs, key) => mean(runs.map(r => r[key]))
    console.log(`${name.padEnd(16)} n=${String(n).padStart(2)} edges=${n} before -> after: crossings ${col(off, 'crossings')} -> ${col(on, 'crossings')}, edges through a member ${col(off, 'passes')} -> ${col(on, 'passes')}, blocked chips ${col(off, 'chipHits')} -> ${col(on, 'chipHits')}`)
  }
  // chip spots: centered t = 0.3 ... 0.7 (before 2026-11-10) -> every t and side; chips over a member or another chip
  for (const [name, [W, H]] of Object.entries({ 'web 1440x900': screens['web 1440x900'], 'iphone portrait': screens['iphone portrait'] })) for (const n of [10, 16, 24]) {
    const seeds = [1, 2, 3, 4, 5], mean = list => (list.reduce((a, b) => a + b, 0) / seeds.length).toFixed(1)
    const run = spots => seeds.map(seed => simulate({ W, H, n, edges: denseEdges(n, seed + 11), seed, spots }))
    const old = run(centerSpots), now = run(chipSpots), col = (runs, key) => mean(runs.map(r => r[key]))
    console.log(`${name.padEnd(16)} n=${String(n).padStart(2)} chips without a clear spot ${col(old, 'chipFaults')} -> ${col(now, 'chipFaults')}, edges through a member ${col(old, 'passes')} -> ${col(now, 'passes')}, crossings ${col(old, 'crossings')} -> ${col(now, 'crossings')}`)
  }
  // chips on screen (2026-11-10): spots leaving the drawing area allowed -> slid inside; chips off screen and chips without a clear spot
  for (const [name, [W, H]] of Object.entries({ 'web 1440x900': screens['web 1440x900'], 'iphone portrait': screens['iphone portrait'] })) for (const n of [10, 16, 24]) {
    const seeds = [1, 2, 3, 4, 5], mean = list => (list.reduce((a, b) => a + b, 0) / seeds.length).toFixed(1)
    const run = keepOnScreen => seeds.map(seed => simulate({ W, H, n, edges: denseEdges(n, seed + 11), seed, keepOnScreen }))
    const old = run(false), now = run(true), col = (runs, key) => mean(runs.map(r => r[key]))
    console.log(`${name.padEnd(16)} n=${String(n).padStart(2)} chips off screen ${col(old, 'chipsOff')} -> ${col(now, 'chipsOff')}, chips without a clear spot ${col(old, 'chipFaults')} -> ${col(now, 'chipFaults')}`)
  }
  // settle (2026-11-13): alpha 1 -> below alphaMin after ceil(log(alphaMin) / log(alphaDecay)) frames, then the run stops
  const still = simulate({ W: 345, H: 640, n: 4, edges: sampleEdges(4) })
  if (still.settled !== Math.ceil(Math.log(LAYOUT.alphaMin) / Math.log(LAYOUT.alphaDecay))) throw new Error(`settle at ${still.settled}`)
  // self-checks: segment/box test, and a swap's gain is exactly the drop in crossings
  const box = { x0: 0, x1: 10, y0: 0, y1: 10 }
  if (!segmentHitsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, box) || segmentHitsBox({ x: -5, y: 15 }, { x: 15, y: 15 }, box) || !segmentHitsBox({ x: 5, y: 5 }, { x: 50, y: 50 }, box)) throw new Error('segmentHitsBox')
  if (chipSpots.length !== 85 || chipSpots[1].t !== 0.5 || chipSpots[5].t !== 0.45 || chipSpots.at(-1).t !== 0.9) throw new Error('chipSpots')
  const up = chipBox({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, LAYOUT, [0, -1])
  if (up.y1 !== LAYOUT.chipGap || up.x0 !== 50 - LAYOUT.chipWidth / 2 - LAYOUT.chipGap) throw new Error('chipBox side')
  // an edge hugging the left screen edge: the centered chip at t = 0.5 slides right to the screen edge and still covers its point
  const edgeChip = chipAt([{ x: 10, y: 100 }, { x: 10, y: 400 }], 0, 1, 20, 0, LAYOUT, chipSpots, [], { W: 300, H: 500 })
  if (edgeChip.blocked || edgeChip.box.x0 !== 0 || edgeChip.box.x0 > 10 || edgeChip.box.y0 !== 250 - LAYOUT.chipHeight / 2 - LAYOUT.chipGap) throw new Error('chip on screen')
  // an oversize chip (taller than D): no free slot, blocked with its top edge on D's top and still on its own column
  const tall = { ...LAYOUT, chipHeight: 600 }, bigChip = chipAt([{ x: 100, y: 100 }, { x: 200, y: 400 }], 0, 1, 20, 0, tall, chipSpots, [], { W: 300, H: 500 })
  if (!bigChip.blocked || bigChip.box.y0 !== 0 || bigChip.box.x0 !== 150 - tall.chipWidth / 2 - tall.chipGap || onScreen(bigChip.box, { W: 300, H: 500 })) throw new Error('oversize chip')
  if (placeChips([{ x: 100, y: 100 }, { x: 200, y: 400 }], [[0, 1]], 20, 0, tall, chipSpots, { W: 300, H: 500 }).blocked !== 1) throw new Error('oversize chip count')
  let s = 5
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 100; k++) {
    const P = Array.from({ length: 12 }, () => ({ x: rnd() * 900, y: rnd() * 600 })), E = denseEdges(12, k + 1), swap = bestSwap(P, E)
    if (!swap) continue
    const Q = P.slice(); [Q[swap.pair[0]], Q[swap.pair[1]]] = [P[swap.pair[1]], P[swap.pair[0]]]
    if (crossings(P, E) - crossings(Q, E) !== swap.gain) throw new Error(`swap gain mismatch at sample ${k}`)
  }
}
