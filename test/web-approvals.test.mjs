import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  failureOf, originOf, cardRow, confirmText, answerOutcome, deliveryNote, groupDone, countsOf, entryView, linkPanel, historyRows, originCounts, originFilter,
  parseHash, decisionHash, ageText, MESSAGES, connectView, connectOutcome,
} from '../web/approvals-model.js'
import { createApprovalsFeed } from '../web/approvals-feed.js'
import { createApprovalsEntry, createApprovalsView } from '../web/approvals.js'

const fx = async name => JSON.parse(await readFile(new URL(`./fixtures/approvals/${name}`, import.meta.url), 'utf8'))
const [bellteam, external, unknown, answered, list, summary, errors] = await Promise.all(['view-decision.bellteam-pending.json', 'view-decision.external-pending.json', 'view-decision.unknown-origin.json',
  'view-decision.answered-delivery-unknown.json', 'list.pending.json', 'summary.json', 'errors.json'].map(fx))
const NOW = Date.parse('2026-11-15T03:00:00Z') // 12:00 JST
const decision = (base, patch) => structuredClone({ ...base, ...patch })

// ---- pure ----
test('failureOf：HTTP の答えを画面の種類へ（ルート全体の 404 は旧サーバー、契約・接続・再接続は別）', () => {
  assert.equal(failureOf(404, { error: 'NOT_FOUND' }), 'old'); assert.equal(failureOf(404, errors.conflict.body), 'old')
  assert.equal(failureOf(404, { error: { code: 'not_found' } }), 'gone')
  assert.equal(failureOf(403, errors['not_entitled.trial'].body), 'notEntitled'); assert.equal(failureOf(403, errors['not_entitled.expired'].body), 'expired')
  assert.equal(failureOf(402, { error: { code: 'subscription_expired' } }), 'expired')
  assert.equal(failureOf(409, errors.not_connected.body), 'noCredential'); assert.equal(failureOf(409, { error: { code: 'conflict', decision: bellteam } }), 'conflict')
  assert.equal(failureOf(409, { error: { code: 'conflict' } }), 'refused', '最新の決裁が無い conflict は差し替えられない')
  for (const status of [0, 500, 503]) assert.equal(failureOf(status, null), 'reconnect')
  assert.equal(failureOf(429, null), 'wait'); assert.equal(failureOf(400, { error: { code: 'validation_failed' } }), 'refused'); assert.equal(failureOf(403, { error: 'x' }), 'refused')
})

test('originOf：BellTeam は顔と名前、外は道具の札 + 道具・セッション、出どころ不明は地球儀。どれも隠さない', () => {
  const b = originOf(bellteam), e = originOf(external), u = originOf(unknown)
  assert.deepEqual([b.external, b.member.name, b.name, b.who], [false, 'ブレッディ', 'ブレッディ', 'ブレッディ'])
  assert.deepEqual([e.external, e.member, e.tile, e.name, e.via, e.who], [true, null, 'terminal', 'Claude Code · Macのレシート整理', 'リモート接続', 'Claude Code'])
  assert.deepEqual([u.external, u.unknown, u.tile, u.name, u.who], [true, true, 'globe', '出どころ不明', '出したAI'])
  assert.equal(originOf(decision(external, { origin: { ...external.origin, client: 'chatgpt', tool: 'ChatGPT' } })).tile, 'chat')
})

test('cardRow：状態の札・つながりの一行・期限と推奨。id もコードも出さない', () => {
  const b = cardRow(bellteam, NOW), e = cardRow(external, NOW), u = cardRow(unknown, NOW)
  assert.deepEqual(b.badges.map(item => item.text), ['回答待ち', '急ぎ', '修正あり'])
  assert.deepEqual(b.note, { text: '工程表「課金の設計」が、この回答を待っています', tone: 'link' })
  assert.deepEqual(b.chips, ['期限 今日 18:00', '推奨あり']); assert.equal(b.urgent, true)
  assert.deepEqual(e.badges.map(item => item.text), ['回答待ち', '外部から']); assert.deepEqual(e.note, { text: '工程表とはつながっていません', tone: 'muted' })
  assert.deepEqual(u.badges.map(item => item.text), ['回答待ち', '外部から']); assert.equal(u.origin.name, '出どころ不明')
  assert.equal(cardRow(decision(bellteam, { link: null }), NOW).note.text, '工程表につなげています')
  const held = cardRow(decision(external, { status: 'held' }), NOW), heldLinked = cardRow(decision(bellteam, { status: 'held' }), NOW)
  assert.deepEqual([held.note.text, heldLinked.note.text], ['保留中です', '保留中です。戻すまで工程は待ちます']); assert.equal(held.badges[0].text, '保留')
  assert.equal(cardRow(decision(bellteam, { link: { ...bellteam.link, state: 'diverged' } }), NOW).note.text, '工程はすでに済みです。この決裁は、まだ答えられます。')
  assert.doesNotMatch([b, e, u].map(row => `${row.label}${row.title}${row.age}`).join('\n'), /K-DEMO|bot-[0-9a-f]{6,}|approval-box\//u)
  assert.equal(ageText(new Date(NOW - 30000).toISOString(), NOW), 'たった今'); assert.equal(ageText(new Date(NOW - 600000).toISOString(), NOW), '10分前'); assert.equal(ageText(new Date(NOW - 7200000).toISOString(), NOW), '2時間前')
})

test('confirmText：つながる決裁は工程が済みになる、外やつながりの無い決裁は誰に届くかだけ', () => {
  assert.equal(confirmText(bellteam, { label: '決裁箱と同じ請求にする' }), '「決裁箱と同じ請求にする」で答えますか？ 答えると、ブレッディが続きに進み、工程「課金の設計」が済みになります。')
  assert.equal(confirmText(external, { label: '共有フォルダに保存する' }), '「共有フォルダに保存する」で答えますか？ 答えると、Claude Codeに届きます。')
  assert.equal(confirmText(external, { text: 'もう少し調べて' }), 'この指示を送りますか？ 答えると、Claude Codeに届きます。')
  assert.equal(confirmText(unknown, { label: 'はい' }), '「はい」で答えますか？ 答えると、出したAIに届きます。')
})

test('answerOutcome / deliveryNote：200・409・再試行・止まりと、届き方ごとの一文', () => {
  assert.deepEqual(answerOutcome(200, {}), { kind: 'ok' })
  assert.deepEqual(answerOutcome(409, { error: { code: 'conflict', decision: bellteam } }), { kind: 'conflict', decision: bellteam })
  for (const [status, body] of [[503, errors.unavailable.body], [0, null], [429, null]]) assert.deepEqual(answerOutcome(status, body), { kind: 'retry', message: MESSAGES.retry })
  assert.deepEqual(answerOutcome(402, null), { kind: 'stop', message: '決裁箱の契約が切れています。' }); assert.equal(answerOutcome(409, errors.not_connected.body).message, MESSAGES.noCredential)
  assert.equal(answerOutcome(400, { error: { code: 'validation_failed', message: '答えを選んでください。' } }).message, '答えを選んでください。'); assert.equal(answerOutcome(404, { error: { code: 'not_found' } }).kind, 'gone')
  assert.deepEqual(deliveryNote(decision(bellteam, { delivery: 'delivered' })), { tone: 'ok', text: '答えました。ブレッディに届きました。' })
  assert.equal(deliveryNote(decision(bellteam, { delivery: 'fetched' })).tone, 'ok')
  assert.deepEqual(deliveryNote(decision(bellteam, { delivery: 'waiting' })), { tone: 'vio', text: '答えました。ブレッディが会話に戻ると受け取ります。' })
  const lost = deliveryNote(answered), lostExternal = deliveryNote(decision(answered, { origin: external.origin, requester: null, link: null }))
  assert.equal(lost.copy, true); assert.match(lost.text, /次の担当にはこちらから知らせます/u); assert.match(lost.text, /再開の文をブレッディの会話に貼ってください/u)
  assert.doesNotMatch(lostExternal.text, /次の担当/u); assert.match(lostExternal.text, /Claude Code/u)
})

test('groupDone：新しい答えが先、JSTの日の見出し、取り下げは理由つき、届き方の札', () => {
  const day = (id, at, extra = {}) => decision(answered, { id, updatedAt: at, answer: { ...answered.answer, answeredAt: at }, ...extra })
  const groups = groupDone([day('a', '2026-11-14T12:10:00Z'), day('b', '2026-11-15T01:00:00Z', { delivery: 'delivered' }), day('c', '2026-11-10T01:00:00Z', { status: 'cancelled', answer: null, cancelReason: '統合しました' })], NOW)
  assert.deepEqual(groups.map(group => group.heading), ['今日', '昨日', '11月10日'])
  assert.deepEqual(groups.map(group => group.rows[0].id), ['b', 'a', 'c'])
  assert.deepEqual([groups[0].rows[0].delivery.text, groups[1].rows[0].delivery.text], ['届きました', '届いたか不明'])
  assert.deepEqual([groups[2].rows[0].cancelled, groups[2].rows[0].line, groups[2].rows[0].delivery], [true, '統合しました', null])
  assert.equal(groups[1].rows[0].line, 'あなたの答え：1つだけ開く')
})

test('countsOf / entryView / 出どころ：数は全部の回答待ち、絞り込みは隠さず数える', () => {
  const counts = countsOf(summary)
  assert.deepEqual([counts.pending, counts.urgent, counts.held, counts.answered, counts.filed, counts.fraction], [4, 1, 1, 2, 6, 2 / 6])
  assert.deepEqual(countsOf(null), { pending: 0, urgent: 0, held: 0, answered: 0, filed: 0, fraction: 0 })
  assert.deepEqual(entryView(summary, 'live'), { pending: 4, urgent: true, sub: 'あなたの回答を待っています', label: '決裁箱、回答待ち4件' })
  assert.equal(entryView({ ...summary, pending: 0, urgent: 0 }, 'live').sub, '待っている決裁はありません'); assert.equal(entryView(null, 'old').sub, 'このサーバーではまだ使えません')
  const items = list.items
  assert.deepEqual(originCounts(items), { all: 3, bellteam: 1, external: 2 }, '出どころ不明は外部に数える')
  assert.deepEqual(originFilter(items, 'external').map(item => item.id), ['K-DEMO2', 'K-DEMO3']); assert.equal(originFilter(items, 'all').length, 3)
})

test('linkPanel / historyRows / 深いリンク', () => {
  const linked = linkPanel(bellteam), plain = linkPanel(external), connecting = linkPanel(decision(bellteam, { link: null }))
  assert.equal(linked.kind, 'linked'); assert.deepEqual(linked.ids, { projectId: 'bellteam', cardId: 'approval-box/dec-k-demo1' }); assert.equal(linked.projectId, 'bellteam')
  assert.match(linked.sentence, /答えると、「課金の設計」が済みになり、ブレッディが「課金の実装」へ進めます。答えで決まらない時は、新しい決裁が工程に差し込まれます。/u)
  assert.deepEqual([plain.kind, plain.title, plain.lines.length], ['unlinked', 'つながっていません', 3]); assert.match(plain.lines[1], /Claude Code/u)
  assert.deepEqual([connecting.kind, connecting.title], ['connecting', '工程表につなげています'])
  assert.equal(linkPanel(decision(bellteam, { link: { ...bellteam.link, chart: { name: '工程表' } } })).ids, null, 'id が無ければ開くボタンを出さない')
  assert.deepEqual(historyRows(bellteam, NOW).map(row => row.text), ['ブレッディが申請しました', 'ブレッディが内容を直しました（選択肢）'])
  assert.equal(historyRows(bellteam, NOW)[1].amended, true)
  assert.equal(decisionHash('K a/b'), '#approvals/K%20a%2Fb'); assert.deepEqual(parseHash('#approvals/K%20a%2Fb'), { id: 'K a/b' })
  assert.deepEqual(parseHash('#approvals'), { id: null }); assert.equal(parseHash('#other'), null); assert.equal(parseHash(''), null)
})

// ---- feed ----
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }
function fakeClock() {
  const clock = { next: 1, timers: new Map() }
  return { clock, setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.set(id, { fn, ms }); return id }, clearTimeout: id => clock.timers.delete(id), random: () => 0.5 }
}
function fakeStream() {
  const queue = [], waiting = []
  const encoder = new TextEncoder()
  return {
    push(text) { const chunk = { done: false, value: encoder.encode(text) }; waiting.length ? waiting.shift()(chunk) : queue.push(chunk) },
    end() { const chunk = { done: true }; waiting.length ? waiting.shift()(chunk) : queue.push(chunk) },
    body: { getReader: () => ({ read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve)) }) },
  }
}
const reply = (status, body, stream) => ({ ok: status >= 200 && status < 300, status, json: async () => body, body: stream?.body })
function feedHarness(routes) {
  const timing = fakeClock(), events = [], calls = []
  const doc = { hidden: false, listeners: [], addEventListener(type, fn) { this.listeners.push(fn) }, removeEventListener(type, fn) { this.listeners = this.listeners.filter(item => item !== fn) }, visibility(hidden) { this.hidden = hidden; for (const fn of this.listeners) fn() } }
  const fetch = async (path, options) => { calls.push(path); const route = routes[path]; return typeof route === 'function' ? route(options) : route }
  const feed = createApprovalsFeed({ fetch, doc, ...timing })
  feed.on(event => events.push(event))
  return { feed, events, calls, doc, ...timing }
}

test('feed：summary を読んで SSE を保ち、summary と decision の知らせを渡す。読める間はタイマーを持たない', async () => {
  const stream = fakeStream(), h = feedHarness({ '/api/approvals/summary': reply(200, summary), '/api/approvals/events': reply(200, null, stream) })
  h.feed.start(); await flush()
  assert.equal(h.feed.status, 'live'); assert.deepEqual(h.feed.summary, summary); assert.equal(h.clock.timers.size, 1, '無音を見る一つだけ')
  stream.push(': hb\n\nevent: summary\ndata: ' + JSON.stringify({ ...summary, pending: 5 }) + '\n\nevent: decision.updated\ndata: {"id":"K-DEMO1","version":3}\n\n'); await flush()
  assert.equal(h.feed.summary.pending, 5)
  assert.deepEqual(h.events.filter(event => event.type === 'decision'), [{ type: 'decision', event: 'updated', id: 'K-DEMO1', version: 3 }])
  assert.equal(h.calls.filter(path => path === '/api/approvals/summary').length, 1, '読める間は読み直さない')
  h.feed.stop()
})

test('feed：流れが切れたら drop、バックオフで読み直し、戻ったら resync を渡す', async () => {
  const streams = [fakeStream(), fakeStream()], first = streams[0]
  const h = feedHarness({ '/api/approvals/summary': reply(200, summary), '/api/approvals/events': () => reply(200, null, streams.shift()) })
  h.feed.start(); await flush()
  assert.equal(h.events.some(event => event.type === 'resync'), false, '最初の読みは resync ではない')
  first.end(); await flush()
  assert.equal(h.feed.status, 'drop'); assert.equal(h.clock.timers.size, 1); assert.equal([...h.clock.timers.values()][0].ms, 1000)
  const [id, timer] = [...h.clock.timers][0]; h.clock.timers.delete(id); timer.fn(); await flush()
  assert.equal(h.feed.status, 'live'); assert.equal(h.events.filter(event => event.type === 'resync').length, 1)
  h.feed.stop()
})

test('feed：404 / 403 / 409 は待っても変わらない。状態を持ってタイマーを持たず、読み直すで抜ける', async () => {
  let answer = reply(404, { error: 'NOT_FOUND' })
  const stream = fakeStream(), h = feedHarness({ '/api/approvals/summary': () => answer, '/api/approvals/events': reply(200, null, stream) })
  h.feed.start(); await flush()
  assert.equal(h.feed.status, 'old'); assert.equal(h.clock.timers.size, 0); assert.equal(h.feed.summary, null)
  for (const [response, status] of [[reply(403, errors['not_entitled.trial'].body), 'notEntitled'], [reply(403, errors['not_entitled.expired'].body), 'expired'], [reply(409, errors.not_connected.body), 'noCredential']]) {
    answer = response; await h.feed.refresh(); assert.equal(h.feed.status, status); assert.equal(h.clock.timers.size, 0)
  }
  answer = reply(200, summary); await h.feed.refresh(); await flush()
  assert.equal(h.feed.status, 'live'); assert.deepEqual(h.feed.summary, summary)
  h.feed.stop()
})

test('feed：503 は drop にして 1, 2 … 秒のバックオフで読み直し続ける。隠れたら止め、戻ったら読む', async () => {
  let fail = true
  const stream = fakeStream(), h = feedHarness({ '/api/approvals/summary': () => fail ? reply(503, errors.unavailable.body) : reply(200, summary), '/api/approvals/events': reply(200, null, stream) })
  const wait = () => [...h.clock.timers.values()][0].ms
  const fire = async () => { const [id, timer] = [...h.clock.timers][0]; h.clock.timers.delete(id); timer.fn(); await flush() }
  h.feed.start(); await flush()
  assert.equal(h.feed.status, 'drop'); assert.equal(h.clock.timers.size, 1); assert.equal(wait(), 1000)
  await fire(); assert.equal(wait(), 2000, '失敗が続くとバックオフが伸びる')
  fail = false; await fire(); assert.equal(h.feed.status, 'live')
  h.doc.visibility(true); assert.equal(h.clock.timers.size, 0, '隠れたら無音の見張りも止める')
  const before = h.calls.filter(path => path === '/api/approvals/summary').length
  h.doc.visibility(false); await flush(); assert.equal(h.calls.filter(path => path === '/api/approvals/summary').length, before + 1, '前面に戻ったら読む')
  h.feed.stop()
})

// ---- view（偽の DOM） ----
class Text { constructor(text) { this.nodeType = 3; this.textContent = text } }
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = new Map(); this.dataset = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.style = { setProperty: (k, v) => { this.style[k] = v } }; this.open = false; this.parent = null; this.value = ''; this.scrollTop = 0 }
  get textContent() { return this.children.map(c => c.textContent).join('') }
  set textContent(v) { this.children = [new Text(String(v))] }
  get classList() { const el = this; return { add: n => { if (!el.className.split(' ').includes(n)) el.className = `${el.className} ${n}`.trim() }, remove: n => { el.className = el.className.split(' ').filter(c => c && c !== n).join(' ') }, contains: n => el.className.split(' ').includes(n), toggle(n, force) { const on = force ?? !this.contains(n); on ? this.add(n) : this.remove(n); return on } } }
  setAttribute(k, v) { if (k === 'class') this.className = String(v); else this.attrs.set(k, String(v)) }
  getAttribute(k) { return k === 'class' ? this.className : this.attrs.get(k) ?? null }
  append(...nodes) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n) } }
  prepend(...nodes) { for (const n of nodes) { n.parent = this } this.children.unshift(...nodes) }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes) }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== fn) }
  fire(type, event = {}) { const e = { target: this, preventDefault() { this.prevented = true }, ...event }; for (const fn of this.listeners[type] ?? []) fn(e); return e }
  click() { return this.fire('click') }
  focus() { document.activeElement = this }
  showModal() { this.open = true }
  close() { this.open = false; this.fire('close') }
  querySelector(sel) { const key = sel.slice(1, -1).replace(/^data-/u, '').replace(/-./gu, m => m[1].toUpperCase()); return all(this).find(el => el.dataset && key in el.dataset) ?? null }
}
const all = root => root.children.flatMap(c => c.nodeType === 3 ? [] : [c, ...all(c)])
const byClass = (root, name) => all(root).filter(el => el.className.split(' ').includes(name))
const buttonByText = (root, text) => all(root).find(el => el.tagName === 'button' && el.textContent.includes(text))

function viewHarness(t, { routes, openTab, feedStatus = 'live', getMember = id => id === 'bot-823b56e9' ? { botId: id, name: 'ブレッディ', color: 'amber', known: true } : null } = {}) {
  const saved = Object.fromEntries(['document', 'matchMedia'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  globalThis.document = { createElement: tag => new El(tag), createElementNS: () => new El('svg'), createTextNode: s => new Text(s), activeElement: null, hidden: false, addEventListener() {}, removeEventListener() {} }
  globalThis.matchMedia = () => ({ matches: false })
  t.after(() => { for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k] })
  const dialog = new El('dialog'), body = new El('div'), pill = new El('p'); body.dataset.approvalsBody = ''; pill.dataset.approvalsPill = ''; pill.hidden = true
  dialog.append(body, pill)
  const calls = [], listeners = [], timing = fakeClock()
  const feed = { status: feedStatus, summary, on: fn => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1) }, refresh: async () => { calls.push({ path: 'feed.refresh' }) } }
  const fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null })
    const route = routes[`${options.method ?? 'GET'} ${path}`] ?? routes[path]
    const value = typeof route === 'function' ? route(options) : Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route
    if (!value) return { status: 404, json: async () => ({ error: 'NOT_FOUND' }) }
    return { status: value.status, json: async () => value.body }
  }
  const opened = [], keys = ['key-1', 'key-2', 'key-3', 'key-4']
  const view = createApprovalsView(dialog, { feed, fetch, getMember, openChart: (projectId, cardId) => opened.push([projectId, cardId]), now: () => NOW, uuid: () => keys.shift(), copyText: async () => {}, ...(openTab ? { openTab } : {}), ...timing })
  return { view, dialog, body, pill, calls, feed, emit: event => { for (const fn of [...listeners]) fn(event) }, opened, ...timing }
}
const ok = body => ({ status: 200, body })
const baseRoutes = () => ({
  '/api/approvals?status=pending,held': ok({ items: [bellteam, external, unknown, decision(bellteam, { id: 'K-HELD', status: 'held', title: '保留の決裁', urgency: 'normal' })] }),
  '/api/approvals?status=answered,cancelled': ok({ items: [answered] }),
})
const cardTitles = body => byClass(body, 'approvals-card').map(el => el.children.find(c => c.className === 'ti')?.textContent)

test('入口の行：急ぎも待ちも無い時は、部品だけを出す（false の文字を出さない）。待ちがあれば数、急ぎがあれば稲妻（a306）', t => {
  const { feed, emit } = viewHarness(t)
  const button = new El('button'), entry = { status: 'live', summary: { pending: 0, urgent: 0 }, on: feed.on }
  createApprovalsEntry(button, { feed: entry, open() {} })
  assert.equal(button.children.length, 2); assert.equal(button.textContent.includes('false'), false)
  entry.summary = { pending: 3, urgent: 0 }; emit({ type: 'summary' })
  assert.equal(button.children.length, 3); assert.equal(button.textContent.includes('false'), false); assert.equal(button.textContent.endsWith('3'), true)
  entry.summary = { pending: 3, urgent: 1 }; emit({ type: 'summary' })
  assert.equal(button.children.length, 4)
})

test('view 開く：待ちの札が並び、保留は区切りの下。出どころの絞り込みは既定で何も隠さない', async t => {
  const h = viewHarness(t, { routes: baseRoutes() })
  h.view.open(); await flush()
  assert.equal(h.dialog.open, true)
  assert.deepEqual(cardTitles(h.body), [bellteam.title, external.title, unknown.title, '保留の決裁'], '待ち3件のあとに保留')
  assert.match(h.body.textContent, /回答を待っています/u); assert.match(h.body.textContent, /保留 1/u); assert.match(h.body.textContent, /2\/6今日の回答/u)
  assert.equal(byClass(h.body, 'approvals-hidden').length, 0)
  assert.deepEqual(h.calls.map(call => call.path), ['/api/approvals?status=pending,held'])
  // 外部を絞る：BellTeam を隠す。その数をいつも言い、すべてを見るで戻る
  buttonByText(h.body, '外部').click()
  assert.deepEqual(cardTitles(h.body), [external.title, unknown.title])
  assert.match(byClass(h.body, 'approvals-hidden')[0].textContent, /BellTeamの決裁 1件を隠しています。/u)
  buttonByText(byClass(h.body, 'approvals-hidden')[0], 'すべてを見る').click()
  assert.equal(cardTitles(h.body).length, 4, '待ち3件と保留1件')
  buttonByText(h.body, 'BellTeam').click()
  assert.match(byClass(h.body, 'approvals-hidden')[0].textContent, /外部の決裁 2件を隠しています。/u)
  h.view.close()
})

test('view 答える：選ぶ→その場で確認→答える。503 は同じ Idempotency-Key で出し直せ、200 で答えを差し替える', async t => {
  const final = decision(bellteam, { status: 'answered', version: 3, delivery: 'delivered', answer: { optionId: 'o1', text: null, attachments: [], answeredAt: '2026-11-15T03:00:00Z' } })
  const routes = { ...baseRoutes(), 'POST /api/approvals/K-DEMO1/answer': [{ status: 503, body: errors.unavailable.body }, ok(final)] }
  const h = viewHarness(t, { routes })
  h.view.open(); await flush()
  byClass(h.body, 'approvals-card')[0].click()
  const option = byClass(h.body, 'opt').find(el => el.textContent.includes('決裁箱と同じ請求にする'))
  assert.match(option.textContent, /推奨/u); assert.equal(h.calls.filter(call => call.method === 'POST').length, 0, '選んだだけでは送らない')
  option.click()
  assert.match(byClass(h.body, 'approvals-confirm')[0].textContent, /「決裁箱と同じ請求にする」で答えますか？ 答えると、ブレッディが続きに進み、工程「課金の設計」が済みになります。/u)
  buttonByText(h.body, 'やめる').click()
  assert.equal(byClass(h.body, 'approvals-confirm').length, 0); assert.ok(byClass(h.body, 'opt').length > 0, 'やめるで選択肢へ戻る')
  byClass(h.body, 'opt')[0].click()
  buttonByText(h.body, '答える').click(); await flush()
  let posts = h.calls.filter(call => call.method === 'POST')
  assert.deepEqual(posts[0].body, { optionId: 'o1', version: 2 }); assert.equal(posts[0].headers['Idempotency-Key'], 'key-2'); assert.equal(posts[0].headers['content-type'], 'application/json')
  assert.match(h.body.textContent, /いまは送れませんでした。答えは残っています。少し待って、もう一度押してください。/u)
  buttonByText(h.body, '答える').click(); await flush()
  posts = h.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2); assert.equal(posts[1].headers['Idempotency-Key'], 'key-2', '出し直しは同じ鍵')
  assert.match(h.body.textContent, /答えました。ブレッディに届きました。/u); assert.match(h.body.textContent, /あなたの答え：決裁箱と同じ請求にする/u)
  h.view.close()
})

test('view 答える（指示）：書いて返す＝text、409 は最新の決裁へ差し替えて何も送らず、外部は誰に届くかだけ言う', async t => {
  const amended = decision(external, { version: 2, title: '領収書の保存先を、どこにしますか？', amended: { is: true, fields: ['title'] } })
  const routes = { ...baseRoutes(), 'POST /api/approvals/K-DEMO2/answer': [{ status: 409, body: { error: { code: 'conflict', message: 'x', decision: amended } } }] }
  const h = viewHarness(t, { routes })
  h.view.open(); await flush()
  byClass(h.body, 'approvals-card')[1].click()
  const area = all(h.body).find(el => el.tagName === 'textarea'); area.value = 'もう少し調べて'; area.fire('input', { target: area })
  buttonByText(h.body, '指示を送る').click()
  assert.match(byClass(h.body, 'approvals-confirm')[0].textContent, /この指示を送りますか？ 答えると、Claude Codeに届きます。/u); assert.doesNotMatch(h.body.textContent, /工程「.*が済みになります/u)
  buttonByText(h.body, '答える').click(); await flush()
  assert.deepEqual(h.calls.find(call => call.method === 'POST').body, { text: 'もう少し調べて', version: 1 })
  assert.match(h.body.textContent, /答える前に、Claude Codeが内容を直しました。もう一度、内容を確かめてください。/u)
  assert.match(h.body.textContent, /領収書の保存先を、どこにしますか？/u); assert.equal(byClass(h.body, 'approvals-confirm').length, 0, '勝手に答えない')
  h.view.close()
})

test('view 保留 / 済み / 工程表: 保留にする→POST、済みは読み取りだけ（届いたか不明は再開の文をコピー）、工程表で見る→openChart', async t => {
  const held = decision(bellteam, { status: 'held', version: 3 })
  const routes = { ...baseRoutes(), 'POST /api/approvals/K-DEMO1/hold': ok(held) }
  const h = viewHarness(t, { routes })
  h.view.open(); await flush()
  byClass(h.body, 'approvals-card')[0].click()
  buttonByText(h.body, '工程表で見る').click(); assert.deepEqual(h.opened, [['bellteam', 'approval-box/dec-k-demo1']])
  buttonByText(h.body, '保留にする').click(); await flush()
  assert.equal(h.calls.some(call => call.path === '/api/approvals/K-DEMO1/hold' && call.method === 'POST'), true)
  buttonByText(h.body, '済み').click(); await flush()
  assert.deepEqual(h.calls.map(call => call.path).filter(path => path.includes('answered')), ['/api/approvals?status=answered,cancelled'])
  const row = byClass(h.body, 'approvals-row')[0]; assert.match(row.textContent, /あなたの答え：1つだけ開く.*届いたか不明/su)
  row.click()
  assert.equal(byClass(h.body, 'opt').length, 0, '済みに答えのボタンは無い'); assert.match(h.body.textContent, /再開の文をブレッディの会話に貼ってください/u)
  buttonByText(h.body, '再開の文をコピー').click(); await flush()
  assert.match(h.body.textContent, /コピーしました/u)
  h.view.close()
})

test('view 失敗：旧サーバー・契約・読めない時は、その言葉と抜ける操作。読めない間は札を薄くして再接続の帯、タイマーで読み直す', async t => {
  const h = viewHarness(t, { routes: { '/api/approvals?status=pending,held': { status: 503, body: errors.unavailable.body } } })
  h.view.open(); await flush()
  assert.equal(h.pill.hidden, false); assert.match(h.pill.textContent, /決裁箱に再接続しています…/u)
  assert.equal(h.timers?.size ?? h.clock.timers.size, 1, '読み直しのタイマーが一つ')
  h.feed.status = 'old'; h.emit({ type: 'status', status: 'old' })
  assert.match(h.body.textContent, /このサーバーではまだ決裁箱の拡張を使えません。サーバーが更新されると、自動で使えます。/u); assert.ok(buttonByText(h.body, '閉じる'))
  h.feed.status = 'notEntitled'; h.emit({ type: 'status', status: 'notEntitled' })
  assert.match(h.body.textContent, /決裁箱の拡張は、まだ使えません。/u); assert.ok(buttonByText(h.body, '契約を確かめる'))
  h.feed.status = 'expired'; h.emit({ type: 'status', status: 'expired' })
  assert.match(h.body.textContent, /決裁箱の契約が切れています。/u)
  h.feed.status = 'noCredential'; h.emit({ type: 'status', status: 'noCredential' })
  assert.match(h.body.textContent, /決裁箱につながっていません。つなぐと、自動で決裁を読み込みます。/u); assert.ok(buttonByText(h.body, '決裁箱につなぐ'))
  h.view.close(); assert.equal(h.clock.timers.size, 0, '閉じたらタイマーを持たない')
})

test('view 知らせ：decision の知らせで一覧を読み直し、同じ版なら読まない。開いている札は 修正あり で選択を外さない', async t => {
  const routes = baseRoutes(), h = viewHarness(t, { routes })
  h.view.open(); await flush()
  h.calls.length = 0
  h.emit({ type: 'decision', event: 'updated', id: 'K-DEMO1', version: 2 }); await flush()
  assert.equal(h.calls.length, 0, '同じ版は読まない')
  h.emit({ type: 'decision', event: 'created', id: 'K-NEW', version: 1 }); await flush()
  assert.deepEqual(h.calls.map(call => call.path), ['/api/approvals?status=pending,held'])
  h.emit({ type: 'resync' }); await flush()
  assert.equal(h.calls.filter(call => call.path === '/api/approvals?status=pending,held').length, 2)
  h.view.close()
})

// ---- つなぐ ----
const CONSENT = 'https://approvals.example/consent?code=ZXCV-1234'
const tabMaker = () => { const tabs = [], openTab = () => { const tab = { location: { href: '' }, closed: false, close() { this.closed = true } }; tabs.push(tab); return tab }; return { tabs, openTab } }
const fire = async h => { const [id, timer] = [...h.clock.timers][0]; h.clock.timers.delete(id); timer.fn(); await flush() }
const connectRoutes = extra => ({ '/api/approvals?status=pending,held': { status: 409, body: errors.not_connected.body }, ...extra })

test('connectView / connectOutcome：状態ごとの言葉とボタン。開くのは https の許可ページだけ', () => {
  assert.deepEqual(connectView({}).actions.map(item => item.label), ['決裁箱につなぐ', '読み直す']); assert.equal(connectView({}).text, MESSAGES.noCredential)
  assert.equal(connectView({ server: 'expired' }).text, '決裁箱とのつなぎの期限が切れました。もう一度つないでください。')
  const waiting = connectView({ phase: 'waiting' }); assert.equal(waiting.text, '決裁箱の画面で、許可してください。終わると、ここが自動で読み込みます。'); assert.equal(waiting.spinner, true); assert.deepEqual(waiting.actions.map(item => item.label), ['もう一度開く', 'やめる'])
  assert.deepEqual(connectView({ phase: 'denied' }).actions.map(item => item.label), ['もう一度つなぐ']); assert.equal(connectView({ phase: 'denied' }).text, '許可されませんでした。もう一度つなげます。')
  assert.equal(connectView({ phase: 'opening' }).actions.length, 0)
  assert.deepEqual(connectOutcome(200, { authorizationUrl: CONSENT, expiresAt: 'x' }), { kind: 'ok', url: CONSENT })
  for (const body of [{ authorizationUrl: 'http://x/y' }, { authorizationUrl: 'javascript:alert(1)' }, {}, null]) assert.equal(connectOutcome(200, body).kind, 'retry', 'https 以外は開かない')
  for (const status of [402, 403, 404, 409]) assert.equal(connectOutcome(status, null).kind, 'again')
  for (const status of [0, 429, 503, 400]) assert.deepEqual(connectOutcome(status, null), { kind: 'retry', message: 'いまは決裁箱につなげませんでした。少し待って、もう一度押してください。' })
})

test('view つなぐ：押す→決裁箱の画面が開く（コードは出さない・貼らせない）→許可待ちを見続け→つながったら読む', async t => {
  const { tabs, openTab } = tabMaker()
  const routes = connectRoutes({ 'GET /api/approvals/connection': [ok({ state: 'not_connected' }), ok({ state: 'waiting' }), ok({ state: 'waiting' }), ok({ state: 'connected' })], 'POST /api/approvals/connect': ok({ authorizationUrl: CONSENT, expiresAt: '2026-11-15T13:00:00Z' }) })
  const h = viewHarness(t, { routes, openTab, feedStatus: 'noCredential' })
  h.view.open(); await flush()
  assert.match(h.body.textContent, /決裁箱につながっていません。つなぐと、自動で決裁を読み込みます。/u); assert.equal(h.clock.timers.size, 0)
  const refreshed = h.calls.filter(call => call.path === 'feed.refresh').length
  buttonByText(h.body, '決裁箱につなぐ').click(); assert.equal(tabs.length, 1, '押した瞬間に開く'); assert.equal(tabs[0].location.href, '', 'まだ空の画面')
  assert.match(h.body.textContent, /決裁箱の画面で、許可してください。/u); assert.equal(buttonByText(h.body, '決裁箱につなぐ'), undefined, '送っている間は押せない')
  await flush()
  assert.equal(tabs[0].location.href, CONSENT); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1)
  assert.ok(buttonByText(h.body, 'もう一度開く')); assert.ok(buttonByText(h.body, 'やめる')); assert.equal(h.clock.timers.size, 1); assert.equal([...h.clock.timers.values()][0].ms, 2000)
  assert.doesNotMatch(h.body.textContent, /ZXCV|consent|https:/u, '画面にコードも住所も出さない')
  await fire(h); assert.match(h.body.textContent, /許可してください/u); assert.equal(h.clock.timers.size, 1, '待ち続ける（回数の上限は置かない）')
  await fire(h); assert.equal(h.clock.timers.size, 1)
  await fire(h)
  assert.equal(h.clock.timers.size, 0, 'つながったら見張りを止める'); assert.equal(h.calls.filter(call => call.path === 'feed.refresh').length, refreshed + 1, 'つながったら読み直す')
  h.view.close()
})

test('view つなぐ：断り・待ち時間切れ・失敗は、その言葉ともう一度つなぐ。やめるは DELETE。閉じたら見張りを持たない', async t => {
  const { tabs, openTab } = tabMaker()
  const states = [ok({ state: 'waiting' }), ok({ state: 'denied' }), ok({ state: 'not_connected' })]
  const routes = connectRoutes({ 'GET /api/approvals/connection': () => states.length > 1 ? states.shift() : states[0],
    'POST /api/approvals/connect': [{ status: 503, body: errors.unavailable.body }, ok({ authorizationUrl: CONSENT }), ok({ authorizationUrl: CONSENT })], 'DELETE /api/approvals/connect': ok({ state: 'not_connected' }) })
  const h = viewHarness(t, { routes, openTab, feedStatus: 'noCredential' })
  h.view.open(); await flush()
  assert.match(h.body.textContent, /決裁箱の画面で、許可してください。/u, '開き直しても許可待ちの続きが分かる'); assert.equal(h.clock.timers.size, 1)
  await fire(h)
  assert.match(h.body.textContent, /許可されませんでした。もう一度つなげます。/u); assert.equal(h.clock.timers.size, 0)
  buttonByText(h.body, 'もう一度つなぐ').click(); await flush()
  assert.equal(tabs[0].closed, true, '作れなかったら開いた画面は閉じる'); assert.match(h.body.textContent, /いまは決裁箱につなげませんでした。少し待って、もう一度押してください。/u); assert.ok(buttonByText(h.body, '決裁箱につなぐ'))
  buttonByText(h.body, '決裁箱につなぐ').click(); await flush()
  assert.equal(tabs[1].location.href, CONSENT); await fire(h)
  assert.match(h.body.textContent, /許可の待ち時間が過ぎました。もう一度つないでください。/u); assert.ok(buttonByText(h.body, '決裁箱につなぐ'))
  buttonByText(h.body, '決裁箱につなぐ').click(); await flush()
  buttonByText(h.body, 'やめる').click(); await flush()
  assert.equal(h.calls.some(call => call.method === 'DELETE' && call.path === '/api/approvals/connect'), true); assert.equal(h.clock.timers.size, 0)
  buttonByText(h.body, '決裁箱につなぐ').click(); await flush(); assert.equal(h.clock.timers.size, 1)
  h.view.close(); assert.equal(h.clock.timers.size, 0, '閉じたら見張りを持たない')
})

test('view つなぐ：期限切れの言葉、画面が開かなかった時の案内、契約の止まりは feed に任せる', async t => {
  const blocked = viewHarness(t, { routes: connectRoutes({ 'GET /api/approvals/connection': ok({ state: 'expired' }), 'POST /api/approvals/connect': ok({ authorizationUrl: CONSENT }) }), openTab: () => null, feedStatus: 'noCredential' })
  blocked.view.open(); await flush()
  assert.match(blocked.body.textContent, /決裁箱とのつなぎの期限が切れました。もう一度つないでください。/u)
  buttonByText(blocked.body, '決裁箱につなぐ').click(); await flush()
  assert.match(blocked.body.textContent, /決裁箱の画面が開かなかったようです。「もう一度開く」を押してください。/u); assert.ok(buttonByText(blocked.body, 'もう一度開く'))
  blocked.view.close()
  const gone = viewHarness(t, { routes: connectRoutes({ 'GET /api/approvals/connection': ok({ state: 'not_connected' }), 'POST /api/approvals/connect': { status: 403, body: errors['not_entitled.expired'].body } }), openTab: tabMaker().openTab, feedStatus: 'noCredential' })
  gone.view.open(); await flush()
  const before = gone.calls.filter(call => call.path === 'feed.refresh').length
  buttonByText(gone.body, '決裁箱につなぐ').click(); await flush()
  assert.equal(gone.calls.filter(call => call.path === 'feed.refresh').length, before + 1, '契約の止まりは feed が決める'); assert.equal(gone.clock.timers.size, 0)
  gone.view.close()
})

test('view つなぎを外す：つながっている間だけ出て、二段（外す / やめる）。外したら読み直してつなぐ画面へ', async t => {
  const routes = { ...baseRoutes(), 'DELETE /api/approvals/connection': [{ status: 503, body: errors.unavailable.body }, ok({ state: 'not_connected' })] }
  const h = viewHarness(t, { routes })
  h.view.open(); await flush()
  buttonByText(h.body, 'つなぎを外す').click()
  assert.match(h.body.textContent, /決裁箱とのつなぎを外します。外すと、また決裁箱につなぐまで決裁は読めません。/u); assert.equal(h.calls.some(call => call.method === 'DELETE'), false, '押しただけでは外さない')
  buttonByText(h.body, 'やめる').click(); assert.ok(buttonByText(h.body, 'つなぎを外す'))
  buttonByText(h.body, 'つなぎを外す').click(); buttonByText(h.body, '外す').click(); await flush()
  assert.match(h.body.textContent, /いまはつなぎを外せませんでした。少し待って、もう一度押してください。/u)
  buttonByText(h.body, '外す').click(); await flush()
  assert.equal(h.calls.filter(call => call.method === 'DELETE' && call.path === '/api/approvals/connection').length, 2); assert.equal(h.calls.filter(call => call.path === 'feed.refresh').length, 1)
  h.feed.status = 'noCredential'; h.emit({ type: 'status', status: 'noCredential' }); await flush()
  assert.ok(buttonByText(h.body, '決裁箱につなぐ')); assert.equal(buttonByText(h.body, 'つなぎを外す'), undefined, 'つながっていなければ外す操作は出ない')
  h.view.close()
})
