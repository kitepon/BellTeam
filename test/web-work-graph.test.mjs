import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarSide, backoffMs, bestSwap, blinkOpacity, clearanceForces, createGraphModel, segmentHitsBox, createTap, edgeText, enterCurve, flowDots, nodeAt, nodeText, wrapLabel } from '../web/work-graph-model.js'
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

test('ラベルは円板に重ならず、混んでいても出し続ける。名前と点と点滅の位相', () => {
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
  const first = crowd.frame(1000, rect).labels.map(label => label.edge.id)
  assert.ok(first.length > 0)
  // 11本以上でも3秒で消えない（Owner 2026-11-09「札はずっと出しておこう」）。
  for (const t of [3500, 4500, 20000]) {
    const shown = crowd.frame(t, rect)
    for (const id of first) assert.ok([...shown.labels, ...shown.blocked].some(label => label.edge.id === id), `${id} at ${t}`)
  }
  assert.equal(blinkOpacity(Date.parse('2026-11-08T12:00:00Z'), '2026-11-08T12:00:00Z'), 0.25 + 0.65 * 0.5)
  assert.ok(Math.abs(enterCurve(1) - 1) < 1e-9 && enterCurve(0) === 0)
  assert.equal(nodeText(node('a', 'working', 'アン'), Date.parse('2026-11-08T12:05:30Z')), 'アン、作業中、5分前から')
  assert.equal(nodeText(node('b', 'linked', 'ベル'), 0), 'ベル、依頼の相手')
  assert.equal(edgeText(edge('a', 'b'), new Map([['a', 'アン'], ['b', 'ベル']])), 'アンからベルへ依頼: 依頼')
  for (const label of [null, '']) assert.equal(edgeText(edge('a', 'b', 'a:b', label), new Map([['a', 'アン'], ['b', 'ベル']])), 'アンからベルへ依頼')
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

test('札どうしも名前とも重ならず、古い依頼から置く。置けない札は空くまで待ち、線を指した時だけ一番上に出す', () => {
  const long = '比較表を更新して、iPhone・Mac・Web・Windowsの4つの画面で相関図のラベルが省略されずに全部出ることを確かめてください'
  const ids = ['h', 'a', 'b', 'c', 'd', 'e', 'f']
  const model = createGraphModel(), small = { x: 24, y: 24, w: 312, h: 600 }
  model.snapshot(snapshot(ids.map(id => node(id)), ids.slice(1).map((id, i) => ({ ...edge('h', id, `h:${id}`, long), startedAt: `2026-11-08T12:0${i}:00Z` }))), 0, small)
  for (let i = 0; i < 300; i++) model.step(1 / 60, small, i * 16)
  const frame = model.frame(5000, small), grow = b => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 })
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.ok(frame.labels.length > 0)
  frame.labels.forEach((a, i) => frame.labels.slice(i + 1).forEach(b => assert.ok(!hit(a.box, grow(b.box)), `${a.edge.id} / ${b.edge.id}`)))
  for (const label of frame.labels) for (const name of frame.names) assert.ok(!hit(label.box, grow(name.box)), `${label.edge.id} over ${name.item.node.botId}`)
  const placed = frame.labels.map(label => label.edge.startedAt)
  assert.deepEqual(placed, [...placed].sort())
  const hidden = ids.slice(1).map(id => `h:${id}`).find(id => !frame.labels.some(label => label.edge.id === id))
  assert.ok(hidden, 'the crowded hub hides at least one chip')
  const hovered = model.frame(5000, small, { hover: { edgeId: hidden } }).labels
  assert.equal(hovered.at(-1).edge.id, hidden)
  assert.deepEqual(hovered.slice(0, -1).map(label => label.box), frame.labels.map(label => label.box))
  assert.equal(model.edges.get(hidden).chip.t, null, 'it goes back to waiting')
  // 置けた札を指すと一番上に描く。
  const shown = frame.labels[0].edge.id
  assert.equal(model.frame(5000, small, { hover: { edgeId: shown } }).labels.at(-1).edge.id, shown)
})

test('札の出始めは依頼ごとに一度だけ決めて保つ。混んでも消えず、空きが無ければ今の t で blocked', () => {
  const two = createGraphModel()
  two.snapshot(snapshot([node('a'), node('b')], [edge('a', 'b')]), 0, rect)
  for (let i = 0; i < 300; i++) two.step(1 / 60, rect, i * 16)
  assert.equal(two.frame(5000, rect).labels.length, 1)
  // 最初に置かれた時は200msで現れる。
  assert.ok(two.frame(5100, rect).labels[0].alpha < 1 && two.frame(5300, rect).labels[0].alpha === 1)
  // あとで混んでも（11本以上）出たまま。text の変化は折り返しだけ。
  const more = Array.from({ length: 11 }, (_, i) => ({ type: 'edge-start', edge: edge('a', 'b', `x${i}`, null) }))
  more.push({ type: 'edge-update', edge: edge('a', 'b', 'a:b', '別の依頼') })
  assert.equal(two.change({ epoch: 'e1', version: 2, degraded: [], changes: more }, 6000, rect), true)
  for (let t = 6000; t < 20000; t += 500) {
    const chip = two.frame(t, rect).labels.find(label => label.edge.id === 'a:b')
    assert.ok(chip && chip.alpha === 1 && chip.lines[0] === '別の依頼', `chip at ${t}`)
  }
  // 円板が今の t に来て空きが無くなったら、その t のまま blocked（線の上・顔の下に描く別の列）。
  const chip = two.edges.get('a:b').chip, a = two.nodes.get('a'), b = two.nodes.get('b')
  const saved = { ax: a.x, ay: a.y }
  a.x = b.x; a.y = b.y + 1
  const frame = two.frame(21000, rect)
  assert.equal(frame.labels.some(label => label.edge.id === 'a:b'), false)
  assert.equal(frame.blocked.find(label => label.edge.id === 'a:b')?.blocked, true)
  assert.notEqual(chip.t, null)
  // label が null に戻ったら 300 ms で消え、場所を返す。
  Object.assign(a, { x: saved.ax, y: saved.ay })
  two.change({ epoch: 'e1', version: 3, degraded: [], changes: [{ type: 'edge-update', edge: edge('a', 'b', 'a:b', null) }] }, 22000, rect)
  two.frame(22000, rect)
  assert.ok(two.frame(22100, rect).labels.find(label => label.edge.id === 'a:b').alpha < 1)
  two.frame(22400, rect)
  assert.equal(chip.t, null)
  assert.equal(two.frame(23000, rect).labels.some(label => label.edge.id === 'a:b'), false)
})

test('顔のタップ範囲：名前か44×44以上の四角。線・札・余白は null。後に描いた顔が上', () => {
  const item = (botId, x, y, side) => ({ node: { botId }, x, y, side })
  const frame = { nodes: [item('a', 100, 100, 30), item('b', 130, 100, 30)], names: [{ item: item('c', 300, 300, 56), box: { x: 280, y: 337, w: 40, h: 18 } }], labels: [], blocked: [], lines: [] }
  assert.equal(nodeAt(frame, 100 - 21, 100 + 21), 'a', '30 px avatar grows to 44×44')
  assert.equal(nodeAt(frame, 100 - 23, 100), null)
  assert.equal(nodeAt(frame, 120, 100), 'b', 'the later drawn node is on top')
  assert.equal(nodeAt(frame, 300, 345), 'c', 'the name is part of the target')
  assert.equal(nodeAt(frame, 500, 500), null)
  // 名前が重なったら、後に描いた（上に見えている）名前の子。
  const both = { ...frame, names: [...frame.names, { item: item('d', 310, 300, 56), box: { x: 300, y: 337, w: 40, h: 18 } }] }
  assert.equal(nodeAt(both, 310, 345), 'd')
  // タップ：押した時の相手で開く。10px以上はみ出したら、戻ってきても開かない。長押しも開かない。
  // up の戻り値は「タップと認めたか」。線や余白のタップ（相手なし）も true、指の札の表示はこれだけで変える。
  const opened = [], tap = createTap(botId => opened.push(botId))
  tap.down(1, 0, 0, 0, true, 'a'); tap.move(1, 5, 0); assert.equal(tap.up(1, 6, 0, 400), true)
  tap.down(1, 0, 0, 1000, true, 'b'); tap.move(1, 20, 0); tap.move(1, 0, 0); assert.equal(tap.up(1, 0, 0, 1200), false)
  tap.down(1, 0, 0, 2000, true, 'c'); assert.equal(tap.up(1, 0, 0, 2500), false)
  tap.down(1, 0, 0, 3000, true, null); assert.equal(tap.up(1, 0, 0, 3100), true)
  tap.down(1, 0, 0, 4000, true, 'e'); tap.cancel(); assert.equal(tap.up(1, 0, 0, 4100), false)
  tap.down(1, 0, 0, 5000, false, null); assert.equal(tap.up(1, 0, 0, 5100), false)
  tap.down(1, 0, 0, 6000, true, null); assert.equal(tap.up(2, 0, 0, 6100), false)
  assert.deepEqual(opened, ['a'])
})

test('タップした子の会話は、通知と同じ経路でメモリにだけ持って開く', async () => {
  const { createNotificationNavigation } = await import('../web/notification-navigation.js')
  const data = new Map(), routed = [], notices = []
  const browser = { location: { href: 'https://example.com/', origin: 'https://example.com' }, history: { replaceState(a, b, url) { browser.location.href = url } }, sessionStorage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }, navigator: {} }
  let fail = true
  const nav = createNotificationNavigation({ browser, onRoute: async value => { if (fail) throw Error('TARGET_UNAVAILABLE'); routed.push(value) }, onNotice: notice => notices.push(notice) })
  await nav.ready()
  const route = { kind: 'member', messageId: null, requestId: null, botId: 'bot-a', roomId: null }
  await nav.open(route)
  assert.match(notices.at(-1), /開けませんでした/)
  assert.equal(data.size, 0); assert.equal(browser.location.href, 'https://example.com/')
  fail = false
  await nav.retry()
  assert.deepEqual(routed, [route]); assert.equal(notices.at(-1), '')
})

test('交差を減らす入れ替え：bestSwap は layout-sim.mjs と同じ。30コマ目に一組だけ位置と速度を替え、700msで滑る', async () => {
  const sim = await import('../docs/architecture/modules/work-graph/layout-sim.mjs')
  let s = 9
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  let swaps = 0
  for (let k = 0; k < 200; k++) {
    const P = Array.from({ length: 10 }, () => ({ x: rnd() * 900, y: rnd() * 600 })), E = sim.denseEdges(10, k + 1)
    if (k % 2) E.push(E[0].slice().reverse())
    const mine = bestSwap(P, E)
    assert.deepEqual(mine, sim.bestSwap(P, E))
    if (mine) swaps++
  }
  assert.ok(swaps > 50)
  // a-c と b-d が交差する並び。a と b を替えると交差が消える。
  const model = createGraphModel()
  model.snapshot(snapshot(['a', 'b', 'c', 'd'].map(id => node(id)), [edge('a', 'c'), edge('b', 'd'), edge('c', 'a', 'c:a2')]), 0, rect)
  const at = { a: [200, 150], b: [600, 150], c: [600, 450], d: [200, 450] }
  const heat = () => { for (const [id, [x, y]] of Object.entries(at)) Object.assign(model.nodes.get(id), { x, y, vu: 0, vv: 0 }) }
  const t0 = 10000
  for (let i = 0; i < 29; i++) { heat(); model.step(0, rect, t0) }
  // 置き直した同じ場所なので、30コマ目の力は29コマ目と同じ。a に足した速度は b へ移る。
  const a = model.nodes.get('a'), b = model.nodes.get('b'), force = [a.vu, b.vu]
  heat(); a.vu = 0.01
  model.step(0, rect, t0)
  assert.deepEqual([a.x, a.y, b.x, b.y], [600, 150, 200, 150])
  assert.ok(Math.abs(a.vu - force[1]) < 1e-12 && Math.abs(b.vu - (force[0] + 0.01 * 0.82)) < 1e-12)
  const pos = now => model.frame(now, rect).nodes.find(item => item.node.botId === 'a')
  assert.deepEqual([pos(t0).x, pos(t0).y], [200, 150])
  assert.ok(Math.abs(pos(t0 + 350).x - (200 + 400 * enterCurve(0.5))) < 1e-6)
  assert.deepEqual([pos(t0 + 700).x, pos(t0 + 700).opacity], [600, 1])
  // 減らない時は替えない
  for (let i = 0; i < 30; i++) model.step(0, rect, t0 + 800)
  assert.deepEqual([a.x, b.x], [600, 200])
  // Reduce Motion：前半は元の場所で消え、後半は新しい場所で現れる
  const reduced = createGraphModel({ reduceMotion: true })
  reduced.snapshot(snapshot(['a', 'b', 'c', 'd'].map(id => node(id)), [edge('a', 'c'), edge('b', 'd')]), 0, rect)
  const put = () => { for (const [id, [x, y]] of Object.entries(at)) Object.assign(reduced.nodes.get(id), { x, y, vu: 0, vv: 0 }) }
  for (let i = 0; i < 29; i++) { put(); reduced.step(0, rect, t0) }
  reduced.step(0, rect, t0)
  const ra = now => reduced.frame(now, rect).nodes.find(item => item.node.botId === 'a')
  assert.deepEqual([ra(t0 + 50).x, ra(t0 + 50).opacity], [200, 0.5])
  assert.deepEqual([ra(t0 + 150).x, ra(t0 + 150).opacity], [600, 0.5])
  assert.equal(ra(t0 + 200).opacity, 1)
})

test('Clearance：segmentHitsBox と線が顔を通る数え方つきの bestSwap は layout-sim.mjs と同じ。押す力は仕様の式', async () => {
  const sim = await import('../docs/architecture/modules/work-graph/layout-sim.mjs')
  let s = 21
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 500; k++) {
    const a = { x: rnd() * 300, y: rnd() * 300 }, b = k % 7 ? { x: rnd() * 300, y: rnd() * 300 } : { x: a.x, y: rnd() * 300 }
    const x0 = rnd() * 250, y0 = rnd() * 250, box = { x0, x1: x0 + rnd() * 80, y0, y1: y0 + rnd() * 80 }
    assert.equal(segmentHitsBox(a, b, box), sim.segmentHitsBox(a, b, box))
  }
  const S = 56, nameHeight = 18, clear = { box: (k, p) => sim.nodeBox(p, S, nameHeight, 0) }
  let differs = 0
  for (let k = 0; k < 200; k++) {
    const P = Array.from({ length: 10 }, () => ({ x: rnd() * 900, y: rnd() * 600 })), E = sim.denseEdges(10, k + 1)
    if (k % 2) E.push(E[0].slice().reverse())
    const mine = bestSwap(P, E, clear)
    assert.deepEqual(mine, sim.bestSwap(P, E, { S, nameHeight }))
    if (JSON.stringify(mine) !== JSON.stringify(bestSwap(P, E))) differs++
  }
  assert.ok(differs > 20, `edges through a member changed ${differs} choices`)
  // 押す力：a(0,0)→b(400,0)。c の箱（円板＋名前、+6）を線が通る。箱の中心は c.y + (2 + 18) / 2。
  const kc = 0.003, box = (P, g) => (k, gap) => sim.nodeBox(P[k], S, nameHeight, gap ?? g)
  const close = (got, want) => got.forEach((f, i) => assert.ok(Math.abs(f.u - want[i][0]) < 1e-12 && Math.abs(f.v - want[i][1]) < 1e-12, `node ${i}: ${f.u},${f.v} vs ${want[i]}`))
  let P = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 100, y: 5 }, { x: 100, y: 300 }]
  close(clearanceForces(P, [[0, 1]], { box: box(P) }), [[0, -kc * 0.75], [0, -kc * 0.25], [0, kc], [0, 0]])
  // 箱の中心がちょうど線の上：線の法線（-ey, ex）へ
  P = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: -10 }]
  close(clearanceForces(P, [[0, 1]], { box: box(P) }), [[0, -kc * 0.5], [0, -kc * 0.5], [0, kc]])
  // blocked の札（中点、4 広げた箱）が c に重なる：c は札の中心から離れ、両端が半分ずつ受ける。線は c の箱に入らない
  P = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: 40 }]
  const chip = () => sim.chipBox(P[0], P[1], 0.5)
  close(clearanceForces(P, [[0, 1]], { box: box(P), chip }), [[0, -kc * 0.5], [0, -kc * 0.5], [0, kc]])
  // 札が自分の端に重なる：線を伸ばす
  P = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
  close(clearanceForces(P, [[0, 1]], { box: box(P), chip: () => sim.chipBox(P[0], P[1], 0.5) }), [[-kc, 0], [kc, 0]])
  // 札が blocked でなければ、線に触れない顔は押さない
  P = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: 50 }]
  close(clearanceForces(P, [[0, 1]], { box: box(P) }), [[0, 0], [0, 0], [0, 0]])
})

test('Clearance をモデルで：描いた名前の箱を覚え、線の上の関係ない顔を押し出す。札の blocked と大きさを覚える', () => {
  const at = { a: [124, 324], b: [624, 324], c: [374, 330] }
  const run = withEdge => {
    const model = createGraphModel()
    model.snapshot(snapshot(['a', 'b', 'c'].map(id => node(id)), withEdge ? [edge('a', 'b', 'a:b', 'とても長い依頼の名前'.repeat(4))] : []), 0, rect)
    for (const [id, [x, y]] of Object.entries(at)) Object.assign(model.nodes.get(id), { x, y, vu: 0, vv: 0 })
    model.frame(5000, rect)
    model.step(0, rect, 5000)
    return model
  }
  const on = run(true), off = run(false), c = on.nodes.get('c')
  assert.ok(c.nameRel && c.nameRel.y0 > 0, 'the name below c is remembered as part of its box')
  // 札は a・b・c の間に空きがなく blocked。線と札の両方が c の上にあるので、c は下へ（v が増える向き）2回押される。違いは押す力だけ。
  assert.equal(on.edges.get('a:b').chip.blocked, true, 'the chip has no free slot between a, b and c')
  assert.ok(Math.abs(c.vv - off.nodes.get('c').vv - 2 * 0.003 * 0.82) < 1e-12, `${c.vv - off.nodes.get('c').vv}`)
  assert.ok(on.edges.get('a:b').chip.w > 0 && on.edges.get('a:b').chip.h > 0)
})
