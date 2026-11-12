// 止め一覧の画面。データは GET /api/lattice/blockers と POST /api/lattice/charts/:projectId/unblock、見た目と動きは screen-spec.md の「止め一覧」。
import { UNASSIGNED, backoffMs, chartName as defaultChartName, formatJst, memberLookup } from './lattice-chart-model.js?v=__ASSET_VERSION__'

export const BLOCKERS_SCHEMA = 'bellteam.lattice-blockers.v1'
export const STOPS_MESSAGES = {
  loading: '止めを読んでいます…',
  empty: '止まっている工程はありません。',
  retry: '止め一覧を読み直しています…',
  old: 'このサーバーではまだ止め一覧を使えません。',
  unread: '一部の工程表を読めませんでした。読めた分だけ表示しています。',
  ask: 'この止めを外しますか？',
  later: 'いまは外せませんでした。少し待ってからもう一度お試しください。',
  refused: reason => reason ? `外せませんでした: ${reason}` : '外せませんでした',
}

const DAY = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
const TIME = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
// 今日 HH:MM / 昨日 HH:MM / M月D日 HH:MM（JST）。読めない時刻は空。
export function stopTime(value, now) {
  if (!value || Number.isNaN(Date.parse(value))) return ''
  const day = DAY.format(new Date(value))
  if (day === DAY.format(now)) return `今日 ${TIME.format(new Date(value))}`
  return day === DAY.format(now - 86400000) ? `昨日 ${TIME.format(new Date(value))}` : formatJst(value)
}

// 担当・止めた人：Bot id -> 名簿の顔（名簿に無ければ名簿にないメンバー）、"owner" -> 指揮官、それ以外の文字はそのまま、null -> 担当なし（null）。
const BOT_ID = /^bot-[0-9a-z]+$/u
function faceLookup(getMember, getOwner) {
  const known = memberLookup({ members: [], owner: getOwner() })
  return value => {
    if (!value) return null
    if (value === 'owner') return known('owner')
    return getMember(value) ?? (BOT_ID.test(value) ? known(value) : { botId: null, name: value, color: 'unknown', avatarVersion: '', known: false, authored: true })
  }
}

export function stopRows(blockers, { now = Date.now(), getMember = () => null, getOwner = () => null, chartName = defaultChartName } = {}) {
  const face = faceLookup(getMember, getOwner), at = value => Number.isNaN(Date.parse(value)) ? -Infinity : Date.parse(value)
  return (blockers ?? []).filter(item => typeof item?.stopId === 'string' && typeof item.projectId === 'string')
    .toSorted((a, b) => at(b.blockedAt) - at(a.blockedAt))
    .map(item => {
      const title = item.title ?? '', chart = chartName({ name: item.chartName, createdBy: item.chartCreatedBy }, getMember), reason = item.reason ?? ''
      const lane = face(item.lane), by = face(item.blockedBy), time = stopTime(item.blockedAt, now), byName = by ? by.name : UNASSIGNED
      return {
        stopId: item.stopId, projectId: item.projectId, cardId: item.cardId, title, chart, lane, reason, by, time,
        label: `止まり、${title}、${chart}、${lane ? `担当 ${lane.name}` : UNASSIGNED}${reason ? `、理由 ${reason}` : ''}、${byName}が${time ? `${time}に` : ''}止めました`,
      }
    })
}

// 外すの答え：drop（外れた / もう無い）、refused（Lattice が断った。reason はその文）、later（それ以外すべて）。
export function unblockOutcome(status, body) {
  if (status === 200 && (body?.outcome === 'removed' || body?.outcome === 'already-gone')) return { kind: 'drop' }
  if (status === 409) return { kind: 'refused', reason: typeof body?.reason === 'string' ? body.reason : '' }
  return { kind: 'later' }
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  return el
}
function* walk(el) { for (const child of el.children ?? []) { yield child; yield* walk(child) } }
const initialFace = member => h('span', { class: 'lattice-av', 'aria-hidden': 'true', text: member ? [...member.name][0] ?? '' : '' })

// 開いている間だけ生きる。読むのは開いた時・読み直す・外すの答えのあと・前面に戻った時だけ（読める間はタイマーで読まない）。
// 読めない時（503・通信・壊れたJSON）だけ 1, 2, 4 … 30 秒で読み直し続ける。
export function createStopsView(host, {
  api, getMember = () => null, getOwner = () => null, chartName = defaultChartName, openCard = () => {}, back = () => {}, glyph = () => h('i'), avatar = initialFace,
  now = Date.now, setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout, random = Math.random,
} = {}) {
  let isOpen = false, phase = 'loading', blockers = [], unread = false, token = 0, attempt = 0, timer = null, confirmId = null
  const removing = new Set(), notes = new Map(), rowEls = new Map()

  function paint(focusKey) {
    const active = globalThis.document?.activeElement, key = focusKey ?? (active && host.contains?.(active) ? active.dataset?.focusKey : null)
    const rows = stopRows(blockers, { now: now(), getMember, getOwner, chartName })
    rowEls.clear()
    const stale = phase === 'retry' ? ' is-stale' : ''
    const head = h('div', { class: 'lattice-stops-head' },
      h('button', { class: 'lattice-back', type: 'button', 'aria-label': 'すべての工程表へ戻る', dataset: { focusKey: 'back' }, on: { click: () => back() } }, glyph('back'), h('span', { text: 'すべての工程表' })),
      h('h3', { text: '止め一覧' }),
      h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: 'reload' }, on: { click: () => void read() } }, glyph('refresh'), '読み直す'))
    let content
    if (phase === 'loading') content = h('div', { class: 'lattice-loading', role: 'status' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), h('span', { class: 'lattice-stops-wait', text: STOPS_MESSAGES.loading }))
    else if (phase === 'old') content = h('p', { class: 'lattice-stops-none', role: 'status', text: STOPS_MESSAGES.old })
    else if (!rows.length && phase === 'ready') content = h('p', { class: 'lattice-stops-none', role: 'status', text: STOPS_MESSAGES.empty })
    else content = h('ul', { class: `lattice-stops-list${stale}` }, ...rows.map(row => rowEl(row)))
    const root = h('div', { class: 'lattice-stops' }, head,
      phase === 'ready' && unread && h('p', { class: 'lattice-stops-unread', role: 'status', text: STOPS_MESSAGES.unread }),
      phase === 'retry' && h('p', { class: 'lattice-stops-pill', role: 'status' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), STOPS_MESSAGES.retry),
      content)
    host.replaceChildren(root)
    if (key) [...walk(host)].find(item => item.dataset?.focusKey === key)?.focus?.()
  }

  function rowEl(row) {
    const id = row.stopId, busy = removing.has(id), asking = confirmId === id && !busy, note = notes.get(id)
    const mark = fn => event => { event.handledByStops = true; fn() } // 外す の外を触ったら確認を閉じる（host の click）ので、行の中の操作は印を付ける。
    const person = member => member ? [avatar(member, 18), h('span', { text: member.name })] : [h('span', { text: UNASSIGNED })]
    const act = busy ? [h('button', { class: 'lattice-btn pri', type: 'button', disabled: true, 'aria-busy': 'true' }, h('i', { class: 'lattice-spinner', 'aria-hidden': 'true' }), '外す')]
      : asking ? [h('span', { class: 'ask', text: STOPS_MESSAGES.ask }),
        h('button', { class: 'lattice-btn pri', type: 'button', dataset: { focusKey: `confirm:${id}` }, on: { click: mark(() => void remove(row)) } }, '外す'),
        h('button', { class: 'lattice-btn', type: 'button', dataset: { focusKey: `cancel:${id}` }, on: { click: mark(() => cancel(true)) } }, 'やめる')]
        : [h('button', { class: 'lattice-btn', type: 'button', 'aria-label': `外す、${row.title}`, dataset: { focusKey: `ask:${id}` }, on: { click: mark(() => { confirmId = id; paint(`confirm:${id}`) }) } }, '外す')]
    const el = h('li', { class: 'lattice-stop', role: 'group', 'aria-label': row.label, dataset: { stopId: id } },
      h('button', { class: 'lattice-stop-main', type: 'button', 'aria-label': `${row.title}を開く`, dataset: { focusKey: `open:${id}` }, on: { click: mark(() => openCard(row.projectId, row.cardId)) } },
        glyph('octagon', 'lattice-stop-g'),
        h('span', { class: 'bd' },
          h('b', { class: 'ti', text: row.title }),
          h('span', { class: 'ch', text: row.chart }),
          h('span', { class: 'mt' }, h('small', { text: '担当' }), person(row.lane)),
          h('span', { class: 'rs' }, h('small', { text: '理由' }), h('span', { class: 'tx', text: row.reason })),
          h('span', { class: 'mt' }, h('small', { text: '止めた人' }), person(row.by), row.time && h('time', { text: row.time })))),
      h('div', { class: 'lattice-stop-act' }, ...act),
      note && h('p', { class: 'lattice-stop-note', role: 'status', text: note }))
    rowEls.set(id, el)
    return el
  }

  function cancel(refocus) {
    const id = confirmId
    confirmId = null
    paint(refocus && id ? `ask:${id}` : undefined)
  }

  async function read() {
    clear(timer); timer = null
    const mine = ++token
    let data
    try { data = await api('/api/lattice/blockers') } catch (error) {
      if (!isOpen || mine !== token) return
      if (error?.status === 404) { phase = 'old'; return paint() }
      return retry()
    }
    if (!isOpen || mine !== token) return
    if (data?.schema !== BLOCKERS_SCHEMA || !Array.isArray(data.blockers)) return retry()
    attempt = 0; phase = 'ready'; blockers = data.blockers; unread = (data.unreadCharts ?? []).length > 0
    const ids = new Set(blockers.map(item => item?.stopId))
    if (confirmId && !ids.has(confirmId)) confirmId = null
    for (const id of notes.keys()) if (!ids.has(id)) notes.delete(id)
    paint()
  }
  function retry() { phase = 'retry'; paint(); timer = later(read, backoffMs(attempt++, random)) }

  async function remove(row) {
    confirmId = null; notes.delete(row.stopId); removing.add(row.stopId); paint()
    let outcome
    try { outcome = unblockOutcome(200, await api(`/api/lattice/charts/${encodeURIComponent(row.projectId)}/unblock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stopId: row.stopId }) })) }
    catch (error) { outcome = unblockOutcome(error?.status, { reason: error?.reason }) }
    removing.delete(row.stopId)
    if (!isOpen) return
    if (outcome.kind === 'drop') { blockers = blockers.filter(item => item?.stopId !== row.stopId); rowEls.get(row.stopId)?.classList.add('is-leaving') }
    else { notes.set(row.stopId, outcome.kind === 'refused' ? STOPS_MESSAGES.refused(outcome.reason) : STOPS_MESSAGES.later); paint() }
    void read() // どの答えでもすぐ読み直す
  }

  const visible = () => { if (isOpen && !globalThis.document.hidden && phase !== 'old') void read() }
  host.addEventListener('click', event => { if (confirmId && !event.handledByStops) cancel(false) })

  return {
    open() { if (isOpen) return; isOpen = true; document.addEventListener('visibilitychange', visible); paint(); void read() },
    close() { if (!isOpen) return; isOpen = false; token++; clear(timer); timer = null; document.removeEventListener('visibilitychange', visible) },
    // Esc：確認が開いていればそれだけ閉じ、無ければ一覧へ戻る。
    escape() { if (confirmId) cancel(true); else back() },
  }
}
