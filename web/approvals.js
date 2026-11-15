// 決裁箱の画面。データは GET/POST /api/approvals/*（決裁箱拡張 contract v0.1）、見た目と動きは screen-spec.md（工程表と同じ作り）。
import { applyAvatar } from './view-format.js?v=__ASSET_VERSION__'
import { openImageViewer } from './image-gallery.js?v=__ASSET_VERSION__'
import { GLYPHS as LATTICE_GLYPHS } from './lattice-chart.js?v=__ASSET_VERSION__'
import { accent, stateInfo, UNKNOWN_MEMBER } from './lattice-chart-model.js?v=__ASSET_VERSION__'
import {
  CONNECT, MESSAGES, STATUS_TEXT, answerOutcome, backoffMs, cardRow, clock, confirmText, connectOutcome, connectView, countsOf, deliveryBadge, deliveryNote, entryView, failureOf,
  groupDone, historyRows, linkPanel, originCounts, originFilter, originOf, answerText,
} from './approvals-model.js?v=__ASSET_VERSION__'
import { stopTime } from './lattice-stops.js?v=__ASSET_VERSION__'

const GLYPHS = {
  ...LATTICE_GLYPHS,
  inbox: '<path d="M3.5 13.5l2.4-7.2A2 2 0 0 1 7.8 5h8.4a2 2 0 0 1 1.9 1.3l2.4 7.2"/><path d="M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5h-5.2a3.3 3.3 0 0 1-6.6 0z"/>',
  bolt: '<path d="M13 3L5.5 13.2h5.2L10 21l7.5-10.2h-5.2z" fill="currentColor" fill-opacity=".18"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  send: '<path d="M20.5 3.5L10 14M20.5 3.5L14 20.5l-4-6.5-6.5-4z"/>',
  pencil: '<path d="M5 19l1-4.2L16.6 4.2a2.1 2.1 0 0 1 3 3L9 17.8z"/><path d="M14.5 6.3l3.2 3.2"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M9 11h6M9 15h6"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M7.5 10l3 2.5-3 2.5M13 15h3.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z"/>',
  arrow: '<path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 3.5 3L16 12l4.5 4.5"/>',
}
const SVG_NS = 'http://www.w3.org/2000/svg'
const UNKNOWN_COLOR = '#9A9DAE'
const TERMINAL = ['old', 'notEntitled', 'expired', 'noCredential']

function glyph(name, extra = '') {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('class', `lattice-g ${extra}`.trim()); el.setAttribute('aria-hidden', 'true')
  el.innerHTML = GLYPHS[name] ?? '' // 上の固定の定数だけ。画面のデータは入れない。
  return el
}
function append(el, children) {
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(typeof child === 'string' ? document.createTextNode(child) : child)
}
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key === 'style') for (const [name, item] of Object.entries(value)) { if (name.startsWith('--')) el.style.setProperty(name, item); else el.style[name] = item }
    else if (key === 'value') el.value = value
    else el.setAttribute(key, value === true ? '' : value)
  }
  append(el, children)
  return el
}
const fill = (el, ...children) => { el.replaceChildren(); append(el, children) }
function* walk(el) { for (const child of el.children ?? []) { yield child; yield* walk(child) } }
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  return el
}

// 入口の行（メンバー一覧の一番上）。置き場所を変えても、この一つを動かすだけ。
export function createApprovalsEntry(button, { feed, open }) {
  const paint = () => {
    const view = entryView(feed.summary, feed.status)
    button.classList.toggle('is-pending', view.pending > 0)
    button.setAttribute('aria-label', view.label)
    button.replaceChildren(
      h('span', { class: 'approvals-tile', 'aria-hidden': 'true' }, glyph('inbox')),
      h('span', { class: 'approvals-entry-text' }, h('b', { text: '決裁箱' }), h('small', { text: view.sub })),
      view.urgent && h('span', { class: 'approvals-bolt', 'aria-hidden': 'true' }, glyph('bolt')),
      view.pending > 0 && h('span', { class: 'approvals-count', 'aria-hidden': 'true', text: String(view.pending) }))
  }
  button.addEventListener('click', () => open())
  feed.on(event => { if (event.type === 'summary' || event.type === 'status') paint() })
  paint()
  return { paint }
}

export function createApprovalsView(dialog, {
  feed, fetch, fetchImage = fetch, getMember = () => null, openChart = () => {}, now = Date.now,
  setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout, random = Math.random,
  uuid = () => globalThis.crypto.randomUUID(), copyText = text => globalThis.navigator.clipboard.writeText(text),
  // 押した瞬間に空の画面を開く（待ったあとの open はブラウザに止められる）。開いた先は決裁箱の画面で、こちらの画面は触らせない。
  openTab = () => { const tab = globalThis.open('', '_blank'); if (tab) tab.opener = null; return tab },
} = {}) {
  const body = dialog.querySelector('[data-approvals-body]')
  const pill = dialog.querySelector('[data-approvals-pill]')
  let isOpen = false, tab = 'pending', origin = 'all', selectedId = null, pending = [], done = [], doneNext = null, doneLoaded = false
  let loaded = false, stale = false, attempt = 0, pendingToken = 0, doneToken = 0, retryTimer = null
  let answer = null, banner = null, draft = { id: null, text: '' }
  const extra = new Map(), notes = new Map(), seen = new Set(), thumbs = new Map(), avatars = new Map(), timers = new Set()
  let ui = null, copied = null, unsubscribe = null
  let connect = { phase: 'idle', server: null, note: '' }, connectToken = 0, connectTimer = null, pollAttempt = 0, drop = null
  const after = (fn, ms) => { const id = later(() => { timers.delete(id); fn() }, ms); timers.add(id); return id }

  // ---- 通信：approvals は入れ子の error を返すので、共有の api() ではなく fetch で読む。
  async function call(path, { method = 'GET', headers = {}, json } = {}) {
    try {
      const response = await fetch(path, { method, cache: 'no-store', headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : undefined })
      let data = null
      try { data = await response.json() } catch { /* 本文なし */ }
      return { status: response.status, body: data }
    } catch { return { status: 0, body: null } }
  }
  const blocked = () => TERMINAL.includes(feed.status) ? feed.status : null
  // 一覧の札と、単独で読んだ決裁（答えたあとは一覧から外れる）のうち、版の新しい方。
  function known(id) {
    const listed = pending.find(item => item.id === id) ?? done.find(item => item.id === id), single = extra.get(id)
    return listed && single ? (single.version > listed.version ? single : listed) : listed ?? single ?? null
  }
  function put(decision) {
    const swap = list => list.map(item => item.id === decision.id ? decision : item)
    pending = swap(pending); done = swap(done); extra.set(decision.id, decision)
  }

  // ---- 顔：avatar は fetchImage で取り、Blob URL にして applyAvatar。取れない時は頭文字。
  function avatarFor(url) {
    if (!avatars.has(url)) {
      const entry = { src: null, promise: null }
      entry.promise = Promise.resolve().then(() => fetchImage(url)).then(response => response.ok ? response.blob() : null)
        .then(blob => { if (!blob || !isOpen) return null; entry.src = URL.createObjectURL(blob); return entry.src }).catch(() => null)
      avatars.set(url, entry)
    }
    return avatars.get(url)
  }
  function face(requester, size) {
    const member = requester ? getMember(requester.botId) : null, unknown = Boolean(requester) && !member
    const el = h('span', { class: `lattice-av${unknown ? ' unk' : ''}`, 'aria-hidden': 'true', style: { '--s': `${size}px`, '--c': unknown ? UNKNOWN_COLOR : accent(member?.color) } })
    el.textContent = unknown ? '?' : [...(member?.name ?? requester?.name ?? '')][0] ?? ''
    const url = member?.avatar || (member?.avatarVersion ? `/api/bots/${encodeURIComponent(member.botId)}/avatar?v=${encodeURIComponent(member.avatarVersion)}` : '')
    if (url) { const entry = avatarFor(url); if (entry.src) applyAvatar(el, { avatar: entry.src }); else void entry.promise.then(src => { if (src) applyAvatar(el, { avatar: src }) }) }
    return el
  }
  const nameOf = origin_ => origin_.member && !getMember(origin_.member.botId) ? UNKNOWN_MEMBER : origin_.name
  const originMark = (info, size) => info.member ? face(info.member, size) : h('span', { class: 'approvals-tile', 'aria-hidden': 'true', style: { '--s': `${size}px` } }, glyph(info.tile))
  const badgeEl = item => h('span', { class: `approvals-badge ${item.tone}` }, glyph(item.glyph), item.text)
  function ringEl(fraction, label) {
    const r = 11, c = 15, len = 2 * Math.PI * r
    const el = h('span', { class: 'lattice-ring', style: { '--s': '30px' } }, h('span', { class: 'sr-only', text: label }))
    const art = svg('svg', { viewBox: '0 0 30 30', 'aria-hidden': 'true' }), track = svg('circle', { class: 'tr', cx: c, cy: c, r }), fg = svg('circle', { class: 'fg', cx: c, cy: c, r, 'stroke-dasharray': `${(fraction * len).toFixed(2)} ${len.toFixed(2)}` })
    art.append(track, fg); el.prepend(art)
    return el
  }
  function keepFocus(rebuild) {
    const active = globalThis.document?.activeElement, key = active && body.contains?.(active) ? active.dataset?.focusKey : null
    const caret = active?.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null
    rebuild()
    if (!key) return
    const target = [...walk(body)].find(item => item.dataset?.focusKey === key)
    target?.focus?.()
    if (caret && target?.setSelectionRange) target.setSelectionRange(...caret)
  }

  // ---- 読む
  async function loadPending() {
    const mine = ++pendingToken
    const result = await call('/api/approvals?status=pending,held')
    if (!isOpen || mine !== pendingToken) return
    if (result.status === 200 && Array.isArray(result.body?.items)) { pending = result.body.items; loaded = true; stale = false; attempt = 0; clear(retryTimer); return paint() }
    const kind = failureOf(result.status, result.body)
    if (kind === 'reconnect' || kind === 'wait' || kind === 'refused') { stale = true; clear(retryTimer); retryTimer = later(() => void loadPending(), backoffMs(attempt++, random)); return paint() }
    void feed.refresh() // 404 / 402 / 403 / 409：feed が止まり方を知らせる
  }
  async function loadDone(reset = true) {
    const mine = ++doneToken
    const result = await call(`/api/approvals?status=answered,cancelled${!reset && doneNext ? `&cursor=${encodeURIComponent(doneNext)}` : ''}`)
    if (!isOpen || mine !== doneToken) return
    if (result.status === 200 && Array.isArray(result.body?.items)) {
      const items = result.body.items
      done = reset ? items : [...done, ...items.filter(item => !done.some(old => old.id === item.id))]
      doneNext = result.body.nextCursor ?? null; doneLoaded = true; stale = false
    } else stale = true
    paint()
  }
  async function loadOne(id) {
    const result = await call(`/api/approvals/${encodeURIComponent(id)}`)
    if (!isOpen) return
    if (result.status === 200 && result.body?.id === id) put(result.body)
    else if (failureOf(result.status, result.body) === 'gone') { extra.delete(id); if (selectedId === id) selectedId = null }
    paint()
  }
  function onFeed(event) {
    if (!isOpen) return
    if (event.type === 'status' || event.type === 'summary') {
      if (event.type === 'status' && event.status === 'live') void loadPending()
      if (event.type === 'status' && event.status === 'noCredential') void enterConnect()
      return paint()
    }
    if (event.type === 'resync') { void loadPending(); if (doneLoaded) void loadDone(); return }
    if (event.type === 'decision') {
      const current = known(event.id)
      if (event.event !== 'deleted' && current && current.version === event.version) return
      void loadPending(); if (doneLoaded) void loadDone()
      if (selectedId === event.id && event.event !== 'deleted') void loadOne(event.id)
      if (selectedId === event.id && event.event === 'deleted') { selectedId = null; paint() }
    }
  }

  // ---- 画面全体
  function build() {
    const title = h('span', { class: 'approvals-title' }, glyph('inbox'), h('b', { text: '決裁箱' }), h('span', { class: 'approvals-count', 'data-count': '' }))
    const live = h('span', { class: 'lattice-live', hidden: true }, h('i', { class: 'ldot' }), 'ライブ')
    const seg = h('div', { class: 'lattice-seg', role: 'group', 'aria-label': '表示' })
    const reload = h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'reload' }, on: { click: () => { stale = false; void feed.refresh(); void loadPending(); if (doneLoaded) void loadDone() } } }, glyph('refresh'), '読み直す')
    const sum = h('div', { class: 'lattice-sum' }), counters = h('div', { class: 'lattice-cnt' })
    const unlink = h('span', { class: 'approvals-unlink' })
    const toolbar = h('div', { class: 'lattice-toolbar approvals-toolbar' }, title, live, seg, h('span', { class: 'lattice-spacer' }), sum, counters, reload, unlink)
    const bannerSlot = h('div', { class: 'approvals-banner-slot' })
    const list = h('section', { class: 'approvals-list', 'aria-label': '決裁の一覧' }), detail = h('section', { class: 'approvals-detail', 'aria-label': '決裁の詳細' }), links = h('aside', { class: 'approvals-links', 'aria-label': '工程とのつながり' })
    const main = h('div', { class: 'approvals-main' }, list, detail, links)
    const note = h('div', { class: 'approvals-note-slot', hidden: true })
    const root = h('div', { class: 'approvals' }, toolbar, bannerSlot, main, note)
    body.replaceChildren(root)
    ui = { root, title, live, seg, sum, counters, unlink, bannerSlot, list, detail, links, main, note }
  }

  function paint() {
    if (!isOpen || !ui) return
    const status = blocked(), summary = feed.summary, counts = countsOf(summary)
    keepFocus(() => {
      fill(ui.title, glyph('inbox'), h('b', { text: '決裁箱' }), counts.pending > 0 && h('span', { class: 'approvals-count', text: String(counts.pending) }))
      ui.live.hidden = !(feed.status === 'live' && !stale)
      const choice = (value, label, n) => h('button', { type: 'button', 'aria-pressed': String(tab === value), dataset: { focusKey: `tab:${value}` }, on: { click: () => setTab(value) } }, label, n !== null && h('em', { class: 'approvals-n', text: String(n) }))
      fill(ui.seg, choice('pending', '待ち', pending.filter(item => item.status === 'pending').length), choice('held', '保留', pending.filter(item => item.status === 'held').length), choice('done', '済み', doneLoaded ? `${done.length}${doneNext ? '+' : ''}` : null))
      fill(ui.sum, ringEl(counts.fraction, `今日の回答 ${counts.answered}/${counts.filed}`), h('span', { class: 't' }, `${counts.answered}/${counts.filed}`, h('small', { text: '今日の回答' })))
      const count = (label, n, color) => h('span', {}, h('i', { style: { background: color } }), `${label} `, h('b', { text: String(n) }))
      fill(ui.counters, count('待ち', counts.pending, accent('violet')), count('急ぎ', counts.urgent, accent('amber')), count('保留', counts.held, '#B3B6C6'))
      ui.main.hidden = Boolean(status); ui.note.hidden = !status
      ui.root.classList.toggle('is-stale', stale || feed.status === 'drop')
      ui.root.classList.toggle('has-selection', Boolean(selectedId) && !status)
      fill(ui.bannerSlot, banner && selectedId === banner.id && h('div', { class: 'lattice-banner violet', role: 'status' }, glyph('info'), h('span', { text: banner.text })))
      fill(ui.unlink, !status && unlinkEl())
      if (status) fill(ui.note, noteEl(status))
      else { paintList(); paintDetail() }
    })
    pill.hidden = !(feed.status === 'drop' || stale && !status)
    if (!pill.hidden) fill(pill, h('span', { class: 'lattice-pill-item' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), MESSAGES.reconnect))
  }
  function noteEl(status) {
    if (status === 'noCredential') return connectEl()
    const again = status === 'notEntitled' ? '契約を確かめる' : '読み直す'
    return h('div', { class: 'lattice-empty', role: 'status' }, glyph('bud', 'lattice-bud'), h('p', { text: STATUS_TEXT[status] }),
      status !== 'old' && h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'again' }, on: { click: () => void feed.refresh().then(() => { if (!blocked()) void loadPending() }) } }, glyph('refresh'), again),
      h('button', { class: 'lattice-btn', type: 'button', on: { click: () => dialog.close() } }, '閉じる'))
  }
  // ---- つなぐ：決裁箱につなぐ -> 決裁箱の画面で許可 -> こちらは GET /connection を見て、つながったら読む。待ちに時間の上限は置かない（閉じる・やめるが出口）。
  function connectEl() {
    const view = connectView(connect)
    const run = { connect: () => void startConnect(), again: () => void startConnect(), cancel: () => void stopConnect(), reload: () => void recheck() }
    return h('div', { class: 'lattice-empty approvals-connect', role: 'status' }, glyph('bud', 'lattice-bud'), h('p', { text: view.text }),
      view.spinner && h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }),
      h('div', { class: 'approvals-connect-acts' }, ...view.actions.map(item => h('button', { class: `lattice-btn${item.primary ? ' pri' : ''}`, type: 'button', dataset: { focusKey: `connect:${item.key}` }, on: { click: run[item.key] } }, item.primary && item.key !== 'cancel' ? glyph('link') : null, item.label)),
        h('button', { class: 'lattice-btn', type: 'button', on: { click: () => dialog.close() } }, '閉じる')),
      view.note && h('p', { class: 'approvals-fail', role: 'status', text: view.note }))
  }
  const settle = patch => { connectToken++; clear(connectTimer); pollAttempt = 0; connect = { phase: 'idle', server: null, note: '', ...patch }; paint() }
  function recover() { settle({}); void feed.refresh() } // つながった：読み直すと feed が live になり、一覧を読む
  // 入る時に一度、モジュールが何を待っているかを聞く（開き直しても、許可待ち・断りの続きが分かる）。
  async function enterConnect() {
    if (connect.phase !== 'idle') return
    const mine = ++connectToken, result = await call('/api/approvals/connection')
    if (!isOpen || mine !== connectToken || result.status !== 200 || blocked() !== 'noCredential') return
    const state = result.body?.state
    if (state === 'connected') return recover()
    connect = { phase: state === 'waiting' ? 'waiting' : state === 'denied' ? 'denied' : 'idle', server: state, note: '' }
    if (state === 'waiting') watch(mine, 2000)
    paint()
  }
  async function recheck() {
    await feed.refresh()
    if (!blocked()) void loadPending(); else if (blocked() === 'noCredential') void enterConnect()
  }
  function watch(mine, ms) {
    clear(connectTimer)
    connectTimer = later(async () => {
      const result = await call('/api/approvals/connection')
      if (!isOpen || mine !== connectToken) return
      const state = result.status === 200 ? result.body?.state : null
      if (state === 'connected') return recover()
      if (state === 'denied') return settle({ phase: 'denied' })
      if (state === 'not_connected' || state === 'expired') return settle({ note: CONNECT.lapsed })
      watch(mine, state === 'waiting' ? (pollAttempt = 0, 2000) : backoffMs(pollAttempt++, random)) // 読めない間も、止まらず見続ける
    }, ms)
  }
  async function startConnect() {
    if (connect.phase === 'opening') return
    let tab = null
    try { tab = openTab() } catch { /* 開けなくても、要求は出す。もう一度開くで開ける */ }
    const mine = ++connectToken; clear(connectTimer)
    connect = { phase: 'opening', server: connect.server, note: '' }; paint()
    const result = await call('/api/approvals/connect', { method: 'POST' })
    if (!isOpen || mine !== connectToken) { tab?.close?.(); return }
    const outcome = connectOutcome(result.status, result.body)
    if (outcome.kind === 'ok') {
      if (tab) tab.location.href = outcome.url
      connect = { phase: 'waiting', server: 'waiting', note: tab ? '' : CONNECT.blocked }; pollAttempt = 0; paint(); return watch(mine, 2000)
    }
    tab?.close?.()
    settle(outcome.kind === 'retry' ? { note: outcome.message } : {})
    if (outcome.kind === 'again') void feed.refresh()
  }
  async function stopConnect() { settle({}); await call('/api/approvals/connect', { method: 'DELETE' }); if (isOpen && blocked() === 'noCredential') void enterConnect() }
  // つながっている間の、つなぎを外す（二段）。外すと summary が 409 になり、つなぐ画面に変わる。
  function unlinkEl() {
    if (drop?.step === 'busy') return h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' })
    if (drop?.step === 'confirm') return [h('span', { class: 'approvals-unlink-ask', role: 'group', 'aria-label': 'つなぎを外す確認', text: drop.note ?? CONNECT.dropAsk }),
      h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'unlink-no' }, on: { click: () => { drop = null; paint() } } }, 'やめる'),
      h('button', { class: 'lattice-btn pri', type: 'button', dataset: { focusKey: 'unlink-yes' }, on: { click: () => void unlink() } }, '外す')]
    return h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'unlink' }, on: { click: () => { drop = { step: 'confirm' }; paint(); focusKey('unlink-no') } } }, 'つなぎを外す')
  }
  async function unlink() {
    drop = { step: 'busy' }; paint()
    const result = await call('/api/approvals/connection', { method: 'DELETE' })
    if (!isOpen) return
    if (result.status === 200) { drop = null; connect = { phase: 'idle', server: 'not_connected', note: '' }; await feed.refresh(); return paint() }
    drop = { step: 'confirm', note: CONNECT.dropFailed }; paint()
  }

  function setTab(value) {
    tab = value; selectedId = null; answer = null
    if (value === 'done' && !doneLoaded) void loadDone()
    paint()
  }

  // ---- 一覧
  function paintList() {
    const heading = tab === 'pending' ? '回答を待っています' : tab === 'held' ? '保留しています' : '済んだ決裁'
    const hint = tab === 'pending' ? '急ぎ → 期限 → 古い順' : ''
    const base = tab === 'done' ? done : pending.filter(item => tab === 'pending' ? item.status === 'pending' : item.status === 'held')
    const chips = originCounts(base), hidden = chips.all - originFilter(base, origin).length
    const shown = originFilter(base, origin)
    const head = h('div', { class: 'approvals-list-head' }, h('h2', { text: heading }), hint && h('small', { text: hint }))
    const chip = (value, label) => h('button', { class: 'approvals-chip', type: 'button', 'aria-pressed': String(origin === value), dataset: { focusKey: `origin:${value}` }, on: { click: () => { origin = value; paint() } } }, label, h('em', { class: 'approvals-n', text: String(chips[value]) }))
    const filter = h('div', { class: 'approvals-filter', role: 'group', 'aria-label': '出どころ' }, h('span', { text: '出どころ' }), chip('all', 'すべて'), chip('bellteam', 'BellTeam'), chip('external', '外部'))
    const hiddenLine = hidden > 0 && h('div', { class: 'approvals-hidden', role: 'status' }, glyph('info'), h('span', { text: `${origin === 'bellteam' ? '外部' : 'BellTeam'}の決裁 ${hidden}件を隠しています。` }),
      h('button', { type: 'button', dataset: { focusKey: 'show-all' }, on: { click: () => { origin = 'all'; paint() } } }, 'すべてを見る'))
    let content
    if (!loaded && tab !== 'done') content = h('div', { class: 'lattice-loading', role: 'status' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), h('span', { class: 'sr-only', text: MESSAGES.loading }))
    else if (tab === 'done') content = doneEl(shown)
    else if (!shown.length) content = h('p', { class: 'approvals-none', role: 'status', text: base.length ? '絞り込みに合う決裁はありません。' : tab === 'held' ? MESSAGES.emptyHeld : MESSAGES.emptyPending },
      tab === 'pending' && !base.length && h('button', { class: 'lattice-btn', type: 'button', on: { click: () => setTab('done') } }, '済みを見る'))
    else if (tab === 'pending') {
      const held = originFilter(pending.filter(item => item.status === 'held'), origin)
      content = h('div', { class: 'approvals-cards' }, ...shown.map(item => cardEl(item)),
        held.length > 0 && h('div', { class: 'approvals-divider' }, glyph('pause'), `保留 ${held.length}`), ...held.map(item => cardEl(item)))
    } else content = h('div', { class: 'approvals-cards' }, ...shown.map(item => cardEl(item)))
    fill(ui.list, head, filter, hiddenLine, content)
  }
  function cardEl(decision) {
    const row = cardRow(decision, now()), info = row.origin
    const fresh = !seen.has(decision.id); seen.add(decision.id)
    return h('button', { class: `approvals-card${decision.status === 'held' ? ' is-held' : ' is-pending'}${row.urgent ? ' is-urgent' : ''}${selectedId === decision.id ? ' sel' : ''}${fresh && loaded ? ' is-entering' : ''}`, type: 'button', 'aria-label': row.label, dataset: { focusKey: `c:${decision.id}` },
      on: { click: () => select(decision.id) } },
    h('span', { class: 'top' }, ...row.badges.map(badgeEl), h('span', { class: 'age', text: row.age }), h('span', { class: 'who' }, originMark(info, 22), h('span', { text: nameOf(info) }))),
    h('span', { class: 'ti', text: row.title }),
    h('span', { class: `en ${row.note.tone}` }, glyph('link'), h('span', { text: row.note.text })),
    row.chips.length > 0 && h('span', { class: 'ch' }, ...row.chips.map(text => h('span', { class: 'approvals-chip-s', text }))))
  }
  function doneEl(shown) {
    if (!doneLoaded) return h('div', { class: 'lattice-loading', role: 'status' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }))
    const groups = groupDone(shown, now())
    if (!groups.length) return h('p', { class: 'approvals-none', role: 'status', text: MESSAGES.emptyDone })
    return h('div', { class: 'approvals-done' }, ...groups.map(group => h('section', {}, h('h4', { text: group.heading }),
      ...group.rows.map(row => h('button', { class: `approvals-row${row.cancelled ? ' is-withdrawn' : ''}${selectedId === row.id ? ' sel' : ''}`, type: 'button', dataset: { focusKey: `c:${row.id}` }, on: { click: () => select(row.id) } },
        glyph(row.cancelled ? 'xmark' : 'seal'),
        h('span', { class: 'm' }, h('b', { text: row.title }), h('small', { text: [row.line, row.external && '外部から'].filter(Boolean).join('　') })),
        row.delivery && h('span', { class: `approvals-badge ${row.delivery.tone}` }, row.delivery.text),
        h('time', { text: row.time }))))),
    doneNext && h('button', { class: 'lattice-btn approvals-more', type: 'button', dataset: { focusKey: 'more' }, on: { click: () => void loadDone(false) } }, 'もっと見る'))
  }
  function select(id) {
    if (selectedId !== id) { answer = null; if (draft.id !== id) draft = { id, text: '' } }
    selectedId = id
    if (!known(id)) void loadOne(id)
    paint()
    ui.detail.scrollTop = 0
  }
  function closeDetail() { selectedId = null; answer = null; paint() }

  // ---- 詳細
  function paintDetail() {
    const decision = selectedId ? known(selectedId) : null
    if (answer && decision && answer.version !== decision.version) { banner = { id: decision.id, text: MESSAGES.amended(originOf(decision).who) }; answer = null }
    if (!decision) {
      fill(ui.detail, h('div', { class: 'approvals-empty' }, glyph('inbox'), h('p', { text: selectedId ? MESSAGES.loading : '決裁を選ぶと、ここに内容が出ます。' })))
      fill(ui.links, linkEl(null)); return
    }
    const info = originOf(decision), badges = cardRow(decision, now()).badges, open = ['pending', 'held'].includes(decision.status)
    const recommended = (decision.options ?? []).find(option => option.recommended)
    const sub = [h('span', { class: 'who' }, originMark(info, 18), h('b', { text: nameOf(info) })), info.member && info.session && h('span', { text: `· ${info.session}` }),
      h('span', { text: `· ${clock(decision.createdAt)} に受付` }), decision.deadline && open && h('span', { text: `· 期限 ${stopTime(decision.deadline, now())}` })]
    const panel = linkPanel(decision)
    fill(ui.detail, h('div', { class: 'approvals-detail-in' },
      h('div', { class: 'row1' }, ...badges.map(badgeEl), h('button', { class: 'x', type: 'button', 'aria-label': '詳細を閉じる', dataset: { focusKey: 'close' }, on: { click: closeDetail } }, glyph('xmark'))),
      h('h3', { text: decision.title }),
      h('div', { class: 'sub' }, ...sub),
      info.external && h('div', { class: 'approvals-outside' }, originMark(info, 40), h('div', {}, h('b', { text: 'BellTeamの外から届いた決裁です' }),
        h('small', { text: [info.tool, info.via, info.session && `セッション「${info.session}」`].filter(Boolean).join(' · ') }))),
      decision.context && h('div', { class: 'sc' }, h('div', { class: 'l' }, glyph('doc'), '背景'), h('p', { class: 'ctx', text: decision.context })),
      attachmentsEl(decision),
      open && recommended && h('div', { class: 'rec' }, glyph('check'), h('span', { text: `${info.who}の推奨：${recommended.label}` })),
      open ? answerEl(decision, info) : answeredEl(decision, info),
      open && h('div', { class: 'acts' },
        h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'hold' }, on: { click: () => void toggleHold(decision) } }, glyph('pause'), decision.status === 'held' ? '保留を戻す' : '保留にする'),
        panel.ids && h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'chart' }, on: { click: () => openChart(panel.ids.projectId, panel.ids.cardId) } }, glyph('target'), '工程表で見る')),
      notes.get(decision.id)?.hold && h('p', { class: 'approvals-fail', role: 'status', text: notes.get(decision.id).hold }),
      historyEl(decision),
      h('div', { class: 'approvals-links-inline' }, linkEl(decision))))
    fill(ui.links, linkEl(decision))
  }
  function attachmentsEl(decision) {
    const list = decision.requestAttachments ?? []
    if (!list.length) return null
    const urls = list.map(item => thumb(decision.id, item))
    return h('div', { class: 'sc' }, h('div', { class: 'l' }, glyph('image'), `添付 ${list.length}`), h('div', { class: 'approvals-thumbs' }, ...list.map((item, index) => {
      const entry = urls[index], button = h('button', { class: 'approvals-thumb', type: 'button', 'aria-label': `${item.name}を大きく開く`, dataset: { focusKey: `a:${item.id}` },
        on: { click: () => { const ready = urls.map(each => each.src).filter(Boolean); if (entry.src) openImageViewer(ready, Math.max(0, ready.indexOf(entry.src)), item.name) } } }, glyph('image'))
      const apply = src => { if (src) { button.style.backgroundImage = `url(${JSON.stringify(src)})`; button.classList.add('has-image') } }
      if (entry.src) apply(entry.src); else void entry.promise.then(apply)
      return button
    })))
  }
  function thumb(decisionId, item) {
    const key = `${decisionId}/${item.id}`
    if (!thumbs.has(key)) {
      const entry = { src: null, promise: null }
      entry.promise = Promise.resolve().then(() => fetchImage(`/api/approvals/${encodeURIComponent(decisionId)}/attachments/${encodeURIComponent(item.id)}`)).then(response => response.ok ? response.blob() : null)
        .then(blob => { if (!blob || !isOpen) return null; entry.src = URL.createObjectURL(blob); return entry.src }).catch(() => null)
      thumbs.set(key, entry)
    }
    return thumbs.get(key)
  }
  function historyEl(decision) {
    const rows = historyRows(decision, now())
    return rows.length > 0 && h('div', { class: 'sc' }, h('div', { class: 'l' }, glyph('hour'), '経過'), h('div', { class: 'tlne' }, ...rows.map(row => h('div', {}, h('time', { text: row.time }), row.text, row.amended && h('span', { class: 'approvals-badge ind', text: '修正あり' })))))
  }
  function answeredEl(decision, info) {
    const badge = deliveryBadge(decision), note = notes.get(decision.id)?.answer ?? (decision.status === 'answered' && decision.delivery === 'unknown' ? deliveryNote(decision) : null)
    const names = (decision.answer?.attachments ?? []).map(item => item.name)
    return h('div', { class: 'sc approvals-answered' }, h('div', { class: 'l' }, glyph('seal'), decision.status === 'cancelled' ? '取り下げ' : '答え'),
      decision.status === 'cancelled' ? h('p', { text: decision.cancelReason ? `${info.who}が取り下げました：${decision.cancelReason}` : `${info.who}が取り下げました。` })
        : [h('p', { class: 'ans', text: answerText(decision) }), names.length > 0 && h('p', { class: 'approvals-files', text: `添付：${names.join('、')}` }),
          h('div', { class: 'at' }, badge && h('span', { class: `approvals-badge ${badge.tone}`, text: badge.text }), h('time', { text: decision.answer?.answeredAt ? stopTime(decision.answer.answeredAt, now()) : '' }))],
      note && noteLine(decision, note))
  }
  function noteLine(decision, note) {
    const wait = copied === decision.id
    return h('div', { class: `approvals-result ${note.tone}`, role: 'status' }, h('p', { text: note.text }),
      note.copy && h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'copy' }, on: { click: () => void copyResume(decision) } }, glyph('copy'), wait ? 'コピーしました' : '再開の文をコピー'))
  }
  async function copyResume(decision) {
    try { await copyText(decision.resumePhrase) } catch { return }
    copied = decision.id; paint()
    after(() => { if (copied === decision.id) { copied = null; paint() } }, 2000)
  }

  // ---- 答える：選ぶ -> その場で確認 -> 答える（同じ場所がボタンから確認、送信中、結果に変わる）
  function answerEl(decision, info) {
    const mine = answer?.id === decision.id ? answer : null
    const failure = mine?.note && h('p', { class: 'approvals-fail', role: 'status', text: mine.note })
    const writing = h('div', { class: 'ta' }, h('textarea', { rows: 3, placeholder: 'やり直してほしいこと、足したい条件を書きます', 'aria-label': '選ばずに、指示を書いて返す', dataset: { focusKey: 'text' }, value: draft.id === decision.id ? draft.text : '',
      on: { input: event => { draft = { id: decision.id, text: event.target.value } } } }),
    h('button', { class: 'lattice-btn soft', type: 'button', dataset: { focusKey: 'send-text' }, on: { click: () => { const text = (draft.text ?? '').trim(); if (text) ask(decision, { text }) } } }, glyph('send'), '指示を送る'))
    if (mine?.step === 'sending') return h('div', { class: 'sc' }, h('div', { class: 'approvals-confirm sending', role: 'status' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), h('span', { text: '答えを送っています…' })))
    if (mine?.step === 'confirm') {
      return h('div', { class: 'sc' }, h('div', { class: 'approvals-confirm', role: 'group', 'aria-label': '答えの確認' }, glyph('send'), h('div', { class: 'cf' }, h('p', { text: confirmText(decision, mine) }), mine.text && h('blockquote', { text: mine.text }), failure,
        h('div', { class: 'cb' },
          h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: `cancel` }, on: { click: () => cancel(true) } }, 'やめる'),
          h('button', { class: 'lattice-btn pri', type: 'button', dataset: { focusKey: 'confirm' }, on: { click: () => void send(decision) } }, '答える')))))
    }
    return h('div', { class: 'sc' }, h('div', { class: 'l' }, glyph('target'), '答えを選ぶ'),
      h('div', { class: 'opts' }, ...(decision.options ?? []).map(option => h('button', { class: `opt${option.recommended ? ' rc' : ''}`, type: 'button', 'aria-label': `${option.label}${option.recommended ? '、推奨' : ''}`, dataset: { focusKey: `o:${option.id}` },
        on: { click: () => ask(decision, { optionId: option.id, label: option.label }) } }, glyph(option.recommended ? 'check' : 'arrow'), h('span', { text: option.label }), option.recommended && h('span', { class: 'tag', text: '推奨' })))),
      h('div', { class: 'l' }, glyph('pencil'), '選ばずに、指示を書いて返す'), writing, failure)
  }
  function ask(decision, choice) { answer = { id: decision.id, step: 'confirm', version: decision.version, key: uuid(), ...choice }; paint(); focusKey('confirm') }
  function cancel(refocus) { const was = answer; answer = null; paint(); if (refocus && was) focusKey(was.optionId ? `o:${was.optionId}` : 'send-text') }
  function focusKey(key) { [...walk(ui.root)].find(item => item.dataset?.focusKey === key)?.focus?.() }
  async function send(decision) {
    const mine = answer
    mine.step = 'sending'; mine.note = null; paint()
    const result = await call(`/api/approvals/${encodeURIComponent(decision.id)}/answer`, { method: 'POST', headers: { 'Idempotency-Key': mine.key }, json: { ...(mine.optionId ? { optionId: mine.optionId } : { text: mine.text }), version: mine.version } })
    if (!isOpen || answer !== mine) return
    const outcome = answerOutcome(result.status, result.body)
    if (outcome.kind === 'ok' && result.body?.id) { put(result.body); answer = null; draft = { id: null, text: '' }; notes.set(decision.id, { answer: deliveryNote(result.body) }); banner = null; void loadPending(); if (doneLoaded) void loadDone() }
    else if (outcome.kind === 'conflict') { put(outcome.decision); answer = null; banner = { id: decision.id, text: MESSAGES.amended(originOf(outcome.decision).who) } }
    else if (outcome.kind === 'gone') { selectedId = null; answer = null; void loadPending() }
    else { mine.step = 'confirm'; mine.note = outcome.message }
    paint()
  }
  async function toggleHold(decision) {
    const result = await call(`/api/approvals/${encodeURIComponent(decision.id)}/${decision.status === 'held' ? 'unhold' : 'hold'}`, { method: 'POST' })
    if (!isOpen) return
    if (result.status === 200 && result.body?.id) { put(result.body); notes.delete(decision.id); void loadPending() }
    else notes.set(decision.id, { hold: MESSAGES.holdFailed })
    paint()
  }

  // ---- 右：工程とのつながり
  function linkEl(decision) {
    const panel = decision ? linkPanel(decision) : null
    const head = h('div', { class: 'wp-h' }, h('h3', {}, glyph('link'), '工程とのつながり'),
      h('p', { text: panel?.kind === 'linked' ? (decision.status === 'answered' ? 'この決裁は、工程表の1つの工程でした。' : 'この決裁は、工程表の1つの工程になっています。答えると、その工程が済みになります。') : 'BellTeamの工程表とつながる決裁は、ここに前後の工程が出ます。' }))
    if (!panel) return [head]
    if (panel.kind === 'connecting') return [head, h('div', { class: 'approvals-cn is-muted' }, h('b', { text: panel.title }))]
    if (panel.kind === 'unlinked') return [head, h('div', { class: 'approvals-cn is-dashed' }, glyph('link'), h('div', {}, h('b', { text: panel.title }), h('p', { text: panel.lines[0] }))), ...panel.lines.slice(1).map(line => h('p', { class: 'approvals-line', text: line }))]
    const mini = (item, label) => {
      const state = stateInfo(item.state), openable = panel.projectId && item.cardId
      return h(openable ? 'button' : 'div', { class: `approvals-cn${openable ? ' is-link' : ''}`, type: openable ? 'button' : undefined, 'aria-label': openable ? `${item.title}、工程表で開く` : undefined,
        dataset: openable ? { focusKey: `n:${item.cardId}` } : undefined, on: openable ? { click: () => openChart(panel.projectId, item.cardId) } : undefined },
      h('b', { text: item.title }), h('small', {}, glyph(state.glyph), `${label} · ${state.badge}`))
    }
    return [head, h('div', { class: 'approvals-chain' },
      ...panel.previous.map(item => mini(item, '前の工程')),
      h('div', { class: 'approvals-cn is-self' }, glyph('inbox'), h('div', {}, h('b', { text: panel.task.title }), h('small', { text: decision.status === 'answered' ? '済み' : 'この決裁の工程' }))),
      ...panel.next.map(item => mini(item, '次の工程'))),
    h('p', { class: 'approvals-line', text: panel.sentence }),
    panel.ids && h('button', { class: 'lattice-btn pri', type: 'button', dataset: { focusKey: 'chart2' }, on: { click: () => openChart(panel.ids.projectId, panel.ids.cardId) } }, glyph('target'), '工程表の工程を開く'),
    panel.chart && h('p', { class: 'approvals-line muted', text: `工程表は「${panel.chart}」です。` })]
  }

  // Esc は、詳細が開いていれば詳細だけを閉じる（狭い画面）。確認が開いていれば確認だけ。
  dialog.addEventListener('cancel', event => {
    if (answer?.step === 'confirm') { event.preventDefault(); cancel(true) } else if (selectedId && dialog.querySelector('.approvals.has-selection') && globalThis.matchMedia?.('(max-width: 1023px)').matches) { event.preventDefault(); closeDetail() }
  })

  return {
    open(decisionId = null) {
      if (isOpen) { if (decisionId) select(decisionId); return }
      isOpen = true; connect = { phase: 'idle', server: null, note: '' }; drop = null; loaded = false; stale = false; attempt = 0; tab = 'pending'; origin = 'all'; selectedId = decisionId; answer = null; banner = null; pending = []; done = []; doneLoaded = false; doneNext = null
      build(); paint()
      if (!dialog.open) dialog.showModal()
      unsubscribe = feed.on(onFeed)
      if (feed.status === 'live') void loadPending(); else void feed.refresh() // 読めたら feed の status が知らせ、一覧を読む
      if (blocked() === 'noCredential') void enterConnect()
      if (decisionId) void loadOne(decisionId)
    },
    close() {
      if (!isOpen) return
      isOpen = false; unsubscribe?.(); unsubscribe = null
      pendingToken++; doneToken++; connectToken++; clear(retryTimer); clear(connectTimer); for (const id of timers) clear(id); timers.clear()
      for (const entry of [...avatars.values(), ...thumbs.values()]) if (entry.src) URL.revokeObjectURL(entry.src)
      avatars.clear(); thumbs.clear(); extra.clear(); notes.clear(); seen.clear(); body.replaceChildren(); pill.hidden = true; ui = null
    },
  }
}
