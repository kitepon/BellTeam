import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarSide, backoffMs, blinkOpacity, createGraphModel, edgeText, enterCurve, flowDots, nodeText, wrapLabel } from '../web/work-graph-model.js'
import { createGraphStream, parseFrames } from '../web/work-graph.js'

const rect = { x: 24, y: 24, w: 800, h: 600 }
const node = (botId, state = 'working', name = botId) => ({ botId, name, color: 'mint', avatarVersion: '', state, activeSince: '2026-11-08T12:00:00Z' })
const edge = (from, to, id = `${from}:${to}`, label = '依頼') => ({ id, requestId: id, from, to, context: 'direct', roomId: null, label, state: 'running', startedAt: '2026-11-08T12:00:00Z' })
const snapshot = (nodes, edges, version = 1, epoch = 'e1') => ({ schema: 'bellteam.work-graph.v1', epoch, version, at: '', degraded: [], nodes, edges })

test('snapshot と change は epoch と version が1つずつ進む時だけ適用し、それ以外は再接続', () => {
  const model = createGraphModel()
  assert.throws(() => model.snapshot({ schema: 'other', nodes: [], edges: [] }, 0, rect))
  model.snapshot(snapshot([node('a'), node('b')], [edge('a', 'b')]), 0, rect)
  assert.equal(model.change({ epoch: 'e1', version: 3, changes: [] }, 1, rect), false)
  assert.equal(model.change({ epoch: 'e2', version: 2, changes: [] }, 1, rect), false)
  assert.equal(model.change({ epoch: 'e1', version: 2, degraded: ['queue'], changes: [{ type: 'edge-end', edgeId: 'a:b' }, { type: 'member-leave', botId: 'b' }] }, 1000, rect), true)
  assert.deepEqual(model.degraded, ['queue'])
  assert.ok(model.nodes.get('b').leaveAt && model.edges.get('a:b').endAt)
  model.step(1 / 60, rect, 1000 + 700)
  assert.equal(model.nodes.has('b'), false)
  assert.equal(model.edges.has('a:b'), false)
  // 再接続後の新しい一枚：残る人は位置を保ち、居なくなった人は出ていく。
  const a = model.nodes.get('a'), x = a.x
  model.snapshot(snapshot([node('a'), node('c')], [], 9, 'e2'), 2000, rect)
  assert.equal(model.nodes.get('a'), a); assert.equal(a.x, x)
  assert.ok(model.nodes.has('c'))
})

test('大きさ・力学・境界は仕様の数値。多い時は小さくなり、全員がDの中で互いに離れる', () => {
  assert.equal(avatarSide(rect, 4, false), 56)
  assert.equal(avatarSide(rect, 4, true), 64)
  assert.ok(Math.abs(avatarSide(rect, 27, false) - 56 * Math.sqrt(12 / 27)) < 1e-9)
  assert.equal(avatarSide({ w: 300, h: 300 }, 40, false), 36)
  const model = createGraphModel(), ids = Array.from({ length: 14 }, (_, i) => `bot-${i}`)
  model.snapshot(snapshot(ids.map(id => node(id)), ids.slice(1).map((id, i) => edge(ids[i], id))), 0, rect)
  for (let i = 0; i < 900; i++) model.step(1 / 60, rect, i * 16)
  const S = avatarSide(rect, 14, false), list = [...model.nodes.values()]
  for (const item of list) {
    assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y))
    assert.ok(item.x >= rect.x + S * 1.1 - 1e-6 && item.x <= rect.x + rect.w - S * 1.1 + 1e-6)
    assert.ok(item.y >= rect.y + S / 2 - 1e-6 && item.y <= rect.y + rect.h - S / 2 - 28 + 1e-6)
  }
  const near = Math.min(...list.flatMap((a, i) => list.slice(i + 1).map(b => Math.hypot(a.x - b.x, a.y - b.y))))
  assert.ok(near > S * 1.6, `nearest pair ${near}`)
  assert.ok(model.alpha >= 0.04)
})

test('ラベルは円板に重ならず、混んでいる時は始まって3秒だけ。名前と点と点滅の位相', () => {
  const model = createGraphModel()
  model.snapshot(snapshot([node('a', 'working', 'アン'), node('b', 'linked', 'ベル')], [edge('a', 'b')]), 0, rect)
  for (let i = 0; i < 300; i++) model.step(1 / 60, rect, i * 16)
  let frame = model.frame(5000, rect)
  assert.equal(frame.labels.length, 1)
  for (const label of frame.labels) for (const item of frame.nodes) {
    const d = { x: item.x - item.side / 2 - 4, y: item.y - item.side / 2 - 4, w: item.side + 8, h: item.side + 8 }, b = label.box
    assert.ok(!(b.x < d.x + d.w && d.x < b.x + b.w && b.y < d.y + d.h && d.y < b.y + b.h))
  }
  assert.ok(flowDots(frame.lines[0], 5000).length > 0)
  const crowd = createGraphModel(), ids = Array.from({ length: 12 }, (_, i) => `n${i}`)
  crowd.snapshot(snapshot(ids.map(id => node(id)), ids.slice(1).map((id, i) => edge(ids[i], id))), 0, rect)
  for (let i = 0; i < 300; i++) crowd.step(1 / 60, rect, i * 16)
  assert.ok(crowd.frame(1000, rect).labels.length > 0)
  assert.equal(crowd.frame(3500, rect).labels.length, 0)
  assert.equal(crowd.frame(3500, rect, { hover: { edgeId: 'n0:n1' } }).labels.length, 1)
  assert.equal(blinkOpacity(Date.parse('2026-11-08T12:00:00Z'), '2026-11-08T12:00:00Z'), 0.25 + 0.65 * 0.5)
  assert.ok(Math.abs(enterCurve(1) - 1) < 1e-9 && enterCurve(0) === 0)
  assert.equal(nodeText(node('a', 'working', 'アン'), Date.parse('2026-11-08T12:05:30Z')), 'アン、作業中、5分前から')
  assert.equal(nodeText(node('b', 'linked', 'ベル'), 0), 'ベル、依頼の相手')
  assert.equal(edgeText(edge('a', 'b'), new Map([['a', 'アン'], ['b', 'ベル']])), 'アンからベルへ依頼: 依頼')
})

test('SSEの読み取り：snapshotから始め、番号の飛び・404・503・切断はどれも再接続し続ける', async () => {
  assert.deepEqual(parseFrames('event: snapshot\ndata: {"a":1}\n\n: hb\n\nevent: ch'), { frames: [{ event: 'snapshot', data: '{"a":1}' }, { event: null, data: null }], rest: 'event: ch' })
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => backoffMs(i, () => 0.5)), [0, 1000, 2000, 4000, 8000, 15000, 15000])
  const body = text => ({ ok: true, status: 200, body: { getReader() { let sent = false; return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new TextEncoder().encode(text) } } } } } })
  const responses = [{ ok: false, status: 404 }, { ok: false, status: 503 }, body('event: snapshot\ndata: {"v":1}\n\nevent: change\ndata: {"v":3}\n\n'), body('event: snapshot\ndata: not-json\n\n')]
  const statuses = [], snapshots = [], timers = []
  let stream
  stream = createGraphStream({
    fetch: async () => responses.shift() ?? new Promise(() => {}),
    setTimeout: (fn, ms) => { if (ms === 35000) return 0; timers.push(ms); if (timers.length < 6) queueMicrotask(fn); return timers.length }, clearTimeout() {}, random: () => 0.5,
    onSnapshot: data => snapshots.push(data), onChange: data => data.v === 2, onStatus: status => statuses.push(status),
  })
  stream.start()
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  stream.stop()
  assert.deepEqual(statuses, ['missing', 'unreadable', 'live', 'drop', 'unreadable'])
  assert.deepEqual(snapshots, [{ v: 1 }])
  assert.ok(timers.includes(0))
})

test('配置は D に正規化した力で両方向を埋める（layout-sim.mjs と同じ埋まり方、Web 1440×900）', async () => {
  const { simulate, sampleEdges } = await import('../docs/architecture/modules/work-graph/layout-sim.mjs')
  const D = { x: 24, y: 24, w: 1392, h: 740 }
  for (const n of [4, 16]) {
    const ids = Array.from({ length: n }, (_, i) => `bot-${i}`), model = createGraphModel()
    model.snapshot(snapshot(ids.map(id => node(id)), sampleEdges(n, 4).map(([a, b]) => edge(ids[a], ids[b]))), 0, D)
    for (let i = 0; i < 900; i++) model.step(1 / 60, D, i * 16.7)
    const S = avatarSide(D, n, false), list = [...model.nodes.values()]
    const fillX = (Math.max(...list.map(p => p.x)) - Math.min(...list.map(p => p.x)) + S) / D.w
    const fillY = (Math.max(...list.map(p => p.y)) - Math.min(...list.map(p => p.y)) + S + 18) / D.h
    const ref = simulate({ W: D.w, H: D.h, n, edges: sampleEdges(n, 4), seed: 1 })
    assert.ok(Math.abs(fillX - ref.fillX) < 0.05 && Math.abs(fillY - ref.fillY) < 0.05, `n=${n} web ${fillX.toFixed(2)}/${fillY.toFixed(2)} ref ${ref.fillX.toFixed(2)}/${ref.fillY.toFixed(2)}`)
    assert.ok(fillX > 0.8 && fillY > 0.8)
  }
})

test('依頼ラベルは省略せず折り返し、伸びた札の大きさで円板を避ける', () => {
  const measure = text => text.length * 7
  assert.deepEqual(wrapLabel('aaaa bbbb cc', 56, measure), ['aaaa', 'bbbb cc'])
  assert.deepEqual(wrapLabel('あいうえおかきくけこ', 35, measure), ['あいうえお', 'かきくけこ'])
  const long = 'PR733 の相関図の仕様に合わせて、依頼のラベルを省略せずに折り返して全部見せるように直してください。'
  assert.equal(wrapLabel(long, 168, measure).join('').replace(/ /g, ''), long.replace(/ /g, ''))
  const model = createGraphModel()
  model.snapshot(snapshot([node('a'), node('b')], [edge('a', 'b', 'a:b', long)]), 0, rect)
  for (let i = 0; i < 300; i++) model.step(1 / 60, rect, i * 16)
  const [label] = model.frame(5000, rect).labels
  assert.ok(label.lines.length > 1 && label.lines.every(line => !line.includes('…') && measure(line) <= 168))
  assert.equal(label.box.h, label.lines.length * 16 + 6)
  assert.ok(label.box.w <= 180)
  for (const item of model.frame(5000, rect).nodes) {
    const d = { x: item.x - item.side / 2 - 4, y: item.y - item.side / 2 - 4, w: item.side + 8, h: item.side + 8 }, b = label.box
    assert.ok(!(b.x < d.x + d.w && d.x < b.x + b.w && b.y < d.y + d.h && d.y < b.y + b.h))
  }
})

test('札どうしは重ならず、古い依頼から置く。置けない札は指した時だけ一番上に出す', () => {
  const long = '比較表を更新して、iPhone・Mac・Web・Windowsの4つの画面で相関図のラベルが省略されずに全部出ることを確かめてください'
  const ids = ['h', 'a', 'b', 'c', 'd', 'e', 'f']
  const model = createGraphModel(), small = { x: 24, y: 24, w: 312, h: 600 }
  model.snapshot(snapshot(ids.map(id => node(id)), ids.slice(1).map((id, i) => ({ ...edge('h', id, `h:${id}`, long), startedAt: `2026-11-08T12:0${i}:00Z` }))), 0, small)
  for (let i = 0; i < 300; i++) model.step(1 / 60, small, i * 16)
  const frame = model.frame(5000, small), grow = b => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 })
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.ok(frame.labels.length > 0)
  frame.labels.forEach((a, i) => frame.labels.slice(i + 1).forEach(b => assert.ok(!hit(a.box, grow(b.box)), `${a.edge.id} / ${b.edge.id}`)))
  const placed = frame.labels.map(label => label.edge.startedAt)
  assert.deepEqual(placed, [...placed].sort())
  const hidden = ids.slice(1).map(id => `h:${id}`).find(id => !frame.labels.some(label => label.edge.id === id))
  assert.ok(hidden, 'the crowded hub hides at least one chip')
  const hovered = model.frame(5000, small, { hover: { edgeId: hidden } }).labels
  assert.equal(hovered.at(-1).edge.id, hidden)
  assert.deepEqual(hovered.slice(0, -1).map(label => label.box), frame.labels.map(label => label.box))
})
