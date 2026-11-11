// 工程表の画面。データは GET /api/lattice/charts と /api/lattice/charts/:id/events、見た目と動きは docs/architecture/modules/lattice/screen-spec.md。
import { parseFrames } from './work-graph.js?v=__ASSET_VERSION__'
import { applyAvatar } from './view-format.js?v=__ASSET_VERSION__'
import {
  MESSAGES, SCHEMA, UNASSIGNED, accent, backoffMs, bannerFor, chartCounts, coordinatorBotId, degradedPills, detailOf, diffSnapshots, edgeChipText, edgeGeometry,
  flowPositions, highlightSets, layoutChart, layoutTree, chartName, listItems, listSignature, memberLookup, ownerLookup, particleOpacity, pointOnEdge, railItems, stateInfo, waitRows, cardLabel, cardNote, minutesSince, RED,
} from './lattice-chart-model.js?v=__ASSET_VERSION__'

const GLYPHS = {
  crown: '<path d="M3.6 8.6l4.4 3.6L12 5.2l4 7 4.4-3.6-1.7 9.6H5.3z" fill="currentColor" fill-opacity=".18"/><path d="M5.6 20.8h12.8"/>',
  hour: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4.6 3.2 5.8 4 8.5-.8 2.7-4 3.9-4 8.5M16 3.5c0 4.6-3.2 5.8-4 8.5.8 2.7 4 3.9 4 8.5"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10.2 8.6l5.2 3.4-5.2 3.4z" fill="currentColor"/>',
  dashed: '<circle cx="12" cy="12" r="9" stroke-dasharray="3.2 3.1"/>',
  progress: '<circle cx="12" cy="12" r="9" opacity=".3"/><path d="M12 3a9 9 0 0 1 9 9"/>',
  octagon: '<path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6z"/><path d="M12 7.8v5.2"/><circle cx="12" cy="16.3" r=".7" fill="currentColor"/>',
  seal: '<path d="M21.95 12.00 L21.79 12.64 L21.34 13.23 L20.73 13.74 L20.09 14.17 L19.57 14.57 L19.25 15.00 L19.17 15.53 L19.25 16.19 L19.40 16.94 L19.48 17.74 L19.38 18.47 L19.04 19.04 L18.47 19.38 L17.74 19.48 L16.94 19.40 L16.19 19.25 L15.53 19.17 L15.00 19.25 L14.57 19.57 L14.17 20.09 L13.74 20.73 L13.23 21.34 L12.64 21.79 L12.00 21.95 L11.36 21.79 L10.77 21.34 L10.26 20.73 L9.83 20.09 L9.43 19.57 L9.00 19.25 L8.47 19.17 L7.81 19.25 L7.06 19.40 L6.26 19.48 L5.53 19.38 L4.96 19.04 L4.62 18.47 L4.52 17.74 L4.60 16.94 L4.75 16.19 L4.83 15.53 L4.75 15.00 L4.43 14.57 L3.91 14.17 L3.27 13.74 L2.66 13.23 L2.21 12.64 L2.05 12.00 L2.21 11.36 L2.66 10.77 L3.27 10.26 L3.91 9.83 L4.43 9.43 L4.75 9.00 L4.83 8.47 L4.75 7.81 L4.60 7.06 L4.52 6.26 L4.62 5.53 L4.96 4.96 L5.53 4.62 L6.26 4.52 L7.06 4.60 L7.81 4.75 L8.47 4.83 L9.00 4.75 L9.43 4.43 L9.83 3.91 L10.26 3.27 L10.77 2.66 L11.36 2.21 L12.00 2.05 L12.64 2.21 L13.23 2.66 L13.74 3.27 L14.17 3.91 L14.57 4.43 L15.00 4.75 L15.53 4.83 L16.19 4.75 L16.94 4.60 L17.74 4.52 L18.47 4.62 L19.04 4.96 L19.38 5.53 L19.48 6.26 L19.40 7.06 L19.25 7.81 L19.17 8.47 L19.25 9.00 L19.57 9.43 L20.09 9.83 L20.73 10.26 L21.34 10.77 L21.79 11.36Z"/><path d="M8.2 12.3l2.7 2.8 4.9-5.5"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  chat: '<path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-4.5 4v-4H7a3 3 0 0 1-3-3z"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2"/>',
  chev: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
  tri: '<path d="M12 3.6l9.4 16.3H2.6z"/><path d="M12 10v4.6"/><circle cx="12" cy="17.3" r=".7" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.9" r=".7" fill="currentColor"/>',
  xmark: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  person: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.8 3.6-5.6 7-5.6s6.2 1.8 7 5.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.7-6M20 4.5v4.8h-4.8"/>',
  back: '<path d="M19 12H6M11 6.5L5.5 12l5.5 5.5"/>',
  bud: '<path d="M12 21v-6"/><path d="M12 15c-3.200 0-5-2.400-5-5.600C7 6.600 9 4 12 3c3 1 5 3.600 5 6.400 0 3.200-1.800 5.600-5 5.600z"/><path d="M12 18c-2.500 0-4-1-5-2.500"/>',
}
const SVG_NS = 'http://www.w3.org/2000/svg'
const UNKNOWN_COLOR = '#9A9DAE'
const LIST_POLL_MS = 10000

function glyph(name, extra = '') {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('class', `lattice-g ${extra}`.trim()); el.setAttribute('aria-hidden', 'true')
  el.innerHTML = GLYPHS[name] // 上の固定の定数だけ。画面のデータは入れない。
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
    else if (key === 'hidden') el.hidden = true
    else el.setAttribute(key, value === true ? '' : value)
  }
  append(el, children)
  return el
}
function fill(el, ...children) { el.replaceChildren(); append(el, children) }
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  append(el, children)
  return el
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')
const colorOf = member => member && member.known === false ? UNKNOWN_COLOR : accent(member?.color)
function* walk(el) { for (const child of el.children ?? []) { yield child; yield* walk(child) } }

// 接続を保ち続ける。開いている間は決してあきらめない（閉じる・404 の時だけ終わる）。
export function createChartStream({ fetch, url, setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout, random = Math.random, onSnapshot, onStatus }) {
  let abort = null, timer = null, silence = null, attempt = 0, running = false
  const schedule = () => { clear(timer); if (running) timer = later(connect, backoffMs(attempt++, random)) }
  const release = () => { clear(silence); const current = abort; abort = null; current?.abort() }
  function fail(kind) { release(); if (!running) return; onStatus(kind); schedule() }
  function end(kind) { release(); running = false; clear(timer); onStatus(kind) }
  async function lost(response) {
    try { const body = await response.json(); return (body?.error ?? body?.code) === 'LATTICE_CHART_NOT_FOUND' ? 'notfound' : 'missing' } catch { return 'missing' }
  }
  async function connect() {
    if (!running) return
    const controller = abort = new AbortController()
    const arm = () => { clear(silence); silence = later(() => { if (abort === controller) fail('drop') }, 35000) }
    try {
      arm()
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      if (abort !== controller) return
      if (response.status === 404) { const kind = await lost(response); if (abort === controller) end(kind); return }
      if (!response.ok) return fail('unreadable')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (abort !== controller) return
        if (done) return fail('drop')
        arm()
        const parsed = parseFrames(buffer + decoder.decode(value, { stream: true }))
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          if (frame.event !== 'snapshot') continue
          let data
          try { data = JSON.parse(frame.data); onSnapshot(data) } catch { return fail('unreadable') }
          attempt = 0; onStatus('live')
        }
      }
    } catch {
      if (abort !== controller || !running) return
      fail('drop')
    }
  }
  return {
    start() { if (running) return; running = true; attempt = 0; void connect() },
    stop() { running = false; clear(timer); release() },
  }
}

export function createLatticeChart(dialog, {
  api, fetchImage, openChat: openMemberChat = () => {}, getMember = () => null, mode: startMode = 'tree',
  setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout, random = Math.random, now = Date.now,
  requestFrame = callback => globalThis.requestAnimationFrame(callback), cancelFrame = id => globalThis.cancelAnimationFrame(id),
} = {}) {
  const body = dialog.querySelector('[data-lattice-body]')
  const pill = dialog.querySelector('[data-lattice-pill]')
  const reduceMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let isOpen = false, view = 'loading', status = 'connecting', list = null, listShown = '', listNote = null, listToken = 0, listAttempt = 0, listTimer = null
  let resumeId = null, places = new Map(), chartId = null, snapshot = null, ui = null, stream = null, highlight = null, detailId = null, frameId = 0, tickTimer = null, particles = []
  const cardEls = new Map(), treeEls = new Map(), entering = new Set(), avatars = new Map(), timers = new Set()
  let cameFrom = null // 工程表から一覧へ来た時の戻り先 {id, name}。
  let mode = startMode, treePlaces = new Map() // ツリー / 担当。ページが生きている間だけ覚える。
  const after = (fn, ms) => { const id = later(() => { timers.delete(id); fn() }, ms); timers.add(id); return id }
  const lookup = () => memberLookup(snapshot)
  // 会話を開くと工程表のダイアログは閉じる。戻って開き直したら、その工程表から続ける。
  const openChat = botId => { resumeId = chartId; return openMemberChat(botId) }

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
  function avatar(member, size = 24) {
    const unknown = member?.known === false && !member.authored
    const el = h('span', { class: `lattice-av${unknown ? ' unk' : ''}`, 'aria-hidden': 'true', style: { '--s': `${size}px`, '--c': colorOf(member) } })
    if (!member) el.append(glyph('person'))
    else el.textContent = unknown ? '?' : [...member.name][0] ?? ''
    const url = member?.known === false ? '' : member?.avatar || (member?.avatarVersion ? `/api/bots/${encodeURIComponent(member.botId)}/avatar?v=${encodeURIComponent(member.avatarVersion)}` : '')
    if (url) {
      const entry = avatarFor(url)
      if (entry.src) applyAvatar(el, { avatar: entry.src })
      else void entry.promise.then(src => { if (src) applyAvatar(el, { avatar: src }) })
    }
    return el
  }
  const withArc = (member, size) => h('span', { class: 'lattice-avw', style: { '--s': `${size}px`, '--c': colorOf(member) } },
    svg('svg', { class: 'lattice-arc', viewBox: '0 0 40 40', 'aria-hidden': 'true' }, svg('circle', { class: 'tr', cx: 20, cy: 20, r: 18 }), svg('circle', { cx: 20, cy: 20, r: 18, 'stroke-dasharray': '34 79.1' })),
    avatar(member, size))

  // 再描画しても、キーボードの位置を失わない。
  function keepFocus(container, rebuild) {
    const active = globalThis.document?.activeElement, key = active && container.contains?.(active) ? active.dataset?.focusKey : null
    rebuild()
    if (key) [...walk(container)].find(item => item.dataset?.focusKey === key)?.focus?.()
  }

  // ---- 状態の帯（接続・読み直し）。
  function paintPills() {
    const items = []
    if (status === 'drop' && view !== 'note') items.push({ text: MESSAGES.reconnect, spinner: true })
    else if (view === 'chart' && snapshot && status === 'live') for (const text of degradedPills(snapshot)) items.push({ text })
    pill.hidden = items.length === 0
    pill.replaceChildren(...items.map(item => h('span', { class: 'lattice-pill-item' }, item.spinner && h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), item.text)))
    if (ui) { ui.root.classList.toggle('is-stale', status === 'drop'); ui.live.hidden = status !== 'live' }
  }

  function show(view_, ...nodes) { view = view_; ui = null; body.replaceChildren(...nodes) }
  function note(text, action) {
    const buttons = action === 'list' ? [h('button', { class: 'lattice-btn', type: 'button', on: { click: goList } }, glyph('back'), '一覧へ戻る')]
      : action === 'close' ? [h('button', { class: 'lattice-btn', type: 'button', on: { click: () => dialog.close() } }, '閉じる')] : []
    return h('div', { class: 'lattice-empty', role: 'status' }, glyph('bud', 'lattice-bud'), h('p', { text }), ...buttons)
  }

  // ---- 一覧
  function paintList() {
    const items = listItems(list ?? { charts: [] }, getMember)
    const signature = `${listNote?.text ?? ''}|${listSignature(list ?? { charts: [] })}`
    if (view === 'list' && listShown === signature) return
    listShown = signature
    if (view === 'list') keepFocus(body, build); else build()
    function build() {
      if (listNote) return show('list', note(listNote.text, listNote.action))
      if (!items.length) return show('list', note(MESSAGES.listEmpty, 'close'))
      const back = cameFrom && (list?.charts ?? []).some(chart => chart.projectId === cameFrom.id)
      show('list', h('div', { class: 'lattice-list' },
        back && h('button', { class: 'lattice-back', type: 'button', dataset: { focusKey: 'back' }, 'aria-label': `${cameFrom.name}へ戻る`, on: { click: () => openChart(cameFrom.id) } }, glyph('back'), h('span', { text: cameFrom.name })),
        h('div', { class: 'lattice-grid' },
          ...items.map(item => h('button', { class: `lattice-cc${item.coordinator ? ' pin' : ''}`, type: 'button', 'aria-label': item.label, dataset: { focusKey: item.projectId }, on: { click: () => openChart(item.projectId) } },
            h('span', { class: 'nm' }, item.coordinator && glyph('crown', 'lattice-crown'), h('b', { text: item.name }), item.coordinator && h('span', { class: 'lattice-badge', text: '統括' })),
            ringEl(item.fraction, 40, `${item.done}/${item.total}`),
            h('span', { class: 'co' }, ...item.members.map(member => avatar(member, 22))),
            h('span', { class: `wt${item.waiting ? '' : ' z'}` }, glyph('hour'), item.waitingText),
            h('span', { class: 'upd', text: item.updated }))),
          h('div', { class: 'lattice-cc new' }, h('span', { class: 'pl' }, glyph('plus')), h('b', { text: '新しい工程表' }), h('p', { text: MESSAGES.newChart })))))
    }
  }
  const listWanted = () => view === 'loading' || view === 'list'
  async function loadList() {
    clear(listTimer)
    const token = ++listToken
    let data
    try { data = await api('/api/lattice/charts') } catch (error) {
      if (!isOpen || token !== listToken || !listWanted()) return
      if (error.status === 404) { status = 'live'; listNote = { text: MESSAGES.oldServer, action: 'close' }; view = 'list'; paintList(); listTimer = later(loadList, LIST_POLL_MS) }
      else { status = 'drop'; if (view === 'loading') show('loading', loading()); listTimer = later(loadList, backoffMs(listAttempt++, random)) }
      return paintPills()
    }
    if (!isOpen || token !== listToken || !listWanted()) return
    listAttempt = 0; status = 'live'; listNote = null; list = data
    const resume = view === 'loading' && data.charts?.find(chart => chart.projectId === resumeId)
    resumeId = null
    if (view === 'loading' && (resume || data.charts?.length === 1)) { paintPills(); return openChart((resume || data.charts[0]).projectId) }
    view = 'list'; paintList(); paintPills()
    listTimer = later(loadList, LIST_POLL_MS)
  }
  const loading = () => h('div', { class: 'lattice-loading', role: 'status' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), h('span', { class: 'sr-only', text: '読み込んでいます…' }))
  function ringEl(fraction, size, label) {
    const r = size === 30 ? 11 : 16, c = size / 2, len = 2 * Math.PI * r
    return h('span', { class: 'lattice-ring', style: { '--s': `${size}px` } },
      svg('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' }, svg('circle', { class: 'tr', cx: c, cy: c, r }), svg('circle', { class: 'fg', cx: c, cy: c, r, 'stroke-dasharray': `${(fraction * len).toFixed(2)} ${len.toFixed(2)}` })),
      label && h('span', { text: label }))
  }

  // ---- 工程表：骨組みを一度つくり、スナップショットごとに差し替える。
  function goList() {
    cameFrom = chartId && snapshot ? { id: chartId, name: chartName(snapshot, getMember) } : null
    stream?.stop(); stream = null; stopMotion(); clearChart()
    status = 'connecting'; listShown = ''; listNote = null
    if (list) { view = 'list'; paintList() } else show('loading', loading())
    paintPills(); void loadList()
  }
  function clearChart() { chartId = null; snapshot = null; highlight = null; detailId = null; cardEls.clear(); treeEls.clear(); entering.clear(); particles = []; ui = null }
  function openChart(id) {
    clear(listTimer); listToken++
    clearChart(); chartId = id; status = 'connecting'
    buildChart()
    stream = createChartStream({
      fetch: fetchImage, url: `/api/lattice/charts/${encodeURIComponent(id)}/events`, setTimeout: later, clearTimeout: clear, random,
      onSnapshot(data) {
        if (data?.schema !== SCHEMA) throw new Error('SCHEMA')
        const before = snapshot
        snapshot = data
        paintChart(diffSnapshots(before, data))
      },
      onStatus(kind) {
        if (!isOpen) return
        if (kind === 'live') status = 'live'
        else if (kind === 'notfound') { stopMotion(); show('note', note(MESSAGES.notFound, 'list')); status = 'live' }
        else if (kind === 'missing') { stopMotion(); show('note', note(MESSAGES.oldServer, 'close')); status = 'live' }
        else status = 'drop'
        paintPills(); if (status === 'drop') stopFrames(); else ensureFrames()
      },
    })
    stream.start()
  }
  function buildChart() {
    const sheet = h('section', { class: 'lattice-sheet', role: 'dialog', 'aria-label': '工程の詳細', hidden: true })
    const edgesSvg = svg('svg', { class: 'lattice-edges', 'aria-hidden': 'true' }), defs = svg('defs'), edgeLayer = svg('g'), flowLayer = svg('g')
    edgesSvg.append(defs, edgeLayer, flowLayer)
    const lanes = h('div', { class: 'lattice-lanes' }), cards = h('div', { class: 'lattice-cards' }), chips = h('div', { class: 'lattice-chips' })
    const plane = h('div', { class: 'lattice-plane' }, lanes, edgesSvg, cards, chips)
    const treeSvg = svg('svg', { class: 'lattice-tree-svg', 'aria-hidden': 'true' }), treeLinks = svg('g', { class: 'links' }), treeArcs = svg('g', { class: 'arcs' })
    treeSvg.append(svg('defs', {}, ...['arrow', 'arrow-wait'].map(id => svg('marker', { id: `lattice-${id}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      svg('path', { d: 'M0 0L8 4L0 8z', class: id })))), treeLinks, treeArcs)
    const treeBoxes = h('div', { class: 'lattice-tree-boxes' }), tree = h('div', { class: 'lattice-tree' }, treeSvg, treeBoxes)
    const canvas = h('div', { class: 'lattice-canvas', on: { click: event => { if (highlight && !event.target.closest?.('.lattice-card, .lattice-tbox')) { highlight = null; applyHighlight(); paintRail() } } } }, plane, tree)
    const modeBtn = (value, label) => h('button', { type: 'button', 'aria-pressed': String(mode === value), dataset: { mode: value, focusKey: `mode:${value}` }, on: { click: () => setMode(value) } }, label)
    const modes = h('div', { class: 'lattice-seg', role: 'group', 'aria-label': '表示' }, modeBtn('tree', 'ツリー'), modeBtn('lanes', '担当'))
    const switcher = h('button', { class: 'lattice-switcher', type: 'button', on: { click: goList } })
    const live = h('span', { class: 'lattice-live', hidden: true }, h('i', { class: 'ldot' }), 'ライブ')
    const summary = h('div', { class: 'lattice-sum' }), counters = h('div', { class: 'lattice-cnt' })
    const banner = h('div', { class: 'lattice-banner-slot' }), rail = h('nav', { class: 'lattice-rail', 'aria-label': 'メンバー' }), waits = h('aside', { class: 'lattice-waits', 'aria-label': '待ちの流れ' })
    const main = h('div', { class: 'lattice-main' }, rail, canvas, waits)
    const empty = h('div', { class: 'lattice-empty-slot', hidden: true })
    const loadingEl = loading()
    const root = h('div', { class: 'lattice-chart', hidden: true }, h('div', { class: 'lattice-toolbar' }, switcher, live, modes, h('span', { class: 'lattice-spacer' }), summary, counters), banner, main, empty, sheet)
    body.replaceChildren(loadingEl, root)
    view = 'chart'
    ui = { root, switcher, live, modes, tree, treeSvg, treeLinks, treeArcs, treeBoxes, summary, counters, banner, rail, canvas, plane, lanes, cards, chips, edgesSvg, defs, edgeLayer, flowLayer, waits, main, empty, sheet, loading: loadingEl }
  }

  function paintChart(diff) {
    if (!ui) return
    ui.root.hidden = false; ui.loading.hidden = true
    const counts = chartCounts(snapshot), unavailable = snapshot.state === 'unavailable', blank = !unavailable && !snapshot.cards?.length
    paintToolbar(counts)
    const banner = bannerFor(snapshot)
    ui.root.classList.toggle('is-dim', Boolean(banner?.dim))
    fill(ui.banner, banner && bannerEl(banner))
    ui.main.hidden = unavailable || blank
    ui.empty.hidden = !(unavailable || blank)
    if (unavailable || blank) { fill(ui.empty, note(unavailable ? MESSAGES.unavailable : MESSAGES.noCards, 'list')); detailId = null; stopFrames() }
    else {
      const layout = layoutChart(snapshot)
      ui.plane.hidden = mode !== 'lanes'; ui.tree.hidden = mode !== 'tree'
      for (const button of ui.modes.children) button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
      if (mode === 'tree') { paintTree(); particles = [] } else paintPlane(layout, diff)
      paintRail(layout)
      paintWaits()
    }
    paintDetail()
    applyHighlight()
    paintPills()
    ensureFrames(); ensureTick()
  }

  function setMode(value) {
    if (value === mode || !snapshot) return
    mode = value
    paintChart({ ...diffSnapshots(snapshot, snapshot), first: true })
  }

  // ツリー：箱は小さく（状態の記号・一行の題名・担当の顔）、タップで詳細。依存は右の弧、待っている弧は色付きで矢印が待つ側へ。
  function paintTree() {
    const tree = layoutTree(snapshot, chartName(snapshot, getMember)), owners = ownerLookup(snapshot)
    treePlaces = tree.cards
    for (const el of [ui.tree, ui.treeBoxes]) { el.style.width = `${tree.width}px`; el.style.height = `${tree.height}px` }
    ui.treeSvg.setAttribute('width', tree.width); ui.treeSvg.setAttribute('height', tree.height)
    ui.treeLinks.replaceChildren(...tree.links.map(link => svg('path', { d: link.d, class: 'tl' })))
    ui.treeArcs.replaceChildren(...tree.arcs.map(arc => svg('path', { d: arc.d, class: `ta${arc.waiting ? ' waiting' : ''}`, 'data-edge': arc.key, 'marker-end': `url(#lattice-${arc.waiting ? 'arrow-wait' : 'arrow'})` })))
    const at = node => ({ transform: `translate(${node.x}px, ${node.y}px)`, width: `${node.w}px`, height: `${node.h}px` })
    treeEls.clear()
    keepFocus(ui.treeBoxes, () => fill(ui.treeBoxes, ...tree.nodes.map(node => {
      if (node.kind !== 'card') {
        const info = stateInfo(node.tone)
        return h('div', { class: `lattice-tnode ${node.kind} is-${info.tone}`, style: at(node), role: 'group', 'aria-label': `${node.label}、完了 ${node.done}/${node.total}` },
          node.kind === 'root' ? ringEl(node.total ? node.done / node.total : 0, 18) : glyph(info.glyph), h('b', { text: node.label }), h('small', { text: `${node.done}/${node.total}` }))
      }
      const card = node.card, owner = owners(card), info = stateInfo(card.state)
      const el = h('button', { class: `lattice-tbox is-${info.tone}${detailId === card.id ? ' sel' : ''}`, type: 'button', style: { ...at(node), '--a': owner?.known === false ? UNKNOWN_COLOR : accent(owner?.color) },
        dataset: { cardId: card.id, focusKey: `t:${card.id}` }, 'aria-label': cardLabel(card, owner), title: card.title, on: { click: () => openDetail(card.id, treeEls.get(card.id)) } },
      glyph(info.glyph), h('span', { class: 'ti', text: card.title }), owner ? avatar(owner, 18) : h('span', { class: 'na', text: UNASSIGNED }))
      treeEls.set(card.id, el)
      return el
    })))
  }

  function paintToolbar(counts) {
    const members = lookup(), coordinatorId = coordinatorBotId(list), coordinator = snapshot.coordinator && coordinatorId ? members(coordinatorId) : null
    const name = chartName(snapshot, getMember)
    ui.switcher.setAttribute('aria-label', `${name}、工程表の一覧へ`)
    fill(ui.switcher, snapshot.coordinator && glyph('crown', 'lattice-crown'), h('b', { text: name }),
      snapshot.coordinator && h('span', { class: 'lattice-coord' }, h('span', { class: 'lattice-badge', text: '統括' }), coordinator?.known && [avatar(coordinator, 16), h('strong', { text: coordinator.name })]), glyph('chev'))
    const fraction = counts.total ? counts.done / counts.total : 0
    fill(ui.summary, ringEl(fraction, 30), h('span', { class: 't' }, `${counts.done}/${counts.total}`, h('small', { text: '完了' })))
    const count = (label, n, color) => h('span', {}, h('i', { style: { background: color } }), `${label} `, h('b', { text: String(n) }))
    fill(ui.counters, count('作業中', counts.working, accent('violet')), count('待ち', counts.waiting, '#B3B6C6'), count('止まり', counts.blocked, RED))
  }
  function bannerEl(banner) {
    const coordinatorId = coordinatorBotId(list)
    return h('div', { class: `lattice-banner ${banner.tone}`, role: 'status' }, glyph(banner.glyph), h('span', { text: banner.text }),
      banner.talk && coordinatorId && h('button', { class: 'bt', type: 'button', on: { click: () => openChat(coordinatorId) } }, glyph('chat'), '統括と話す'))
  }

  // カードは id で持ち続け、位置は transform で動かす（同じ列・レーンの札は動かない）。
  function paintPlane(layout, diff) {
    const owners = ownerLookup(snapshot), at = now(), animate = !diff.first && !reduceMotion()
    places = layout.cards
    ui.plane.style.width = `${layout.width}px`; ui.plane.style.height = `${layout.height}px`
    for (const el of [ui.edgesSvg]) { el.setAttribute('width', layout.width); el.setAttribute('height', layout.height) }
    ui.lanes.replaceChildren(...layout.lanes.map((lane, i) => h('div', { class: `lattice-lane${i % 2 ? ' alt' : ''}`, style: { top: `${lane.y}px`, height: `${lane.h}px` } },
      h('div', { class: 'lattice-lane-label' }, avatar(lane.member, 30), h('b', {}, lane.botId && lane.botId === coordinatorBotId(list) && glyph('crown', 'lattice-crown'), lane.member ? lane.member.name : UNASSIGNED)))))
    const cards = new Map(snapshot.cards.map(card => [card.id, card]))
    for (const [id, el] of cardEls) if (!cards.has(id)) { cardEls.delete(id); entering.delete(id); if (animate) { el.classList.add('is-leaving'); after(() => el.remove(), 300) } else el.remove() }
    for (const id of layout.order) {
      const card = cards.get(id), place = layout.cards.get(id), member = owners(card), info = stateInfo(card.state)
      let el = cardEls.get(id)
      if (!el) {
        el = h('button', { class: 'lattice-card', type: 'button', dataset: { cardId: id }, on: { click: () => openDetail(id, cardEls.get(id)) } })
        cardEls.set(id, el)
        if (animate) { entering.add(id); after(() => { entering.delete(id); el.classList.remove('is-entering') }, 320) }
      }
      const elapsed = card.state === 'in-progress' ? minutesSince(card.startedAt, at) : null
      const signature = [card.state, card.title, cardNote(card, member), member?.botId, member?.name, member?.avatarVersion, elapsed].join('\n')
      if (el.dataset.signature !== signature) {
        el.dataset.signature = signature
        const mark = member ? (card.state === 'in-progress' ? withArc(member, 22) : avatar(member, 22)) : null
        fill(el, ...(info.tone === 'done' || info.tone === 'retired'
          ? [glyph(info.glyph), h('span', { class: 'ti', text: card.title }), mark]
          : [h('div', { class: 'top' }, glyph(info.glyph), h('b', { text: info.badge }), elapsed !== null && h('span', { class: 'el', text: elapsed < 1 ? '1分未満' : `${elapsed}分` }), h('span', { class: 'pa' }, mark)),
            h('div', { class: 'ti', text: card.title }), h('div', { class: `en${card.state === 'blocked' ? ' rs' : ''}`, text: cardNote(card, member) })]))
        el.setAttribute('aria-label', cardLabel(card, member))
        if (animate && diff.completedCards.includes(id)) {
          el.append(h('span', { class: 'lattice-bloom', 'aria-hidden': 'true' }, ...[0, 1, 2, 3, 4].map(i => h('i', { style: { '--i': String(i) } }))))
          after(() => { for (const child of [...(el.children ?? [])]) if (child.className === 'lattice-bloom') child.remove() }, 700)
        }
      }
      const color = member?.known === false ? UNKNOWN_COLOR : accent(member?.color)
      el.className = `lattice-card is-${info.tone}${entering.has(id) ? ' is-entering' : ''}${detailId === id ? ' sel' : ''}`
      el.style.setProperty('--a', color); el.style.setProperty('--ar', rgb(color))
      el.style.width = `${place.w}px`; el.style.height = `${place.h}px`; el.style.transform = `translate(${place.x}px, ${place.y}px)`
    }
    // 読む順に並べ替える（立っている札を動かすのは並びが変わった時だけ）。
    const wanted = layout.order.map(id => cardEls.get(id)), current = [...(ui.cards.children ?? [])].filter(el => !el.classList.contains('is-leaving'))
    if (current.length !== wanted.length || current.some((el, i) => el !== wanted[i])) {
      const active = globalThis.document?.activeElement
      ui.cards.append(...wanted)
      if (active && wanted.includes(active)) active.focus?.()
    }
    paintEdges(layout, diff, owners)
  }

  // 辺：満たされた辺は細く淡く、待っている辺は太い勾配。待っている辺には粒を流し、「◯◯が待っています」の札を付ける。
  function paintEdges(layout, diff, owners) {
    const cards = new Map(snapshot.cards.map(card => [card.id, card]))
    ui.defs.replaceChildren(); ui.edgeLayer.replaceChildren(); ui.flowLayer.replaceChildren(); ui.chips.replaceChildren(); particles = []
    const edges = snapshot.edges ?? []
    edges.forEach((edge, i) => {
      const from = layout.cards.get(edge.from), to = layout.cards.get(edge.to)
      if (!from || !to) return
      const key = `${edge.from}>${edge.to}`, geometry = edgeGeometry(from, to)
      const fresh = !diff.first && !reduceMotion() && diff.addedEdges.includes(key)
      if (!edge.waiting) { ui.edgeLayer.append(svg('path', { d: geometry.d, class: `lattice-edge${fresh ? ' is-new' : ''}`, 'data-edge': key })); return }
      const start = colorOf(owners(cards.get(edge.from))), end = colorOf(owners(cards.get(edge.to)))
      ui.defs.append(svg('linearGradient', { id: `lattice-grad-${i}`, gradientUnits: 'userSpaceOnUse', x1: geometry.p0.x, y1: geometry.p0.y, x2: geometry.p3.x, y2: geometry.p3.y },
        svg('stop', { offset: 0, 'stop-color': start }), svg('stop', { offset: 1, 'stop-color': end })))
      ui.edgeLayer.append(svg('path', { d: geometry.d, class: `lattice-edge waiting${fresh ? ' is-new' : ''}`, style: `stroke: url(#lattice-grad-${i})`, 'data-edge': key }))
      const mid = pointOnEdge(geometry, 0.5), waiter = owners(cards.get(edge.to))
      ui.chips.append(h('div', { class: 'lattice-chip', dataset: { edge: key }, style: { transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)` } }, avatar(waiter, 18), edgeChipText(snapshot, edge)))
      const circles = [0, 1, 2].map(() => svg('circle', { r: 3.5, fill: end, opacity: 0, style: `filter: drop-shadow(0 0 4px ${end})` }))
      ui.flowLayer.append(...circles)
      particles.push({ geometry, circles, key })
    })
  }

  // ---- 左のレール：担当ごとの顔。タップで強調。
  function paintRail(layout = layoutChart(snapshot)) {
    if (!ui || !snapshot) return
    keepFocus(ui.rail, () => fill(ui.rail, ...railItems(snapshot, layout).map(item => {
      const name = item.member.name
      return h('button', { class: `lattice-ri${item.working ? ' is-working' : ''}${item.blocked ? ' is-blk' : ''}`, type: 'button', 'aria-pressed': String(highlight === item.botId), dataset: { focusKey: item.botId },
        'aria-label': `${name}${item.working ? '、作業中' : ''}${item.blocked ? '、止まりあり' : ''}${item.waiting ? `、待ち ${item.waiting}` : ''}`,
        on: { click: () => { highlight = highlight === item.botId ? null : item.botId; applyHighlight(); paintRail(layout) } } },
      item.working ? withArc(item.member, 36) : avatar(item.member, 36),
      item.blocked && h('span', { class: 'rdot' }, glyph('octagon')),
      item.waiting > 0 && h('span', { class: 'rhg' }, glyph('hour'), String(item.waiting)))
    })))
  }

  // ---- 待ちの流れ
  function paintWaits() {
    const rows = waitRows(snapshot, now())
    keepFocus(ui.waits, () => fill(ui.waits, 
      h('div', { class: 'wp-h' }, h('h3', {}, glyph('hour'), '待ちの流れ', h('span', { class: 'n', text: String(rows.length) })), h('p', { text: '誰が何を待っていて、誰がつくっているか' })),
      rows.length ? h('ul', { class: 'wp-l' }, ...rows.map(row => h('li', { class: `wr${row.emphasized ? ' em' : ''}`, role: 'group', 'aria-label': row.label, dataset: { wait: row.key } },
        h('div', { class: 'l1' }, avatar(row.waiter, 20), h('span', { text: row.headline }), h('span', { class: 'w', text: `待ち ${row.length}` })),
        h('div', { class: 'ow', text: row.ownerText }),
        h('div', { class: 'mk', text: 'この工程が終わるのを待っています' }),
        h('div', { class: 'l2' }, glyph(row.info.glyph), h('b', { text: row.title })),
        h('div', { class: 'l3' }, h('span', { class: 'mk2', text: 'つくっている' }), avatar(row.producer, 18), h('b', { text: row.producer ? row.producer.name : UNASSIGNED }),
          h('span', { class: `stp tone-${row.info.tone}` }, glyph(row.info.glyph), row.state)),
        h('div', { class: 'l4' },
          row.canChat && h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: `${row.key}:chat` }, on: { click: () => openChat(row.producer.botId) } }, glyph('chat'), '会話を開く'),
          h('button', { class: 'lattice-btn pri', type: 'button', dataset: { focusKey: `${row.key}:go` }, on: { click: () => goTo(row.forCard) } }, glyph('target'), '工程へ移動')))))
        : h('p', { class: 'wp-none', text: 'いま待っている工程はありません。' })))
  }

  // ---- 詳細
  function openDetail(id, source) {
    const from = source?.getBoundingClientRect?.()
    detailId = id; paintDetail(from); applyCardSelection(); focusClose()
  }
  const focusClose = () => [...walk(ui.sheet)].find(item => item.dataset && 'close' in item.dataset)?.focus?.()
  function closeDetail() {
    const id = detailId
    detailId = null; paintDetail(); applyCardSelection()
    const els = mode === 'tree' ? treeEls : cardEls
    els.get(id)?.focus?.()
  }
  function applyCardSelection() { for (const [id, el] of [...cardEls, ...treeEls]) el.classList.toggle('sel', id === detailId) }
  function paintDetail(from) {
    if (!ui) return
    const detail = detailId && snapshot ? detailOf(snapshot, detailId, now()) : null
    if (detailId && !detail) detailId = null
    ui.sheet.hidden = !detail
    if (!detail) { ui.sheet.replaceChildren(); return }
    const link = item => h('button', { class: 'lattice-mini', type: 'button', dataset: { focusKey: `d:${item.id}` }, 'aria-label': `${item.title}、${stateInfo(item.state).badge}`, on: { click: () => goTo(item.id, true) } },
      avatar(item.producer, 18), h('span', { class: 'ti', text: item.title }), h('span', { class: `st tone-${stateInfo(item.state).tone}` }, glyph(stateInfo(item.state).glyph), item.stateText))
    const parts = [detail.producer?.name, detail.stateText].filter(Boolean)
    if (!detail.producer && detail.stateText !== UNASSIGNED) parts.push(UNASSIGNED)
    keepFocus(ui.sheet, () => fill(ui.sheet,
      h('div', { class: 'h' }, h('span', { class: `big tone-${detail.info.tone}` }, glyph(detail.info.glyph)),
        h('div', { class: 'hd' }, h('h3', { text: detail.card.title }), h('div', { class: 'sub' }, avatar(detail.producer, 15), h('span', { text: parts.join(' · ') }))),
        h('button', { class: 'x', type: 'button', 'aria-label': '詳細を閉じる', dataset: { close: '', focusKey: 'close' }, on: { click: closeDetail } }, glyph('xmark'))),
      detail.card.designMemo && h('div', { class: 'sc' }, h('div', { class: 'l', text: '設計メモ' }), h('p', { class: 'memo', text: detail.card.designMemo })),
      detail.card.doneCondition && h('div', { class: 'sc' }, h('div', { class: 'l', text: '終了条件' }), h('div', { class: 'endc' }, glyph('check'), h('span', { text: detail.card.doneCondition }))),
      detail.previous.length > 0 && h('div', { class: 'sc' }, h('div', { class: 'l', text: `前の工程 · ${detail.previous.length}` }), ...detail.previous.map(link)),
      detail.next.length > 0 && h('div', { class: 'sc' }, h('div', { class: 'l', text: `次の工程 · ${detail.next.length}` }), ...detail.next.map(link)),
      h('div', { class: 'ft', text: detail.startedText })))
    if (from && !reduceMotion() && ui.sheet.getBoundingClientRect) morph(from)
  }
  // カードが詳細の面に広がる動き（FLIP）。
  function morph(from) {
    const to = ui.sheet.getBoundingClientRect()
    if (!to.width || !to.height) return
    ui.sheet.style.transition = 'none'; ui.sheet.style.transformOrigin = 'top left'; ui.sheet.style.opacity = '0.2'
    ui.sheet.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`
    requestFrame(() => { ui.sheet.style.transition = ''; ui.sheet.style.transform = ''; ui.sheet.style.opacity = '' })
  }
  // 札へ運ぶ：中央へ寄せて詳細を開く。
  function goTo(id, keepSheet = false) {
    const el = (mode === 'tree' ? treeEls : cardEls).get(id)
    if (!el) return
    const canvas = ui.canvas, place = (mode === 'tree' ? treePlaces : places).get(id)
    if (place) canvas.scrollTo?.({ left: Math.max(0, place.x - ((canvas.clientWidth ?? 0) - place.w) / 2), top: Math.max(0, place.y - ((canvas.clientHeight ?? 0) - place.h) / 2), behavior: reduceMotion() ? 'auto' : 'smooth' })
    detailId = id; paintDetail(keepSheet ? undefined : el.getBoundingClientRect?.()); applyCardSelection()
    if (keepSheet) focusClose()
  }

  // ---- 強調：選んだ担当の札と待ちだけ残し、ほかは薄く。
  function applyHighlight() {
    if (!ui || !snapshot) return
    const sets = highlightSets(snapshot, highlight)
    for (const [id, el] of [...cardEls, ...treeEls]) el.classList.toggle('dim', Boolean(sets) && !sets.cards.has(id))
    for (const row of ui.waits.querySelectorAll?.('[data-wait]') ?? []) row.classList.toggle('dim', Boolean(sets) && !sets.waits.has(row.dataset.wait))
    const lit = key => !sets || sets.cards.has(key.split('>')[0]) || sets.cards.has(key.split('>')[1])
    for (const item of [...(ui.edgeLayer.children ?? []), ...(ui.chips.children ?? []), ...(ui.treeArcs.children ?? [])]) { const key = item.getAttribute?.('data-edge') ?? item.dataset?.edge; if (key) item.classList.toggle('dim', !lit(key)) }
  }

  // ---- 動き：待ちの辺の粒（requestAnimationFrame）、30 秒ごとの分の更新。動きを減らす設定では粒も回転も無し。
  function frame() {
    frameId = 0
    if (!isOpen || !particles.length || status !== 'live') return
    const t = now()
    const positions = flowPositions(t)
    for (const item of particles) {
      item.circles.forEach((circle, i) => {
        const progress = positions[i]
        if (progress === undefined) return circle.setAttribute('opacity', 0)
        const point = pointOnEdge(item.geometry, progress)
        circle.setAttribute('cx', point.x.toFixed(1)); circle.setAttribute('cy', point.y.toFixed(1)); circle.setAttribute('opacity', particleOpacity(progress).toFixed(2))
      })
    }
    frameId = requestFrame(frame)
  }
  function ensureFrames() { if (!frameId && isOpen && view === 'chart' && particles.length && status === 'live' && !reduceMotion() && !globalThis.document?.hidden) frameId = requestFrame(frame) }
  function stopFrames() { if (frameId) cancelFrame(frameId); frameId = 0 }
  function ensureTick() {
    if (tickTimer || !isOpen) return
    tickTimer = later(() => { tickTimer = null; if (view === 'chart' && snapshot) paintChart({ ...diffSnapshots(snapshot, snapshot), first: false }); }, 30000)
  }
  function stopMotion() { stopFrames(); clear(tickTimer); tickTimer = null; for (const id of timers) clear(id); timers.clear() }

  const visibility = () => {
    if (!isOpen) return
    if (globalThis.document.hidden) { stream?.stop(); clear(listTimer); stopFrames() }
    else if (view === 'chart') { stream?.start(); ensureFrames() } else if (view === 'list' || view === 'loading') void loadList()
  }
  // Esc は、詳細が開いていれば詳細だけを閉じる。
  dialog.addEventListener('cancel', event => {
    if (detailId) { event.preventDefault(); closeDetail() } else if (view === 'list' && cameFrom) { event.preventDefault(); openChart(cameFrom.id) }
  })

  return {
    open() {
      if (isOpen) return
      isOpen = true; cameFrom = null; view = 'loading'; status = 'connecting'; list = null; listShown = ''; listNote = null; listAttempt = 0
      clearChart(); show('loading', loading()); pill.hidden = true
      document.addEventListener('visibilitychange', visibility)
      if (!dialog.open) dialog.showModal()
      void loadList()
    },
    close() {
      if (!isOpen) return
      isOpen = false
      stream?.stop(); stream = null; listToken++; clear(listTimer); stopMotion(); clearChart()
      document.removeEventListener('visibilitychange', visibility)
      for (const entry of avatars.values()) if (entry.src) URL.revokeObjectURL(entry.src)
      avatars.clear(); body.replaceChildren(); pill.hidden = true
    },
  }
}
