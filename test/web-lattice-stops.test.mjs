import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopRows, stopTime, unblockOutcome, createStopsView } from '../web/lattice-stops.js'
import { createLatticeChart } from '../web/lattice-chart.js'

const BASE = Date.parse('2026-11-12T12:00:00Z'), ago = ms => new Date(BASE - ms).toISOString()
const MIN = 60000, DAY = 86400000
const TRONY = 'bot-7b140b27', MOLLY = 'bot-39be7047', GHOST = 'bot-ghost0001'
const SCHEMA = 'bellteam.lattice-blockers.v1'
const members = { [TRONY]: 'トロニー', [MOLLY]: 'モリー' }
const getMember = id => members[id] ? { botId: id, name: members[id], color: 'mint', avatar: '', known: true } : null
const stop = (n, extra = {}) => ({ stopId: `${String(n).padStart(2, '0')}`.repeat(12), projectId: 'bellteam', chartName: 'BellTeam開発', chartCreatedBy: TRONY, plan: 'p1', taskId: `t${n}`, cardId: `p1/t${n}`,
  title: `工程${n}`, lane: MOLLY, reason: 'CI is red on main', blockedAt: ago(30 * MIN), blockedBy: MOLLY, ...extra })
const answer = (blockers, extra = {}) => ({ schema: SCHEMA, at: '', blockers, unreadCharts: [], ...extra })
const http = (status, body = {}) => Object.assign(new Error(`HTTP_${status}`), { status, ...body })

// ---- pure ----
test('stopRows：新しい止めが先、担当と止めた人は名簿・指揮官・書かれた文字・名簿にない子・なし、時刻はJST、id もコードも出ない', () => {
  const blockers = [
    stop(1, { blockedAt: '2026-11-05T15:30:00Z', lane: 'kiro', blockedBy: GHOST, chartName: null, chartCreatedBy: 'bot-nobody0001' }),
    stop(2, { blockedAt: ago(30 * MIN), lane: null, blockedBy: 'owner', chartName: null }),
    stop(3, { blockedAt: ago(DAY), lane: 'owner', blockedBy: TRONY }),
    stop(4, { blockedAt: 'not a time', reason: '' }),
  ]
  const rows = stopRows(blockers, { now: BASE, getMember, getOwner: () => ({ name: 'クオ' }) })
  assert.deepEqual(rows.map(row => row.title), ['工程2', '工程3', '工程1', '工程4'], '新しい blockedAt が先、読めない時刻は最後')
  assert.deepEqual(rows.map(row => row.time), ['今日 20:30', '昨日 21:00', '11月6日 00:30', ''])
  const [r2, r3, r1] = rows
  assert.equal(r2.lane, null); assert.equal(r2.by.name, 'クオ'); assert.equal(r2.chart, 'トロニーの工程表', '名前が無ければ作った人の工程表')
  assert.equal(r3.lane.name, 'クオ'); assert.equal(r3.by.name, 'トロニー'); assert.equal(r3.chart, 'BellTeam開発')
  assert.deepEqual([r1.lane.name, r1.lane.authored, r1.by.name, r1.by.known, r1.chart], ['kiro', true, '名簿にないメンバー', false, '名前のない工程表'])
  assert.equal(r2.label, '止まり、工程2、トロニーの工程表、担当なし、理由 CI is red on main、クオが今日 20:30に止めました')
  assert.equal(rows[3].label, '止まり、工程4、BellTeam開発、担当 モリー、モリーが止めました', '理由が空なら言わない、時刻が読めなければ時刻を言わない')
  assert.doesNotMatch(rows.map(row => `${row.label}${row.chart}`).join('\n'), /bot-[0-9a-z]{6,}|bellteam\b|p1\/t\d|[0-9a-f]{24}/u)
  assert.deepEqual(rows.map(row => [row.projectId, row.cardId]).slice(0, 1), [['bellteam', 'p1/t2']])
  assert.equal(stopTime(ago(0), BASE), '今日 21:00'); assert.equal(stopTime('', BASE), '')
  assert.deepEqual(stopRows([{ title: 'no id' }, null], { now: BASE }), [], 'stopId と projectId の無い行は捨てる')
})

test('unblockOutcome：200 removed / already-gone は drop、409 は refused と reason、それ以外はすべて later', () => {
  assert.deepEqual(unblockOutcome(200, { outcome: 'removed' }), { kind: 'drop' })
  assert.deepEqual(unblockOutcome(200, { outcome: 'already-gone' }), { kind: 'drop' })
  assert.deepEqual(unblockOutcome(409, { reason: '先に確認してください' }), { kind: 'refused', reason: '先に確認してください' })
  assert.deepEqual(unblockOutcome(409, {}), { kind: 'refused', reason: '' })
  for (const [status, body] of [[200, { outcome: 'other' }], [200, null], [400, {}], [503, {}], [500, {}], [undefined, {}]]) assert.deepEqual(unblockOutcome(status, body), { kind: 'later' }, String(status))
})

// ---- fake DOM ----
class Text { constructor(text) { this.nodeType = 3; this.textContent = text } }
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = new Map(); this.dataset = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.style = { setProperty: (k, v) => { this.style[k] = v } }; this.open = false; this.parent = null }
  get textContent() { return this.children.map(c => c.textContent).join('') }
  set textContent(v) { this.children = [new Text(String(v))] }
  get classList() { const el = this; return { add: n => { if (!el.className.split(' ').includes(n)) el.className = `${el.className} ${n}`.trim() }, remove: n => { el.className = el.className.split(' ').filter(c => c && c !== n).join(' ') }, contains: n => el.className.split(' ').includes(n), toggle(n, force) { const on = force ?? !this.contains(n); on ? this.add(n) : this.remove(n); return on } } }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else this.attrs.set(k, String(v)) }
  getAttribute(k) { return k === 'class' ? this.className : this.attrs.get(k) ?? null }
  append(...nodes) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n) } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes) }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== fn) }
  fire(type, event = {}) { const e = { target: this, preventDefault() { this.prevented = true }, ...event }; for (const fn of this.listeners[type] ?? []) fn(e); return e }
  click() { return this.fire('click') }
  focus() { document.activeElement = this }
  closest() { return null }
  scrollTo(options) { this.scrolled = options }
  showModal() { this.open = true }
  close() { this.open = false; this.fire('close') }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
  querySelectorAll(sel) { const key = sel.slice(1, -1).replace(/^data-/u, '').replace(/-./gu, m => m[1].toUpperCase()); return all(this).filter(el => el.dataset && key in el.dataset) }
}
const all = root => root.children.flatMap(c => c.nodeType === 3 ? [] : [c, ...all(c)])
const textOf = el => el.textContent
const byClass = (root, name) => all(root).filter(el => el.className.split(' ').includes(name))
const buttonByText = (root, text) => all(root).find(el => el.tagName === 'button' && textOf(el).includes(text))
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)) }

function fakeEnv(t) {
  const saved = Object.fromEntries(['document', 'matchMedia'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const doc = { createElement: tag => new El(tag), createElementNS: (ns, tag) => new El(tag), createTextNode: s => new Text(s), listeners: [], activeElement: null, hidden: false,
    addEventListener(type, fn) { this.listeners.push([type, fn]) }, removeEventListener(type, fn) { this.listeners = this.listeners.filter(item => item[0] !== type || item[1] !== fn) },
    visibility(hidden) { this.hidden = hidden; for (const [type, fn] of this.listeners.filter(item => item[0] === 'visibilitychange')) fn() } }
  globalThis.document = doc; globalThis.matchMedia = () => ({ matches: false })
  t.after(() => { for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k] })
  const clock = { now: BASE, next: 1, timers: new Map() }
  const timing = { setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.set(id, { fn, at: clock.now + ms }); return id }, clearTimeout: id => clock.timers.delete(id), random: () => 0.5, now: () => clock.now }
  const advance = async ms => {
    const end = clock.now + ms
    for (;;) {
      const due = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      clock.timers.delete(due[0]); clock.now = Math.max(clock.now, due[1].at); due[1].fn(); await flush()
    }
    clock.now = end; await flush()
  }
  return { doc, clock, timing, advance }
}

// api: GET /api/lattice/blockers answers from `reads` (an array or a function), POST unblock from `posts`.
function fakeApi({ reads, posts = () => ({ outcome: 'removed' }) }) {
  const calls = []
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET', headers: options.headers, body: options.body })
    const step = options.method === 'POST' ? posts : reads
    const value = typeof step === 'function' ? step(path, options) : step.length > 1 ? step.shift() : step[0]
    if (value instanceof Error) throw value
    return value
  }
  return { api, calls, gets: () => calls.filter(call => call.method === 'GET').length, posts: () => calls.filter(call => call.method === 'POST') }
}
const makeView = (t, api, extra = {}) => {
  const env = fakeEnv(t), host = new El('div'), taps = [], goneBack = []
  const view = createStopsView(host, { api, getMember, getOwner: () => ({ name: 'クオ' }), openCard: (projectId, cardId) => taps.push([projectId, cardId]), back: () => goneBack.push(true), glyph: name => new El(`g-${name}`), ...env.timing, ...extra })
  return { ...env, host, view, taps, goneBack }
}
const rowsOf = host => byClass(host, 'lattice-stop')

test('開く：最初はスピナー、読めたら新しい順の行。読み直すと行は残したまま、タイマーでは読まない', async t => {
  const net = fakeApi({ reads: [answer([stop(1, { blockedAt: ago(DAY) }), stop(2)])] })
  const ui = makeView(t, net.api)
  ui.view.open()
  assert.match(textOf(ui.host), /止めを読んでいます…/u); assert.equal(rowsOf(ui.host).length, 0)
  await flush()
  assert.equal(net.calls[0].path, '/api/lattice/blockers')
  const rows = rowsOf(ui.host)
  assert.deepEqual(rows.map(el => el.dataset.stopId), [stop(2).stopId, stop(1).stopId])
  assert.equal(rows[0].getAttribute('aria-label'), '止まり、工程2、BellTeam開発、担当 モリー、理由 CI is red on main、モリーが今日 20:30に止めました')
  assert.match(textOf(rows[0]), /工程2.*BellTeam開発.*担当.*モリー.*理由.*CI is red on main.*止めた人.*モリー.*今日 20:30.*外す/su)
  assert.match(textOf(rows[1]), /昨日 21:00/u)
  assert.doesNotMatch(textOf(ui.host), /bot-[0-9a-f]{6,}|p1\/t\d|[0-9a-f]{24}|LATTICE_/u)
  assert.equal(byClass(ui.host, 'lattice-stops-pill').length, 0)
  await ui.advance(120000); assert.equal(net.gets(), 1, '読める間はタイマーで読まない')
  buttonByText(ui.host, '読み直す').click(); await flush()
  assert.equal(net.gets(), 2); assert.equal(rowsOf(ui.host).length, 2); assert.doesNotMatch(textOf(ui.host), /読んでいます/u, '二度目からスピナーは出ない')
  ui.view.close()
})

test('止まりが無い：止まっている工程はありません。読み直すで読み直せる', async t => {
  const reads = [answer([])], net = fakeApi({ reads })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  assert.match(textOf(ui.host), /止まっている工程はありません。/u)
  reads.unshift(answer([stop(1)]))
  buttonByText(ui.host, '読み直す').click(); await flush()
  assert.equal(rowsOf(ui.host).length, 1); assert.doesNotMatch(textOf(ui.host), /止まっている工程はありません。/u)
  ui.view.close()
})

test('古いサーバー（404）は案内だけで読み直さない。戻るで一覧へ', async t => {
  const net = fakeApi({ reads: () => http(404) })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  assert.match(textOf(ui.host), /このサーバーではまだ止め一覧を使えません。/u)
  await ui.advance(120000); assert.equal(net.gets(), 1)
  ui.doc.visibility(false); await flush(); assert.equal(net.gets(), 1, '古いサーバーは前面に戻っても読み直さない')
  buttonByText(ui.host, 'すべての工程表').click(); assert.deepEqual(ui.goneBack, [true])
  ui.view.close()
})

test('503・通信エラー・壊れたJSON・別のschema：薄くした行と帯、1,2,4…秒で読み直し続け、読めたら帯が消える', async t => {
  const results = [http(503), new Error('network'), { schema: 'other.v1', blockers: [] }, { schema: SCHEMA, blockers: 'x' }, answer([stop(1)]), http(503), answer([stop(1)])]
  const net = fakeApi({ reads: () => results.shift() })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  assert.equal(net.gets(), 1); assert.match(textOf(byClass(ui.host, 'lattice-stops-pill')[0]), /止め一覧を読み直しています…/u)
  await ui.advance(999); assert.equal(net.gets(), 1)
  await ui.advance(1); assert.equal(net.gets(), 2)
  await ui.advance(2000); assert.equal(net.gets(), 3)
  await ui.advance(4000); assert.equal(net.gets(), 4)
  await ui.advance(8000); assert.equal(net.gets(), 5)
  assert.equal(byClass(ui.host, 'lattice-stops-pill').length, 0); assert.equal(rowsOf(ui.host).length, 1)
  assert.equal(byClass(ui.host, 'lattice-stops-list')[0].className.includes('is-stale'), false)
  // 行がある時の失敗：行は残って薄くなり、読み直す（今）が間隔を待たない
  buttonByText(ui.host, '読み直す').click(); await flush()
  assert.equal(rowsOf(ui.host).length, 1); assert.ok(byClass(ui.host, 'lattice-stops-list')[0].className.includes('is-stale')); assert.equal(byClass(ui.host, 'lattice-stops-pill').length, 1)
  buttonByText(ui.host, '読み直す').click(); await flush()
  assert.equal(net.gets(), 7); assert.equal(byClass(ui.host, 'lattice-stops-pill').length, 0)
  const waits = [...ui.clock.timers.values()]; assert.equal(waits.length, 0, '読めたらタイマーは残らない')
  ui.view.close()
})

test('バックオフは 30 秒で頭打ち、閉じるとタイマーも前面の監視も止まる', async t => {
  const net = fakeApi({ reads: () => http(503) })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  const gaps = []
  for (let i = 0; i < 7; i++) { const before = ui.clock.now; const next = [...ui.clock.timers.values()][0].at - before; gaps.push(next); await ui.advance(next) }
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.equal(ui.doc.listeners.length, 1)
  ui.view.close()
  assert.equal(ui.clock.timers.size, 0); assert.equal(ui.doc.listeners.length, 0)
  const reads = net.gets(); await ui.advance(120000); ui.doc.visibility(false); await flush(); assert.equal(net.gets(), reads)
})

test('unreadCharts があれば細い帯。ids は出さない', async t => {
  const net = fakeApi({ reads: [answer([stop(1)], { unreadCharts: ['peertable'] })] })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  assert.equal(textOf(byClass(ui.host, 'lattice-stops-unread')[0]), '一部の工程表を読めませんでした。読めた分だけ表示しています。'); assert.doesNotMatch(textOf(ui.host), /peertable/u)
  ui.view.close()
})

test('外す：二段階（確認の行、やめる・Esc・ほかをタップで戻る）、確認の外すで POST {stopId}、スピナー、外れた行は消えてすぐ読み直す', async t => {
  let state = [stop(1), stop(2, { blockedAt: ago(60 * MIN) })]
  let release
  const net = fakeApi({ reads: () => answer(state), posts: () => new Promise(resolve => { release = () => { state = state.filter(item => item.taskId !== 't1'); resolve({ schema: 'bellteam.lattice-unblock.v1', projectId: 'bellteam', stopId: stop(1).stopId, outcome: 'removed' }) } }) })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  const first = () => rowsOf(ui.host).find(el => el.dataset.stopId === stop(1).stopId)
  const ask = el => all(el).find(item => item.tagName === 'button' && textOf(item) === '外す')
  assert.equal(ask(first()).getAttribute('aria-label'), '外す、工程1')
  ask(first()).click()
  assert.match(textOf(first()), /この止めを外しますか？/u); assert.equal(net.posts().length, 0, '一度では外さない')
  assert.equal(document.activeElement.dataset.focusKey, `confirm:${stop(1).stopId}`, '確認の外すへフォーカス')
  buttonByText(first(), 'やめる').click()
  assert.doesNotMatch(textOf(first()), /この止めを外しますか？/u); assert.equal(document.activeElement.dataset.focusKey, `ask:${stop(1).stopId}`, 'やめるは行の外すへ戻す')
  ask(first()).click(); ui.view.escape()
  assert.doesNotMatch(textOf(first()), /この止めを外しますか？/u); assert.deepEqual(ui.goneBack, [], 'Esc は確認だけ閉じる')
  ask(first()).click(); ui.host.click()
  assert.doesNotMatch(textOf(first()), /この止めを外しますか？/u, 'ほかをタップしたら戻る')
  ask(first()).click(); ui.view.escape(); ask(first()).click()
  const confirm = all(first()).find(item => item.tagName === 'button' && textOf(item) === '外す' && item.dataset.focusKey.startsWith('confirm'))
  const gets = net.gets()
  confirm.click(); await flush()
  assert.deepEqual(net.posts().map(call => [call.path, call.method, call.headers, call.body]), [[`/api/lattice/charts/bellteam/unblock`, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ stopId: stop(1).stopId })]])
  const busy = all(first()).find(item => item.tagName === 'button' && item.attrs.get('aria-busy') === 'true')
  assert.ok(busy, 'スピナー付きのボタン'); assert.equal(busy.attrs.has('disabled'), true); assert.equal(rowsOf(ui.host).length, 2, '答えまで行は残る')
  release(); await flush()
  assert.equal(net.gets(), gets + 1, '外れたらすぐ読み直す')
  assert.deepEqual(rowsOf(ui.host).map(el => el.dataset.stopId), [stop(2).stopId])
  ui.view.close()
})

test('already-gone も外れた扱いで行が消える。行が消えた確認は閉じる', async t => {
  let state = [stop(1)]
  const net = fakeApi({ reads: () => answer(state), posts: () => { state = []; return { outcome: 'already-gone' } } })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  buttonByText(ui.host, '外す').click(); all(ui.host).find(item => item.dataset?.focusKey?.startsWith('confirm')).click(); await flush()
  assert.equal(rowsOf(ui.host).length, 0); assert.match(textOf(ui.host), /止まっている工程はありません。/u)
  ui.view.close()
})

test('409：行は残り、外せませんでした: reason（Lattice の文のまま）。すぐ読み直し、次の外すまで出し続ける', async t => {
  const net = fakeApi({ reads: () => answer([stop(1)]), posts: () => http(409, { code: 'LATTICE_UNBLOCK_REFUSED', reason: 'Task t1 is not blocked by you' }) })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  const press = () => { buttonByText(ui.host, '外す').click(); all(ui.host).find(item => item.dataset?.focusKey?.startsWith('confirm')).click() }
  press(); await flush()
  assert.equal(net.gets(), 2); assert.equal(rowsOf(ui.host).length, 1)
  assert.equal(textOf(byClass(ui.host, 'lattice-stop-note')[0]), '外せませんでした: Task t1 is not blocked by you')
  assert.doesNotMatch(textOf(ui.host), /LATTICE_/u)
  buttonByText(ui.host, '読み直す').click(); await flush()
  assert.equal(byClass(ui.host, 'lattice-stop-note').length, 1, '読み直しても消えない')
  press(); await flush(); assert.equal(net.posts().length, 2, '外す をもう一度できる')
  ui.view.close()
})

test('503・通信エラー・400・その他：いまは外せませんでした。行は残り、すぐ読み直す', async t => {
  for (const failure of [http(503), new Error('network'), http(400), http(500)]) {
    const net = fakeApi({ reads: () => answer([stop(1)]), posts: () => failure })
    const ui = makeView(t, net.api)
    ui.view.open(); await flush()
    buttonByText(ui.host, '外す').click(); all(ui.host).find(item => item.dataset?.focusKey?.startsWith('confirm')).click(); await flush()
    assert.equal(textOf(byClass(ui.host, 'lattice-stop-note')[0]), 'いまは外せませんでした。少し待ってからもう一度お試しください。', String(failure.status))
    assert.equal(net.gets(), 2); assert.equal(rowsOf(ui.host).length, 1); assert.doesNotMatch(textOf(ui.host), /HTTP_|400|network/u, '400 の中身は出さない')
    ui.view.close()
  }
})

test('前面に戻った時に読み直す（隠れた時は読まない）。行のタップは openCard(projectId, cardId)、外すボタンはタップ扱いにならない', async t => {
  const net = fakeApi({ reads: () => answer([stop(1, { projectId: 'peer', cardId: 'p9/t07' })]) })
  const ui = makeView(t, net.api)
  ui.view.open(); await flush()
  ui.doc.visibility(true); await flush(); assert.equal(net.gets(), 1)
  ui.doc.visibility(false); await flush(); assert.equal(net.gets(), 2)
  all(ui.host).find(item => item.attrs.get('aria-label') === '工程1を開く').click()
  assert.deepEqual(ui.taps, [['peer', 'p9/t07']])
  buttonByText(ui.host, '外す').click(); assert.equal(ui.taps.length, 1)
  ui.view.close()
})

// ---- 一覧から：ボタン、戻る、Esc、行のタップで工程表と詳細 ----
const list = { schema: 'bellteam.lattice-charts.v1', at: '', charts: ['bellteam', 'peer'].map((projectId, i) => ({ projectId, name: i ? '別の工程表' : 'BellTeam開発', coordinator: i === 0, createdBy: TRONY, counts: { total: 2, done: 0, waiting: 0 }, activeMembers: [], updatedAt: ago(MIN) })) }
const chartSnapshot = () => ({ schema: 'bellteam.lattice-chart.v1', epoch: 'e', version: 1, at: '', projectId: 'peer', name: '別の工程表', createdBy: TRONY, coordinator: false, state: 'verified', verifiedAt: '', degraded: [],
  members: [{ botId: MOLLY, name: 'モリー', color: 'mint', avatarVersion: '' }],
  cards: [{ id: 'p9/t07', plan: 'p9', taskId: 't07', title: '止まった工程', doneCondition: '', designMemo: 'メモ', state: 'blocked', lane: null, producer: MOLLY, startedAt: null, changedAt: ago(MIN), blockedReason: 'CI is red', depth: 0 }], edges: [], waits: [] })

test('一覧の止め一覧ボタン → 止め一覧 → 戻る・Esc で一覧 → 行のタップでその工程表と詳細', async t => {
  const env = fakeEnv(t), dialog = new El('dialog'), body = new El('div'), pill = new El('p'); pill.hidden = true
  dialog.querySelector = sel => sel === '[data-lattice-body]' ? body : sel === '[data-lattice-pill]' ? pill : null
  const streams = [], encoder = new TextEncoder(), calls = []
  const fetchImage = async url => {
    calls.push(url)
    if (!url.includes('/events')) return { ok: false, status: 404 }
    return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(resolve => streams.push(resolve)) }) } }
  }
  const api = async path => {
    calls.push(path)
    if (path === '/api/lattice/charts') return list
    if (path === '/api/lattice/blockers') return answer([stop(1, { projectId: 'peer', chartName: '別の工程表', cardId: 'p9/t07' })])
    throw new Error(path)
  }
  const view = createLatticeChart(dialog, { api, fetchImage, getMember, mode: 'tree', ...env.timing, requestFrame: () => 1, cancelFrame() {} })
  dialog.addEventListener('close', () => view.close())
  view.open(); await flush()
  assert.equal(byClass(body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2)
  buttonByText(body, '止め一覧').click(); await flush()
  assert.match(textOf(body), /止め一覧/u); assert.equal(byClass(body, 'lattice-stop').length, 1)
  assert.equal(byClass(body, 'lattice-cc').length, 0, '止め一覧の間は一覧を描かない')
  const reads = () => calls.filter(c => c === '/api/lattice/charts').length
  const before = reads(); await env.advance(60000); assert.equal(reads(), before, '止め一覧の間は一覧を読み直さない')
  buttonByText(body, 'すべての工程表').click(); await flush()
  assert.equal(byClass(body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2, '戻ると一覧')
  buttonByText(body, '止め一覧').click(); await flush()
  assert.equal(dialog.fire('cancel').prevented, true); await flush()
  assert.equal(byClass(body, 'lattice-cc').filter(el => el.tagName === 'button').length, 2, 'Esc も一覧へ')
  buttonByText(body, '止め一覧').click(); await flush()
  all(body).find(el => el.attrs.get('aria-label') === '工程1を開く').click(); await flush()
  assert.ok(calls.includes('/api/lattice/charts/peer/events'), 'その工程表を開く')
  assert.equal(byClass(body, 'lattice-sheet')[0].hidden, true)
  streams.shift()({ done: false, value: encoder.encode(`event: snapshot\ndata: ${JSON.stringify(chartSnapshot())}\n\n`) }); await flush()
  const sheet = byClass(body, 'lattice-sheet')[0]
  assert.equal(sheet.hidden, false); assert.match(textOf(sheet), /止まった工程/u); assert.match(textOf(sheet), /メモ/u, '札の詳細が開く')
  view.close()
  assert.equal(env.doc.listeners.filter(item => item[0] === 'visibilitychange').length, 0, '閉じたら監視も止まる')
})
