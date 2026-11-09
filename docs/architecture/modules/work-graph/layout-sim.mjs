// Reference simulation of the 相関図 layout in behavior-spec.md. `node layout-sim.mjs` prints the per-axis fill and the edge crossings without and with uncrossing swaps.
// Forces act on normalized coordinates (u = x/W, v = y/H), so every aspect ratio fills both axes alike.
export const LAYOUT = Object.freeze({ repulsion: 0.005, spring: 0.02, springLength: 1.4, springMax: 0.7,
  gravity: 0.02, targetFill: 0.88, gravityExponent: 16, gravityMin: 0.001, gravityMax: 50, damping: 0.82, maxSpeed: 14, collision: 2.2,
  uncrossEvery: 30 })

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

// The node pair whose swapped places remove the most crossings, or null when no swap removes any.
// Only edges touching i or j move, so each pair costs (deg i + deg j) x edges, not edges^2.
export function bestSwap(P, edges) {
  const pairs = pairsOf(edges), adjacent = P.map((_, i) => pairs.filter(([a, b]) => a === i || b === i)), touching = i => adjacent[i]
  const local = (Q, i, j) => {
    const mine = [...new Set([...touching(i), ...touching(j)])]
    const inner = crossCount(Q, mine, mine) / 2
    return crossCount(Q, mine, pairs) - inner
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

export function simulate({ W, H, n, edges, frames = 900, seed = 1, nameHeight = 18, L = LAYOUT, uncross = true }) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const S = nodeSize(W, H, n), kr = L.repulsion / n, len = Math.min(L.springMax, L.springLength / Math.sqrt(n))
  const nodes = Array.from({ length: n }, () => ({ u: 0.5 + (rnd() - 0.5) * 0.05, v: 0.5 + (rnd() - 0.5) * 0.05, vu: 0, vv: 0 }))
  const span = (key, size) => Math.max(...nodes.map(nd => nd[key])) - Math.min(...nodes.map(nd => nd[key])) + size
  const gravity = fill => L.gravity * Math.min(L.gravityMax, Math.max(L.gravityMin, (fill / L.targetFill) ** L.gravityExponent))
  let alpha = 1, swaps = 0
  for (let frame = 0; frame < frames; frame++) {
    const F = nodes.map(() => ({ u: 0, v: 0 }))
    const pull = (i, j, q) => {
      const du = nodes[j].u - nodes[i].u, dv = nodes[j].v - nodes[i].v, d = Math.max(0.01, Math.hypot(du, dv))
      F[i].u += q(d) * du / d; F[i].v += q(d) * dv / d; F[j].u -= q(d) * du / d; F[j].v -= q(d) * dv / d
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pull(i, j, d => -kr / (d * d))
    for (const [a, b] of edges) pull(a, b, d => L.spring * (d - len))
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
      const swap = bestSwap(nodes.map(nd => ({ x: nd.u * W, y: nd.v * H })), edges)
      if (swap) {
        const [i, j] = swap.pair, a = nodes[i]
        nodes[i] = nodes[j]; nodes[j] = a
        swaps++
      }
    }
    alpha = Math.max(0.04, alpha * 0.985)
  }
  const xs = nodes.map(nd => nd.u * W), ys = nodes.map(nd => nd.v * H)
  return { crossings: crossings(nodes.map(nd => ({ x: nd.u * W, y: nd.v * H })), edges), swaps, fillX: (Math.max(...xs) - Math.min(...xs) + S) / W, fillY: (Math.max(...ys) - Math.min(...ys) + S + nameHeight) / H, size: S }
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
    const off = seeds.map(seed => simulate({ W, H, n, edges: denseEdges(n, seed + 11), seed, uncross: false }).crossings)
    const on = seeds.map(seed => simulate({ W, H, n, edges: denseEdges(n, seed + 11), seed }).crossings)
    console.log(`${name.padEnd(16)} n=${String(n).padStart(2)} edges=${n} crossings without swaps=${mean(off)} with swaps=${mean(on)}`)
  }
  // self-check: a swap's gain is exactly the drop in crossings
  let s = 5
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 100; k++) {
    const P = Array.from({ length: 12 }, () => ({ x: rnd() * 900, y: rnd() * 600 })), E = denseEdges(12, k + 1), swap = bestSwap(P, E)
    if (!swap) continue
    const Q = P.slice(); [Q[swap.pair[0]], Q[swap.pair[1]]] = [P[swap.pair[1]], P[swap.pair[0]]]
    if (crossings(P, E) - crossings(Q, E) !== swap.gain) throw new Error(`swap gain mismatch at sample ${k}`)
  }
}
